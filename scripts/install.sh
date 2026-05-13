#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js not found. Install Node 20+: https://nodejs.org/" >&2
  exit 1
fi
NODE_MAJOR=$(node --version | sed 's/^v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "✗ Node.js 20+ required. You have $(node --version). Upgrade: https://nodejs.org/" >&2
  exit 1
fi

node "$REPO_ROOT/scripts/install.mjs"
