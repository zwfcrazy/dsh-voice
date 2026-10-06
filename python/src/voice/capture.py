"""采集层：source 解析（含 HFP profile 保障）+ parec 子进程托管。

P2-2 已确认（2026-09-06）：
- pulsectl + parec，固定 `--latency-ms=80`（不带则 2s 突发投递，实测）
- 输出 s16le / 16k / mono，帧长由 audio.frame_ms 决定
- source 消失时读端 EOF，由上层守 循环重解析重开流
"""
from __future__ import annotations

import asyncio
import logging
import subprocess

log = logging.getLogger("voice.capture")


class SourceLost(Exception):
    """parec 结束（EOF/被杀），通常意味着 source 消失。"""


def _bt_prefix(mac: str) -> str:
    return "bluez_input." + mac.replace(":", "_").upper()


def find_pulse_for_mac(pulse, mac: str) -> list:
    """bluez 麦克风 source 候选（按 MAC 前缀，排除 monitor）。"""
    if not mac:
        return []
    prefix = _bt_prefix(mac)
    out = []
    for s in pulse.source_list():
        if s.name.startswith(prefix) and not s.name.endswith(".monitor"):
            out.append(s.name)
    return sorted(out)


def bt_card(pulse, mac: str):
    """返回配置 MAC 对应的 bluez 声卡对象（无则 None）。"""
    if not mac:
        return None
    for c in pulse.card_list():
        if c.proplist.get("api.bluez5.address", "").upper() == mac.upper():
            return c
    return None


def ensure_hfp(pulse, mac: str) -> tuple[bool, str]:
    """保障 HFP profile：卡存在但 profile 非 headset 时切换。

    返回 (是否做过切换, 说明)。切换后 source 需要数百毫秒才出现，
    调用方应稍候重查。
    """
    card = bt_card(pulse, mac)
    if card is None:
        return False, "no-card"
    profs = {p.name: p for p in card.profile_list}
    active = getattr(card, "active_profile", None)
    active = active.name if hasattr(active, "name") else active
    if active and str(active).startswith("headset-head-unit"):
        return False, f"already:{active}"
    if "headset-head-unit" not in profs:
        return False, f"no-hfp-profile:active={active}"
    pulse.card_profile_set(card, "headset-head-unit")
    return True, f"switched:{active}->headset-head-unit"


def resolve_source(pulse, cfg: dict, mutate: bool = True) -> tuple[str | None, str]:
    """解析目标 source。返回 (source名或None, 说明)。

    audio.source == "auto"：先 bluez_input.<bt_mac 前缀>，再默认 source。
    否则按精确名匹配。
    mutate=False 为纯查询（watcher 用）：绝不切 profile——
    Phase 2 实测教训：watcher 侧切 profile 会与采集重启互相激励形成振荡。
    """
    a = cfg["audio"]
    want = a.get("source", "auto")
    if want and want != "auto":
        for s in pulse.source_list():
            if s.name == want:
                return want, "exact"
        return None, f"configured-source-missing:{want}"
    mac = a.get("bt_mac", "")
    if mac:
        cands = find_pulse_for_mac(pulse, mac)
        if cands:
            return cands[0], "bt-mic"
        if not mutate:
            return None, "bt-mic-missing(no-mutate)"
        # 有卡无 source：尝试切 HFP（重连后常为 a2dp）——仅采集主循环允许
        try:
            switched, why = ensure_hfp(pulse, mac)
            if switched:
                return None, "hfp-switching"  # 上层稍候重查
        except Exception as e:  # noqa: BLE001
            return None, f"ensure-hfp-error:{e}"
        # 严格模式：配置了 bt_mac 时不退化到默认 source。
        # Phase 2 实测教训：退化到 monitor 会让 daemon 永远"伪采集"数字静音，
        # 耳机断连无从感知（parec 不随 source 消失而 EOF）。
        return None, "bt-mic-missing"
    dflt = pulse.server_info().default_source_name
    if dflt and not dflt.endswith(".monitor"):
        return dflt, "default-source(fallback)"
    if dflt:
        return dflt, "default-monitor(last-resort)"
    return None, "no-source"


class ParecCapture:
    """parec 子进程托管：async 帧迭代器。"""

    def __init__(self, source: str, cfg: dict):
        self.source = source
        a = cfg["audio"]
        self.rate = a["sample_rate"]
        self.channels = a["channels"]
        self.frame_bytes_ = a["sample_rate"] * a["channels"] * 2 * a["frame_ms"] // 1000
        self.latency_ms = a.get("latency_ms", 80)
        self.proc: asyncio.subprocess.Process | None = None

    async def start(self) -> None:
        self.proc = await asyncio.create_subprocess_exec(
            "parec",
            f"--device={self.source}",
            "--format=s16le",
            f"--rate={self.rate}",
            f"--channels={self.channels}",
            f"--latency-ms={self.latency_ms}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        log.info("parec started src=%s pid=%s latency_ms=%s", self.source, self.proc.pid, self.latency_ms)

    async def frames(self):
        """yield 完整帧 bytes；EOF/异常 -> SourceLost。"""
        assert self.proc and self.proc.stdout
        while True:
            try:
                data = await self.proc.stdout.readexactly(self.frame_bytes_)
            except asyncio.IncompleteReadError:
                raise SourceLost(self.source) from None
            if not data:
                raise SourceLost(self.source)
            yield data

    async def stop(self) -> None:
        if self.proc and self.proc.returncode is None:
            try:
                self.proc.terminate()
                await asyncio.wait_for(self.proc.wait(), timeout=2.0)
            except (ProcessLookupError, asyncio.TimeoutError):
                self.proc.kill()
        self.proc = None

    @property
    def alive(self) -> bool:
        return self.proc is not None and self.proc.returncode is None


def pactl_card_profile(mac: str) -> str | None:
    """辅助：pactl 查询当前卡 profile（诊断用，非主路径）。"""
    try:
        out = subprocess.run(
            ["pactl", "list", "cards"], capture_output=True, text=True, timeout=5
        ).stdout
    except Exception:  # noqa: BLE001
        return None
    want = mac.upper()
    import re

    for blk in out.split("Card #"):
        if f"api.bluez5.address = \"{want}\"" in blk or f"api.bluez5.address=\"{want}\"" in blk:
            m = re.search(r"Active Profile:\s*(\S+)", blk)
            if m:
                return m.group(1)
    return None
