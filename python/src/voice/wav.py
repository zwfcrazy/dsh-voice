"""WAV 容器小工具（零依赖）：PCM s16le ↔ WAV。"""
from __future__ import annotations

import struct


def pcm_to_wav(pcm: bytes, rate: int, channels: int) -> bytes:
    bits = 16
    block = channels * bits // 8
    hdr = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVE"
    hdr += b"fmt " + struct.pack("<IHHIIHH", 16, 1, channels, rate,
                                rate * block, block, bits)
    hdr += b"data" + struct.pack("<I", len(pcm))
    return hdr + pcm


def sniff_mime(data: bytes) -> str:
    if data[:4] == b"RIFF":
        return "audio/wav"
    if data[:3] == b"ID3" or (len(data) > 2 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0):
        return "audio/mpeg"
    return "application/octet-stream"
