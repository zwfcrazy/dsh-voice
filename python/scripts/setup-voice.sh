#!/usr/bin/env bash
# setup-voice.sh — dsh-voice 打包形态的一键 bootstrap（首次安装/升级依赖/修复）
#
# 与开发仓 scripts/setup.sh 的区别：venv 与全部数据落 VOICE_HOME（默认 ~/.dsh/voice），
# 而不是代码目录内。幂等：已存在的文件不覆盖（用户配置/已换唤醒词/已下模型）。
#
# 用法: bash setup-voice.sh [--proxy URL|none]
# 步骤: venv → 依赖 → 种子资源（assets/models/config 模板）→ sherpa 模型下载
set -euo pipefail

CODE="$(cd "$(dirname "$0")/.." && pwd)"
export VOICE_HOME="${VOICE_HOME:-$HOME/.dsh/voice}"

if [[ "${1:-}" == "--proxy" && -n "${2:-}" ]]; then
    export VOICE_PROXY="$2"
fi
# shellcheck source=scripts/_net.sh
source "$CODE/scripts/_net.sh"

echo "==> CODE=$CODE"
echo "==> VOICE_HOME=$VOICE_HOME  (代理: ${VOICE_PROXY})"
mkdir -p "$VOICE_HOME"/{config,models,logs,assets/tts-cache,assets/music}

echo "==> 创建/复用 venv"
if [[ ! -x "$VOICE_HOME/.venv/bin/python" ]]; then
    python3 -m venv "$VOICE_HOME/.venv"
fi
# venv pip.conf：官方源 + 当前代理（未激活时 .venv/bin/pip 也能用）
cat > "$VOICE_HOME/.venv/pip.conf" <<EOF
[global]
index-url = ${PIP_INDEX_URL:-https://pypi.org/simple/}
proxy = ${VOICE_PROXY}
EOF

source "$VOICE_HOME/.venv/bin/activate"
echo "==> 升级 pip / wheel / setuptools"
pip install --no-cache-dir --timeout 30 -q -U pip wheel setuptools
echo "==> 安装依赖（$CODE/requirements.txt）"
pip install --no-cache-dir --timeout 30 -q -r "$CODE/requirements.txt"

echo "==> 播种资源（seed/ → VOICE_HOME，不覆盖已有文件）"
if [[ -d "$CODE/seed" ]]; then
    cp -rn "$CODE/seed/." "$VOICE_HOME/"
fi

echo "==> 下载 sherpa KWS 模型（幂等，已存在跳过）"
MODELS_DIR="$VOICE_HOME/models" bash "$CODE/scripts/download-models.sh"

date -Is > "$VOICE_HOME/.bootstrap-ok"
echo "==> bootstrap 完成: $(cat "$VOICE_HOME/.bootstrap-ok")"
echo "    启动: bash $CODE/scripts/daemon-start.sh（或由 dsh-voice 插件自动拉起）"
