"""EchoAgent — Phase 6 假后端（回显），Phase 7 的 DSH bridge 实现同一协议替换之。

AgentBackend 协议（loop 消费）：
    async def reply(self, text: str, on_tool=None) -> AsyncIterator[str]
        - yield 回复增量（chunk），loop 逐块喂 Speaker.stream_feed（流式播放）
        - 思考延迟在首个 chunk 前模拟（0.5–3s 随机，可配）
        - 撤销语义：loop 取消 task（asyncio.CancelledError）即放弃本轮

EchoAgent 行为：延迟 → "你说的是：{text}" 按 2–4 字切片流出，
间隔 50–200ms 模拟真实 agent 的 token 生成节奏（单句需凑齐句末标点
才入队合成，节奏与 Phase 7 流式一致）。
"""
from __future__ import annotations

import asyncio
import random
from typing import AsyncIterator, Protocol


class AgentBackend(Protocol):
    """Phase 7 bridge 实现此协议即可无缝替换 EchoAgent。"""

    def reply(self, text: str, on_tool=None) -> AsyncIterator[str]: ...


class EchoAgent:
    name = "echo"

    def __init__(self, cfg: dict | None = None):
        lc = (cfg or {}).get("loop") or {}
        self.min_delay_s = float(lc.get("echo_min_delay_s", 0.5))
        self.max_delay_s = float(lc.get("echo_max_delay_s", 3.0))

    async def reply(self, text: str, on_tool=None) -> AsyncIterator[str]:
        await asyncio.sleep(random.uniform(self.min_delay_s, self.max_delay_s))
        out = f"你说的是：{text}"
        step = random.randint(2, 4)
        for i in range(0, len(out), step):
            yield out[i:i + step]
            await asyncio.sleep(random.uniform(0.05, 0.2))
