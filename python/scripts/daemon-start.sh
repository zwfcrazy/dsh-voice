#!/usr/bin/env bash
# daemon-start.sh — 前台启动 voice-daemon（systemd/nohup/host spawn 托管由调用方决定）
#
# 布局无关（开发仓 / dsh-voice 包内 python/ 同构）：
#   CODE  = 本脚本所在目录的上一级（内含 src/voice/、scripts/、requirements.txt）
#   HOME  = ${VOICE_HOME:-~/.dsh/voice}（数据根：config/models/assets/logs/.venv）
# venv 解析顺序：VOICE_HOME/.venv（打包形态）→ CODE/.venv（开发仓形态）。
# VOICE_DAEMON_START 供引擎自重启 RPC 回到同一份脚本（见 daemon.py）。
set -euo pipefail

CODE="$(cd "$(dirname "$0")/.." && pwd)"
export VOICE_HOME="${VOICE_HOME:-$HOME/.dsh/voice}"
export VOICE_DAEMON_START="$(readlink -f "$0")"

mkdir -p "$VOICE_HOME/logs"
export PYTHONPATH="$CODE/src${PYTHONPATH:+:$PYTHONPATH}"

PY="${VOICE_PYTHON:-}"
if [[ -z "$PY" ]]; then
    if [[ -x "$VOICE_HOME/.venv/bin/python" ]]; then
        PY="$VOICE_HOME/.venv/bin/python"
    elif [[ -x "$CODE/.venv/bin/python" ]]; then
        PY="$CODE/.venv/bin/python"
    else
        echo "daemon-start: 未找到 venv（$VOICE_HOME/.venv 与 $CODE/.venv 均缺失），请先运行 setup" >&2
        exit 1
    fi
fi

cd "$VOICE_HOME"
exec "$PY" -m voice.daemon
