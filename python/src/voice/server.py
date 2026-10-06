"""WebSocket 事件总线（P2-3 已确认 websockets）。

- 仅监听 127.0.0.1（config server.listen）
- 事件广播：level / vad/start / vad/end / state / source/changed
- RPC（客户端 -> {"id","method","params"}）：ping / get_state / get_buffer
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import time

import websockets

log = logging.getLogger("voice.server")


class Hub:
    def __init__(self):
        self.clients: set = set()
        self.rpc: dict[str, object] = {}
        self.state_fn = None  # () -> dict，连接时发送快照
        self.tap = None       # Phase 6：进程内事件监听（VoiceLoop），broadcast 同步回调
        self.stats = {"events": 0, "rpc": 0}

    def register_rpc(self, method: str, fn) -> None:
        self.rpc[method] = fn

    async def broadcast(self, event: dict) -> None:
        self.stats["events"] += 1
        # tap 在 early-return 之前：无 WS 客户端时状态机也必须收到事件
        if self.tap is not None:
            try:
                self.tap(dict(event))
            except Exception as e:  # noqa: BLE001
                log.warning("tap handler failed: %s", e)
        if not self.clients:
            return
        msg = json.dumps(event, separators=(",", ":"), ensure_ascii=False)
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send(msg)
            except Exception:  # noqa: BLE001
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    def _handle_sync(self, request: dict) -> dict:
        method = request.get("method")
        params = request.get("params") or {}
        fn = self.rpc.get(method)
        if fn is None:
            return {"id": request.get("id"), "error": f"unknown-method:{method}"}
        try:
            res = fn(**params) if isinstance(params, dict) else fn(params)
            return {"id": request.get("id"), "result": res}
        except Exception as e:  # noqa: BLE001
            log.warning("rpc %s failed: %s", method, e)
            return {"id": request.get("id"), "error": f"{type(e).__name__}:{e}"}

    async def _handler(self, ws) -> None:
        peer = ws.remote_address
        self.clients.add(ws)
        log.debug("client connected %s total=%d", peer, len(self.clients))
        try:
            if self.state_fn:
                await ws.send(json.dumps(
                    {"type": "state", **self.state_fn()},
                    separators=(",", ":"), ensure_ascii=False))
            async for raw in ws:
                try:
                    req = json.loads(raw)
                except (TypeError, ValueError):
                    await ws.send(json.dumps({"error": "bad-json"}))
                    continue
                self.stats["rpc"] += 1
                resp = await asyncio.get_event_loop().run_in_executor(
                    None, self._handle_sync, req)
                await ws.send(json.dumps(resp, separators=(",", ":")))
        except Exception as e:  # noqa: BLE001
            log.debug("client %s dropped: %s", peer, e)
        finally:
            self.clients.discard(ws)
            log.debug("client disconnected %s total=%d", peer, len(self.clients))


async def serve(hub: Hub, listen: str, started_future: asyncio.Future | None = None):
    host, _, port = listen.partition(":")
    async with websockets.serve(hub._handler, host, int(port), max_queue=32):
        log.info("ws listening on %s", listen)
        if started_future and not started_future.done():
            started_future.set_result(True)
        await asyncio.Future()  # run until cancelled
