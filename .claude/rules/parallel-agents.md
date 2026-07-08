# Parallel Agent Orchestration

<!-- No paths frontmatter — loads unconditionally. Applies whenever multiple
     agents edit the same working tree concurrently. -->

When several agents (or a workflow) edit the **same git working tree** at once:

## Never use `git stash` to "isolate" your build

`git stash` (and `git stash pop/apply`, `git checkout -- .`, `git reset --hard`, `git clean`)
operate on the **entire working tree**, not just your files. Under concurrent agents this is a
data-loss race: a sibling agent that writes a file during your stash window has its change
captured into your stash (or clobbered on restore). Even a clean pop can silently swallow
another agent's in-flight edit.

- **Do not stash, reset, checkout, or clean the tree to get a green build in isolation.** Your
  verification does not justify mutating shared state.
- If a sibling agent's half-finished edit is breaking your build/typecheck, that's **expected
  mid-flight noise** — report it and proceed; do not try to make it disappear. The orchestrator
  reconciles at the end.
- Need an isolated tree? Ask the orchestrator for a **git worktree** (`isolation: "worktree"` on
  the Agent tool) instead. That's the supported isolation primitive; stash is not.

## The pre-commit hook stashes — so isolate concurrent file-mutating work

The pre-commit hook (`.husky/pre-commit`) runs `npx lint-staged` (default behavior — it
**stashes the working tree** around the eslint/prettier pass) followed by `pnpm typecheck`.
Because lint-staged stashes, committing from a **shared** tree while a sibling agent is mid-edit
is a data-loss race — the sibling's unstaged change can be swallowed by the stash. The rule is
therefore simple: **agents that mutate files concurrently must each work in their own worktree,
not share one tree.** Read-only reviewer agents can safely share the tree (they never commit).

## Provisioning a worktree (pnpm workspaces)

A fresh worktree does **not** inherit the main tree's `node_modules`, so one step is required
before any agent works in it:

1. **`pnpm install` in the worktree (required — not automatic).** A detached checkout has no
   pnpm-symlinked `node_modules`, so the `@axlsdk/*` workspace packages (linked via
   `workspace:*`) fail to resolve until install rebuilds the symlinks. It's relatively fast —
   pnpm hardlinks packages from the global store rather than re-downloading.
2. **API keys are NOT copied in.** This repo has no `.worktreeinclude`, so a worktree starts
   without the repo-root `.env`. That only matters for **live-API integration tests**
   (`pnpm test:integration`, gated on `<PROVIDER>_API_KEY`) — the default `pnpm test` uses
   `MockProvider` and needs no keys. If an agent must run integration tests in a worktree, copy
   `.env` in by hand first.

Once provisioned, worktrees are the right tool when agents mutate files concurrently.

## Scope discipline

- Edit only the files in your assigned scope. Disjoint scopes are what make concurrent editing
  safe — a tree-wide git command breaks that guarantee for everyone.
- Respect dependency order: **foundation / shared-type changes in the core package
  (`packages/axl`) land first**, then fan out across the dependent packages (`axl-testing`,
  `axl-eval`, `axl-studio`), which import from it. Never parallelize a dependent package's work
  against an in-flight change to the core types it consumes.
- Run only your own package's targeted `pnpm -F @axlsdk/<pkg> test` / `pnpm -F @axlsdk/<pkg>
  typecheck`. Avoid tree-wide commands (`pnpm -r test`, `pnpm typecheck` across all packages,
  formatters that rewrite untouched files) while siblings are active — the orchestrator runs
  those once at consolidation.

## Verifying a build when the tree has unrelated in-flight changes

Don't sanitize the tree. Either (a) build/test only your package and accept that a transitive
dep may not compile yet (note it in your report), or (b) request a worktree up front. Never
reach for stash.
