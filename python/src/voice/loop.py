"""VoiceLoop — 语音对话状态机（Phase 6，P6-1/2/3 已确认）。

两层状态中的**对话层**：采集层 state（capturing/speaking/waiting_source，
daemon 维护）保持不变；本模块管理对话生命周期：

    idle → woken → listening → thinking → speaking → (followup) → listening …

转移由 Hub.tap 全量事件驱动（wake/vad/asr/tts），每状态配超时任务。
打断（P6-1）：speaking 期间 wake 命中 → speaker.stop() → woken。
hfp 播放模式下采集全程在线，KWS 播报期间可命中；a2dp 模式下仅在
麦克风恢复间隙后可达（行为退化但不错误）。

配置：config/voice.toml [loop]。
事件：loop/state {from,to,reason,turn} + turn/end {outcome, 各段耗时}
"""
from __future__ import annotations

import asyncio
import logging
import re
import time

log = logging.getLogger("voice.loop")

IDLE = "idle"
WOKEN = "woken"            # 唤醒确认后等首句（woken_timeout_s 静默回 idle）
LISTENING = "listening"    # 对话听取中（followup 窗口/最长 listening_max_s）
TRANSCRIBING = "transcribing"  # 段已结束、转写在飞（感知提前：说完即"识别中"）
THINKING = "thinking"      # agent 处理中（think_timeout_s）
SPEAKING = "speaking"      # TTS 播报中（tts/done 驱动收尾）

# 话术（合成走主链路；断网时 Speaker 兜底播 net-unavailable 预合成文件）
PHRASE_ASR_ERR = "语音识别暂时不可用，请稍后再试。"
PHRASE_AGENT_TIMEOUT = "我遇到了问题，请稍后再试。"
PHRASE_AGENT_ERR = "我遇到了问题，请稍后再试。"

# 唤醒词前缀剥离。2026-09-25 重构：此前是写死「你好丁满」的静态正则，面板换词后
# 失配——「嘿，丁满。」剥不掉被当指令发模型，且真指令段被"迟到丢弃"顶掉
# （症状：唤醒后立刻触发、模型收到唤醒词）。现改为按 cfg.wake.keyword 动态匹配：
#   - 逐字 pypinyin 无声调比对（同音容错：嘿/黑、丁/叮），字间允许标点/空白；
#   - 问候头（嘿/你好等）与核心名（去头后）均可单独成单元，允许 stutter/重复
#     最多 4 个单元（2026-09-11 实测 ASR 会"你好，你好丁满"式重复）；
#   - 单元后可带 吧/嘛 等语气词（旧 [吧嘛] 行为保留）；
#   - keyword 缺失或 pypinyin 不可用时退回下方静态正则（你好丁满 时代兜底）。
try:
    from pypinyin import Style, lazy_pinyin
except ImportError:                                    # pragma: no cover
    lazy_pinyin = None

_WAKE_PREFIX = re.compile(
    r"^\s*(?:(?:你{1,3}好[，,、.。\s]*){0,3})?丁满[吧嘛]?[。.!！？?\s,，]*")

_SEPS = "，,、.。！!？?·…\t "
_TAIL = "吧嘛呐呢啊"
_GREET_HEADS = "嘿哈嗨喂哦噢诶呃哎"


def _py(ch: str) -> str:
    r = lazy_pinyin(ch, style=Style.NORMAL, errors=lambda x: x)
    return r[0] if r else ch


def _match_unit(s: str, i: int, target_py: list) -> int | None:
    """从 s[i] 起匹配 target_py（逐字同音，字间跳过分隔符）；返回结束下标。"""
    k, j = 0, i
    while j < len(s):
        if s[j] in _SEPS:
            j += 1
            continue
        if k >= len(target_py):
            break
        if _py(s[j]) != target_py[k]:
            return None
        k += 1
        j += 1
    return j if k == len(target_py) else None


def strip_wake_prefix(text: str, keyword: str | None = None) -> str:
    """剥离句首唤醒词（动态 keyword + 同音容错 + stutter/重复问候）；
    剩余为空表示纯唤醒词段。"""
    kw = "".join(c for c in (keyword or "") if c not in _SEPS)
    if not kw or lazy_pinyin is None:
        return _WAKE_PREFIX.sub("", text, count=1).strip()

    if kw.startswith("你好") and len(kw) > 2:
        head, core = "你好", kw[2:]
    elif kw[0] in _GREET_HEADS and len(kw) > 1:
        head, core = kw[0], kw[1:]
    else:
        head, core = "", kw
    # 匹配单元：整词 / 核心名（followup 裸称呼"丁满，几点了"）/ 问候头（stutter 前缀）
    kw_py = [_py(c) for c in kw]
    units: list[tuple[list, bool]] = [(kw_py, True)]
    if core and core != kw:
        units.append(([_py(c) for c in core], True))
    if head:
        units.append(([_py(c) for c in head], False))

    # 句首叠音压缩（2026-09-11 实测 ASR 会出"你你你好，丁满。"）：首音节的
    # 同音相邻重复去掉一个（你你你好→你好；嘿，嘿丁满→嘿丁满），迭代到不重复。
    t = text
    while True:
        e1 = _match_unit(t, 0, [kw_py[0]])
        if e1 is None:
            break
        e2 = _match_unit(t, e1, [kw_py[0]])
        if e2 is None:
            break
        t = t[e1:]

    i, hit = 0, False
    for _ in range(4):                       # 前缀单元上限（重复问候/叠词）
        while i < len(t) and t[i] in _SEPS:
            i += 1
        if i >= len(t):
            break
        for unit_py, significant in units:
            if not significant and hit:
                continue       # 问候头只允许出现在整词之前（防"嘿丁满黑名单"吃掉黑）
            end = _match_unit(t, i, unit_py)
            if end is not None:
                if significant:
                    hit = True
                    while end < len(t) and t[end] in _TAIL:  # 语气词
                        end += 1
                i = end
                break
        else:
            break
    if not hit:
        return text.strip()
    while i < len(t) and (t[i] in _SEPS or t[i] in _TAIL):
        i += 1
    return t[i:].strip()


class VoiceLoop:
    """对话状态机。daemon 在 Hub.broadcast 上挂 tap → on_event（同步，事件循环内）。"""

    def __init__(self, cfg: dict, hub, speaker, agent, asr=None):
        self.hub = hub
        self.speaker = speaker
        self.agent = agent          # AgentBackend 协议（echo_agent / Phase 7 bridge）
        self.asr = asr              # 2026-09-19：可选，上下文增强历史钩子
                                    # （BailianMmAsr.note_user/note_reply）
        lc = cfg.get("loop") or {}
        self.woken_timeout_s = float(lc.get("woken_timeout_s", 8))
        self.listening_max_s = float(lc.get("listening_max_s", 30))
        self.think_timeout_s = float(lc.get("think_timeout_s", 60))
        self.followup_window_s = float(lc.get("followup_window_s", 8))
        # 工具过渡语（P7c：tool/call 时播预合成话术，替代纯垫乐的"无解释等待"；
        # 只对慢工具播（web_search 秒~十几秒），voice_volume 类本地快工具不播）
        self.tool_filler = bool(lc.get("tool_filler", True))
        self.tool_filler_tools = {str(x) for x in (lc.get("tool_filler_tools") or ["web_search"])}
        self._tool_filled = False          # 每轮只播一次
        # 唤醒词前缀剥离用（2026-09-25：动态跟随面板换词，见 strip_wake_prefix）
        self.wake_keyword = str((cfg.get("wake") or {}).get("keyword") or "").strip()

        self.state = IDLE
        self.turn = 0
        self._timer: asyncio.Task | None = None
        self._timer_kind = ""
        self._agent_task: asyncio.Task | None = None
        self._interrupt_pending = False   # wake 打断等 tts/interrupted 收尾
        self._idle_after_speak = False    # 错误播报后直接回 idle（判据 3/5：不进 followup）
        self._outcome_override = ""       # 错误播报轮的真实结局（tts 收尾时结算 turn）
        self._seg_start_ts = 0.0          # 最近 vad/start 时刻（followup 新轮基准）
        self._wake_pending_woken = False  # 本段来自 woken（纯唤醒词保持重听）
        self._metrics: dict = {}
        log.info("loop ready: keyword=%r followup=%ss woken=%ss listening_max=%ss think=%ss",
                 self.wake_keyword, self.followup_window_s, self.woken_timeout_s,
                 self.listening_max_s, self.think_timeout_s)

    # ---------- 对外查询（daemon 门控 / 状态快照） ----------

    def wants_asr(self) -> bool:
        """daemon._on_seg_end 门控：仅对话中的段才转写（P6-idle 决策）。

        注：transcribing 由 vad/end 转入（tap 同步先于本门控查询），
        woken 期的段（唤醒词段/连说段）同样转写。
        """
        return self.state in (WOKEN, LISTENING, TRANSCRIBING)

    # ---------- 事件入口（Hub.tap，同步；异步动作用 ensure_future 派生） ----------

    def on_event(self, msg: dict) -> None:
        t = msg.get("type")
        if t == "wake/detected":
            self._ev_wake()
        elif t == "vad/start":
            self._ev_vad_start()
        elif t == "vad/end":
            self._ev_vad_end()
        elif t == "asr/final":
            self._ev_asr_final(msg)
        elif t == "asr/error":
            self._ev_asr_error()
        elif t == "tts/start":
            self._ev_tts_start()
        elif t == "tts/done":
            self._ev_tts_done()
        elif t == "tts/interrupted":
            self._ev_tts_interrupted()

    # ---------- 转移 ----------

    def _to(self, state: str, reason: str) -> None:
        if state == self.state:
            return
        old, self.state = self.state, state
        log.info("loop: %s -> %s (%s) turn=%d", old, state, reason, self.turn)
        # 思考等待音乐（2026-09-20）：离开思考/转写态且未进播报 → 停。
        # 转入 SPEAKING 不在此停——TTS 首句合成期（2-7s）仍需音乐垫，
        # 由首次回复音频写入（speaker._write → music_stop）精确接棒。
        if old in (THINKING, TRANSCRIBING) and state != SPEAKING:
            asyncio.ensure_future(self.speaker.music_stop())
        asyncio.ensure_future(self.hub.broadcast({
            "type": "loop/state", "from": old, "to": state,
            "reason": reason, "turn": self.turn}))

    def _arm(self, kind: str, seconds: float) -> None:
        self._disarm()
        self._timer_kind = kind
        self._timer = asyncio.ensure_future(self._timer_fire(kind, seconds))

    def _disarm(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
        self._timer_kind = ""

    async def _timer_fire(self, kind: str, seconds: float) -> None:
        await asyncio.sleep(seconds)
        if self._timer_kind != kind or self.state not in self._state_for(kind):
            return  # 已被后续转移取代
        if kind == "woken":
            self._disarm()
            self._end_turn("no-speech")           # 判据 3/4：静默回 idle 不播报
            self._to(IDLE, "woken-timeout")
        elif kind == "listening":
            self._disarm()
            self._end_turn("listen-timeout")      # 判据 3：listening 强切
            self._to(IDLE, "listening-timeout")
        elif kind == "thinking":
            self._disarm()
            log.warning("thinking 超时 %.0fs", seconds)
            self._cancel_agent()
            asyncio.ensure_future(self._speak_then_idle(
                PHRASE_AGENT_TIMEOUT, "think-timeout"))
        elif kind == "followup":
            self._disarm()                        # P6-2：窗口内无新句
            self._to(IDLE, "followup-timeout")

    @staticmethod
    def _state_for(kind: str):
        return {"woken": {WOKEN}, "listening": {LISTENING},
                "thinking": {THINKING, TRANSCRIBING},
                "followup": {LISTENING}}[kind]

    # ---------- 事件处理 ----------

    def _ev_wake(self) -> None:
        # 先结算被唤醒打断的旧轮（保留旧轮指标；错误播报轮优先真实结局）
        if self.state == SPEAKING:
            self._end_turn(self._outcome_override or "barge-in")
        elif self.state in (THINKING, TRANSCRIBING):
            self._end_turn(self._outcome_override or "barge-in-think")
            self._cancel_agent()
        elif self.state != IDLE:
            self._end_turn("rewake")
        # 开新轮
        self.turn += 1
        self._metrics = {"turn": self.turn, "wake_ts": time.time()}
        self._interrupt_pending = False
        self._idle_after_speak = False
        self._outcome_override = ""
        if self.state == SPEAKING:
            # P6-1 打断：停播（tts/interrupted 收尾时转 woken；确认音由 daemon._on_wake 播）
            self._interrupt_pending = True
            asyncio.ensure_future(self._interrupt_speak())
            return
        if self.state in (THINKING, TRANSCRIBING):
            self._to(WOKEN, "wake-cancel")        # P6-3：thinking 期唤醒 = 取消本轮
            self._arm("woken", self.woken_timeout_s)
            return
        # idle / woken / listening 再唤醒：重开一轮
        self._to(WOKEN, "wake")
        self._arm("woken", self.woken_timeout_s)

    async def _interrupt_speak(self) -> None:
        try:
            await self.speaker.stop()             # 杀 pw-cat，ms 级静音
        except Exception as e:  # noqa: BLE001
            log.warning("打断 stop 失败: %s", e)

    def _ev_vad_end(self) -> None:
        if self.state in (WOKEN, LISTENING):
            # 段结束、转写即将启动（daemon 门控在 tap 之后查询，此刻状态
            # 已含本转移）→ 立即显示"识别中"（2026-09-11 用户感知：说完
            # 2-3s 才见"思考中"；转写在飞即提示，快档提前 ~1s）
            self._metrics["listen_end_ts"] = time.time()
            self._wake_pending_woken = (self.state == WOKEN)  # 转移前记来源
            self._disarm()
            self._to(TRANSCRIBING, "transcribing")
            self._arm("thinking", self.think_timeout_s)

    def _ev_vad_start(self) -> None:
        self._seg_start_ts = time.time()
        if self.state == TRANSCRIBING:
            # 用户抢话补充：新段覆盖（旧段转写到达时按 LISTENING 语义处理/丢弃）
            self._to(LISTENING, "speech-again")
            self._arm("listening", self.listening_max_s)
        elif self.state == WOKEN:
            # 用户开始说话：woken 超时让位给 listening 上限（判据 3 的 8s 只管"不说话"）
            self._to(LISTENING, "speech-start")
            self._arm("listening", self.listening_max_s)
        elif self.state == LISTENING and self._timer_kind == "followup":
            # P6-2 窗口内开口：免唤醒继续，切回 listening 上限计时
            self._arm("listening", self.listening_max_s)

    def _ev_asr_final(self, msg: dict) -> None:
        if self.state not in (WOKEN, LISTENING, TRANSCRIBING):
            log.info("loop: 丢弃迟到 asr/final（%s 态）", self.state)
            return
        if self._metrics.get("outcome"):
            # followup 连续对话的新句（上轮已结算）：开新轮，基准为本段开口时刻
            self.turn += 1
            self._metrics = {"turn": self.turn,
                             "wake_ts": self._seg_start_ts or time.time()}
        if self.state == WOKEN:
            self._wake_pending_woken = True   # 旧时序（无 vad/end 直接 final）
        self._metrics["listen_end_ts"] = self._metrics.get("listen_end_ts") or time.time()
        self._metrics["asr_done_ts"] = time.time()
        # 剥离句首唤醒词（连说场景）；剥离后为空 = 纯唤醒词段，静默等下一句
        text = strip_wake_prefix((msg.get("text") or "").strip(),
                                 self.wake_keyword)
        if not text:
            if self._wake_pending_woken:
                # woken 期的段（唤醒词段）：保持等真正的指令
                self._wake_pending_woken = False
                self._disarm()
                self._to(WOKEN, "wake-word-only")
                self._arm("woken", self.woken_timeout_s)
                log.info("loop: 唤醒词段无指令，继续等（woken）")
            else:
                self._end_turn("empty-asr")       # 判据 4：噪声段静默收尾
                self._to(IDLE, "empty-asr")
            return
        self._disarm()
        self._to(THINKING, "asr-ok")
        self._arm("thinking", self.think_timeout_s)
        self._tool_filled = False               # 过渡语：每轮重置（P7c）
        asyncio.ensure_future(self.speaker.music_start())   # 思考期垫乐（2026-09-20）
        if self.asr is not None:
            try:
                self.asr.note_user(text)     # 上下文增强：本轮用户话术入滑窗
            except Exception:  # noqa: BLE001
                pass
        self._agent_task = asyncio.ensure_future(self._agent_run(text))

    def _ev_asr_error(self) -> None:
        if self.state not in (WOKEN, LISTENING, TRANSCRIBING):
            return
        # 判据 5：播报不可用回 idle（断网时 Speaker 兜底播预合成 net-unavailable）
        asyncio.ensure_future(self._speak_then_idle(PHRASE_ASR_ERR, "asr-error"))

    def _ev_tts_start(self) -> None:
        if self.state == THINKING:
            self._disarm()                        # 回复开始播：thinking 超时让位播放时长
            self._metrics["reply_first_ts"] = self._metrics.get("reply_first_ts") or time.time()
            self._to(SPEAKING, "reply")

    def _ev_tts_done(self) -> None:
        if self.state != SPEAKING:
            return
        self._metrics["speak_done_ts"] = time.time()
        self._end_turn(self._outcome_override or "ok")
        self._outcome_override = ""
        if self._idle_after_speak:
            self._idle_after_speak = False
            self._to(IDLE, "speak-then-idle")
            return
        # P6-2：连续对话窗口——免唤醒继续 listening
        self._to(LISTENING, "followup")
        self._arm("followup", self.followup_window_s)

    def _ev_tts_interrupted(self) -> None:
        if self._interrupt_pending:
            # wake 打断收尾：旧轮已在 _ev_wake 结算；确认音已播，进入新一轮听取
            self._interrupt_pending = False
            self._outcome_override = ""
            self._to(WOKEN, "barge-in")           # 判据 2：停播 + 回 listening
            self._arm("woken", self.woken_timeout_s)
        elif self.state == SPEAKING:
            # manual_stop / 播放故障兜底后 teardown(interrupted=True)
            self._end_turn(self._outcome_override or "tts-failed")
            self._outcome_override = ""
            self._to(IDLE, "interrupted")

    # ---------- agent 会话 ----------

    def _on_tool(self, name: str) -> None:
        """工具过渡语（P7c）：桥转发的 tool/call。thinking 态、本轮首次、
        白名单工具才播；本地缓存话术走 beep 管道（worker 串行，与回复音频
        天然排队；_write 会自动让位垫乐）。失败静默——过渡语是锦上添花。"""
        if not self.tool_filler or self._tool_filled or self.state != THINKING:
            return
        if name not in self.tool_filler_tools:
            return
        self._tool_filled = True
        log.info("过渡语触发 name=%s（诊断）", name)
        asyncio.ensure_future(self._speak_tool_filler())

    def _resume_music_after_filler(self) -> None:
        """worker 域回调（filler 播完、busy 已清）：仍在思考且音乐没开 → 恢复垫乐。"""
        if self.state == THINKING and not self.speaker._music_on:
            asyncio.ensure_future(self.speaker.music_start())

    async def _speak_tool_filler(self) -> None:
        try:
            wav = self.speaker.cache_dir / "tool-search.wav"
            await self.speaker.speak_filler(wav, after=self._resume_music_after_filler)
        except Exception as e:  # noqa: BLE001
            log.warning("工具过渡语异常（忽略，不影响回复）: %s", e)

    async def _agent_run(self, text: str) -> None:
        first = True
        reply_buf: list[str] = []
        live = (THINKING, SPEAKING)   # 正常转移 thinking→speaking 不算终结
        try:
            await self.speaker.stream_begin()
            async for chunk in self.agent.reply(text, on_tool=self._on_tool):
                if self.state not in live:          # 超时/打断已接管（IDLE/WOKEN）
                    break
                if first:
                    self._metrics["reply_first_ts"] = time.time()
                    first = False
                reply_buf.append(chunk)
                await self.speaker.stream_feed(chunk)
            if self.asr is not None and reply_buf:
                try:
                    self.asr.note_reply("".join(reply_buf))   # 回复入滑窗
                except Exception:  # noqa: BLE001
                    pass
            if self.state not in live:
                return
            if first:
                self._end_turn("agent-empty")     # agent 无输出：静默回 idle
                await self.speaker.stream_end()
                self._to(IDLE, "agent-empty")
                return
            await self.speaker.stream_end()       # 残句入队；tts/* 事件驱动后续
        except asyncio.CancelledError:
            try:
                await self.speaker.flush()        # 丢弃未播残留
            except Exception:  # noqa: BLE001
                pass
            raise
        except Exception as e:  # noqa: BLE001
            log.warning("agent 失败: %s", e)
            phrase = getattr(e, "phrase", None) or PHRASE_AGENT_ERR
            asyncio.ensure_future(self._speak_then_idle(phrase, "agent-error"))

    def _cancel_agent(self) -> None:
        if self._agent_task is not None and not self._agent_task.done():
            self._agent_task.cancel()
        self._agent_task = None

    async def _speak_then_idle(self, phrase: str, outcome: str) -> None:
        """错误播报：完成后结算 turn 并回 idle（不进 followup，判据 3/5）。

        turn 的 outcome 由 outcome 参数带入（tts 收尾事件统一结算，
        保证每轮恰好一条 turn/end）。
        """
        self._idle_after_speak = True
        self._outcome_override = outcome
        self._to(SPEAKING, "error-speak")
        n = await self.speaker.speak(phrase)
        if n == 0:
            self._idle_after_speak = False
            self._end_turn(outcome)
            self._to(IDLE, "speak-skip")

    # ---------- 手动打断（GUI 停止按钮 → RPC loop/stop） ----------

    async def manual_stop(self) -> None:
        if self.state == SPEAKING:
            self._interrupt_pending = False
            self._outcome_override = "manual-stop"
            await self.speaker.stop()             # tts/interrupted → idle
        elif self.state in (THINKING, TRANSCRIBING):
            self._end_turn("manual-stop")
            self._cancel_agent()
            self._to(IDLE, "manual-stop")
        elif self.state in (WOKEN, LISTENING):
            self._end_turn("manual-stop")
            self._to(IDLE, "manual-stop")

    # ---------- 指标 ----------

    def _end_turn(self, outcome: str) -> None:
        m = self._metrics
        m["outcome"] = outcome
        if "wake_ts" in m:
            def g(k: str):
                v = m.get(k)
                return round((v - m["wake_ts"]) * 1000) if v else None
            m["durations"] = {
                "listen_end_ms": g("listen_end_ts"),
                "asr_done_ms": g("asr_done_ts"),
                "reply_first_ms": g("reply_first_ts"),
                "speak_done_ms": g("speak_done_ts"),
            }
        log.info("turn/end #%s %s %s", m.get("turn"), outcome, m.get("durations") or "")
        asyncio.ensure_future(self.hub.broadcast({
            "type": "turn/end", "turn": m.get("turn"), "outcome": outcome,
            "durations": m.get("durations") or {}}))
