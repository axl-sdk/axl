#!/bin/bash
set -o pipefail
# Axl workspace TeammateIdle hook: typecheck + lint before idle
# Exit 2 = keep working, Exit 0 = allow idle

INPUT=$(cat)
TEAMMATE_NAME=$(echo "$INPUT" | jq -r '.teammate_name // "unknown"')

DIR="${CLAUDE_PROJECT_DIR:-.}"

# Only check if TS/JS files changed (staged + unstaged vs HEAD)
CHANGED=$(cd "$DIR" && git diff --name-only --diff-filter=ACMR HEAD 2>/dev/null | grep -E '\.(ts|tsx|js|jsx)$' || true)
[ -z "$CHANGED" ] && exit 0

# Typecheck all packages
TC_OUTPUT=$(cd "$DIR" && pnpm typecheck 2>&1) || {
  echo "Teammate '$TEAMMATE_NAME': TypeScript errors found. Fix type errors before stopping." >&2
  echo "$TC_OUTPUT" | tail -20 >&2
  exit 2
}

# Lint
LINT_OUTPUT=$(cd "$DIR" && pnpm lint 2>&1) || {
  echo "Teammate '$TEAMMATE_NAME': Lint errors found. Fix lint issues before stopping." >&2
  echo "$LINT_OUTPUT" | tail -20 >&2
  exit 2
}

exit 0
