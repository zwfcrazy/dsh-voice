"""TTS Provider（P5-1 cosyvoice；2026-09-15 增 qwen-realtime 线）。

两条 provider（均阻塞接口，必须在执行器线程跑，daemon 的 player 如此使用）：
  cosyvoice    —— DashScope 旧 WS（/api-ws/v1/inference run-task 协议）。
                  同时服务 cosyvoice-* 与 qwen-audio-3.0-tts-*（协议相同，
                  见 docs/research/tts-upgrade-2026-09-15.md）。
  qwen-realtime—— DashScope realtime WS（/api-ws/v1/realtime，OpenAI-realtime
                  风格事件）。**连接/会话跨批复用**（首音 ~0.25s 的前提），
                  自带事件循环线程；打断（on_chunk 抛异常）会废弃会话防串音。

实测协议细节见 docs/research/phase-45-云服务选型.md 与 tts-upgrade-2026-09-15.md。
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import struct
import threading
import time
import urllib.request
import uuid

from .secrets import get_key

log = logging.getLogger("voice.tts")

BAILIAN_WS = "wss://dashscope.aliyuncs.com/api-ws/v1/inference"
BAILIAN_RT = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model={model}"


def build_tts(cfg: dict):
    t = cfg.get("tts") or {}
    if not t.get("enabled", False):
        return None
    provider = t.get("provider", "cosyvoice")
    if provider == "cosyvoice":
        return CosyVoiceTts(t)
    if provider == "qwen-realtime":
        return QwenRealtimeTts(t)
    raise RuntimeError(f"未知 tts provider: {provider}（cosyvoice | qwen-realtime）")


class CosyVoiceTts:
    name = "cosyvoice"

    def __init__(self, cfg: dict):
        self.model = cfg.get("model", "cosyvoice-v3-flash")
        self.voice = cfg.get("voice", "longhuhu_v3")
        self.rate = int(cfg.get("sample_rate", 24000))
        self.timeout_s = float(cfg.get("timeout_s", 20))
        self.key = get_key(cfg.get("key_env", "DASHSCOPE_API_KEY"))
        if not self.key:
            raise RuntimeError("缺 DASHSCOPE_API_KEY（~/.config/voice/secrets.env）")

    @property
    def provider(self) -> str:
        return f"cosyvoice/{self.model}:{self.voice}"

    def synthesize_pcm(self, text: str) -> bytes:
        """阻塞调用 → raw s16le mono PCM @rate。失败抛异常（由调用方兜底）。"""
        return asyncio.run(self._ws(text))

    def synthesize_stream(self, text: str, on_chunk) -> int:
        """阻塞**流式**合成（执行器线程）：音频块到达即回调 on_chunk(pcm)。

        2026-09-11：Phase 6 用户感知"反应慢"，主因是收齐再播（首音 ~3s）；
        改为边收边写播放管道（首音 ≈ 云端首块到达，实测目标 <1s）。
        首块剥 44 字节 WAV 头；on_chunk 抛异常（如 stop）立即中止。
        返回总 PCM 字节数。
        """
        return asyncio.run(self._ws_stream(text, on_chunk))

    async def _ws_stream(self, text: str, on_chunk) -> int:
        tid = str(uuid.uuid4())
        t0 = time.time()
        total = 0
        chunks = []          # 诊断：分块到达时间线（首块延迟/最大间隙）
        async with await self._connect() as ws:
            await ws.send(self._run_task_msg(text))
            header_skipped = False
            while True:
                raw = await asyncio.wait_for(ws.recv(), timeout=self.timeout_s)
                if isinstance(raw, (bytes, bytearray)):
                    if not header_skipped:
                        if raw[:4] != b"RIFF":
                            raise RuntimeError(f"cosyvoice 返回非 WAV: {raw[:8]!r}")
                        raw = raw[44:]           # 流式 WAV 头（长度为占位符）
                        header_skipped = True
                    if raw:
                        chunks.append(time.time())
                        on_chunk(bytes(raw))
                        total += len(raw)
                    continue
                msg = json.loads(raw)
                ev = msg.get("header", {}).get("event")
                if ev == "task-result":
                    out = (msg.get("payload") or {}).get("output") or {}
                    if out.get("audio"):
                        chunk = base64.b64decode(out["audio"])
                        if not header_skipped:
                            chunk = chunk[44:]
                            header_skipped = True
                        if chunk:
                            on_chunk(chunk)
                            total += len(chunk)
                elif ev == "task-finished":
                    break
                elif ev == "task-failed":
                    h = msg["header"]
                    raise RuntimeError(
                        f"cosyvoice {h.get('error_code')}: "
                        f"{str(h.get('error_message', ''))[:160]}")
        if chunks:
            gaps = [b - a for a, b in zip(chunks, chunks[1:])]
            log.info("ws-chunks n=%d first=%.2fs maxgap=%.2fs medgap=%.3fs",
                     len(chunks), chunks[0] - t0, max(gaps) if gaps else 0,
                     sorted(gaps)[len(gaps) // 2] if gaps else 0)
        return total

    def _run_task_msg(self, text: str) -> str:
        return json.dumps({
            "header": {"message_id": str(uuid.uuid4()), "task_id": str(uuid.uuid4()),
                       "action": "run-task", "streaming": "out"},
            "payload": {
                "model": self.model, "task_group": "audio",
                "task": "tts", "function": "SpeechSynthesizer",
                "input": {"text": text},
                "parameters": {"text_type": "PlainText", "voice": self.voice,
                               "format": "wav", "sample_rate": self.rate}}})

    async def _connect(self):
        """带握手重试的 WS 连接（2026-09-11 实测 opening handshake 可卡 10s
        超时——与 ASR 延迟双峰同时段；握手失败重试一次通常即恢复）。"""
        import websockets
        last = None
        for attempt in range(2):
            try:
                return await websockets.connect(
                    BAILIAN_WS,
                    additional_headers={"Authorization": f"bearer {self.key}"},
                    open_timeout=10 if attempt == 0 else 6)
            except Exception as e:  # noqa: BLE001
                last = e
                if attempt == 0:
                    continue
                raise
        raise last  # unreachable

    async def _ws(self, text: str) -> bytes:
        tid = str(uuid.uuid4())
        t0 = time.time()
        async with await self._connect() as ws:
            await ws.send(json.dumps({
                "header": {"message_id": str(uuid.uuid4()), "task_id": tid,
                           "action": "run-task", "streaming": "out"},
                "payload": {
                    "model": self.model, "task_group": "audio",
                    "task": "tts", "function": "SpeechSynthesizer",
                    "input": {"text": text},
                    "parameters": {"text_type": "PlainText", "voice": self.voice,
                                   "format": "wav", "sample_rate": self.rate}}}))
            audio = b""
            while True:
                raw = await asyncio.wait_for(ws.recv(), timeout=self.timeout_s)
                if isinstance(raw, (bytes, bytearray)):
                    audio += raw
                    continue
                msg = json.loads(raw)
                ev = msg.get("header", {}).get("event")
                if ev == "task-result":
                    out = (msg.get("payload") or {}).get("output") or {}
                    if out.get("audio"):
                        audio += base64.b64decode(out["audio"])
                elif ev == "task-finished":
                    break
                elif ev == "task-failed":
                    h = msg["header"]
                    raise RuntimeError(
                        f"cosyvoice {h.get('error_code')}: "
                        f"{str(h.get('error_message', ''))[:160]}")
        if audio[:4] != b"RIFF":
            raise RuntimeError(f"cosyvoice 返回非 WAV: {audio[:8]!r}")
        # 流式 WAV：头部长度字段是 0x7FFFFFFF 占位；我们只要裸 PCM（头 44 字节丢弃）
        return audio[44:]


class _Aborted(Exception):
    """on_chunk 主动打断（player stop）：废弃会话但不重试。"""


class QwenRealtimeTts:
    """qwen3-tts-*-realtime（/api-ws/v1/realtime，commit 模式）。

    会话复用是首音收益的前提：连接 → session.update(voice) 后常驻，
    每批一次 append+commit，response.audio.delta 流式回调。
    自带 asyncio 循环线程；公有方法阻塞（与 CosyVoiceTts 同构）。
    """

    name = "qwen-realtime"

    def __init__(self, cfg: dict):
        self.model = cfg.get("model", "qwen3-tts-flash-realtime")
        self.voice = cfg.get("voice", "Cherry")
        self.rate = int(cfg.get("sample_rate", 24000))
        self.timeout_s = float(cfg.get("timeout_s", 20))
        self.key = get_key(cfg.get("key_env", "DASHSCOPE_API_KEY"))
        if not self.key:
            raise RuntimeError("缺 DASHSCOPE_API_KEY（~/.config/voice/secrets.env）")
        self._lock = threading.Lock()
        self._ws = None
        self._sess_voice = None
        self._drain = None
        self._loop = None
        self._ready = threading.Event()
        self._thread = threading.Thread(target=self._run_loop, daemon=True,
                                        name="tts-qwen-rt")
        self._thread.start()
        self._ready.wait(5)

    # ---- 生命周期 ----

    def _run_loop(self):
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        self._ready.set()
        self._loop.run_forever()

    def close(self):
        """热切 provider / 进程收尾时调用（幂等）。"""
        if self._loop is not None:
            try:
                asyncio.run_coroutine_threadsafe(self._close_ws(), self._loop).result(3)
            except Exception:  # noqa: BLE001
                pass
            self._loop.call_soon_threadsafe(self._loop.stop)
            self._loop = None

    async def _close_ws(self):
        ws, self._ws, self._sess_voice = self._ws, None, None
        if ws is not None:
            try:
                await ws.close()
            except Exception:  # noqa: BLE001
                pass

    # ---- 公有接口（player 兼容）----

    @property
    def provider(self) -> str:
        return f"qwen3-rt/{self.model}:{self.voice}"

    def synthesize_pcm(self, text: str) -> bytes:
        with self._lock:
            return self._call(lambda: self._synth(text, None))[1]

    def synthesize_stream(self, text: str, on_chunk) -> int:
        with self._lock:
            return self._call(lambda: self._synth(text, on_chunk))[0]

    def _call(self, factory, timeout: float | None = None):
        assert self._loop is not None, "realtime 循环线程未启动"
        fut = asyncio.run_coroutine_threadsafe(factory(), self._loop)
        return fut.result(timeout or self.timeout_s + 15)

    # ---- 协议 ----

    async def _recv(self, timeout: float | None = None):
        return await asyncio.wait_for(self._ws.recv(),
                                      timeout=timeout or self.timeout_s)

    async def _ensure_session(self):
        """连接 + session.update(voice)。

        实测（2026-09-15）：服务端拒绝对已开始的会话二次 update
        （"session already started"），音色切换 = 废弃会话重连。
        """
        import websockets
        if self._sess_voice != self.voice and self._ws is not None:
            await self._close_ws()
        if self._ws is None:
            self._ws = await websockets.connect(
                BAILIAN_RT.format(model=self.model),
                additional_headers={"Authorization": f"Bearer {self.key}"},
                open_timeout=10)
            while True:
                m = json.loads(await self._recv(15))
                if m.get("type") == "session.created":
                    break
                if m.get("type") == "error":
                    raise RuntimeError(str(m.get("error"))[:180])
            await self._ws.send(json.dumps({"type": "session.update", "session": {
                "mode": "commit", "voice": self.voice, "language_type": "Auto",
                "response_format": "pcm", "sample_rate": self.rate}}))
            while True:
                m = json.loads(await self._recv(15))
                if m.get("type") == "session.updated":
                    break
                if m.get("type") == "error":
                    raise RuntimeError(str(m.get("error"))[:180])
            self._sess_voice = self.voice

    async def _synth(self, text: str, on_chunk):
        # 等待上一次打断的排空完成（会话干净才能复用）
        if self._drain is not None:
            try:
                await asyncio.wait_for(self._drain, 12)
            except Exception:  # noqa: BLE001
                pass
            self._drain = None
        for attempt in (0, 1):
            try:
                await self._ensure_session()
                return await self._append_commit(text, on_chunk)
            except _Aborted:
                # 打断：response.cancel 裸协议不被支持（2026-09-15 实测），
                # 硬关连接会让服务端会话滞留（恢复 ~20s）。改为后台排空
                # 剩余响应（丢弃音频），响应完成即会话可复用。
                self._drain = asyncio.ensure_future(self._drain_response())
                raise
            except Exception as e:              # noqa: BLE001
                await self._close_ws()
                if attempt:
                    raise
                log.warning("realtime 合成失败重试一次: %s", e)

    async def _drain_response(self):
        """丢弃当前响应剩余事件直到 done/finished（上限 12s，超时弃会话）。"""
        t0 = time.time()
        dropped = 0
        try:
            while True:
                raw = await asyncio.wait_for(self._ws.recv(), 5)
                m = json.loads(raw)
                ev = m.get("type")
                if ev == "response.audio.delta":
                    dropped += len(m.get("delta", ""))
                elif ev in ("response.done", "session.finished", "error"):
                    break
                if time.time() - t0 > 12:
                    raise TimeoutError("drain 超时")
        except Exception as e:  # noqa: BLE001
            log.info("drain 中断（弃会话重连）: %s", e)
            await self._close_ws()
            return
        log.info("drain 完成 %.1fs 丢弃 %dB", time.time() - t0, dropped * 3 // 4)

    async def _append_commit(self, text: str, on_chunk):
        """一批 = append 全文 + commit；返回 (总字节, 完整 PCM)。"""
        t0 = time.time()
        first = None
        parts: list[bytes] = []
        await self._ws.send(json.dumps({"type": "input_text_buffer.append",
                                        "text": text}))
        await self._ws.send(json.dumps({"type": "input_text_buffer.commit"}))
        while True:
            m = json.loads(await self._recv())
            ev = m.get("type")
            if ev == "response.audio.delta":
                b = base64.b64decode(m.get("delta", ""))
                if b:
                    if first is None:
                        first = time.time() - t0
                    parts.append(b)
                    if on_chunk is not None:
                        try:
                            on_chunk(b)
                        except Exception:  # noqa: BLE001
                            raise _Aborted() from None
            elif ev == "error":
                raise RuntimeError(str(m.get("error"))[:180])
            elif ev in ("response.done", "session.finished"):
                break
        audio = b"".join(parts)
        if first is not None:
            log.info("rt-chunks first=%.2fs total=%.1fs audio=%.2fs",
                     first, time.time() - t0, len(audio) / 2 / self.rate)
        return len(audio), audio
