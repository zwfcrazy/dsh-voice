"""ASR Provider（2026-09-19 起双线，docs/research/asr-upgrade-2026-09-16.md）。

- bailian：qwen3-asr-flash，OpenAI 兼容 chat/completions + input_audio
  （P4 定型路径；asr_options.context 实测零效果，保留为回退）。
- bailian-mm：fun-asr-flash / qwen-audio-3.0-asr-flash，原生同步
  multimodal-generation 端点；上下文增强 input_text 实测有效
  （丁满/贾维斯/专名全对，A/B 宽松 CER 3.91%/4.30% vs qwen3 4.13%）。
"""
from __future__ import annotations

import base64
import json
import threading
import time
import urllib.error
import urllib.request
from collections import deque

from .secrets import get_key
from .wav import pcm_to_wav

BAILIAN_ASR = ("https://dashscope.aliyuncs.com/compatible-mode/"
               "v1/chat/completions")
BAILIAN_MM = ("https://dashscope.aliyuncs.com/api/v1/services/aigc/"
              "multimodal-generation/generation")

_NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def build_asr(cfg: dict):
    """按配置构造 provider；未启用返回 None，缺 Key 抛 RuntimeError。"""
    a = cfg.get("asr") or {}
    if not a.get("enabled", False):
        return None
    provider = a.get("provider", "bailian")
    if provider == "bailian":
        return BailianAsr(a)
    if provider == "bailian-mm":
        return BailianMmAsr(a)
    raise RuntimeError(f"未知 asr provider: {provider}（bailian/bailian-mm）")


class BailianAsr:
    name = "bailian"

    def __init__(self, cfg: dict):
        self.model = cfg.get("model", "qwen3-asr-flash")
        self.timeout_s = float(cfg.get("timeout_s", 15))
        self.context = (cfg.get("context") or "").strip() or None
        self.key_env = cfg.get("key_env", "DASHSCOPE_API_KEY")
        self.key = get_key(self.key_env)
        if not self.key:
            raise RuntimeError(
                f"缺 {self.key_env}（写入 ~/.config/voice/secrets.env）")
        self._opener = _NO_PROXY

    @property
    def provider(self) -> str:
        return f"bailian/{self.model}"

    def transcribe(self, pcm16k: bytes) -> dict:
        """输入 16kHz/mono/s16le PCM 段 → {text, latency_ms, provider}。"""
        return self._post(base64.b64encode(pcm_to_wav(pcm16k, 16000, 1)).decode())

    def transcribe_wav(self, wav_bytes: bytes) -> dict:
        """输入完整 WAV 文件字节（云端自行解析容器）。"""
        return self._post(base64.b64encode(wav_bytes).decode())

    def _post(self, audio_b64: str) -> dict:
        """qwen3-asr 注意（2026-02-11 实测）：messages 里加 text 段或 system
        message 都会 400（"dedicated task asr does not support this input"）；
        热词上下文的正确位置是请求顶层 `asr_options.context`。"""
        body = {
            "model": self.model,
            "messages": [{"role": "user", "content": [
                {"type": "input_audio",
                 "input_audio": {"data": f"data:audio/wav;base64,{audio_b64}",
                                 "format": "wav"}}]}],
        }
        if self.context:
            body["asr_options"] = {"context": self.context}
        req = urllib.request.Request(
            BAILIAN_ASR, data=json.dumps(body).encode(), headers={
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
        })
        t0 = time.time()
        with self._opener.open(req, timeout=self.timeout_s) as resp:
            data = json.loads(resp.read())
        text = (((data.get("choices") or [{}])[0].get("message") or {})
                .get("content") or "")
        if isinstance(text, list):
            text = "".join(str(x.get("text", "")) if isinstance(x, dict)
                           else str(x) for x in text)
        return {"text": text.strip(),
                "latency_ms": round((time.time() - t0) * 1000),
                "provider": self.provider}


class BailianMmAsr:
    """原生 multimodal 同步端点（fun-asr-flash / qwen-audio-3.0-asr-flash）。

    - 上下文增强：input_text 消息置于音频前（官方机制，实测有效；
      长度实测 5000 字符内延迟无可测影响）。
    - 对话历史滑窗：loop 在每轮结束调 note_user/note_reply，本类合成
      "静态热词 + 最近 N 轮" 上下文，字符封顶。
    - 网络抖动重试：DNS 瞬断（Errno -3）重试一次；HTTP 错误不重试。
      尾延迟（~10% 概率 5-6s 双峰）由 daemon 层 _asr_hedged 对冲兜底。
    """

    name = "bailian-mm"
    HISTORY_TURNS = 2
    HISTORY_MAX_CHARS = 1200

    def __init__(self, cfg: dict):
        self.model = cfg.get("model", "fun-asr-flash-2026-06-15")
        self.timeout_s = float(cfg.get("timeout_s", 15))
        self.static_ctx = (cfg.get("context") or "").strip() or None
        self.key_env = cfg.get("key_env", "DASHSCOPE_API_KEY")
        self.key = get_key(self.key_env)
        if not self.key:
            raise RuntimeError(
                f"缺 {self.key_env}（写入 ~/.config/voice/secrets.env）")
        self._opener = _NO_PROXY
        self._lock = threading.Lock()
        self._history: deque = deque(maxlen=self.HISTORY_TURNS)

    @property
    def provider(self) -> str:
        return f"bailian-mm/{self.model}"

    # ---- 对话历史（loop 事件驱动；线程安全：note_* 在事件循环，
    #      transcribe 在执行器线程）----

    def note_user(self, text: str) -> None:
        """一轮开始：记录用户话术（即使 agent 失败，用户侧上下文也在）。"""
        with self._lock:
            self._history.append((text.strip()[:200], ""))

    def note_reply(self, text: str) -> None:
        """一轮结束：补记回复（与最近一条 user 拼对）。"""
        with self._lock:
            if self._history:
                u, _ = self._history[-1]
                self._history[-1] = (u, text.strip()[:400])

    def _compose_context(self) -> str | None:
        with self._lock:
            hist = list(self._history)
        parts = []
        if self.static_ctx:
            parts.append(self.static_ctx)
        if hist:
            dialog = "。".join(
                f"用户说：{u}" + (f"；助手答：{r[:400]}" if r else "")
                for u, r in hist if u)
            parts.append("最近对话：" + dialog)
        return "\n".join(parts)[-self.HISTORY_MAX_CHARS:] or None

    # ---- 转写 ----

    def transcribe(self, pcm16k: bytes) -> dict:
        return self._post(base64.b64encode(
            pcm_to_wav(pcm16k, 16000, 1)).decode())

    def transcribe_wav(self, wav_bytes: bytes) -> dict:
        return self._post(base64.b64encode(wav_bytes).decode())

    def _post(self, audio_b64: str) -> dict:
        content = []
        ctx = self._compose_context()
        if ctx:
            content.append({"type": "input_text", "text": ctx})
        content.append({"type": "input_audio",
                        "input_audio": {"data": f"data:audio/wav;base64,{audio_b64}"}})
        body = {"model": self.model,
                "input": {"messages": [{"role": "user", "content": content}]},
                "parameters": {"format": "wav", "sample_rate": "16000"}}
        req = urllib.request.Request(
            BAILIAN_MM, data=json.dumps(body).encode(), headers={
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "X-DashScope-SSE": "disable"})
        t0 = time.time()
        last: Exception | None = None
        for attempt in range(3):
            try:
                with self._opener.open(req, timeout=self.timeout_s) as resp:
                    data = json.loads(resp.read())
                break
            except urllib.error.HTTPError:
                raise                     # 4xx/5xx 不重试（daemon 会记 asr/error）
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                last = e                  # DNS 瞬断/超时：退避后重试
                time.sleep(0.6 * (attempt + 1))
        else:
            raise last
        out = data.get("output") or {}
        text = out.get("text") or ((out.get("output") or {}).get("sentence")
                                   or {}).get("text") or ""
        return {"text": str(text).strip(),
                "latency_ms": round((time.time() - t0) * 1000),
                "provider": self.provider}


def transcribe_file(cfg: dict, wav_path) -> dict:
    """CLI 用：wav 文件（任意采样率，云端自己解析）→ 转写结果。"""
    import pathlib
    eng = build_asr(cfg)
    if eng is None:
        raise RuntimeError("asr.enabled=false")
    return eng.transcribe_wav(pathlib.Path(wav_path).read_bytes())
