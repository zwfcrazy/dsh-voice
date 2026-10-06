"""Speaker — TTS 播放队列（P5 实施步骤 4/5/7）。

设计（P5-1/P5-2 决策）：
- 合成：CosyVoiceTts（执行器线程，阻塞 WS 全流程）
- 播放：常驻 `pw-cat --playback --raw` 管道，往 stdin 写 PCM——
  **播放期间零 fork**（fork×解析器锁死锁教训，见 phase-4 研究文档）；
  pw-cat 在每轮说话会话开始时 spawn 一次（此时无合成在飞）
- 兜底：合成失败 → 播预合成话术 wav（assets/tts-cache/，24k mono）
- 事件：tts/start {i,total,text} / tts/done / tts/interrupted / tts/error
- RPC 语义：speak 入队；stop 立断（杀 pw-cat）；flush 当前句播完丢弃旧队列
"""
from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path

from .audio_router import AudioRouter
from .config import REPO_ROOT
from .sentence import SentenceBatcher, split_sentences, strip_markdown
from .tts_provider import build_tts

log = logging.getLogger("voice.player")

CHUNK = 8192          # 写管道的块（48KB/s 流 → ~170ms/块）
GAP_S = 0.12          # 句间静音


class Speaker:
    def __init__(self, cfg: dict, hub, pause_hook=None, resume_hook=None):
        self.cfg = cfg
        self.hub = hub
        self.pause_hook = pause_hook    # 播放前暂停采集（腾出 HFP，见 daemon._pause_capture）
        self.resume_hook = resume_hook
        t = cfg.get("tts") or {}
        self.rate = int(t.get("sample_rate", 24000))
        # 软边界保险丝（2026-09-15：1500→180。markdown 星号咬住英文句点时半句
        # 无限累积，曾倾泻出 72s/125s 音频巨批 → qwen-audio 打结循环；现只允许
        # 在自然停顿标点处软切，正常批 40-90 字不受影响）
        self.max_chars = int(t.get("max_sentence_chars", 180))
        self.volume = float(t.get("volume", 0.9))
        # P6-1：hfp = 不切 profile 直接播 HFP sink（麦克风全程在线，唤醒词可打断）；
        # a2dp = Phase 5 行为（暂停采集 → 切 A2DP 立体声 → 播完切回）
        self.sink_mode = str(t.get("sink_mode", "a2dp"))
        self.cache_dir = REPO_ROOT / t.get("phrase_dir", "assets/tts-cache")
        self.tts = build_tts(cfg)   # 2026-09-15：provider 分发（cosyvoice | qwen-realtime）
        self.router = AudioRouter(cfg)
        self.queue: asyncio.Queue = asyncio.Queue()
        self.speaking = False            # 供 daemon watcher 静默判定
        self.synthesizing = False        # 云端合成在飞（daemon beep fork-guard 用）
        self._streaming = False          # 流式会话中（agent 边生成边播，Phase 7）
        self._stream_buf = ""
        self._idle_handle = None         # 半句空闲兜底定时器（2026-09-14 重设计）
        self.idle_flush_s = float(t.get("sentence_idle_s", 1.5))
        # 攒批发 TTS（2026-09-14 用户决策 v2）：完整句凑 min_chars 才发一批
        self.min_chars = int(t.get("min_sentence_chars", 40))
        self.batcher = SentenceBatcher(self.min_chars)
        self._stream_idx = 0
        self._proc = None                # pw-cat 进程
        self._flush_flag = False
        self._stop_flag = False
        self._worker_task = None
        self._first_audio_at = 0.0
        self._bytes_written = 0
        self._last_sentence_at = 0.0
        # 思考等待音乐（2026-09-20）：thinking 进入时循环播放，首次回复
        # 音频写入前让位。复用 pw-cat 常驻管道——hfp 模式麦克风全程在线，
        # 播报期唤醒打断不受影响。
        m = cfg.get("music") or {}
        self.music_enabled = bool(m.get("enabled", False))
        self.music_volume = float(m.get("volume", 0.35))
        self.music_path = REPO_ROOT / str(m.get("file", "assets/music/thinking-loop.wav"))
        self._music_on = False
        self._music_task: asyncio.Task | None = None
        self._music_pcm: bytes | None = None   # 惰性加载（重采样到管道 rate）
        self._worker_busy = False        # worker 正在处理队列项（音乐让位/独占判定）

    # ---------- 对外（事件循环内调用） ----------
    def start(self) -> None:
        self._worker_task = asyncio.get_event_loop().create_task(self._worker())

    async def speak(self, text: str) -> int:
        sents = split_sentences(strip_markdown(text), self.max_chars)
        if not sents:
            return 0
        self._flush_flag = False
        for i, s in enumerate(sents, 1):
            await self.queue.put((i, len(sents), s))
        return len(sents)

    async def stop(self) -> None:
        """立即停止：杀 pw-cat（声音随进程死亡即停，~ms 级）+ 清队列。"""
        # 2026-09-19 取证插桩：定位"chunk 到达后被静默吞掉"的调用方
        import traceback
        log.warning("speaker.stop() 调用方:\n%s",
                    "".join(traceback.format_stack(limit=6)[:-1]))
        self._stop_flag = True
        self._music_on = False           # 音乐随管道一起死（stop 杀 pw-cat）
        if self._music_task is not None:
            self._music_task.cancel()
            self._music_task = None
        self.batcher.clear()
        self._stream_buf = ""
        while not self.queue.empty():
            self.queue.get_nowait()
        proc = self._proc
        if proc is not None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass

    # ---------- 思考等待音乐（2026-09-20） ----------
    async def music_start(self) -> None:
        """进入 thinking 时开音乐：复用/预建 pw-cat 会话，循环写 PCM。

        停止路径全覆盖：首次回复音频 _write 前让位（会话保留给语音无缝
        接棒）；离开思考态未进播报由 loop._to 停（_kill_session 拆会话）；
        stop()/打断随管道死亡。
        """
        if self._music_on or not self.music_enabled:
            log.info("music_start 早退：on=%s enabled=%s（诊断）", self._music_on, self.music_enabled)
            return
        if self._worker_busy:
            log.info("music_start 早退：worker_busy（诊断）")   # 上一轮播报仍在收尾（followup 抢话边角）：不叠音乐
            return
        if self._music_pcm is None:
            self._music_pcm = self._wav_pcm(self.music_path)
            if self._music_pcm is None:
                log.warning("music 素材缺失/不可读: %s（本轮无等待音乐）",
                            self.music_path)
                return
        try:
            if self._proc is None or self._proc.returncode is not None:
                await self._start_session()   # 幂等：语音 _start_session 直接复用
        except Exception as e:  # noqa: BLE001
            log.warning("music 建会话失败（本轮无等待音乐）: %s", e)
            return
        self._music_on = True
        self._music_task = asyncio.ensure_future(self._music_loop())
        log.info("music/start %.1fs loop vol=%.2f",
                 len(self._music_pcm) / (self.rate * 2), self.music_volume)

    async def _music_loop(self) -> None:
        import numpy as np
        raw = np.frombuffer(self._music_pcm, dtype=np.int16).astype(np.float32)
        step = self.rate * 2 // 8        # 125ms 块（停让位残余 ≤ ~0.3s）
        pos = 0
        while self._music_on:
            proc = self._proc
            if proc is None or proc.stdin is None:
                break
            end = pos + step
            if end <= len(raw):
                seg, pos = raw[pos:end], (end if end < len(raw) else 0)
            else:
                seg = np.concatenate([raw[pos:], raw[:end - len(raw)]])
                pos = end - len(raw)
            # 音量逐块实时读：面板拖动热改（config/set 直写 music_volume）
            # ≤125ms 生效。v1 起乐时一次性烘进 PCM——播放中调音量无效（已修）
            v = self.music_volume
            chunk = np.clip(seg * v, -32768, 32767).astype(np.int16).tobytes()
            try:
                proc.stdin.write(chunk)
                await proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError):
                break   # stop() 已杀进程；收尾交给调用方

    async def music_stop(self) -> None:
        if not self._music_on:
            return
        self._music_on = False
        t, self._music_task = self._music_task, None
        if t is not None:
            t.cancel()
            try:
                await t
            except asyncio.CancelledError:
                pass
            except Exception:  # noqa: BLE001
                pass
        if self._worker_busy:
            # 语音即将/正在用同一会话：保留管道无缝接棒；播放计量基准移交
            # 真实首音（_write 的 bytes_written==0 分支）
            self._bytes_written = 0
            log.info("music/stop（语音接棒）")
            return
        await self._kill_session()
        log.info("music/stop")

    async def _kill_session(self) -> None:
        """静默拆播放会话（音乐独用、无语音跟随时）：不广播 tts/* 事件。"""
        proc, self._proc = self._proc, None
        if proc is not None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            try:
                await proc.wait()
            except Exception:  # noqa: BLE001
                pass
        if self.sink_mode != "hfp":
            try:
                await asyncio.get_event_loop().run_in_executor(
                    None, self.router.end)
            except Exception as e:  # noqa: BLE001
                log.warning("router.end: %s", e)
            if self.resume_hook:
                try:
                    await self.resume_hook()
                except Exception as e:  # noqa: BLE001
                    log.warning("resume_capture: %s", e)
        self.speaking = False

    async def flush(self) -> None:
        """新对话优先：当前句播完即止。"""
        while not self.queue.empty():
            self.queue.get_nowait()
        self._flush_flag = True

    async def set_volume(self, v: float) -> float:
        self.volume = max(0.05, min(1.5, float(v)))
        # 2026-09-25 教训（音量突然变小排查）：音量在 pw-cat spawn 时经 --volume
        # 固化，_start_session 复用活管道——只改 self.volume 的话，热改要等到管道
        # 自然重建才生效，期间面板调音量/即时试播全是旧值假象。改为立即杀活管道：
        # 下次播放全新 spawn 即用新值（与 stop 同路径，幂等；正在播的句子会被截断，
        # 权衡可接受——此前是静默不生效）。
        proc, self._proc = self._proc, None
        if proc is not None and proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        return self.volume

    async def speak_filler(self, wav_path: Path, after=None) -> bool:
        """工具过渡语（P7c）：走 worker 队列但 kind=filler——不拆播放会话
        （回复语音随后接棒）。after 回调在 worker 清完 busy 之后同任务调用
        （loop 用它恢复垫乐：worker 域内决策，无跨任务竞速——2026-09-27
        修复：loop 侧按 wav 时长 sleep 后调 music_start 会撞 worker 的
        播放等待期，busy 守卫早退，垫乐恢复静默失效）。"""
        pcm = self._phrase_pcm(wav_path.stem) if wav_path.parent == self.cache_dir \
            else self._wav_pcm(wav_path)
        if pcm is None:
            return False
        await self.queue.put({"kind": "filler", "pcm": pcm, "after": after})
        return True

    async def beep(self, wav_path: Path) -> bool:
        """本地提示音走播放管道（Phase 6：替代 paplay——fork 无死锁面，
        worker 串行保证 spawn 不与合成并发；唤醒确认音不再被在飞 ASR 卡住）。
        wav 任意采样率 mono → 线性重采样到管道 rate。
        """
        pcm = self._phrase_pcm(wav_path.stem) if wav_path.parent == self.cache_dir \
            else self._wav_pcm(wav_path)
        if pcm is None:
            return False
        await self.queue.put({"kind": "beep", "pcm": pcm})
        return True

    def _wav_pcm(self, path: Path) -> bytes | None:
        """读 wav 文件 → 管道 rate 的裸 PCM（线性重采样）。"""
        try:
            import wave
            import numpy as np
            with wave.open(str(path), "rb") as w:
                if w.getnchannels() != 1 or w.getsampwidth() != 2:
                    return None
                src_rate = w.getframerate()
                x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
            if src_rate == self.rate:
                return x.tobytes()
            n = int(len(x) * self.rate / src_rate)
            idx = np.minimum(
                np.arange(n) * src_rate / self.rate, len(x) - 1).astype(np.int64)
            return x[idx].astype(np.int16).tobytes()
        except Exception as e:  # noqa: BLE001
            log.warning("beep 读 wav 失败 %s: %s", path, e)
            return None

    # ---------- 流式会话（agent token 流 → 边生成边播，Phase 7 主路径） ----------
    async def stream_begin(self) -> None:
        self._streaming = True
        self._stream_buf = ""
        self._stream_idx = 0
        self._flush_flag = False

    async def stream_feed(self, text: str) -> int:
        """喂入 token 增量；完整句进攒批器，凑满 min_chars 发一批。返回批数。

        2026-09-14 用户决策 v2：多句一批合成（跨句韵律连贯），最小长度放行，
        不再有常规字符上限；空闲超时/流结束兜底 flush。
        """
        if not self._streaming:
            await self.stream_begin()
        self._stream_buf += text
        sents = split_sentences(self._stream_buf, self.max_chars)
        n = 0
        # 最后一段可能是半句（无句末标点），留在缓冲
        if not self._buf_ends_sentence():
            sents, self._stream_buf = sents[:-1], sents[-1] if sents else ""
        else:
            self._stream_buf = ""
        # 逐句清洗后再攒批：列表/标题等行首标记必须在拼接前去掉
        # （拼接后成了行中普通字符，正则咬不住）
        sents = [x for x in (strip_markdown(s) for s in sents) if x]
        for batch in self.batcher.add(sents):
            self._stream_idx += 1
            self.queue.put_nowait((self._stream_idx, 0, batch))
            n += 1
        self._arm_idle_flush()
        return n

    def _arm_idle_flush(self) -> None:
        """半句/不满批兜底：空闲超时后强制发出（模型停顿或收尾）。"""
        if self._idle_handle is not None:
            self._idle_handle.cancel()
            self._idle_handle = None
        if not self._stream_buf.strip() and not self.batcher._buf:
            return
        loop = asyncio.get_event_loop()
        self._idle_handle = loop.call_later(self.idle_flush_s, self._idle_flush_now)
        log.info("tts/idle-arm buf=%dbatch=%d",
                 len(self._stream_buf), sum(len(s) for s in self.batcher._buf))

    def _idle_flush_now(self) -> None:
        self._idle_handle = None
        if not self._streaming:
            log.info("tts/idle-flush 跳过（非流式）")
            return
        tail = strip_markdown(self._stream_buf)
        self._stream_buf = ""
        if tail:
            # 残段也要过软边界：长尾在逗号处切开，防巨批倾泻
            self.batcher.add(split_sentences(tail, self.max_chars))
        batches = self.batcher.flush()
        if not batches:
            log.info("tts/idle-flush 空（缓冲已被清空——stop() 嫌疑）")
        for batch in batches:
            self._stream_idx += 1
            self.queue.put_nowait((self._stream_idx, 0, batch))
            log.info("tts/idle-flush %dchars", len(batch))

    async def stream_end(self) -> int:
        """流结束：残余半句 + 未满批全部发出，会话收尾交回 worker。"""
        if self._idle_handle is not None:
            self._idle_handle.cancel()
            self._idle_handle = None
        n = 0
        tail = strip_markdown(self._stream_buf)
        self._stream_buf = ""
        self._streaming = False
        if tail:
            self.batcher.add(split_sentences(tail, self.max_chars))
        for batch in self.batcher.flush():
            self._stream_idx += 1
            await self.queue.put((self._stream_idx, 0, batch))
            n += 1
        return n

    def _buf_ends_sentence(self) -> bool:
        s = self._stream_buf.rstrip()
        if s and s[-1] in "。！？!?；;…":
            return True
        # 英文句点（排除小数 "3."）：句尾立即闭合，不必等下一批 token
        if len(s) >= 2 and s[-1] == "." and not s[-2].isdigit():
            return True
        return False

    # ---------- 内部 ----------
    async def _start_session(self) -> None:
        """建播放会话。

        hfp 模式（P6-1）：不切 profile、不停采集——pw-cat 指向当前 HFP sink，
        麦克风保持在线（KWS 可打断）。a2dp 模式：暂停采集 → 切 A2DP → spawn。
        """
        loop = asyncio.get_event_loop()
        if self.sink_mode == "hfp":
            if self._proc is not None and self._proc.returncode is None:
                return   # 音乐已建会话：语音直接复用同一管道（无缝接棒）
            sink = await loop.run_in_executor(None, self.router.hfp_sink)
            await self._spawn_pwcat(sink)
            return
        if self.pause_hook:
            await self.pause_hook()
        if self._proc is not None and self._proc.returncode is None:
            return   # 同上：音乐占位期间不重复建会话/切 profile
        sink = await loop.run_in_executor(None, self.router.begin)
        await self._spawn_pwcat(sink)

    def _phrase_pcm(self, key: str) -> bytes | None:
        """预合成话术兜底（P5-2：合成不可用时直读文件）。"""
        wav = self.cache_dir / f"{key}.wav"
        if not wav.exists():
            return None
        data = wav.read_bytes()
        return data[44:] if data[:4] == b"RIFF" else None

    async def _synth(self, text: str) -> bytes:
        loop = asyncio.get_event_loop()
        return await asyncio.wait_for(
            loop.run_in_executor(None, self.tts.synthesize_pcm, text),
            timeout=self.tts.timeout_s + 5)

    async def _synth_stream(self, text: str) -> None:
        """整句缓冲后一次性写入（2026-09-13 P7a 断播修复）。

        旧版边收边写（首音 ≈ 云端首块）：直播轮期间实测云端仅 ~1x 实时且抖动
        （句间 3.7s→29.5s），播放裸追合成 → 句中饥饿 → 断播（monitor 取证：
        17s 静默发往 BT）。改为整句收齐再写；句 N 播放期间句 N+1 经
        _start_prefetch 在后台合成（见 worker 预取管线）。
        """
        audio = await self._synth_collect(text)
        await self._write(audio)

    async def _synth_collect(self, text: str) -> bytes:
        """合成一句并收集完整音频（不写入）——预取管线复用。"""
        loop = asyncio.get_event_loop()
        chunks: list[bytes] = []

        def on_chunk(pcm: bytes) -> None:
            if self._stop_flag:
                raise RuntimeError("stopped")
            chunks.append(pcm)

        self.synthesizing = True
        t0 = time.monotonic()
        try:
            await asyncio.wait_for(
                loop.run_in_executor(None, self.tts.synthesize_stream, text, on_chunk),
                timeout=self.tts.timeout_s + 5)
        finally:
            self.synthesizing = False
        audio = b"".join(chunks)
        if not audio:
            raise RuntimeError("cosyvoice 无音频输出")
        log.info("tts/synth %dB audio=%.1fs synth=%.1fs (%.1fx) %s",
                 len(audio), len(audio) / (self.rate * 2),
                 time.monotonic() - t0,
                 (len(audio) / (self.rate * 2)) / max(time.monotonic() - t0, 0.01),
                 text[:20])
        return audio

    def _try_start_prefetch(self):
        """若文本队列已有下一句，立刻在后台启动其合成（一深度预取）。

        返回 (i, n, text, task) 或 None。task 结果为完整音频 bytes。
        stop/flush 由调用方在消费前检查并 cancel。
        """
        try:
            nxt = self.queue.get_nowait()
        except asyncio.QueueEmpty:
            return None
        if isinstance(nxt, dict):
            # beep 项不预取：塞回去交主循环直写（beep 罕见且本地即写）
            self.queue.put_nowait(nxt)
            return None
        j, m, jtext = nxt
        task = asyncio.ensure_future(self._synth_collect(jtext))
        return [j, m, jtext, task]

    async def _spawn_pwcat(self, sink: str):
        """常驻播放管道。

        本机 pw-cat 版本无 --raw 选项、且 stdin 不可 seek 解析不了 WAV 头
        （2026-09-06 实测：带容器头会按默认 48k 立体声解释 → 变速怪声）。
        正确姿势：显式 --rate/--channels/--format + 裸 PCM 流。
        """
        self._proc = await asyncio.create_subprocess_exec(
            "pw-cat", "-p",
            "--rate", str(self.rate), "--channels", "1", "--format", "s16",
            "--target", sink, "--volume", f"{self.volume:.2f}", "-",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            # 2026-09-13 修复：stderr 不可用 PIPE——underrun warning 会写满 64KB
            # 管道（无人读）→ pw-cat 阻塞在 stderr 写 → 停止消费音频 → 断播
            stderr=asyncio.subprocess.DEVNULL)
        self._bytes_written = 0
        self._first_audio_at = time.monotonic()

    async def _write(self, pcm: bytes) -> None:
        if self._proc is None or self._proc.stdin is None:
            return
        if self._music_on:
            await self.music_stop()   # 回复音频接棒：音乐让位（会话保留复用）
        # 2026-09-13：NewPie USB 声卡无视 sink/流音量（软件旋钮全无效），
        # 在 PCM 上做纯数字衰减（物理不可绕过）。config [tts] volume 即此值。
        v = self.volume
        if 0 < v < 0.999 or v > 1.001:
            import numpy as np
            arr = np.frombuffer(pcm, dtype=np.int16)
            scaled = (arr.astype(np.float32) * v)
            np.clip(scaled, -32768, 32767, out=scaled)
            pcm = scaled.astype(np.int16).tobytes()
        for i in range(0, len(pcm), CHUNK):
            if self._stop_flag:
                return
            try:
                self._proc.stdin.write(pcm[i:i + CHUNK])
                # 2026-09-13 修复：asyncio write() 从不阻塞（旧注释"管道满则阻塞"错误），
                # 无 drain() 则合成块瞬间堆积、bytes_written 虚增 → 排空估时失真 + 无背压
                await self._proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError):
                return  # stop() 已杀进程；静默收尾交 worker teardown
            if self._bytes_written == 0:
                self._first_audio_at = time.monotonic()   # 真实首音起点（流式下 spawn≠发声）
            self._bytes_written += len(pcm[i:i + CHUNK])

    async def _teardown(self, interrupted: bool, total: int = 0) -> None:
        proc, self._proc = self._proc, None
        if proc is not None:
            if not interrupted and proc.stdin is not None:
                # 2026-09-13 尾截断修复：自然结束关 stdin 发 EOF，pw-cat 播完
                # 管道+内部缓冲后自然退出（旧 kill 会丢 OS pipe 里最多 1.33s
                # 音频——"回复快结束时中断"多次复现的根因）
                try:
                    proc.stdin.close()
                    await asyncio.wait_for(proc.wait(), timeout=3.0)
                except Exception:  # noqa: BLE001
                    try:
                        proc.kill()
                    except ProcessLookupError:
                        pass
                    try:
                        await proc.wait()
                    except Exception:  # noqa: BLE001
                        pass
            else:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                try:
                    await proc.wait()
                except Exception:  # noqa: BLE001
                    pass
        self.speaking = False
        if self.sink_mode != "hfp":
            try:
                await asyncio.get_event_loop().run_in_executor(None, self.router.end)
            except Exception as e:  # noqa: BLE001
                log.warning("router.end: %s", e)
            if self.resume_hook:
                try:
                    await self.resume_hook()
                except Exception as e:  # noqa: BLE001
                    log.warning("resume_capture: %s", e)
        if interrupted:
            await self.hub.broadcast({"type": "tts/interrupted"})
        else:
            await self.hub.broadcast({"type": "tts/done", "total": total})
        log.info("tts %s (bytes=%d)", "interrupted" if interrupted else "done",
                 self._bytes_written)

    async def _worker(self) -> None:
        loop = asyncio.get_event_loop()
        while True:
            item = await self.queue.get()
            self._worker_busy = True
            self._stop_flag = False
            self._flush_flag = False
            self.speaking = True
            session_items = [item]
            try:
                # ---- beep/filler 项（本地话术直写，不合成不广播 tts/start）----
                if isinstance(item, dict) and item.get("kind") in ("beep", "filler"):
                    await self._start_session()
                    await self._write(item["pcm"])
                    played_s = self._bytes_written / (self.rate * 2)
                    remain = played_s - (time.monotonic() - self._first_audio_at)
                    if remain > 0:
                        await asyncio.sleep(min(remain, 5))
                    if item.get("kind") == "filler":
                        # P7c 工具过渡语：thinking 期插播——会话保留（回复语音
                        # 直接接棒）。清 busy 后同任务调 after（垫乐恢复等
                        # 后续动作在 worker 域决策，避开跨任务竞速）
                        self._worker_busy = False
                        after = item.get("after")
                        if after is not None:
                            try:
                                after()
                            except Exception as e:  # noqa: BLE001
                                log.warning("filler after 回调异常: %s", e)
                        continue
                    await self._teardown(self._stop_flag, total=1)
                    continue

                # ---- 建会话 → 流式合成边到边写（首音 ≈ 云端首块到达） ----
                i, n, text = item
                await self.hub.broadcast({"type": "tts/start", "i": i, "n": n,
                                          "text": text})
                await self._start_session()
                self._last_sentence_at = time.time()
                audio = await self._synth_collect(text)
                await self._write(audio)
                # 首句在写：立刻预取下一句（若文本已到）——句 N 播放期间
                # 句 N+1 后台合成，消除"播完才开合成"的句间空隙
                prefetch = self._try_start_prefetch()

                # ---- 后续句：优先消费预取（合成已与上句播放重叠）----
                while True:
                    if self._stop_flag or self._flush_flag:
                        if prefetch is not None:
                            prefetch[3].cancel()
                        break
                    if prefetch is not None:
                        j, m, jtext, ptask = prefetch
                        prefetch = None
                        try:
                            audio = await ptask
                        except Exception as e:  # noqa: BLE001
                            log.warning("tts 预取合成失败（跳过）: %s", e)
                            await self.hub.broadcast({"type": "tts/error",
                                                      "error": str(e)[:160]})
                            continue
                        gap_ms = round((time.time() - self._last_sentence_at) * 1000)
                        self._last_sentence_at = time.time()
                        log.info("tts/sentence i=%d gap=%dms(pref) %s", j, gap_ms,
                                 jtext[:24])
                        await self.hub.broadcast({"type": "tts/start", "i": j, "n": m,
                                                  "text": jtext})
                        try:
                            await self._write(b"\x00" * int(self.rate * 2 * GAP_S))
                            await self._write(audio)
                        except Exception as e:  # noqa: BLE001
                            log.warning("tts 句播放失败（跳过）: %s", e)
                        session_items.append((j, m, jtext))
                        prefetch = self._try_start_prefetch()
                        continue
                    try:
                        nxt = self.queue.get_nowait()
                    except asyncio.QueueEmpty:
                        if self._streaming:
                            # agent 还在生成：等下一句（3s 空闲即收尾）
                            try:
                                nxt = await asyncio.wait_for(
                                    self.queue.get(), timeout=3.0)
                            except asyncio.TimeoutError:
                                log.info("tts 流式空闲 3s，收尾")
                                break
                        else:
                            break
                    j, m, jtext = nxt if not isinstance(nxt, dict) else (0, 0, None)
                    if jtext is None:  # beep 项混入：直写提示音继续
                        await self._write(nxt["pcm"])
                        session_items.append(nxt)
                        continue
                    gap_ms = round((time.time() - self._last_sentence_at) * 1000)
                    self._last_sentence_at = time.time()
                    log.info("tts/sentence i=%d gap=%dms %s", j, gap_ms,
                             jtext[:24])
                    await self.hub.broadcast({"type": "tts/start", "i": j, "n": m,
                                              "text": jtext})
                    try:
                        await self._write(b"\x00" * int(self.rate * 2 * GAP_S))
                        await self._synth_stream(jtext)
                    except Exception as e:  # noqa: BLE001
                        log.warning("tts 句合成失败（跳过）: %s", e)
                        await self.hub.broadcast({"type": "tts/error",
                                                  "error": str(e)[:160]})
                        continue
                    session_items.append(nxt)

                # ---- 排空管道（估算播放完所需时间；drain 后 written≈已消费，留 0.5s 管道尾量）----
                if not self._stop_flag:
                    played_s = self._bytes_written / (self.rate * 2)
                    remain = played_s - (time.monotonic() - self._first_audio_at)
                    if remain > 0:
                        await asyncio.sleep(min(remain + 0.5, 30))
                await self._teardown(self._stop_flag, total=len(session_items))
            except Exception as e:  # noqa: BLE001
                log.warning("tts 会话失败: %s", e, exc_info=True)
                # 兜底：预合成话术（P5-2）；stop 触发的断管不播。
                # 首句合成失败时会话未建——完整建会话再播。
                fallback = None if self._stop_flag else self._phrase_pcm("net-unavailable")
                if fallback is not None:
                    try:
                        if self._proc is None:
                            await self._start_session()
                        await self._write(fallback)
                        await asyncio.sleep(len(fallback) / (self.rate * 2))
                    except Exception as e2:  # noqa: BLE001
                        log.warning("兜底播放失败: %s", e2)
                await self.hub.broadcast({"type": "tts/error",
                                          "error": str(e)[:160]})
                await self._teardown(True)
            finally:
                self._worker_busy = False   # 音乐让位判定：worker 空闲后可拆会话
