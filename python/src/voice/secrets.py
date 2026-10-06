"""secrets.env 加载：repo config/secrets.env + ~/.config/voice/secrets.env → os.environ。

约定（P4-2/P5-1）：云端 Key 一律存 secrets.env（权限 600），不进仓库（.gitignore
已忽略任意目录的 secrets.env）。两处来源：
- repo config/secrets.env：语音实验室插件写入（沙箱内可写 workspace）
- ~/.config/voice/secrets.env：用户手工/早期写入（home 值优先覆盖 repo 值）
"""
from __future__ import annotations

import os
from pathlib import Path

SECRETS_FILE = Path.home() / ".config" / "voice" / "secrets.env"
_REPO_FILE = Path(__file__).resolve().parent.parent.parent / "config" / "secrets.env"


def _parse(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k, v = k.strip(), v.strip()
            if k and v:
                out[k] = v
    except OSError:
        pass
    return out


def load_secrets() -> None:
    """依次 setdefault：repo 文件 → home 文件（home 覆盖 repo，真实 env 最优先）。"""
    for src in (_parse(_REPO_FILE), _parse(SECRETS_FILE)):
        for k, v in src.items():
            os.environ.setdefault(k, v)


def get_key(name: str) -> str:
    """环境变量优先，其次 secrets.env；都没有返回空串。"""
    load_secrets()
    return os.environ.get(name, "")
