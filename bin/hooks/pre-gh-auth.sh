#!/bin/bash
# PreToolUse hook for mcp__github__* tools. Verifies `gh` CLI is
# authenticated before letting the call through. Catches the
# "auth expired silently" failure mode at the gate instead of
# letting the model retry-loop on a 401.
#
# Block strategy: exit 2 with a clear stderr message.

set -euo pipefail

# gh resolves from PATH; common locations to fall back to if PATH
# is minimal in the subprocess env.
GH_BIN="${GH_BIN:-}"
if [ -z "$GH_BIN" ]; then
  for candidate in \
      "/opt/homebrew/bin/gh" \
      "/usr/local/bin/gh" \
      "$(command -v gh 2>/dev/null || true)"; do
    if [ -x "$candidate" ]; then
      GH_BIN="$candidate"
      break
    fi
  done
fi

if [ -z "$GH_BIN" ] || [ ! -x "$GH_BIN" ]; then
  echo "[pre-gh-auth] gh CLI not found on disk; install with: brew install gh" >&2
  exit 2
fi

if ! "$GH_BIN" auth status >/dev/null 2>&1; then
  echo "[pre-gh-auth] gh not authenticated. Run: gh auth login" >&2
  exit 2
fi

exit 0
