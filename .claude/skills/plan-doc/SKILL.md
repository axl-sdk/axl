---
name: plan-doc
description: Create a living plan/design doc — journeys → requirements → architecture → phases → acceptance criteria — that feeds tackle-plan and graduates into spec/docs when done.
disable-model-invocation: true
---

Create the living plan doc for the work in the user's request by following
`.claude/skills/plan-doc/references/procedure.md` (read it now). This file
binds the procedure's lanes to Claude Code.

## Lane bindings

| Lane                  | Agent                                                                                |
| --------------------- | ------------------------------------------------------------------------------------ |
| Discovery             | `Explore`                                                                            |
| Review, plan charter  | `reviewer` for established architecture; `senior-reviewer` for consequential changes |
| Blind analyst, opt-in | `senior-reviewer` with the blind-analyst charter                                     |

## Platform mechanics

- Plan mode: present the full document through `ExitPlanMode`; write to `.internal/plans/` only after approval.
- Resume with `SendMessage`; named agents deliver their report to `team-lead` with `SendMessage`.
