"""voice-daemon 主程序：采集 → 电平/VAD → WebSocket 事件。

启动：scripts/daemon-start.sh（设 PYTHONPATH=src 后 `python -m voice.daemon`）
事件：level(1Hz) / vad/start / vad/end / state / source/changed
RPC：ping / get_state / get_buffer{seconds}
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import signal
import sys
import time
from pathlib import Path

import numpy as np
import pulsectl

from .capture import ParecCapture, SourceLost, resolve_source
from .config import load_config, REPO_ROOT
from .kws import KwsEngine
from .ringbuffer import RingBuffer
from .server import Hub, serve
from .vad import Segmenter, SileroVad

# 2026-09-15 TTS 升级调研（docs/research/tts-upgrade-2026-09-15.md）：
# 音色方案 = (provider, model, voice) 三元组预设，面板一键热切。
# cosyvoice 线 = 旧 WS（cosyvoice-* / qwen-audio-* 同协议）；
# qwen-realtime 线 = /api-ws/v1/realtime（首音 ~0.25s，会话复用）。
TTS_PRESETS = {
    "cosyvoice-longhan": ("现状·男声沉稳（cosyvoice）",
                          "cosyvoice", "cosyvoice-v3-flash", "longhan_v3"),
    "qa-jielidou": ("qwen-audio·天真男童 5 岁",
                    "cosyvoice", "qwen-audio-3.1-tts-flash", "longjielidou_v3.1"),
    "qa-huohuo": ("qwen-audio·顽皮少年 8 岁",
                  "cosyvoice", "qwen-audio-3.0-tts-flash", "longhuohuo_v3.6"),
    "qa-anhuan": ("qwen-audio·欢快女声 25 岁",
                  "cosyvoice", "qwen-audio-3.0-tts-flash", "longanhuan_v3.6"),
    "rt-pip": ("realtime·顽皮小男孩（小新风）",
               "qwen-realtime", "qwen3-tts-flash-realtime", "Pip"),
    "rt-bunny": ("realtime·萌小萝莉",
                 "qwen-realtime", "qwen3-tts-flash-realtime", "Bunny"),
    "rt-mochi": ("realtime·机灵小大人（男童）",
                 "qwen-realtime", "qwen3-tts-flash-realtime", "Mochi"),
    "rt-cherry": ("realtime·阳光女青年",
                  "qwen-realtime", "qwen3-tts-flash-realtime", "Cherry"),
}

# 候选试听句（中英混说，与调研实测同文，便于跨方案对比）。
# 2026-09-25：去掉唤醒词字样——试听经音箱外放，含唤醒词会在任何词下自唤醒。
TTS_PREVIEW_TEXT = ("你好呀！我是你的语音小助手。今天我们来测试中英文混说的效果："
                    "The weather looks great today, Shall we go for a walk?")

log = logging.getLogger("voice.daemon")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        return json.dumps({
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()),
            "level": record.levelname,
            "mod": record.name,
            "msg": record.getMessage(),
        }, ensure_ascii=False)


def setup_logging(logfile: Path) -> None:
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    logfile.parent.mkdir(parents=True, exist_ok=True)
    fh = logging.FileHandler(logfile, encoding="utf-8")
    fh.setFormatter(JsonFormatter())
    sh = logging.StreamHandler(sys.stderr)
    sh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s", "%H:%M:%S"))
    root.addHandler(fh)
    root.addHandler(sh)


def _toml_set(text: str, section: str, key: str, value: object) -> str:
    """段落级保注释替换：只动 [section] 块内首个 `key = ...` 行的值部分。
    块或键不存在时追加（保守：面板字段均现存在于 voice.toml）。"""
    import json as _json
    import re as _re
    if isinstance(value, str):
        val = _json.dumps(value, ensure_ascii=False)
    elif isinstance(value, bool):
        val = "true" if value else "false"
    else:
        val = str(value)
    m = _re.search(rf"(?ms)^\[{_re.escape(section)}\][ \t]*(?:#.*)?$(.*?)(?=^\[|\Z)", text)
    if not m:
        return text.rstrip("\n") + f"\n\n[{section}]\n{key} = {val}\n"
    block = m.group(0)
    km = _re.search(rf"(?m)^(\s*{_re.escape(key)}\s*=\s*)(\"(?:[^\"\\]|\\.)*\"|'(?:[^'\\]|\\.)*'|[^\n#]+?)(\s*(?:#.*)?)$", block)
    if km:
        new_block = block[:km.start()] + km.group(1) + val + km.group(3) + block[km.end():]
    else:
        new_block = block.rstrip("\n") + f"\n{key} = {val}\n"
    return text[:m.start()] + new_block + text[m.end():]


class Daemon:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.hub = Hub()
        self.stopping = False
        self.t0 = time.monotonic()
        # 注意：后台托管 namespace 中 time.monotonic() 观测到不可信偏移
        # （Phase 2 实测：跨段 t 出现负值），事件相对时间一律用墙钟派生。
        self.t0_wall = time.time()
        self.frame_no = 0
        self.state = "init"
        self.source: str | None = None
        self.source_why = ""
        self.restart_event = asyncio.Event()
        self._capture_paused = False
        self._watch_last_frames = 0     # 帧流看门狗（2026-09-13）
        self._watch_stall_s = 0.0
        self._last_level_sent = 0.0
        self._level_dbfs = -96.0

        a = cfg["audio"]
        v = cfg["vad"]
        self.vad = SileroVad()
        self.seg = Segmenter(
            threshold=v["threshold"], min_speech_ms=v["min_speech_ms"],
            min_silence_ms=v["min_silence_ms"], pre_roll_ms=v["pre_roll_ms"],
            frame_ms=a["frame_ms"])
        self.seg.on_start = self._on_seg_start
        self.seg.on_end = self._on_seg_end
        r = cfg["ring"]
        self.ring = RingBuffer(r["seconds"], a["sample_rate"], a["channels"])
        self.kws = KwsEngine(cfg)
        self._beep_busy = False

        # Phase 4：ASR（P4-2 只用 bailian qwen3-asr-flash，无 fallback）
        self.asr = None
        self._asr_inflight = False
        self._asr_pending = False
        if (cfg.get("asr") or {}).get("enabled", False):
            try:
                from .asr_provider import build_asr
                self.asr = build_asr(cfg)
                log.info("asr ready: %s", self.asr.provider)
            except Exception as e:  # noqa: BLE001
                log.error("asr 初始化失败（段转写停用）: %s", e)

        self.hub.state_fn = self.state_snapshot
        self.hub.register_rpc("ping", lambda: {"ok": True, "uptime_s": round(time.monotonic() - self.t0, 1)})
        self.hub.register_rpc("get_state", self.state_snapshot)
        self.hub.register_rpc("get_buffer", self._rpc_get_buffer)
        self.hub.register_rpc("get_cpu", self._rpc_get_cpu)
        self.hub.register_rpc("config/get", self._rpc_config_get)
        self.hub.register_rpc("config/set", self._rpc_config_set)
        self.hub.register_rpc("engine/restart", self._rpc_engine_restart)
        # 2026-09-20 P7c 前置：唤醒词换词（生成+校验+落盘+自重启）
        self.hub.register_rpc("wake/get", self._rpc_wake_get)
        self.hub.register_rpc("wake/set", self._rpc_wake_set)
        self._cpu_last = self._cpu_sample()

        # Phase 5：TTS 播放队列（P5-1 cosyvoice 单线 + P5-2 话术兜底）
        self.speaker = None
        self._loop = None
        if (cfg.get("tts") or {}).get("enabled", False):
            try:
                from .player import Speaker
                self.speaker = Speaker(
                    cfg, self.hub,
                    pause_hook=self._pause_capture,
                    resume_hook=self._resume_capture)
                self.hub.register_rpc("tts/speak", self._rpc_tts_speak)
                self.hub.register_rpc("tts/stream", self._rpc_tts_stream)
                self.hub.register_rpc("tts/stop", self._rpc_tts_stop)
                self.hub.register_rpc("tts/flush", self._rpc_tts_flush)
                self.hub.register_rpc("tts/volume", self._rpc_tts_volume)
                self.hub.register_rpc("tts/preview", self._rpc_tts_preview)
                self.hub.register_rpc("music/preview", self._rpc_music_preview)
                log.info("tts ready: %s sink_mode=%s",
                         self.speaker.tts.provider, self.speaker.sink_mode)
            except Exception as e:  # noqa: BLE001
                log.error("tts 初始化失败（播放停用）: %s", e)

        # Phase 6：语音循环状态机（P6-1/2/3 已确认）
        self.voiceloop = None
        if (cfg.get("loop") or {}).get("enabled", False) and self.speaker is not None:
            try:
                from .loop import VoiceLoop
                backend = str((cfg.get("loop") or {}).get("agent", "echo"))
                if backend == "echo":
                    from .echo_agent import EchoAgent
                    agent = EchoAgent(cfg)
                elif backend == "dsh":  # Phase 7a：DSH 插件 WS 中继
                    from .dsh_agent import DshAgent
                    agent = DshAgent(cfg, self.hub)
                else:
                    raise RuntimeError(f"未知 loop.agent: {backend}")
                self.voiceloop = VoiceLoop(cfg, self.hub, self.speaker, agent,
                                           asr=self.asr)
                self.hub.tap = self.voiceloop.on_event
                self.hub.register_rpc("loop/stop", self._rpc_loop_stop)
                self.hub.register_rpc("loop/turn", self._rpc_loop_turn)
                log.info("voice-loop ready（%s 后端）", backend)
            except Exception as e:  # noqa: BLE001
                log.error("voice-loop 初始化失败（对话编排停用）: %s", e)

    def _tts_call(self, coro, timeout: float | None = 2.0):
        """执行器线程 → 事件循环的安全调用。"""
        if self._loop is None:
            return None
        fut = asyncio.run_coroutine_threadsafe(coro, self._loop)
        try:
            return fut.result(timeout)
        except Exception:  # noqa: BLE001
            return None

    def _rpc_tts_speak(self, text: str = "", **_) -> dict:
        if self.speaker is None:
            return {"ok": False, "error": "tts 未启用"}
        if not (text or "").strip():
            return {"ok": False, "error": "空文本"}
        n = self._tts_call(self.speaker.speak(text))
        return {"ok": n is not None, "sentences": n or 0}

    def _rpc_tts_stream(self, action: str = "feed", text: str = "", **_) -> dict:
        """流式会话（Phase 7 agent token 流 → 边生成边播）：
        action=begin 开流 / feed 喂增量（返回入队句数）/ end 收尾。"""
        if self.speaker is None:
            return {"ok": False, "error": "tts 未启用"}
        if action == "begin":
            self._tts_call(self.speaker.stream_begin(), timeout=None)
            return {"ok": True}
        if action == "feed":
            n = self._tts_call(self.speaker.stream_feed(text or ""))
            return {"ok": n is not None, "sentences": n or 0}
        if action == "end":
            n = self._tts_call(self.speaker.stream_end(), timeout=None)
            return {"ok": True, "sentences": n or 0}
        return {"ok": False, "error": f"未知 action: {action}"}

    def _rpc_tts_stop(self, **_) -> dict:
        if self.speaker is None:
            return {"ok": False, "error": "tts 未启用"}
        self._tts_call(self.speaker.stop(), timeout=None)
        return {"ok": True}

    def _rpc_tts_flush(self, **_) -> dict:
        if self.speaker is None:
            return {"ok": False, "error": "tts 未启用"}
        self._tts_call(self.speaker.flush(), timeout=None)
        return {"ok": True}

    def _rpc_tts_volume(self, volume: float = 0.9, **_) -> dict:
        if self.speaker is None:
            return {"ok": False, "error": "tts 未启用"}
        v = self._tts_call(self.speaker.set_volume(volume))
        return {"ok": v is not None, "volume": v}

    def _rpc_loop_stop(self, **_) -> dict:
        """GUI 停止按钮：打断当前轮（播报/思考/听取）回 idle。"""
        if self.voiceloop is None:
            # 无 loop 时至少停播
            if self.speaker is not None:
                self._tts_call(self.speaker.stop(), timeout=None)
            return {"ok": True, "loop": False}
        self._tts_call(self.voiceloop.manual_stop(), timeout=None)
        return {"ok": True, "loop": self.voiceloop.state}

    def _rpc_loop_turn(self, text: str = "", **_) -> dict:
        """debug（Phase 7a 回归）：注入一轮 wake+asr，全链路真实走
        （agent→流式 TTS→音箱出声）。等价于用户说 text。"""
        if self.voiceloop is None:
            return {"ok": False, "error": "loop-disabled"}
        if not (text or "").strip():
            return {"ok": False, "error": "empty-text"}
        self._tts_call(self._debug_turn(text), timeout=None)
        return {"ok": True, "state": self.voiceloop.state}

    async def _debug_turn(self, text: str) -> None:
        loop = self.voiceloop
        loop._ev_wake()
        await asyncio.sleep(0.05)
        loop._ev_vad_start()
        loop._ev_vad_end()
        loop._ev_asr_final({"text": text})

    # ---- 采集暂停/恢复（TTS 播放用；协程，事件循环内调用） ----
    async def _pause_capture(self) -> None:
        """暂停采集并等它真正停稳（state=speaking）。

        wireplumber 会因常开录音流锁死 HFP profile（2026-09-06 实测），
        A2DP 切换前必须让 parec 真正退出。
        """
        if self.state == "speaking":
            return
        self._capture_paused = True
        self.restart_event.set()
        t0 = time.monotonic()
        while self.state != "speaking" and time.monotonic() - t0 < 3.0:
            await asyncio.sleep(0.05)

    async def _resume_capture(self) -> None:
        self._capture_paused = False
        self.restart_event.set()

    @staticmethod
    def _cpu_sample() -> tuple[float, float]:
        """(wall_s, cpu_jiffies) 读自身 /proc/self/stat 的 utime+stime。"""
        with open("/proc/self/stat") as f:
            parts = f.read().rsplit(") ", 1)[1].split()
        return time.time(), (int(parts[11]) + int(parts[12])) / os.sysconf("SC_CLK_TCK")

    def _rpc_get_cpu(self) -> dict:
        now, j = self._cpu_sample()
        prev_t, prev_j = self._cpu_last
        self._cpu_last = (now, j)
        inst = (j - prev_j) / max(now - prev_t, 1e-6) * 100
        cum = j / max(time.time() - self.t0_wall, 1e-6) * 100
        rss_kb = 0
        try:
            with open("/proc/self/status") as f:
                for line in f:
                    if line.startswith("VmRSS:"):
                        rss_kb = int(line.split()[1])
                        break
        except OSError:
            pass
        return {"cpu_pct_since_last": round(inst, 1),
                "cpu_pct_cumulative": round(cum, 1),
                "rss_mb": round(rss_kb / 1024, 1),
                "note": "100 = 1 核"}

    # ---------- 面板配置 RPC（P7：白名单 + 热改/需重启分级） ----------

    def _cfg_fields(self) -> dict:
        """面板可配置字段白名单：path → (section, key, 校验器, 生效方式, 选项)。"""
        def num(lo, hi):
            def f(v):
                try:
                    return lo <= float(v) <= hi
                except (TypeError, ValueError):
                    return False
            return f

        def oneof(*opts):
            return lambda v: isinstance(v, str) and v in opts

        def text(maxlen):
            def f(v):
                return isinstance(v, str) and 0 < len(v.strip()) <= maxlen
            return f

        return {
            "tts.volume": ("tts", "volume", num(0.05, 1.5), "live", None),
            # 2026-09-20 P7c 前置：断句静默可调（用户反馈：说话卡壳时停顿长，
            # 450ms 偏短易截断；上限给到 3s 容忍长停顿）——Segmenter 每帧读
            # min_silence_fr，改属性即热生效，无需重启
            "vad.min_silence_ms": ("vad", "min_silence_ms",
                                   num(200, 3000), "live", None),
            # 2026-09-20 思考等待音乐（热改即生效：Speaker 每轮读取）
            "music.enabled": ("music", "enabled",
                              lambda v: isinstance(v, bool), "live", None),
            "music.volume": ("music", "volume", num(0.0, 1.0), "live", None),
            # 2026-09-15：音色方案预设取代 model/voice 两个独立选择
            # （model 与 provider 耦合，独立选会造出 ModelNotFound 组合）
            "tts.preset": ("tts", "preset",
                           oneof(*TTS_PRESETS), "live",
                           [(k, f"{v[0]}（{k}）") for k, v in TTS_PRESETS.items()]),
            # 2026-09-20 P7b：自定义音色覆盖（agent 个性音色）；空串=回落
            # 预设默认音色（config_set 归一化，build_tts 永远见到具体值）
            "tts.voice": ("tts", "voice",
                          lambda v: (isinstance(v, str) and v.strip() == "") or
                          (isinstance(v, str) and 0 < len(v.strip()) <= 64 and
                           all(c.isascii() and (c.isalnum() or c in "_.-")
                               for c in v.strip())), "live", None),
            "asr.provider": ("asr", "provider",
                             oneof("bailian", "bailian-mm"), "restart",
                             [("bailian-mm", "bailian-mm（同步端点：fun/qa3，推荐）"),
                              ("bailian", "bailian（兼容端点：qwen3，回退）")]),
            "asr.model": ("asr", "model",
                          oneof("qwen-audio-3.1-asr-flash",
                                "fun-asr-flash-2026-06-15",
                                "qwen-audio-3.0-asr-flash",
                                "qwen3-asr-flash"), "restart",
                          [("qwen-audio-3.1-asr-flash",
                            "qwen-audio-3.1-asr-flash（当前，需 bailian-mm；"
                            "9-25 A/B 延迟/准确率平 fun，价约 1/10）"),
                           ("fun-asr-flash-2026-06-15",
                            "fun-asr-flash-2026-06-15（上代定点，需 bailian-mm）"),
                           ("qwen-audio-3.0-asr-flash",
                            "qwen-audio-3.0-asr-flash（需 bailian-mm，延迟差）"),
                           ("qwen3-asr-flash",
                            "qwen3-asr-flash（需 bailian，旧基线）")]),
            "asr.context": ("asr", "context", text(500), "restart", None),
            "wake.threshold": ("wake", "threshold", num(0.05, 0.6), "restart", None),
            "wake.keywords_score": ("wake", "keywords_score", num(0.5, 8.0), "restart", None),
            "loop.tool_filler": ("loop", "tool_filler", lambda v: isinstance(v, bool), "live", None),
            "loop.think_timeout_s": ("loop", "think_timeout_s", num(10, 180), "restart", None),
            "loop.followup_window_s": ("loop", "followup_window_s", num(2, 30), "restart", None),
        }

    def _rpc_config_get(self, **_) -> dict:
        fields = self._cfg_fields()
        out = {}
        for path, (sec, key, _v, effect, options) in fields.items():
            sec_cfg = self.cfg.get(sec) or {}
            out[path] = {"value": sec_cfg.get(key),
                         "effect": effect,
                         **({"options": [{"value": v, "label": l} for v, l in options]} if options else {})}
        return {"ok": True, "config": out,
                "wake_keyword": (self.cfg.get("wake") or {}).get("keyword"),
                "session_id": (self.cfg.get("agent") or {}).get("session_id")}

    def _rpc_config_set(self, updates: dict | None = None, **_) -> dict:
        updates = updates or {}
        fields = self._cfg_fields()
        errors: dict[str, str] = {}
        accepted: dict[str, object] = {}
        for path, value in updates.items():
            spec = fields.get(path)
            if spec is None:
                errors[path] = "不在白名单"
                continue
            if not spec[2](value):
                errors[path] = "取值不合法"
                continue
            accepted[path] = value
        if errors:
            return {"ok": False, "errors": errors}

        # P7b 2026-09-20：tts.voice 传空串 = 清除自定义覆盖 → 归一化为当前
        # 预设的默认音色（与 tts.preset 展开三键的落盘形态保持一致，
        # build_tts 永远读到具体音色 id；预设不可解析则忽略本次 voice 更新）
        if "tts.voice" in accepted and str(accepted["tts.voice"]).strip() == "":
            pspec = TTS_PRESETS.get(
                (self.cfg.get("tts") or {}).get("preset", ""), ())
            if pspec:
                accepted["tts.voice"] = pspec[3]
            else:
                accepted.pop("tts.voice")

        # 1) 持久化（保注释的段落级 TOML 替换）
        try:
            from pathlib import Path as _P
            p = _P(self.cfg["_path"])
            text = p.read_text(encoding="utf-8")
            for path, value in accepted.items():
                sec, key, _v, _e, _o = fields[path]
                text = _toml_set(text, sec, key, value)
                self.cfg.setdefault(sec, {})[key] = value
                if path == "tts.preset":
                    # 预设展开：provider/model/voice 三键一并落盘
                    _, prov, model, voice = TTS_PRESETS[value]
                    for k2, v2 in (("provider", prov), ("model", model),
                                   ("voice", voice)):
                        text = _toml_set(text, "tts", k2, v2)
                        self.cfg["tts"][k2] = v2
            p.write_text(text, encoding="utf-8")
        except Exception as e:  # noqa: BLE001
            log.error("config 写回失败: %s", e)
            return {"ok": False, "errors": {"_persist": str(e)}}

        # 2) 热改（tts.volume / tts.preset 运行时生效）
        applied, restart_needed = [], []
        for path, value in accepted.items():
            sec, key, _v, effect, _o = fields[path]
            (restart_needed if effect == "restart" else applied).append(path)
            if effect != "live":
                continue
            if sec == "vad" and self.seg is not None and key == "min_silence_ms":
                # 断句静默热改：Segmenter 状态机每帧比较 _sil_run >= min_silence_fr，
                # 只改属性即生效（正在说的这句不受影响，下一段起用新值）
                frame_ms = int((self.cfg.get("audio") or {}).get("frame_ms", 80))
                self.seg.min_silence_fr = max(1, round(float(value) / frame_ms))
                log.info("vad 断句静默热改: %.0fms", float(value))
            if sec == "music" and self.speaker is not None:
                if key == "enabled":
                    self.speaker.music_enabled = bool(value)
                    if not value:
                        self._tts_call(self.speaker.music_stop(), timeout=None)
                elif key == "volume":
                    self.speaker.music_volume = float(value)
            if sec == "loop" and self.voiceloop is not None and key == "tool_filler":
                self.voiceloop.tool_filler = bool(value)
                log.info("工具过渡语热改: %s", bool(value))
            if sec == "tts" and self.speaker is not None:
                if key == "volume":
                    self._tts_call(self.speaker.set_volume(float(value)))
                    # 音量即调即听：本地缓存话术试播（走播放管道，含新音量缩放）
                    self._tts_call(
                        self.speaker.beep(self.speaker.cache_dir / "ok.wav"),
                        timeout=2.0)
                elif key in ("preset", "voice"):
                    # 音色热切（预设整体切换 / P7b 自定义 voice 覆盖）：
                    # 重建 provider（realtime 线自动带会话线程），失败回滚
                    from .tts_provider import build_tts
                    old = self.speaker.tts
                    try:
                        self.speaker.tts = build_tts(self.cfg)
                        if hasattr(old, "close"):
                            old.close()
                        log.info("tts 切换(%s): %s → %s model=%s voice=%s",
                                 key, old.provider, self.speaker.tts.provider,
                                 getattr(self.speaker.tts, "model", "?"),
                                 getattr(self.speaker.tts, "voice", "?"))
                    except Exception as e:  # noqa: BLE001
                        self.speaker.tts = old   # 回滚，旧 provider 继续可用
                        return {"ok": False,
                                "errors": {path: f"切换失败已回滚: {e}"}}
        return {"ok": True, "applied": applied, "restart_needed": restart_needed}

    def _rpc_music_preview(self, seconds: float = 5.0, **_) -> dict:
        """面板试听等待音乐：播 seconds 秒后自动停（独立于语音轮）。"""
        if self.speaker is None:
            return {"ok": False, "error": "tts 未启用"}
        if not self.speaker.music_enabled:
            return {"ok": False, "error": "等待音乐未启用（先开 music.enabled）"}

        async def _do() -> None:
            await self.speaker.music_start()
            await asyncio.sleep(max(2.0, min(float(seconds), 20.0)))
            await self.speaker.music_stop()
        self._tts_call(_do(), timeout=None)
        return {"ok": True}

    # ---------- 唤醒词换词（P7c 前置，2026-09-20） ----------

    def _rpc_wake_get(self, **_) -> dict:
        """当前唤醒词 + keywords 文件原文（面板展示用）。"""
        w = self.cfg.get("wake") or {}
        line = ""
        try:
            line = self.kws.keywords_file.read_text(encoding="utf-8").strip()
        except Exception:  # noqa: BLE001
            pass
        return {"ok": True, "keyword": w.get("keyword"),
                "line": line, "file": str(self.kws.keywords_file)}

    def _rpc_wake_set(self, phrase: str = "", **_) -> dict:
        """换唤醒词：pypinyin 生成「声母+带调韵母」token → tokens.txt 词表
        校验 → 写 keywords 文件（留 .bak）→ voice.toml 记 keyword → 自重启
        （KWS 在 init 时加载文件，不重启不生效）。
        生成算法已对拍：你好丁满 → n ǐ h ǎo d īng m ǎn 与原文件逐字节一致。
        """
        phrase = (phrase or "").strip()
        if not (2 <= len(phrase) <= 8) or not all(
                "\u4e00" <= c <= "\u9fff" for c in phrase):
            return {"ok": False, "error": "唤醒词需 2–8 个汉字"}
        try:
            from pypinyin import pinyin, Style
            inits = [x[0] for x in pinyin(
                phrase, style=Style.INITIALS, errors="strict")]
            fins = [x[0] for x in pinyin(
                phrase, style=Style.FINALS_TONE, errors="strict")]
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"拼音生成失败（含非汉字字符？）：{e}"}
        toks: list = []
        for i, f in zip(inits, fins):
            if i:
                toks.append(i)
            toks.append(f)
        vocab = set()
        try:
            for ln in (self.kws.model_dir / "tokens.txt").read_text(
                    encoding="utf-8").splitlines():
                if ln.strip():
                    vocab.add(ln.split()[0])
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"tokens.txt 读取失败：{e}"}
        bad = [t for t in toks if t not in vocab]
        if bad:
            return {"ok": False,
                    "error": f"该词含模型词表外的音节：{'、'.join(bad)}，换个说法试试"}
        old_kw = (self.cfg.get("wake") or {}).get("keyword", "")
        from pathlib import Path as _P
        try:
            kfile = _P(self.kws.keywords_file)
            kfile.with_suffix(".txt.bak").write_text(
                kfile.read_text(encoding="utf-8"), encoding="utf-8")
            kfile.write_text(" ".join(toks) + f" @{phrase}\n", encoding="utf-8")
            p = _P(self.cfg["_path"])
            text = p.read_text(encoding="utf-8")
            text = _toml_set(text, "wake", "keyword", phrase)
            p.write_text(text, encoding="utf-8")
            self.cfg.setdefault("wake", {})["keyword"] = phrase
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"写入失败（换词未生效，可用 .bak 恢复）：{e}"}
        log.info("wake 换词: %r → %r tokens=%s", old_kw, phrase, toks)
        # 自重启加载新词（应答先于退出送达；面板已有"引擎重启中"提示流程）
        return self._rpc_engine_restart()

    def _rpc_tts_preview(self, preset: str = "", text: str = "",
                         voice: str = "", **_) -> dict:
        """面板「试听」。

        无参：本地缓存话术按当前音量播一遍（零网络零延迟，现状行为）。
        preset：按 TTS_PRESETS 临时建 provider 真合成一句（不动当前配置），
                落 cache_dir/preview-<preset>.wav 后走播放管道（含音量缩放）。
        voice：P7b 自定义音色覆盖（非空时取代该预设默认音色试听）。
        """
        if self.speaker is None:
            return {"ok": False, "error": "tts 未启用"}
        if not preset:
            played = self._tts_call(
                self.speaker.beep(self.speaker.cache_dir / "ok.wav"), timeout=2.0)
            return {"ok": bool(played), "played": bool(played)}
        spec = TTS_PRESETS.get(preset)
        if spec is None:
            return {"ok": False, "error": f"未知预设: {preset}"}
        label, prov, model, vdef = spec
        voice = voice.strip() if isinstance(voice, str) else ""
        if voice:
            vdef = voice

        from .tts_provider import build_tts
        t = dict(self.cfg.get("tts") or {})
        t.update(provider=prov, model=model, voice=vdef)
        tmp = None
        tag = voice if voice else "default"
        try:
            tmp = build_tts({"tts": t})
            body = (text or "").strip() or TTS_PREVIEW_TEXT

            async def _do() -> bool:
                loop = asyncio.get_event_loop()
                pcm = await loop.run_in_executor(
                    None, lambda: tmp.synthesize_pcm(body))
                path = self.speaker.cache_dir / f"preview-{preset}-{tag}.wav"
                import wave
                with wave.open(str(path), "wb") as w:
                    w.setnchannels(1)
                    w.setsampwidth(2)
                    w.setframerate(tmp.rate)
                    w.writeframes(pcm)
                log.info("tts/preview preset=%s voice=%s %dB",
                         preset, vdef, len(pcm))
                return await self.speaker.beep(path)
            played = self._tts_call(_do(), timeout=tmp.timeout_s + 20)
            return {"ok": bool(played), "played": bool(played),
                    "preset": preset, "label": label, "voice": vdef}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"试听失败: {e}"}
        finally:
            if tmp is not None and hasattr(tmp, "close"):
                tmp.close()

    def _rpc_engine_restart(self, **_) -> dict:
        """自重启：spawn 分离会话的启动脚本（脱离 DSH bash job 托管），
        短延迟后 os._exit 让出端口。新进程由 init 收养，DSH 重启不再连带。
        启动脚本路径取 launcher 注入的 VOICE_DAEMON_START（绝对路径，包/开发
        仓两种布局通吃）；未注入（开发仓手动 python -m voice.daemon）则回落
        代码根的 scripts/daemon-start.sh。cwd 与日志都锚定数据根。"""
        import shlex
        import subprocess
        import threading
        script_path = os.environ.get("VOICE_DAEMON_START") or str(REPO_ROOT / "scripts" / "daemon-start.sh")
        home = os.environ.get("VOICE_HOME", str(REPO_ROOT))
        log_path = Path(home) / "logs" / "voice.log"
        script = (f"sleep 1.2; exec bash {shlex.quote(script_path)} "
                  f">> {shlex.quote(str(log_path))} 2>&1")
        subprocess.Popen(["bash", "-c", script], cwd=home,
                         start_new_session=True,
                         stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        threading.Timer(0.3, lambda: os._exit(0)).start()
        return {"ok": True, "restarting": True}


    # ---------- 状态 / RPC ----------

    def state_snapshot(self) -> dict:
        return {
            "state": self.state,
            "source": self.source,
            "source_why": self.source_why,
            "speech_active": self.seg.speech_active,
            "level_dbfs": round(self._level_dbfs, 1),
            "frames": self.frame_no,
            "uptime_s": round(time.monotonic() - self.t0, 1),
            "vad_engine": self.cfg["vad"]["engine"],
            "wake_keyword": self.kws.keyword if self.kws.enabled else None,
            "wake_armed": self.kws.armed,
            "wake_hits": self.kws.hits,
            "asr": self.asr.provider if self.asr else None,
            "tts_speaking": bool(self.speaker and self.speaker.speaking),
            "loop": self.voiceloop.state if self.voiceloop else None,
            "loop_turn": self.voiceloop.turn if self.voiceloop else None,
            "clients": len(self.hub.clients),
        }

    def _rpc_get_buffer(self, seconds: float = 5.0) -> dict:
        seconds = max(0.1, min(float(seconds), self.cfg["ring"]["seconds"]))
        pcm = self.ring.last(seconds)
        return {
            "pcm_b64": base64.b64encode(pcm).decode(),
            "bytes": len(pcm), "seconds": round(len(pcm) / 32000, 2),
            "rate": self.cfg["audio"]["sample_rate"],
            "channels": self.cfg["audio"]["channels"],
        }

    # ---------- 段事件（segmenter 同步回调，本协程上下文） ----------

    def _on_seg_start(self, t_mono: float, ts_wall: float) -> None:
        log.info("vad/start t=%.2f", ts_wall - self.t0_wall)
        # 注意：此处不可 kws.reset()！segmenter 的 on_start 在 kws.feed 之后
        # 触发（同帧序：note_speech → feed → seg.feed），段首重置会把开口
        # 帧连同 KWS 门开预卷一起抹掉 → 唤醒词丢首字必漏检（2026-09-13
        # 实测反转定位：环冲音频离线命中、在线段首重置后零命中）。
        # 段间卫生由 KwsEngine 的门开重置+预卷与 vad/end 重置负责。
        asyncio.ensure_future(self.hub.broadcast({
            "type": "vad/start", "t": round(ts_wall - self.t0_wall, 3),
            "ts": ts_wall, "source": self.source}))

    def _on_seg_end(self, t_mono: float, ts_wall: float, dur_ms: float, pcm: bytes) -> None:
        log.info("vad/end dur=%.0fms bytes=%d", dur_ms, len(pcm))
        # 段边界重置 KWS 解码流（对抗束剪枝漏检，见 kws.reset 注释）
        self.kws.reset()
        asyncio.ensure_future(self.hub.broadcast({
            "type": "vad/end", "t": round(ts_wall - self.t0_wall, 3), "ts": ts_wall,
            "dur_ms": round(dur_ms), "bytes": len(pcm),
            "dbfs": round(self._level_dbfs, 1), "source": self.source}))
        # Phase 6：loop 门控（P6-idle 决策）——仅对话中的段才转写；loop 未启用
        # 时保持 Phase 4 全时段转写行为。
        # 竞态注意（2026-09-11 实测）：hub.broadcast 是 ensure_future 排队的，
        # tap（loop 转移）要到下一 tick 才执行；而唤醒词段 KWS 命中与段结束
        # 挤在同帧——同步查 wants_asr 时 loop 还在 idle → 段被误 skip。
        # 对策：转写调度也排队（_maybe_asr 先让出，tap 先跑完）。
        if self.asr is not None and not self._asr_inflight and not self._asr_pending:
            self._asr_pending = True
            asyncio.ensure_future(self._maybe_asr(pcm, dur_ms, ts_wall))

    async def _maybe_asr(self, pcm: bytes, dur_ms: float, ts_wall: float) -> None:
        """段转写调度：让 vad/end 的 tap（loop 转移）先执行，再门控。"""
        try:
            await asyncio.sleep(0)
            if self.voiceloop is not None and not self.voiceloop.wants_asr():
                log.info("asr skip（loop=%s，段 %dms 不在对话中）",
                         self.voiceloop.state, dur_ms)
                return
            await self._asr_task(pcm, dur_ms, ts_wall)
        finally:
            self._asr_pending = False

    def _asr_once(self, pcm: bytes):
        """单次 ASR（执行器线程）：DNS 瞬断重试一次（Errno -3 实测重试即恢复）。"""
        import time as _t
        for attempt in range(2):
            try:
                return self.asr.transcribe(pcm)
            except Exception as e:  # noqa: BLE001
                if attempt == 0 and "name resolution" in str(e):
                    _t.sleep(0.6)
                    continue
                raise
        return None

    async def _asr_hedged(self, loop, pcm: bytes):
        """对冲双发取先回（2026-09-11 服务端延迟双峰实测）。"""
        tasks = [loop.run_in_executor(None, self._asr_once, pcm)
                 for _ in range(2)]
        done, pending = await asyncio.wait(
            tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
        for t in done:
            if not t.cancelled() and t.exception() is None:
                return t.result()
        for t in done:  # 都失败：抛第一个异常
            if not t.cancelled() and t.exception() is not None:
                raise t.exception()
        return None

    async def _asr_task(self, pcm: bytes, dur_ms: float, ts_wall: float) -> None:
        self._asr_inflight = True
        loop = asyncio.get_event_loop()
        timeout_s = float((self.cfg.get("asr") or {}).get("timeout_s", 15))
        try:
            # Phase 6 演示开关：VOICE_FAULTS=asr=down 模拟 ASR 故障（判据 5 注入）
            if "asr=down" in os.environ.get("VOICE_FAULTS", ""):
                raise RuntimeError("fault-injected: asr=down")
            # 2026-09-11 实测 qwen3-asr-flash 服务端延迟双峰（0.9s / 6-11s 各半）：
            # 对冲双发取先回（都慢概率 16%），费用每段 ×2（≈0.0007 元，忽略）。
            # DNS 瞬断重试由各请求自身的 retry 承担（Errno -3 实测重试即恢复）。
            res = await asyncio.wait_for(
                self._asr_hedged(loop, pcm), timeout=timeout_s)
            if res is None:
                raise RuntimeError("asr 未返回")
            await self.hub.broadcast({
                "type": "asr/final", "t": round(ts_wall - self.t0_wall, 3),
                "ts": ts_wall, "text": res["text"],
                "latency_ms": res["latency_ms"], "dur_ms": round(dur_ms),
                "provider": res["provider"]})
            log.info("asr/final dur=%dms api=%dms %r",
                     dur_ms, res["latency_ms"], res["text"][:50])
        except Exception as e:  # noqa: BLE001
            await self.hub.broadcast({
                "type": "asr/error", "t": round(ts_wall - self.t0_wall, 3),
                "ts": ts_wall, "error": str(e)[:200]})
            log.warning("asr failed: %s", e)
        finally:
            self._asr_inflight = False

    # ---------- 帧处理 ----------

    def _resolve(self):
        """短连接解析目标 source（线程内执行，用后即关）。"""
        with pulsectl.Pulse("voice-resolve") as p:
            return resolve_source(p, self.cfg)

    def _bt_reconnect(self) -> None:
        """限频发起 bluetoothctl connect（8s 一次；耳机不在则快速失败）。"""
        import subprocess
        mac = self.cfg["audio"].get("bt_mac", "")
        if not mac:
            return
        now = time.time()
        if now - getattr(self, "_bt_last_try", 0) < 8.0:
            return
        self._bt_last_try = now
        try:
            r = subprocess.run(
                ["bluetoothctl", "--timeout", "6", "connect", mac],
                capture_output=True, text=True, timeout=8)
            out = (r.stdout + r.stderr).strip().splitlines()
            out = out[-1] if out else ""
            if "succeeded" in out or "already" in out.lower():
                log.info("bt-reconnect: %s", out[:60])
            else:
                log.info("bt-reconnect 尝试: %s", out[:60] or f"rc={r.returncode}")
        except Exception as e:  # noqa: BLE001
            log.warning("bt-reconnect 失败: %s", e)

    def _on_frame(self, frame: bytes) -> None:
        self.frame_no += 1
        self.ring.push(frame)
        x = np.frombuffer(frame, dtype=np.int16)
        rms = float(np.sqrt(np.mean(x.astype(np.float32) ** 2)))
        self._level_dbfs = 20 * np.log10(rms / 32768 + 1e-9)
        speech, prob = self.vad.feed(frame)
        self.kws.note_speech(speech)
        keyword = self.kws.feed(frame)
        if keyword:
            self._on_wake(keyword)
        self.seg.feed(speech, frame, time.monotonic(), time.time())
        now = time.monotonic()
        if now - self._last_level_sent >= 1.0:
            self._last_level_sent = now
            asyncio.ensure_future(self.hub.broadcast({
                "type": "level", "dbfs": round(float(self._level_dbfs), 1),
                "prob": round(prob, 3), "active": speech}))

    def _on_wake(self, keyword: str) -> None:
        """唤醒命中：事件广播 + 确认提示音（判据 2）。"""
        now = time.time()
        log.info("wake/detected keyword=%s #%d", keyword, self.kws.hits)
        asyncio.ensure_future(self.hub.broadcast({
            "type": "wake/detected", "keyword": keyword,
            "t": round(now - self.t0_wall, 3), "ts": now,
            "seq": self.kws.hits, "source": self.source}))
        snd = self.cfg["wake"].get("confirm_sound", "")
        if snd and not self._beep_busy:
            path = Path(snd)
            if not path.is_absolute():
                path = Path(REPO_ROOT) / path
            if path.is_file():
                if self.speaker is not None and self.speaker.sink_mode == "hfp":
                    # hfp：走播放管道（零 fork 死锁面、不被在飞 ASR 卡住——
                    # 2026-09-11 实测 paplay+guard 路径唤醒确认音延迟最多 5s）
                    self._beep_busy = True
                    async def _beep_done():
                        try:
                            await self.speaker.beep(path)
                        finally:
                            self._beep_busy = False
                    asyncio.ensure_future(_beep_done())
                else:
                    asyncio.ensure_future(self._play_beep(path))

    async def _play_beep(self, path: Path) -> None:
        """wake 确认音（a2dp 模式 paplay 路径）。

        paplay 的 fork 若撞上执行器线程内的 glibc getaddrinfo
        （解析器锁 × fork），会死锁事件循环（2026-09-06 实测阻塞 ~40s）。
        对策：fork 前等 ASR **或 TTS 合成**在飞窗口结束。
        蜂鸣只是 UX 反馈，延迟 1–2s 可接受；超时则跳过本次（宁无声不卡死）。
        """
        self._beep_busy = True
        try:
            for _ in range(100):  # 最多等 5s
                synth_busy = self.speaker is not None and self.speaker.synthesizing
                if not self._asr_inflight and not synth_busy:
                    break
                await asyncio.sleep(0.05)
            else:
                log.warning("beep 跳过：ASR 在飞超 5s")
                return
            proc = await asyncio.create_subprocess_exec(
                "paplay", str(path),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL)
            await asyncio.wait_for(proc.wait(), timeout=3.0)
        except Exception as e:  # noqa: BLE001
            log.warning("beep 播放失败: %s", e)
        finally:
            self._beep_busy = False

    # ---------- 采集主循环 ----------

    async def capture_loop(self) -> None:
        backoff = 1.0
        while not self.stopping:
            # TTS 播放暂停采集：wireplumber 会因常开录音流把 profile 锁死 HFP
            # （2026-09-06 实测：capture 活动时 pactl/pulsectl 切 a2dp 均被弹回），
            # 播放前必须腾出 HFP，A2DP 才可用。
            if self._capture_paused:
                if self.state != "speaking":
                    await self._set_state("speaking", "tts-playback")
                self.restart_event.clear()
                await asyncio.sleep(0.2)
                continue
            try:
                src, why = await asyncio.to_thread(self._resolve)
            except Exception as e:  # noqa: BLE001
                log.warning("resolve_source failed: %s", e)
                src, why = None, f"error:{e}"
            if src is None:
                await self._set_state("waiting_source", why)
                # TTS 播放中（A2DP 占卡）不重连不折腾，等 speaker 收尾
                if self.speaker is not None and self.speaker.speaking:
                    await asyncio.sleep(0.3)
                    continue
                # 判据4：BT 层主动重连（耳机上电后只回连"最后主机"，
                # 不保证是 Pi；等待期间由我方限频拉起连接）
                await asyncio.to_thread(self._bt_reconnect)
                try:
                    await asyncio.wait_for(self.restart_event.wait(), timeout=2.0)
                    self.restart_event.clear()
                except asyncio.TimeoutError:
                    pass
                continue
            self.restart_event.clear()
            cap = ParecCapture(src, self.cfg)
            try:
                await cap.start()
            except FileNotFoundError:
                log.error("parec 不可用，无法采集")
                self.stopping = True
                return
            prev = self.source
            self.source, self.source_why = src, why
            await self._set_state("capturing", f"{src} ({why})")
            await self.hub.broadcast({
                "type": "source/changed", "source": src, "why": why,
                "prev": prev})
            backoff = 1.0
            lost = False
            try:
                async for frame in cap.frames():
                    if self.restart_event.is_set():
                        self.restart_event.clear()
                        log.info("source 变化，重启采集")
                        break
                    self._on_frame(frame)
            except SourceLost:
                lost = True
                log.warning("source 丢失（parec EOF）: %s", src)
                await self._set_state("waiting_source", f"source-lost:{src}")
            finally:
                await cap.stop()
            if lost:
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 10.0)

    # ---------- source 监视线程（事件为主，0.5s 轮询兜底） ----------

    def _watcher_thread(self, loop: asyncio.AbstractEventLoop) -> None:
        import pulsectl as pc
        seen: str | None = None
        none_streak = 0
        while not self.stopping:
            try:
                with pc.Pulse("voice-watcher") as p:
                    q: list = []

                    def cb(ev):
                        if ev.facility in ("source", "card", "server"):
                            q.append((time.time(), ev.facility, str(ev.t)))
                            try:
                                p.event_listen_stop()
                            except Exception:  # noqa: BLE001
                                pass

                    p.event_callback_set(cb)
                    p.event_mask_set(
                        pc.PulseEventMaskEnum.source,
                        pc.PulseEventMaskEnum.card)
                    while not self.stopping:
                        q.clear()
                        try:
                            p.event_listen(timeout=0.5)
                        except Exception:  # noqa: BLE001
                            time.sleep(0.5)
                        try:
                            src, _why = resolve_source(p, self.cfg, mutate=False)
                        except Exception:  # noqa: BLE001
                            src = None
                        # 任何解析结果变化都通知重启：出现/切换/消失。
                        # 消失也必须通知——parec 不随 source 消失而 EOF
                        # （Phase 2 实测：否则 daemon 僵尸采集数字静音）。
                        # 消失需连续 2 轮确认（防抖，避免 profile 切换瞬态
                        # 引发采集重启链）。
                        if src != seen:
                            if src is None:
                                none_streak += 1
                                if none_streak >= 2:
                                    # TTS 播放中切走 A2DP 属预期，不触发重启
                                    if self.speaker is not None and self.speaker.speaking:
                                        log.info("watcher: source 消失（tts 播放中，忽略）")
                                        seen = src
                                        none_streak = 0
                                        continue
                                    log.info("watcher: source %s -> None（确认丢失）", seen)
                                    seen = src
                                    none_streak = 0
                                    loop.call_soon_threadsafe(self.restart_event.set)
                            else:
                                none_streak = 0
                                log.info("watcher: source %s -> %s", seen, src)
                                seen = src
                                loop.call_soon_threadsafe(self.restart_event.set)
                        # 帧流看门狗（2026-09-13：wireplumber 重启后源节点还在但
                        # 采集流静默饿死 2h 无自愈——源存在≠流活着）：
                        # capturing 态 5s 帧数零增长即强制重绑采集。
                        if (src is not None and self.state == "capturing"
                                and not self._capture_paused):
                            now_f = self.frame_no
                            if now_f == self._watch_last_frames:
                                self._watch_stall_s += 0.5
                                if self._watch_stall_s >= 5.0:
                                    log.warning(
                                        "watcher: 帧流停滞 %.1fs（源在但无数据），重绑采集",
                                        self._watch_stall_s)
                                    self._watch_stall_s = 0.0
                                    loop.call_soon_threadsafe(self.restart_event.set)
                            else:
                                self._watch_last_frames = now_f
                                self._watch_stall_s = 0.0
            except Exception as e:  # noqa: BLE001
                log.warning("watcher pulse 重连: %s", e)
                time.sleep(2.0)

    async def _set_state(self, state: str, why: str = "") -> None:
        self.state = state
        self.source_why = why
        log.info("state=%s why=%s", state, why)
        await self.hub.broadcast({"type": "state", **self.state_snapshot()})

    # ---------- 生命周期 ----------

    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        self._loop = loop
        cfg = self.cfg
        ws_started = asyncio.Future()
        server_task = asyncio.create_task(
            serve(self.hub, cfg["server"]["listen"], ws_started))
        await ws_started
        log.info("voice-daemon up: vad=silero frame=%dms listen=%s",
                 cfg["audio"]["frame_ms"], cfg["server"]["listen"])

        speaker_task = None
        if self.speaker is not None:
            self.speaker.start()
            speaker_task = self.speaker._worker_task

        import threading
        wt = threading.Thread(target=self._watcher_thread, args=(loop,), daemon=True)
        wt.start()

        stop = asyncio.Event()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, stop.set)
        cap_task = asyncio.create_task(self.capture_loop())
        stop_fut = asyncio.create_task(stop.wait())
        done, _ = await asyncio.wait(
            {cap_task, stop_fut}, return_when=asyncio.FIRST_COMPLETED)
        self.stopping = True
        cap_task.cancel()
        server_task.cancel()
        if speaker_task is not None:
            speaker_task.cancel()
        await asyncio.gather(cap_task, server_task, return_exceptions=True)
        if speaker_task is not None:
            await asyncio.gather(speaker_task, return_exceptions=True)
        agent = getattr(self.voiceloop, "agent", None) if self.voiceloop else None
        if agent is not None and hasattr(agent, "close"):
            await agent.close()   # Phase 7a：关 SSE/HTTP
        log.info("voice-daemon stopped, frames=%d uptime=%.0fs",
                 self.frame_no, time.monotonic() - self.t0)


def main() -> None:
    cfg = load_config()
    setup_logging(Path(cfg["_repo_root"]) / cfg["log"]["file"])
    log.info("config loaded from %s", cfg["_path"])
    # pidfile：托管 job 丢失后仍可按 pid 干净重启（sandbox 内 pgrep 不可见宿主进程）
    pidfile = Path(cfg["_repo_root"]) / "logs" / "voice-daemon.pid"
    pidfile.write_text(str(os.getpid()))
    d = Daemon(cfg)
    try:
        asyncio.run(d.run())
    finally:
        pidfile.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
