#!/usr/bin/env bash
# 下载两个公开数据集（研究/校验用，不进前端）
#   LoL-Draft 2026（CC BY-SA 4.0）真实 BP 顺序
#   ChainCC 2026（CC BY 4.0）职业赛 10/15 分钟经济差
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RAW="$ROOT/data/raw"
mkdir -p "$RAW"

echo "[1/3] LoL-Draft 2026 ..."
curl -L --fail --retry 3 -o "$RAW/lol_draft_2026.inter" \
  "https://raw.githubusercontent.com/DeusExMachina1993/LoL-Draft/main/2026/all_patches/all_patches.inter"

echo "[2/3] ChainCC players 2026 ..."
curl -L --fail --retry 3 -o "$RAW/chaincc-players-2026.csv.gz" \
  "https://chaincc.lol/data/chaincc-players-2026.csv.gz"

echo "[3/3] ChainCC teams 2026 ..."
curl -L --fail --retry 3 -o "$RAW/chaincc-teams-2026.csv.gz" \
  "https://chaincc.lol/data/chaincc-teams-2026.csv.gz"

ls -lh "$RAW"
