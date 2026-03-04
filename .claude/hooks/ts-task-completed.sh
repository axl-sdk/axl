#!/bin/bash
set -o pipefail
# Axl workspace TaskCompleted hook: verify typecheck + tests
# Exit 2 = block completion, Exit 0 = allow completion

INPUT=$(cat)
TASK_SUBJECT=$(echo "$INPUT" | jq -r '.task_subject // "unknown"')
TASK_DESC=$(echo "$INPUT" | jq -r '.task_description // ""')

DIR="${CLAUDE_PROJECT_DIR:-.}"

# Typecheck if TS/JS files changed (staged + unstaged vs HEAD)
CHANGED=$(cd "$DIR" && git diff --name-only --diff-filter=ACMR HEAD 2>/dev/null | grep -E '\.(ts|tsx|js|jsx)$' || true)
if [ -n "$CHANGED" ]; then
  TC_OUTPUT=$(cd "$DIR" && pnpm typecheck 2>&1) || {
    echo "Task '$TASK_SUBJECT': TypeScript errors detected. Fix before completing." >&2
    echo "$TC_OUTPUT" | tail -20 >&2
    exit 2
  }
fi

# If task mentions test/spec, run tests
if echo "$TASK_SUBJECT $TASK_DESC" | grep -qi -E '(test|spec|coverage)'; then
  TEST_OUTPUT=$(cd "$DIR" && pnpm test 2>&1) || {
    echo "Task '$TASK_SUBJECT': Tests failing. Fix before completing." >&2
    echo "$TEST_OUTPUT" | tail -30 >&2
    exit 2
  }
fi

exit 0
