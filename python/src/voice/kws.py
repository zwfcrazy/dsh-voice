"""唤醒词检测层：sherpa-onnx KWS（P3-1 已确认）+ VAD 门控 + refractory。

设计（P3 确认门 2026-09-06）：
- 免训练关键词文件（拼音一行一词）
- VAD 门控：音频帧**始终** accept 进流（保持 zipformer 流连续性），
  但只在 speech-active + hangover 窗口内解码（省 CPU + 缩小误报面）
- refractory：命中后 N ms 内不再触发（防一句话双触发）
"""
from __future__ import annotations

import logging
import time
from pathlib import Path

import numpy as np
import sherpa_onnx

from .config import REPO_ROOT

log = logging.getLogger("voice.kws")


class KwsEngine:
    def __init__(self, cfg: dict):
        w = cfg["wake"]
        self.enabled = bool(w.get("enabled", True))
        self.threshold = float(w.get("threshold", 0.25))
        self.refractory_s = w.get("refractory_ms", 3000) / 1000.0
        self.vad_gated = bool(w.get("vad_gated", True))
        self.hangover_s = w.get("hangover_ms", 1000) / 1000.0
        self.keyword = w.get("keyword", "你好丁满")
        self.idle_reset_s = float(w.get("idle_reset_s", 5.0))
        self._last_reset = 0.0

        mdir = Path(w.get("model_dir", "models/sherpa-kws-wenetspeech"))
        if not mdir.is_absolute():
            mdir = REPO_ROOT / mdir
        self.model_dir = mdir
        self.keywords_file = mdir / w.get("keywords_file", "keywords-dingman.txt")
        self.hits = 0
        self._last_speech = 0.0
        self._refractory_until = 0.0
        self._stream = None
        self._preroll = __import__("collections").deque(maxlen=6)  # 480ms 预卷
        self._gate_was_open = False

        if not self.enabled:
            log.info("KWS disabled (config)")
            return
        t0 = time.monotonic()
        enc = mdir / "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"
        dec = mdir / "decoder-epoch-12-avg-2-chunk-16-left-64.onnx"
        joi = mdir / "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"
        for f in (enc, dec, joi, mdir / "tokens.txt", self.keywords_file):
            if not f.is_file():
                raise FileNotFoundError(f"KWS 模型/文件缺失: {f}")
        self.kws = sherpa_onnx.KeywordSpotter(
            tokens=str(mdir / "tokens.txt"),
            encoder=str(enc), decoder=str(dec), joiner=str(joi),
            keywords_file=str(self.keywords_file),
            num_threads=int(w.get("threads", 1)),
            keywords_threshold=self.threshold,
            keywords_score=float(w.get("keywords_score", 4.0)),
        )
        self._stream = self.kws.create_stream()
        log.info("KWS loaded (%.0f ms): %s threshold=%.2f vad_gated=%s",
                 (time.monotonic() - t0) * 1000, self.keyword,
                 self.threshold, self.vad_gated)

    # ---------- 外部状态注入 ----------

    def note_speech(self, speech: bool) -> None:
        """daemon 在 VAD 出帧后调用；speech=True 刷新挂起窗口。"""
        if speech:
            self._last_speech = time.time()

    # ---------- 主入口 ----------

    def feed(self, frame: bytes) -> str | None:
        """喂 80ms 帧（s16le/16k/mono）；命中返回关键词字符串。

        2026-09-13 积压修复（探针实锤：gate 开瞬间积压解码 135 块冻结
        事件循环 5.7s → 唤醒帧未被处理 + WS 握手超时）：
        - 门关期间帧**不再入流**，只保留最近 PREROLL 帧的滚动缓冲；
        - 门开瞬间 reset_stream + 回放预卷 → 解码积压上限 = 预卷时长。
        """
        if not self.enabled or self._stream is None:
            return None
        now = time.time()
        gate_open = (not self.vad_gated) or (now - self._last_speech <= self.hangover_s)

        if not gate_open:
            self._preroll.append(frame)
            # 长静默防流退化（保留原语义；流此时无积压，代价为零）
            if now - self._last_speech > self.idle_reset_s \
                    and now - self._last_reset > self.idle_reset_s:
                self.reset()
            self._gate_was_open = False
            return None

        if not self._gate_was_open:
            # 门刚开：丢弃积压噪声，从干净流+预卷起判
            self.kws.reset_stream(self._stream)
            for f in self._preroll:
                x = np.frombuffer(f, dtype=np.int16).astype(np.float32) / 32768.0
                self._stream.accept_waveform(16000, x)
            self._preroll.clear()
        self._gate_was_open = True

        x = np.frombuffer(frame, dtype=np.int16).astype(np.float32) / 32768.0
        self._stream.accept_waveform(16000, x)

        if now < self._refractory_until:
            return None
        _t0 = time.monotonic()
        _n = 0
        while self.kws.is_ready(self._stream):
            self.kws.decode_stream(self._stream)
            _n += 1
        _ms = (time.monotonic() - _t0) * 1000
        if _ms > 300 or _n > 12:
            log.warning("kws 解码异常耗时 %d 块 %.0fms（应有界）", _n, _ms)
        res = self.kws.get_result(self._stream)
        if res:
            self.kws.reset_stream(self._stream)
            self._refractory_until = now + self.refractory_s
            self.hits += 1
            return res
        return None

    def reset(self) -> None:
        """重置解码流（daemon 在 vad/end 调用）。

        同一 utterance 内"其他内容+唤醒词"会让关键词前缀在搜索束中被
        剪掉（Phase 3 实测：score=1.0 时 2/3 漏检）。段边界重置让每句
        从干净状态起判，等价孤立词检测（5/5 场景）。
        """
        if not self.enabled or self._stream is None:
            return
        self.kws.reset_stream(self._stream)
        self._last_reset = time.time()

    @property
    def armed(self) -> bool:
        """当前是否处于解码激活窗口（诊断用）。"""
        if not self.enabled:
            return False
        return (not self.vad_gated) or (time.time() - self._last_speech <= self.hangover_s)
