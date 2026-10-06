"""VAD 层：silero v6 ONNX 直调（P2-1 已确认）+ 段状态机。

关键点（实测依据见 docs/research/phase-2-音频管道.md §3）：
- silero pip 包 import 链硬依赖 torch，因此绕开 wrapper，直调 onnxruntime
- 模型 IO：input [b, seq]（前置 64 样本上下文），state [2,b,128]，sr 标量
- 512 样本窗 @16k = 32ms；对外 80ms 总线帧由内部缓冲重分帧
- 单帧(80ms) p50 4.1ms / p95 4.2ms（Pi 4 实测），远低于 15% 预算
"""
from __future__ import annotations

import logging
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort

from .config import REPO_ROOT

log = logging.getLogger("voice.vad")

MODEL_PATHS = [
    REPO_ROOT / "models" / "silero-vad-v6.onnx",
    # 兜底：venv 内 pip 包自带（开发机方便）
    REPO_ROOT / ".venv/lib/python3.11/site-packages/silero_vad/data/silero_vad.onnx",
]

WIN = 512          # silero 16k 窗口样本数
CTX = 64           # 跨窗上下文样本数


class SileroVad:
    """feed(pcm_bytes) -> (speech_bool, prob_float)；内部 512 样本重分帧。"""

    def __init__(self, model_path: str | Path | None = None):
        path = Path(model_path) if model_path else next(
            (p for p in MODEL_PATHS if p.exists()), None)
        if path is None:
            raise FileNotFoundError(
                f"silero 模型未找到，尝试过: {[str(p) for p in MODEL_PATHS]}")
        t0 = time.monotonic()
        so = ort.SessionOptions()
        # Pi 4 实测：默认线程池 4 线空转（270% CPU）；VAD 模型小，
        # 单线程顺序执行足够（推理 ~4ms/80ms 帧）
        so.intra_op_num_threads = 1
        so.inter_op_num_threads = 1
        so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        self.sess = ort.InferenceSession(
            str(path), so, providers=["CPUExecutionProvider"])
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.ctx = np.zeros(CTX, dtype=np.float32)
        self.buf = b""
        self.prob = 0.0
        self.load_ms = (time.monotonic() - t0) * 1000
        log.info("silero loaded %s (%.0f ms)", path.name, self.load_ms)

    def reset(self) -> None:
        self.state[:] = 0
        self.ctx[:] = 0
        self.buf = b""
        self.prob = 0.0

    def feed(self, pcm: bytes) -> tuple[bool, float]:
        self.buf += pcm
        while len(self.buf) >= WIN * 2:
            chunk = self.buf[: WIN * 2]
            self.buf = self.buf[WIN * 2:]
            x = np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768.0
            x = np.concatenate([self.ctx, x])[None, :]
            prob, self.state = self.sess.run(
                ["output", "stateN"],
                {"input": x, "state": self.state,
                 "sr": np.array(16000, dtype=np.int64)})
            self.ctx = x[0, -CTX:]
            self.prob = float(prob.item())
        return self.prob > 0.5, self.prob


class Segmenter:
    """段状态机：min_speech 成段、min_silence 断段、pre_roll 预留。

    回调（同步，由 daemon 注入）：
      on_start(t_mono, ts_wall)             —— vad/start
      on_end(t_mono, ts_wall, dur_ms, pcm)  —— vad/end，pcm 含 pre_roll
    """

    def __init__(self, threshold: float, min_speech_ms: int, min_silence_ms: int,
                 pre_roll_ms: int, frame_ms: int):
        self.threshold = threshold
        self.frame_ms = frame_ms
        self.min_speech_fr = max(1, round(min_speech_ms / frame_ms))
        self.min_silence_fr = max(1, round(min_silence_ms / frame_ms))
        self.b_per_ms = 32  # 16k samples/s * 2 B * 1ch / 1000
        self.pre_roll_bytes = pre_roll_ms * self.b_per_ms
        self.on_start = None
        self.on_end = None
        self.reset()

    def reset(self) -> None:
        self.active = False
        self._speech_run = 0
        self._sil_run = 0
        self._pending: list[bytes] = []
        self._seg: list[bytes] = []
        self._seg_bytes = 0
        self._t_start = 0.0
        self._pre: bytearray = b""

    def feed(self, speech: bool, frame: bytes, t_mono: float, ts_wall: float) -> None:
        if not self.active:
            if speech:
                # 2026-09-19 修复：语音凑帧期间 _pre 冻结——语音帧只进 _pending。
                # 旧版每帧先无条件并入 _pre，成段时 [_pre,*_pending] 会把起头
                # ~min_speech_ms 的语音拼两遍（ASR 转写"丁满丁满"式叠字根因，
                # 合成音频帧幅度序列 [2,3,3,2,3,4...] 复现）。
                self._speech_run += 1
                self._pending.append(frame)
                if self._speech_run >= self.min_speech_fr:
                    self.active = True
                    self._seg = [self._pre, *self._pending]
                    self._seg_bytes = sum(len(x) for x in self._seg)
                    self._t_start = t_mono - (
                        len(self._pre) + sum(len(x) for x in self._pending[:-1])
                    ) / self.b_per_ms
                    self._sil_run = 0
                    if self.on_start:
                        self.on_start(self._t_start, ts_wall)
            else:
                # 静音帧滚动进 _pre（含假起头音频，真语音 200ms 内跟上仍可被
                # pre-roll 保住），并复位凑帧计数。
                self._pre = (self._pre + b"".join(self._pending) + frame)[
                    -self.pre_roll_bytes:]
                self._speech_run = 0
                self._pending.clear()
        else:
            self._seg.append(frame)
            self._seg_bytes += len(frame)
            if speech:
                self._sil_run = 0
            else:
                self._sil_run += 1
                if self._sil_run >= self.min_silence_fr:
                    pcm = b"".join(self._seg)
                    dur_ms = len(pcm) / self.b_per_ms
                    self.active = False
                    self._speech_run = 0
                    self._sil_run = 0
                    self._pending.clear()
                    self._pre = b""
                    if self.on_end:
                        self.on_end(self._t_start, ts_wall, dur_ms, pcm)
                    self._seg = []
                    self._seg_bytes = 0

    @property
    def speech_active(self) -> bool:
        return self.active
