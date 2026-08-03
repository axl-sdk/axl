---
name: tackle-plan
description: Drive a named Axl plan or scope through implementation, targeted verification, risk-scaled independent review, live-provider gap tracking, and logical commits using cost-aware Codex agents. Use only when the user explicitly invokes $tackle-plan.
---

# Tackle Plan

Drive the requested plan to genuine completion. Use Sol/medium for the root lead
when model selection is available. The lead owns requirements, architecture,
decomposition, product decisions, final coverage judgment, and finding triage;
raise effort only for measured unresolved complexity.

## Establish done

Define explicit acceptance criteria and affected developer journeys first.
Treat an uncovered journey as unfinished. Continue through research,
implementation, testing, repair, and review; stop only for a genuine product
fork, irreversible action, or missing authority. Never push, publish, or deploy
without explicit approval.

## Route work by cost and risk

- **Discovery:** `repo-explorer` (Luna/medium) for bounded read-only questions.
- **Behavior and test design:** `behavioral-test-analyst` (Terra/high), blind to
  implementation until its scenario and test matrices are frozen.
- **Routine implementation:** `routine-implementer` (Luna default effort) for
  patterned, highly specified work and mechanical implementation of a frozen
  test matrix.
- **Moderate implementation:** `balanced-implementer` (Terra/medium) for settled
  work needing cross-file judgment.
- **Settled boundary implementation:** `boundary-implementer` (Terra/high) only
  after the lead supplies design, invariants, acceptance criteria, ownership,
  verification, and compatibility expectations. Require a focused
  `adversarial-code-reviewer` (Sol/high) pass.
- **Lead-only:** unresolved architecture, meaningful product decisions, breaking
  public API policy, provider/model support policy, security or tenant policy,
  destructive migrations, and irreversible actions.

Do not delegate because a slot exists. Parallelize only work that repays context
and review overhead, with core/shared types before dependent packages. Follow
`.claude/rules/parallel-agents.md` and isolate concurrent writers in worktrees.

## Implement and verify

- For bugs, establish a behavior-focused failing test first when feasible.
- For new features, have `behavioral-test-analyst` freeze a discriminating
  matrix, then give it to a fresh implementer. The root owns coverage judgment.
- Run targeted tests and typechecks while iterating, then the appropriate final
  repository gate after consolidation.
- Commit logical verified chunks in the repository's conventional style. Never
  work on the default branch.

## Scale independent review

- **Small, low-risk:** one `pragmatic-code-reviewer` (Terra/high) with a composite
  correctness, architecture, and tests charter.
- **Moderate or user-facing:** two pragmatic reviewers with disjoint
  correctness/journey and architecture/boundary/test charters.
- **High-risk:** those ordinary lanes plus one focused
  `adversarial-code-reviewer` for provider wire behavior, state/data loss,
  streaming/redaction, security, concurrency, usage/cost, lifecycle, or public
  API compatibility.
- Add another Sol/high pass only for a concrete unresolved high-consequence
  question, never as a generic duplicate.

De-duplicate and verify findings. Record `REAL BUG`, `NOT A BUG`,
`NEEDS-LIVE-API-VERIFICATION`, or `ESCALATE-SOL`; fix confirmed defects and
rerun targeted verification.

Maintain one live-API checklist and close it with `$live-api-verification`.
Never claim real-provider behavior from `MockProvider` or static inspection.
