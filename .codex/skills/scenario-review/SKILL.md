---
name: scenario-review
description: Derive Axl developer scenarios blind to the implementation, freeze them, map them to the session's code and tests, and close confirmed behavioral gaps. Use only when the user explicitly invokes $scenario-review.
---

# Scenario Review

Derive and verify the scenarios for this session's work by following
`.claude/skills/scenario-review/references/procedure.md` (also linked as
`references/procedure.md` beside this file; read it now). This file binds the
procedure's lanes to Codex.

## Lane bindings

| Lane                      | Agent                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| Blind analyst             | `senior-reviewer` with the blind-analyst charter; never given implementation context before freezing |
| Discovery                 | `Explore`                                                                                            |
| Implementation            | `implementer` for established contracts; `senior-implementer` for consequential seams                |
| Hard problems             | `senior-implementer`                                                                                 |
| Verification / fix review | `reviewer` with the frozen-scenario verification or diff-review charter                              |
| Review, seam              | `senior-reviewer` with the focused seam charter                                                      |
| Live-API pass             | the lead, via `$live-api-verification` with the checklist path                                      |

## Platform mechanics

- Start reviewers and blind analysts in fresh context (`fork_turns="none"` when the host exposes that option). Supply raw requirements and artifacts, not the implementation conversation or persuasive rationale. A blind analyst receives only requirements and public behavior until its matrices are frozen.
- Agents return reports through the host final-result channel; resume the same agent thread for follow-up.
