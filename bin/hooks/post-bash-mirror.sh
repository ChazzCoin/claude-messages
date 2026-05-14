#!/bin/bash
# PostToolUse hook for Bash. If the Bash exit was non-zero (or stderr
# was non-empty), POSTs a `bash_failure` event to the local backend
# so the companion UI can surface it as a chip on the task card.
#
# Backend route (loopback only, unauthenticated by design):
#   POST http://127.0.0.1:3000/api/internal/bash-failure
#
# Input (stdin, JSON):
#   { session_id, cwd, tool_name, tool_input: { command }, tool_response: { stdout, stderr, ... } }
#
# Fire-and-forget. Never blocks. Always exits 0 — we don't want a hook
# failure to retroactively fail a task that already ran.

set -euo pipefail

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | /usr/bin/jq -r '.session_id // ""')
CWD=$(echo "$INPUT" | /usr/bin/jq -r '.cwd // ""')
CMD=$(echo "$INPUT" | /usr/bin/jq -r '.tool_input.command // ""' | tr '\n' ' ' | cut -c1-500)
STDERR=$(echo "$INPUT" | /usr/bin/jq -r '.tool_response.stderr // ""' | cut -c1-1000)
INTERRUPTED=$(echo "$INPUT" | /usr/bin/jq -r '.tool_response.interrupted // false')

# Failure heuristic: non-empty stderr OR interrupted. We can't read
# exit_code from the current PostToolUse payload shape.
if [ -z "$STDERR" ] && [ "$INTERRUPTED" != "true" ]; then
  exit 0
fi

# Build payload (escape strings via jq).
PAYLOAD=$(/usr/bin/jq -n \
  --arg sid "$SESSION_ID" \
  --arg cwd "$CWD" \
  --arg cmd "$CMD" \
  --arg err "$STDERR" \
  --arg interrupted "$INTERRUPTED" \
  '{session_id:$sid, cwd:$cwd, command:$cmd, stderr:$err, interrupted:($interrupted=="true")}')

# Fire-and-forget — short timeout, ignore errors.
/usr/bin/curl -s -o /dev/null \
  --max-time 2 \
  -H "Content-Type: application/json" \
  -X POST \
  -d "$PAYLOAD" \
  "http://127.0.0.1:3000/api/internal/bash-failure" || true

exit 0
