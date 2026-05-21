#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../worker-py"

if [[ -x .venv/bin/uvicorn ]]; then
  exec .venv/bin/uvicorn main:app --reload --host 0.0.0.0 --port 8000
fi

exec python3 -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
