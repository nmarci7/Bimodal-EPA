#!/usr/bin/env bash
# Start the EPA workbench: a virtual environment, the requirements, a Java check, the server,
# and the browser.   ./run.sh [port]
set -euo pipefail
cd "$(dirname "$0")"
PORT="${1:-8765}"

PY="${PYTHON:-python3}"
if ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
  echo "Python 3.11 or newer is needed (found: $("$PY" --version 2>&1))." >&2
  exit 1
fi
if [ ! -d .venv ]; then
  echo "Creating .venv …"
  "$PY" -m venv .venv
fi
. .venv/bin/activate
if [ ! -f .venv/.installed ] || [ requirements.txt -nt .venv/.installed ]; then
  pip install --quiet --upgrade pip
  pip install --quiet -r requirements.txt
  touch .venv/.installed
fi

if ! command -v java >/dev/null 2>&1 || ! java -version >/dev/null 2>&1; then
  echo "Warning: no Java runtime found. TLC needs Java 11+; on macOS: brew install openjdk@21." >&2
  echo "         The UI still starts; analyses whose runs are not cached will fail." >&2
fi

URL="http://127.0.0.1:${PORT}"
( sleep 2
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1
  fi ) &
exec python -m epa serve --port "$PORT"
