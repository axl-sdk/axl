---
name: tackle-plan
description: Drive a plan to completion autonomously as orchestrator — delegate implementation by default, test, review, commit, parallelizing disjoint work via subagents. Use only when the user explicitly invokes this skill on a named plan or scope.
disable-model-invocation: true
---

Tackle the plan, doc, or work described in the user's request by following
`.claude/skills/tackle-plan/references/procedure.md` (read it now). This file
binds the procedure's lanes to Claude Code.

## Lane bindings

| Lane                 | Agent                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------- |
| Discovery            | `Explore`                                                                             |
| Implementation       | `implementer` for established contracts; `senior-implementer` for consequential seams |
| Hard problems        | `senior-implementer`                                                                  |
| Review, composite    | `reviewer` with the composite charter                                                 |
| Review, focused seam | `senior-reviewer` with the focused seam charter                                       |
| Blind analyst        | `senior-reviewer` with the blind-analyst charter, never given the diff                |
| Live-API pass        | the lead, via `/live-api-verification`; paid calls need the owner's spend approval    |

## Platform mechanics

- Skills are invoked with `/skill`; the prompt-iteration skill is `/prompt-iteration`.
- Resume an agent with `SendMessage`. Named agents must deliver their report to `team-lead` with `SendMessage`; an idle notice without a body means the report did not arrive.
- Concurrent writers use `isolation: "worktree"`; the worktree still needs `pnpm install`, and `.env` must be copied by hand only for live integration tests (there is no `.worktreeinclude`).
- A conversation-coupled chunk that is still real implementation may go to a `fork` subagent (inherits the conversation, runs on the lead's model); never fork reviewers or the blind analyst, since their independence from this conversation is the point.
