"""AudioRouter（P5-4 已确认：switch-on-speak）。

进程内 pulsectl 实现（Phase 1 的 scripts/bt/switch-profile.sh 逻辑内化）：
- begin(): 卡切到第一个可用 a2dp-sink* profile，等 bluez sink 出现，返回 sink 名
- end():   切回 headset-head-unit
全部为阻塞方法，调用方放执行器线程。

与 daemon 采集的互动：切走 A2DP 后 HFP 麦克风 source 消失，
daemon 的 speaker.speaking 标志会让 watcher/reconnect 静默（见 daemon 接线）。
"""
from __future__ import annotations

import logging
import time

log = logging.getLogger("voice.router")


class AudioRouter:
    def __init__(self, cfg: dict):
        self._cfg_audio = cfg.get("audio") or {}
        self.mac = self._cfg_audio.get("bt_mac", "")
        self._card_idx = None
        self.switch_ms = 0

    # ---- 内部工具 ----
    def _pulse(self):
        import pulsectl
        return pulsectl.Pulse("voice-router")

    def _find_card(self, p):
        if not self.mac:
            return None
        for c in p.card_list():
            proplist = getattr(c, "proplist", {}) or {}
            addr = str(proplist.get("device.api.bluez5.address", "")) \
                or next((str(v) for k, v in proplist.items()
                         if "bluez5.address" in k), "")
            if not addr and (getattr(c, "name", "") or "").startswith("bluez_card."):
                addr = c.name[len("bluez_card."):].replace("_", ":")
            if addr.upper() == self.mac.upper():
                return c
        return None

    def _pick_profile(self, card, prefix: str):
        cands = []
        for prof in card.profile_list:
            name = getattr(prof, "name", "") or ""
            available = getattr(prof, "available", True)
            if not name.startswith(prefix) or not available:
                continue
            # 精确名优先（如 a2dp-sink / a2dp-sink-sbc / a2dp-sink-aac）
            cands.append((0 if name == prefix else 1, name))
        if not cands:
            return None
        cands.sort()
        return cands[0][1]

    def _wait_sink(self, p, timeout_s: float = 3.0) -> str | None:
        # sink 名保留 MAC 原大小写（实测 bluez_output.30_8A_F7_0A_92_06.1），不敏感匹配
        pre = "bluez_output." + self.mac.replace(":", "_").lower()
        t0 = time.time()
        while time.time() - t0 < timeout_s:
            for s in p.sink_list():
                if (getattr(s, "name", "") or "").lower().startswith(pre):
                    return s.name
            time.sleep(0.1)
        return None

    # ---- 对外接口（阻塞，放线程池） ----
    def hfp_sink(self) -> str:
        """定位当前 HFP sink 名（**不切 profile**；P6-1 hfp-only 播放用）。

        实测（2026-09-06）：A2DP 与 HFP 的 sink node 同名
        （bluez_output.<mac>.1，profile 切换时销毁重建）——
        daemon 常驻 HFP 采集时，直接把播放指向它即可，
        采集不中断 → KWS 全程在线 → 播报期间唤醒词可打断。
        2026-09-13：audio.sink 配置精确名优先（USB 声卡路径，
        绕开蓝牙栈；NewPie BT 适配器崩溃的替代方案）。
        """
        want = (self._cfg_audio or {}).get("sink", "")
        if want:
            with self._pulse() as p:
                for s in p.sink_list():
                    if s.name == want:
                        return want
            raise RuntimeError(f"配置的 sink 不存在: {want}")
        with self._pulse() as p:
            pre = "bluez_output." + self.mac.replace(":", "_").lower()
            for s in p.sink_list():
                if (getattr(s, "name", "") or "").lower().startswith(pre):
                    return s.name
        raise RuntimeError(f"HFP sink 未出现（{self.mac} 已连接？）")

    def begin(self) -> str:
        """切 A2DP 并返回 sink 名；失败抛异常。"""
        t0 = time.time()
        with self._pulse() as p:
            card = self._find_card(p)
            if card is None:
                raise RuntimeError(f"找不到蓝牙声卡 {self.mac}（已连接？）")
            prof = self._pick_profile(card, "a2dp-sink")
            if not prof:
                raise RuntimeError("无可用 a2dp-sink* profile")
            active = getattr(card, "active_profile", None)
            if active is None or active.name != prof:
                p.card_profile_set(card, prof)
            sink = self._wait_sink(p)
        self.switch_ms = round((time.time() - t0) * 1000)
        if not sink:
            raise RuntimeError("A2DP sink 未出现（3s 超时）")
        log.info("router: a2dp %s (%dms)", sink, self.switch_ms)
        return sink

    def end(self) -> None:
        try:
            with self._pulse() as p:
                card = self._find_card(p)
                if card is None:
                    return
                prof = self._pick_profile(card, "headset-head-unit")
                if prof:
                    p.card_profile_set(card, prof)
            log.info("router: back to hfp")
        except Exception as e:  # noqa: BLE001
            log.warning("router end 失败: %s", e)
