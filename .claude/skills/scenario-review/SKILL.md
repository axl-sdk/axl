---
name: scenario-review
description: Black-box behavioral review — derive the user scenarios the work should support (blind to the diff), then verify the implementation satisfies them and fix the gaps. Use only when the user explicitly invokes this skill.
disable-model-invocation: true
---

Derive and verify the scenarios for this session's work by following
`.claude/skills/scenario-review/references/procedure.md` (read it now). Honor
any scope note in the user's request; otherwise default to the session's
work. This file binds the procedure's lanes to Claude Code.

## Lane bindings

| Lane                      | Agent                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------- |
| Blind analyst             | `senior-reviewer` with the blind-analyst charter; never a `fork`, never given the diff |
| Discovery                 | `Explore`                                                                              |
| Implementation            | `implementer` for established contracts; `senior-implementer` for consequential seams  |
| Hard problems             | `senior-implementer`                                                                   |
| Verification / fix review | `reviewer` with the frozen-scenario verification or diff-review charter                |
| Review, seam              | `senior-reviewer` with the focused seam charter                                        |
| Live-API pass             | the lead, via `/live-api-verification` with the checklist path                         |

## Platform mechanics

- Worktree isolation only when concurrent fixers mutate files.
- Resume with `SendMessage`; named agents deliver their report to `team-lead` with `SendMessage`.
