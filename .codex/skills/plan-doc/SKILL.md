---
name: plan-doc
description: Create a living Axl plan or design doc grounded in developer journeys, requirements, acceptance criteria, architecture, implementation phases, and safe parallelization. Use only when the user explicitly invokes $plan-doc for a named body of work.
---

# Plan Doc

Create the living plan requested by the user by following
`.claude/skills/plan-doc/references/procedure.md` (also linked as
`references/procedure.md` beside this file; read it now). This file binds the
procedure's lanes to Codex.

## Lane bindings

| Lane                  | Agent                                                                                |
| --------------------- | ------------------------------------------------------------------------------------ |
| Discovery             | `Explore`                                                                            |
| Review, plan charter  | `reviewer` for established architecture; `senior-reviewer` for consequential changes |
| Blind analyst, opt-in | `senior-reviewer` with the blind-analyst charter                                     |

## Platform mechanics

- Start reviewers and blind analysts in fresh context (`fork_turns="none"` when the host exposes that option). Supply raw requirements and artifacts, not the implementation conversation or persuasive rationale. A blind analyst receives only requirements and public behavior until its matrices are frozen.
- Plan mode: present the full document through the available plan-approval workflow; write to `.internal/plans/` only after approval.
