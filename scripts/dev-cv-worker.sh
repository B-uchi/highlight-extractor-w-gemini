#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../worker-py"

# Never exec `.venv/bin/uvicorn` directly: console_scripts use a stale shebang
# if this repo / venv moved (shows as "bad interpreter: No such file or directory").
VENV_PYTHON=".venv/bin/python3"
if [[ -x "${VENV_PYTHON}" ]] &&
  "${VENV_PYTHON}" -c "import uvicorn" >/dev/null 2>&1; then
  exec "${VENV_PYTHON}" -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
fi

exec python3 -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
