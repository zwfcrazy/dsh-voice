"""配置加载：config/voice.toml + 缺省值合并。

路径锚定：包文件位于 <repo>/src/voice/，代码根 = 上溯两级。
可用环境变量覆盖：
- VOICE_HOME：数据根（config/models/assets/logs/.venv 所在地）。
  未设时回落代码根——开发库内直接跑（测试/实验）即此形态，数据随代码；
  打包运行时由 launcher（daemon-start.sh）显式导出，默认 ~/.dsh/voice/。
- VOICE_CONFIG：单独覆盖配置文件位置（测试用，优先级最高）。
"""
from __future__ import annotations

import os
import tomllib
from pathlib import Path

_CODE_ROOT = Path(__file__).resolve().parent.parent.parent
REPO_ROOT = Path(os.environ["VOICE_HOME"]) if os.environ.get("VOICE_HOME") else _CODE_ROOT

DEFAULTS = {
    "audio": {
        "bt_mac": "",
        "bt_name": "",
        "sample_rate": 16000,
        "channels": 1,
        "frame_ms": 80,
        "source": "auto",
        "latency_ms": 80,
    },
    "vad": {
        "engine": "silero",
        "threshold": 0.5,
        "min_speech_ms": 250,
        "min_silence_ms": 600,
        "pre_roll_ms": 200,
    },
    "server": {
        "listen": "127.0.0.1:8076",
    },
    "ring": {
        "seconds": 30,
    },
    "log": {
        "file": "logs/voice.log",
    },
}


def _merge(defaults: dict, user: dict) -> dict:
    out = dict(defaults)
    for k, v in user.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def load_config(path: str | os.PathLike | None = None) -> dict:
    """读取并合并配置；文件缺失时仅用缺省值（关键项留空由调用方告警）。"""
    p = Path(path or os.environ.get("VOICE_CONFIG") or (REPO_ROOT / "config" / "voice.toml"))
    user = {}
    if p.exists():
        with open(p, "rb") as f:
            user = tomllib.load(f)
    cfg = _merge(DEFAULTS, user)
    cfg["_path"] = str(p)
    cfg["_repo_root"] = str(REPO_ROOT)
    return cfg


def frame_bytes(cfg: dict) -> int:
    """一个总线帧的字节数（s16le）。"""
    a = cfg["audio"]
    return a["sample_rate"] * a["channels"] * 2 * a["frame_ms"] // 1000
