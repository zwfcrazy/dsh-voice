"""取证环形缓冲：最近 N 秒 PCM（16k/mono/s16le）。

Phase 3 唤醒词取证 / 调试回放用；单 asyncio 循环内使用，无需锁。
"""
from __future__ import annotations


class RingBuffer:
    def __init__(self, seconds: float, rate: int = 16000, channels: int = 1):
        self.rate = rate
        self.channels = channels
        self.cap = int(seconds * rate * channels * 2)
        self.buf = bytearray()

    def push(self, data: bytes) -> None:
        self.buf += data
        if len(self.buf) > self.cap:
            del self.buf[: len(self.buf) - self.cap]

    def last(self, seconds: float) -> bytes:
        n = min(int(seconds * self.rate * self.channels * 2), len(self.buf))
        return bytes(self.buf[-n:])

    @property
    def buffered_seconds(self) -> float:
        return len(self.buf) / (self.rate * self.channels * 2)
