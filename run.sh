#!/usr/bin/env bash
# 一条本地命令启动导师配对系统（自动重置演示数据，含换导师案例）
set -euo pipefail
cd "$(dirname "$0")"
PORT="${1:-8000}"
python3 main.py --fresh --port "$PORT"
