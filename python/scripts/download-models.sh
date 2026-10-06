#!/usr/bin/env bash
# download-models.sh — 幂等拉取语音引擎所需模型（Phase 3: sherpa KWS）
# 已存在且非零字节的文件自动跳过。走 scripts/_net.sh 的代理环境。
# MODELS_DIR 可覆盖目标目录（打包 bootstrap 传 $VOICE_HOME/models）；
# 默认为代码根的 models/（开发仓形态）。
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/_net.sh

D="${MODELS_DIR:-models}/sherpa-kws-wenetspeech"
BASE="https://www.modelscope.cn/models/pkufool/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/resolve/master"
mkdir -p "$D"

FILES=(
  "tokens.txt"
  "keywords.txt"
  "keywords_raw.txt"
  "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"
  "decoder-epoch-12-avg-2-chunk-16-left-64.onnx"
  "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"
)

for f in "${FILES[@]}"; do
  if [ -s "$D/$f" ]; then
    echo "skip $f (已存在)"
    continue
  fi
  echo "download $f ..."
  curl -sSL --retry 3 --retry-delay 3 --max-time 300 -o "$D/$f" "$BASE/$f"
done

# 自定义唤醒词词条（默认词；不入远端）。用户可能已换词（面板 wake/set 写此
# 文件）——只在缺失时播种，绝不覆盖既有词条。
if [ ! -s "$D/keywords-dingman.txt" ]; then
  cat > "$D/keywords-dingman.txt" <<'EOF'
n ǐ h ǎo d īng m ǎn @你好丁满
EOF
fi

echo "== 模型就绪: $D =="
ls -la "$D"
