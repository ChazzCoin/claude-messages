#!/bin/bash
# PreToolUse hook for Bash. Appends one line to logs/audit.log per
# invocation. Always allows (exit 0) — this is audit-only.
#
# Input (stdin, JSON):
#   { session_id, cwd, tool_name, tool_input: { command, description } }
#
# Output: nothing. Side effect: line appended to <galt-root>/logs/audit.log
# Format: <ISO-8601> session=<sid> cwd=<dir> cmd=<oneline-truncated>

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GALT_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
LOG_DIR="$GALT_ROOT/logs"
LOG_FILE="$LOG_DIR/audit.log"

mkdir -p "$LOG_DIR"

INPUT=$(cat)

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SESSION_ID=$(echo "$INPUT" | /usr/bin/jq -r '.session_id // "unknown"')
CWD=$(echo "$INPUT" | /usr/bin/jq -r '.cwd // "unknown"')
CMD=$(echo "$INPUT" | /usr/bin/jq -r '.tool_input.command // ""' | tr '\n' ' ' | cut -c1-500)

echo "$TIMESTAMP session=$SESSION_ID cwd=$CWD cmd=$CMD" >> "$LOG_FILE"

exit 0
