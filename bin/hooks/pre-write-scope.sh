#!/bin/bash
# PreToolUse hook for Write / Edit / MultiEdit. Blocks writes to paths
# outside the permitted roots:
#   1. The Claude subprocess's cwd tree (the task's repo)
#   2. ~/.claude/worktrees/ (per-turn worktree dirs)
#   3. The Galt repo root (where this hook lives)
#
# Block strategy: exit 2 with stderr message — the model sees the
# reason and can adapt.
#
# Input (stdin, JSON):
#   { tool_name, tool_input: { file_path: "..." }, cwd: "..." }

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GALT_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
WORKTREES_ROOT="$HOME/.claude/worktrees"

INPUT=$(cat)

FILE_PATH=$(echo "$INPUT" | /usr/bin/jq -r '.tool_input.file_path // ""')
CWD=$(echo "$INPUT" | /usr/bin/jq -r '.cwd // ""')
TOOL=$(echo "$INPUT" | /usr/bin/jq -r '.tool_name // ""')

# No file_path → allow (defensive; shouldn't happen for Write/Edit).
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Resolve to absolute (Claude usually passes absolute, but normalize).
case "$FILE_PATH" in
  /*) ABS_PATH="$FILE_PATH" ;;
  *)  ABS_PATH="$CWD/$FILE_PATH" ;;
esac

# Normalize ../ and ./ — use python since macOS realpath doesn't
# resolve non-existent paths the same way GNU realpath does.
ABS_PATH=$(/usr/bin/python3 -c "import os,sys; print(os.path.normpath(sys.argv[1]))" "$ABS_PATH")

# Check against permitted roots.
allowed=0
for root in "$CWD" "$WORKTREES_ROOT" "$GALT_ROOT"; do
  if [ -n "$root" ]; then
    # Normalize the root too.
    root_abs=$(/usr/bin/python3 -c "import os,sys; print(os.path.normpath(sys.argv[1]))" "$root")
    case "$ABS_PATH" in
      "$root_abs"|"$root_abs"/*) allowed=1; break ;;
    esac
  fi
done

if [ "$allowed" -eq 1 ]; then
  exit 0
fi

# Block. Print to stderr for the model to read.
echo "[pre-write-scope] $TOOL to $ABS_PATH rejected: path not under any permitted root" >&2
echo "[pre-write-scope] permitted roots: cwd=$CWD, worktrees=$WORKTREES_ROOT, galt=$GALT_ROOT" >&2
exit 2
