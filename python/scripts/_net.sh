#!/usr/bin/env bash
# _net.sh — 统一的下载代理环境（被 setup.sh / doctor / 下载脚本 source）
# 约定（P0-2 已确认，2025-09-05）：
#   默认全走代理 http://192.168.31.46:7897 + 官方源（PyPI / HuggingFace）
#   VOICE_PROXY=<url>   覆盖代理地址
#   VOICE_PROXY=none    禁用代理（直连兜底）
set -euo pipefail

VOICE_PROXY="${VOICE_PROXY:-http://192.168.31.46:7897}"

if [[ "$VOICE_PROXY" == "none" ]]; then
    unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY 2>/dev/null || true
else
    export http_proxy="$VOICE_PROXY" https_proxy="$VOICE_PROXY"
    export HTTP_PROXY="$VOICE_PROXY" HTTPS_PROXY="$VOICE_PROXY"
    export PIP_INDEX_URL="${PIP_INDEX_URL:-https://pypi.org/simple/}"
    export PIP_EXTRA_INDEX_URL=""   # 清空镜像 extra-index，避免回落到慢速源
fi
