---
name: session-review
description: Perform a comprehensive white-box review of the session's concrete Axl net diff using independent Codex reviewers; triage findings, fix confirmed defects, verify, and commit. Use only when the user explicitly invokes $session-review.
---

# Session Review

Review the session's net diff by following
`.claude/skills/session-review/references/procedure.md` (also linked as
`references/procedure.md` beside this file; read it now). This file binds the
procedure's lanes to Codex.

## Lane bindings

| Lane                 | Agent                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| Review, composite    | `reviewer` with the composite charter                                                                   |
| Review, focused seam | `senior-reviewer` with the focused seam charter                                                         |
| Cross-platform pass  | a Claude `senior-reviewer` for consequential seams, run by the owner; this session triages its findings |
| Implementation       | `implementer` for established contracts; `senior-implementer` for consequential seams                   |
| Hard problems        | `senior-implementer` for uncertain diagnosis and consequential fixes                                    |
| Live-API pass        | the lead, via `$live-api-verification` with the checklist path                                         |

## Platform mechanics

- Start reviewers and blind analysts in fresh context (`fork_turns="none"` when the host exposes that option). Supply raw requirements and artifacts, not the implementation conversation or persuasive rationale. A blind analyst receives only requirements and public behavior until its matrices are frozen.
- Reviewers run read-only; agents return reports through the host final-result channel. Resume the same agent thread for a recheck.
