---
name: tackle-plan
description: Drive a named Axl plan or scope to completion as orchestrator — delegate implementation by default through the Codex agent fleet, with targeted verification, risk-scaled independent review, live-provider gap tracking, and logical commits. Use only when the user explicitly invokes $tackle-plan.
---

# Tackle Plan

Drive the requested plan to genuine completion by following
`.claude/skills/tackle-plan/references/procedure.md` (also linked as
`references/procedure.md` beside this file; read it now). This file binds the
procedure's lanes to Codex.

## Lane bindings

| Lane                 | Agent                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------- |
| Discovery            | `Explore`                                                                             |
| Implementation       | `implementer` for established contracts; `senior-implementer` for consequential seams |
| Hard problems        | `senior-implementer`                                                                  |
| Review, composite    | `reviewer` with the composite charter                                                 |
| Review, focused seam | `senior-reviewer` with the focused seam charter                                       |
| Blind analyst        | `senior-reviewer` with the blind-analyst charter, never given the diff                |
| Live-API pass        | the lead, via `$live-api-verification`; paid calls need the owner's spend approval    |

## Platform mechanics

- Start reviewers and blind analysts in fresh context (`fork_turns="none"` when the host exposes that option). Supply raw requirements and artifacts, not the implementation conversation or persuasive rationale. A blind analyst receives only requirements and public behavior until its matrices are frozen.
- Skills are invoked with `$skill`; the prompt-iteration skill is `$prompt-iteration`.
- Agents return their report through the host final-result channel; resume the same agent thread for follow-up rather than spawning a fresh one.
- Concurrent writers get a worktree the lead provisions with `git worktree add`: choose the base ref, run `pnpm install`, and copy `.env` without exposing its contents only when the agent runs live integration tests.
- Root selection follows `CLAUDE.md` → Agent routing. Sessions cache agent definitions at start; a stale session lacking a role is not reconfigured by file edits.
