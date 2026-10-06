"""分句切分（P5 实施 → 2026-09-14 按用户决策重设计）。

变化（原 60 字硬切的三个问题：模型出字已远快于 TTS，长句更流畅；硬切伤合成
韵律；按字符数切英文会切碎单词）：
- 不再有字符数硬切；改为 soft_limit 软边界：超限时只在自然停顿标点
  （，、；：,;）处切，切点保留标点；窗口内无好边界则整句保留（宁长勿碎）。
- 英语句点规则：`.` 后跟空白/结尾才算句末（`3.14`、`e.g.` 部分场景仍可能
  误切，代价是偶发短句，可接受）。
- 流式路径的兜底由字数改为空闲超时（见 player.stream_feed）。
"""
from __future__ import annotations

import re

# 句末标点（中文全角 + ASCII !?; + 省略号 + 换行 + 英语句点哨兵 \x00）
_END = re.compile(r"([。！？!?；;…\n\x00]+)")
# 英文句点规则：`.` 前是字母/数字、后跟空白/结尾才算句末（`3.14` 不误切）。
# 用哨兵而非 lookaround：split 的捕获组只含分隔符本身，lookaround 在
# fullmatch 判定时看不到上下文（实测英文整段不切，2026-09-14）。
# 2026-09-15 修正：原"后跟空白"会被 markdown 咬住（`Park.**` 永不切句，
# 半句无限累积 → 巨批倾泻，qwen-audio 超长输入打结循环的根因）。改为
# "后跟非字母数字"；`/` 仍排除保护 URL（example.com/path 不切）。
_EN_DOT = re.compile(r"(?<=[0-9a-zA-Z])\.(?![0-9a-zA-Z/])")

# 软边界候选（按停顿自然度排序，切点保留该标点）
_SOFT = "，、；：,;:"

# ---------- markdown 清洗（TTS 安全网，2026-09-15） ----------
# 大模型回复常带 markdown（**加粗**、列表、链接、表情），直接进 TTS 会念出
# 星号/乱码（实测英文简介批次 `**Northern Jiangsu (苏北)*`、😄 均入合成）。
# P7b 人设提示词会另行要求纯文本输出；这里是机制级兜底，批入队前调用。
_MD_LINK = re.compile(r"\[([^\]\n]+)\]\([^)\s]*\)")       # [text](url) → text
_MD_URL = re.compile(r"https?://[^\s，。；、！？）)】\]\"'”]+")
_MD_FENCE = re.compile(r"```[^\n`]*")                       # 围栏标记（内容保留）
_MD_HEADING = re.compile(r"(?m)^\s{0,3}#{1,6}\s*")
_MD_LIST = re.compile(r"(?m)^\s{0,3}([-*+]|\d{1,2}[.)])\s+")
_MD_QUOTE = re.compile(r"(?m)^\s{0,3}>\s?")
# 2026-09-15 二补：**行中**记号。分句后换行已被吃进上一句，模型又有
# "介绍如下：### 标题"、"如下：- 条目" 这类冒号后直接跟记号的写法，
# 行首锚点咬不住 → `###` 进 TTS 被念成 "pound pound pound"（实测）。
# 规则：记号前是行首或中文停顿标点才算；C#/F#（字母数字紧邻#）保留。
_MD_HASH_ANY = re.compile(r"(?<![0-9a-zA-Z])#{1,6}\s?")
_MD_LIST_ANY = re.compile(r"(?<=[：:，、；;])\s*(?:[-*+]|\d{1,2}[.)])\s+")
_MD_EDGE_US = re.compile(r"(?<!\w)_+|_+(?!\w)")             # 边界下划线（斜体）；词中保留（snake_case）
_EMOJI = re.compile(
    "[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\u2190-\u21FF"
    "\uFE0F\u200D\u2060]+")
def strip_markdown(text: str) -> str:
    """去除影响 TTS 的 markdown 记号与表情；保留正文与换行（换行是句界）。"""
    t = _MD_FENCE.sub("", text or "")
    t = _MD_LINK.sub(r"\1", t)
    t = _MD_URL.sub("", t)
    t = _MD_HEADING.sub("", t)
    t = _MD_LIST.sub("", t)
    t = _MD_QUOTE.sub("", t)
    t = _MD_HASH_ANY.sub(" ", t)
    t = _MD_LIST_ANY.sub(" ", t)
    t = t.replace("|", " ").replace("*", "").replace("~~", "")
    t = _MD_EDGE_US.sub("", t)
    t = t.replace("`", "")
    t = _EMOJI.sub("", t)
    t = re.sub(r"[ \t]{2,}", " ", t)
    return t.strip()


def split_sentences(text: str, soft_limit: int = 120) -> list[str]:
    text = (text or "").strip()
    if not text:
        return []
    text = _EN_DOT.sub(".\x00", text)
    out: list[str] = []
    buf = ""
    for part in _END.split(text):
        if not part:
            continue
        buf += part
        if _END.fullmatch(part):
            out.append(buf.strip())
            buf = ""
    if buf.strip():
        out.append(buf.strip())
    # 软边界：超 soft_limit 的长句在自然停顿处切；无好边界则整句保留
    final: list[str] = []
    for s in out:
        while len(s) > soft_limit:
            best = -1
            for ch in _SOFT:
                pos = s.rfind(ch, 0, soft_limit + 1)
                if pos > best:
                    best = pos
            if best < soft_limit // 2:
                break  # 无自然停顿可切：整句交给 TTS，不做暴力截断
            final.append(s[:best + 1].replace("\x00", "").strip())
            s = s[best + 1:].lstrip(_SOFT + " \x00")
        if s:
            final.append(s.replace("\x00", ""))
    return [x for x in final if x]


class SentenceBatcher:
    """按最小长度攒批发 TTS（2026-09-14 用户决策 v2）。

    完整句先攒批：凑满 min_chars（约 1-3 句）输出一批，多句一次合成——
    跨句韵律更连贯；流停顿/结束时 flush() 兜底输出。不再有"最长字符数"
    概念（云端 cosyvoice 单请求约 2000 字符，批远低于此；split_sentences
    的 soft_limit 仅作超长保险丝）。
    """

    def __init__(self, min_chars: int = 40):
        self.min_chars = min_chars
        self._buf: list[str] = []
        self._n = 0

    def add(self, sentences: list[str]) -> list[str]:
        """加入完整句；累计达到 min_chars 立即输出一批（0 或 1 批）。"""
        self._buf.extend(sentences)
        self._n += sum(len(s) for s in sentences)
        if self._n >= self.min_chars:
            return self.flush()
        return []

    def flush(self) -> list[str]:
        """强制输出待发内容（流结束/空闲兜底用）；无内容返回空表。"""
        if not self._buf:
            return []
        out = ["".join(self._buf)]
        self._buf, self._n = [], 0
        return out

    def clear(self) -> None:
        """丢弃待发内容（打断/停止用）。"""
        self._buf, self._n = [], 0
