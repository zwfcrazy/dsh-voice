"""DshAgent — Phase 7a 真后端：HTTP+SSE 桥接 DSH 插件（AgentBackend 协议）。

传输形态（docs/research/phase-7-dsh集成.md §2，2026-09-13 修订）：
动态插件 host 半区无出站 socket/WS 全局 → 插件在 DSH web 服务器（:3080）上
注册 /voice-bridge 路由，**engine 主动连 DSH**：

    GET  /voice-bridge/stream   SSE 长连（下行）：bridge/ready, agent/chunk,
                                agent/turn-end, agent/error（插件→引擎推送）
    POST /voice-bridge/event    上行短请求：agent/request, agent/cancel

    reply(text) → POST agent/request
        → 插件 followup → session 事件 assistant/chunk(text-delta)
        → SSE agent/chunk → yield text（loop/speaker 原路径分句播报）
        → turn/end → SSE agent/turn-end → 迭代器收尾
        → 失败    → SSE agent/error → raise（loop 播话术）
    打断/超时（CancelledError）→ POST agent/cancel → 插件 agent.cancel('user')

SSE 断连（DSH 不在/重启）→ ready=False → reply() 抛 AgentOfflineError，
loop 播"大脑离线"话术（判据 7）。重连自动退避，恢复后 ready=True。
hub 广播 agent/* 镜像事件仅用于本机 CLI/日志观测。
"""
from __future__ import annotations

import asyncio
import json
import logging

import aiohttp

log = logging.getLogger("voice.dsh_agent")

PHRASE_OFFLINE = "大脑离线了，请稍后再试。"
PHRASE_BRIDGE_LOST = "大脑连接断了，请稍后再试。"
PHRASE_AGENT_ERR = "我遇到了问题，请稍后再试。"


class AgentError(Exception):
    """agent 轮失败（phrase 供 loop 播报）。"""

    def __init__(self, message: str, phrase: str = PHRASE_AGENT_ERR):
        super().__init__(message)
        self.phrase = phrase


class DshAgent:
    """实现 echo_agent.AgentBackend 协议；daemon 经 loop.agent=dsh 选择。"""

    name = "dsh"

    def __init__(self, cfg: dict, hub=None):
        self.hub = hub
        ac = cfg.get("agent") or {}
        self.url = str(ac.get("url", "http://127.0.0.1:3080/voice-bridge")).rstrip("/")
        self.session_id = str(ac.get("session_id", "jarvis-voice"))
        self.ready = False
        self._turn = 0
        self._pending: dict[int, asyncio.Queue] = {}
        self._http: aiohttp.ClientSession | None = None
        self._sse_task: asyncio.Task | None = None
        self._stopping = False
        self._started = False
        log.info("dsh-agent ready: url=%s session=%s", self.url, self.session_id)

    def _ensure_started(self) -> None:
        """懒启动（daemon 构造于事件循环外，首个 reply 在循环内触发本方法）。"""
        if self._started:
            return
        self._started = True
        self._http = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=None, sock_connect=5))
        self._sse_task = asyncio.ensure_future(self._run_sse())

    # ---------- SSE 下行（插件→引擎推送） ----------

    async def _run_sse(self) -> None:
        """SSE 常连循环：断开退避重连；行解析后交给 _on_down。"""
        backoff = 1.0
        while not self._stopping:
            try:
                async with self._http.get(
                        f"{self.url}/stream",
                        headers={"Accept": "text/event-stream"}) as resp:
                    if resp.status != 200:
                        raise RuntimeError(f"sse http {resp.status}")
                    if self.ready:
                        log.info("bridge SSE 重连成功")
                    backoff = 1.0
                    await self._read_sse(resp)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                if self.ready:
                    log.warning("bridge SSE 断开: %s", e)
                self._fail_all(PHRASE_BRIDGE_LOST)
            if self._stopping:
                return
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 15)

    async def _read_sse(self, resp) -> None:
        """逐行解析 SSE；data: 行 JSON → _on_down。连接建立即视为 bridge ready。"""
        self.ready = True
        buf = ""
        async for raw in resp.content:
            buf += raw.decode("utf-8", "replace")
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                line = line.rstrip("\r")
                if line.startswith("data:"):
                    payload = line[5:].strip()
                    try:
                        msg = json.loads(payload) if payload else None
                    except ValueError:
                        continue
                    if isinstance(msg, dict):
                        self._on_down(msg)
                # 注释行（: ping）与空行忽略

    def _on_down(self, msg: dict) -> None:
        t = msg.get("type")
        if t == "bridge/ready":
            log.info("bridge 就绪（session=%s）", msg.get("session"))
            return
        turn = msg.get("turn")
        q = self._pending.get(turn) if turn is not None else None
        if t == "agent/chunk":
            if q is not None and msg.get("text"):
                log.info("bridge chunk turn=%s len=%d %r", turn,
                         len(str(msg["text"])), str(msg["text"])[:24])
                q.put_nowait(("chunk", str(msg["text"])))
        elif t == "agent/turn-end":
            if q is not None:
                log.info("bridge turn-end turn=%s reason=%s", turn,
                         msg.get("reason", "completed"))
                q.put_nowait(("end", msg.get("reason", "completed")))
        elif t == "agent/error":
            if q is not None:
                q.put_nowait(("error", str(msg.get("message") or "agent-error")))
        elif t == "agent/tool":
            # P7c 工具过渡语：桥转发的 tool/call（每轮首个慢工具触发一次播报）
            if q is not None:
                q.put_nowait(("tool", str(msg.get("name") or "")))
        else:
            log.debug("bridge 下行忽略: %s", t)

    def _fail_all(self, phrase: str) -> None:
        self.ready = False
        for q in self._pending.values():
            q.put_nowait(("bridge-lost", phrase))
        self._pending.clear()

    # ---------- 上行（引擎→插件短请求） ----------

    async def _post(self, msg: dict) -> dict | None:
        if self._http is None:
            raise AgentError("dsh-bridge http not started", PHRASE_OFFLINE)
        try:
            async with self._http.post(
                    f"{self.url}/event", json=msg,
                    timeout=aiohttp.ClientTimeout(total=10)) as resp:
                body = await resp.json(content_type=None)
                if resp.status != 200 or not (
                        isinstance(body, dict) and body.get("ok")):
                    detail = body.get("error") if isinstance(body, dict) else body
                    raise AgentError(
                        f"bridge rejected: {resp.status} {detail}",
                        PHRASE_AGENT_ERR)
                return body
        except AgentError:
            raise
        except Exception as e:  # noqa: BLE001
            raise AgentError(f"bridge post failed: {e}", PHRASE_OFFLINE) from e

    async def _mirror(self, msg: dict) -> None:
        """engine 本机事件镜像（CLI/日志观测用，失败无碍）。"""
        if self.hub is not None:
            try:
                await self.hub.broadcast(msg)
            except Exception:  # noqa: BLE001
                pass

    # ---------- AgentBackend 协议 ----------

    async def reply(self, text: str, on_tool=None):
        self._ensure_started()
        if not self.ready:
            # 首轮给 SSE 一点连接时间（DSH 在而插件未挂：404 循环，超时即离线）
            for _ in range(30):
                if self.ready or self._stopping:
                    break
                await asyncio.sleep(0.1)
        if not self.ready:
            raise AgentError("dsh-bridge offline", PHRASE_OFFLINE)
        self._turn += 1
        turn = self._turn
        q: asyncio.Queue = asyncio.Queue()
        self._pending[turn] = q
        try:
            await self._post({"type": "agent/request", "text": text,
                              "turn": turn, "session": self.session_id})
            await self._mirror({"type": "agent/request", "text": text,
                                "turn": turn, "session": self.session_id})
            while True:
                kind, payload = await q.get()
                if kind == "chunk":
                    yield payload
                elif kind == "end":
                    await self._mirror({"type": "agent/turn-end",
                                        "turn": turn, "outcome": payload})
                    return
                elif kind == "error":
                    raise AgentError(f"dsh agent: {payload}", PHRASE_AGENT_ERR)
                elif kind == "tool":
                    if on_tool is not None:
                        try:
                            on_tool(payload)
                        except Exception:  # noqa: BLE001
                            pass
                else:  # bridge-lost（payload=话术）
                    raise AgentError("dsh-bridge lost", payload)
        except asyncio.CancelledError:
            try:
                await self._post({"type": "agent/cancel", "turn": turn})
                await self._mirror({"type": "agent/cancel", "turn": turn})
            except Exception:  # noqa: BLE001
                pass
            raise
        finally:
            self._pending.pop(turn, None)

    async def close(self) -> None:
        """daemon 退出时清理（幂等）。"""
        self._stopping = True
        if self._sse_task is not None:
            self._sse_task.cancel()
            try:
                await self._sse_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        if self._http is not None:
            await self._http.close()
