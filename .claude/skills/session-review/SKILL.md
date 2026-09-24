---
name: session-review
description: Comprehensive adversarial white-box review of the session's net diff via independent reviewer subagents — triage findings, fix the confirmed ones, commit. Use only when the user explicitly invokes this skill.
disable-model-invocation: true
---

Review the session's net diff by following
`.claude/skills/session-review/references/procedure.md` (read it now). Honor
any base ref or scope note in the user's request; otherwise default to the
session's diff. This file binds the procedure's lanes to Claude Code.

## Lane bindings

| Lane                 | Agent                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Review, composite    | `reviewer` with the composite charter                                                                              |
| Review, focused seam | `senior-reviewer` with the focused seam charter                                                                    |
| Cross-platform pass  | a Codex `senior-reviewer` for consequential seams, run by the owner; this session records and triages its findings |
| Implementation       | `implementer` for established contracts; `senior-implementer` for consequential seams                              |
| Hard problems        | `senior-implementer` for uncertain diagnosis and consequential fixes                                               |
| Live-API pass        | the lead, via `/live-api-verification` with the checklist path                                                     |

## Platform mechanics

- Reviewers are read-only subagents; no worktree isolation is needed for them.
- Resume with `SendMessage`; named agents deliver their report to `team-lead` with `SendMessage`.
