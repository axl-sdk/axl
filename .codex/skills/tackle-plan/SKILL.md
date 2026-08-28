---
name: tackle-plan
description: Drive a named Axl plan or scope through implementation, targeted verification, risk-scaled independent review, live-provider gap tracking, and logical commits using cost-aware Codex agents. Use only when the user explicitly invokes $tackle-plan.
---

# Tackle Plan

Drive the requested plan to genuine completion. Use Sol/medium for the root lead
when model selection is available. The lead owns requirements, architecture,
decomposition, product decisions, final coverage judgment, and finding triage;
raise effort only for measured unresolved complexity.

The lead orchestrates implementation by default, serial as well as parallel.
Implement directly only when a chunk is smaller than the delegation overhead,
tightly coupled to the live conversation, or inseparable from a product or
architecture decision the lead is making.

Judge that overhead by expected lead round-trips times accumulated lead
context, not step count alone. Keep single-pass work with the lead; batch small
related edits; delegate settled implementation likely to require multiple
edit, debug, or verification cycles. Resume a suitable idle agent before
spawning another when its context remains relevant.

## Establish done

Define explicit acceptance criteria and affected developer journeys first.
Treat an uncovered journey as unfinished. Continue through research,
implementation, testing, repair, and review; stop only for a genuine product
fork, irreversible action, or missing authority. Never push, publish, or deploy
without explicit approval.

Preserve the plan's goals, acceptance criteria, and explicit owner decisions.
Adapt implementation, decomposition, testing, and sequencing as evidence
emerges, and record material discoveries or deviations in the plan. Ask only
when an adaptation changes product behavior, accepted scope, authority,
irreversible actions, or approved spend.

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
  after the lead supplies all five grant elements: design, invariants,
  acceptance criteria, owned files, and verification. A partial grant is not a
  grant and covers only the named seam. Require a focused
  `adversarial-code-reviewer` (Sol/high) pass on the consolidated seam diff.
- **Debug escalation:** return unclear or intermittent bugs, concurrency or
  provider-specific discrepancies, cross-package lifecycle failures, and a
  chunk an implementer has failed twice to the Sol lead for re-scoping or
  direct investigation.
- **Lead-only:** unresolved architecture, meaningful product decisions, breaking
  public API policy, provider/model support policy, security or tenant policy,
  destructive migrations, and irreversible actions.

Do not delegate because a slot exists. Parallelize only work that repays context
and review overhead, with core/shared types before dependent packages. Follow
`.claude/rules/parallel-agents.md` and isolate concurrent writers in worktrees.

## Implement and verify

- Before designing or changing Axl-owned runtime prompts, model-facing schema
  rendering or guidance, retry feedback, routing instructions, built-in tool
  descriptions, or LLM scorers, load and follow `$prompt-iteration`.
- For bugs, establish a behavior-focused failing test first when feasible.
- For new features, have `behavioral-test-analyst` freeze a discriminating
  matrix, then give it to a fresh `routine-implementer` for mechanical tests or
  `balanced-implementer` when the harness needs judgment. The root owns coverage
  judgment.
- Run targeted tests and typechecks while iterating, then the appropriate final
  repository gate after consolidation.
- Commit logical verified chunks in the repository's conventional style. Never
  work on the default branch.

## Scale independent review

Review only a quiescent tree after overlapping implementers have landed. Batch
one review round's findings into a coherent fix wave, commit it, and review the
consolidated delta once. A fix-only wave on an already premium-reviewed seam
gets a pragmatic re-check; use a fresh Sol pass only for new seam behavior or a
concrete escalated question.

Resume the idle implementer that built a seam for related fixes, and resume the
reviewer for a focused re-check of its own findings. Spawn fresh for a different
seam or stale context. Never cross the independence boundary: implementers do
not review their own work and `behavioral-test-analyst` remains blind.

Before resumed work edits the tree, require it to re-read the current plan,
status, diff, and owned files. If review or new evidence changes the design,
update the plan first and derive every remaining implementation brief from the
current plan rather than an earlier handoff.

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
