#!/usr/bin/env bash
# Start the workbench's MCP server (stdio) with the project's virtual environment, from any folder.
# MCP clients run this: Claude Code through .mcp.json in this repository, Claude Desktop or any other
# client through its own config (docs/user-guide.md, "Using the workbench from an assistant").
#   ./mcp.sh [--workspace FILE] [--work DIR]
# stdout belongs to the MCP protocol: everything else goes to stderr.
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "No .venv yet: run ./run.sh once (it creates it and installs the requirements)." >&2
  exit 1
fi
if [ ! -f .venv/.installed ] || [ requirements.txt -nt .venv/.installed ]; then
  .venv/bin/pip install --quiet -r requirements.txt 1>&2
  touch .venv/.installed
fi
exec .venv/bin/python -m epa mcp "$@"
