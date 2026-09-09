---
name: tackle-plan
description: Drive a named Axl plan or scope through implementation, targeted verification, risk-scaled independent review, live-provider gap tracking, and logical commits using cost-aware Codex agents. Use only when the user explicitly invokes $tackle-plan.
---

# Tackle Plan

Drive the requested plan to genuine completion. Select the lead using
`CLAUDE.md` Agent routing: Sol/medium for settled execution, Astra/medium when
the root is the primary reasoner for unresolved consequential questions.
The lead owns requirements, architecture, decomposition, product decisions,
final coverage judgment, and finding triage. Verify host-resolved settings when
available; a skill cannot switch the root model. Preserve explicit user choices.

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
Treat an uncovered accepted journey as unfinished. Continue through research,
implementation, testing, repair, and review; stop only for a genuine product
fork, irreversible action, or missing authority. Never push, publish, or deploy
without explicit approval.

Preserve the plan's goals, acceptance criteria, and explicit owner decisions.
Adapt implementation, decomposition, testing, and sequencing as evidence
emerges, and record material discoveries or deviations in the plan. Ask only
when an adaptation changes product behavior, accepted scope, authority,
irreversible actions, or approved spend.

For a plan under `.internal/plans/`, keep all review artifacts in its workstream
directory. Once accepted scope is implemented and verified, fold durable
content into `.internal/spec/` or public `docs/` and move the whole workstream
from `active/` to `graduated/` as defined by `.internal/README.md`. A stopped or
partially implemented plan remains active, or moves to `paused/` with a reason
and resume condition. Keep the active index in `.internal/plans/README.md`
aligned with lifecycle moves.

Newly discovered journeys outside accepted scope are proposed decisions, not
implicit implementation obligations.

## Monitor orchestration

Read `.claude/skills/tackle-plan/references/orchestration-accountability.md`
at the start. The lead owns its lightweight execution record, milestone
assessment, and bounded process adjustments throughout the work.

## Route work by cost and risk

- **Discovery:** `repo-explorer` for bounded read-only questions.
- **Behavior and test design:** `behavioral-test-analyst`, blind to
  implementation until its scenario and test matrices are frozen.
- **Routine implementation:** `routine-implementer` for
  patterned, highly specified work and mechanical implementation of a frozen
  test matrix.
- **Moderate implementation:** `balanced-implementer` for settled
  work needing cross-file judgment.
- **Settled boundary implementation:** `boundary-implementer` only
  after the lead supplies all five grant elements: design, invariants,
  acceptance criteria, owned files, and verification. A partial grant is not a
  grant and covers only the named seam. Require a focused
  `adversarial-code-reviewer` pass on the consolidated seam diff.
- **Budget implementation:** optional `budget-implementer` for the same settled
  moderate scope when executable checks and scheduling slack make a cost-oriented
  attempt worthwhile. Use `balanced-implementer` on latency-sensitive critical
  paths. Parallel work does not automatically qualify for budget routing.
- **Debug escalation:** `deep-debugger` for uncertain root causes, intermittent
  bugs, concurrency/provider discrepancies, lifecycle failures, or stagnant
  diagnosis. It may edit consequential fixes only under a settled five-part
  grant followed by consolidated adversarial review.
- **Lead-only:** unresolved architecture, meaningful product decisions, breaking
  public API policy, provider/model support policy, security or tenant policy,
  destructive migrations, and irreversible actions.

Do not delegate because a slot exists. Parallelize only work that repays context
and review overhead, with core/shared types before dependent packages. Follow
`.claude/rules/parallel-agents.md` and isolate concurrent writers in worktrees.

Give workers complete owned chunks, relevant contracts, and executable acceptance
criteria. Allow local engineering judgment within settled behavior and invariants;
do not implement the solution twice through overly prescriptive handoffs. Escalate
after two repetitions of the same ineffective approach without new evidence,
not after two productive red/green test iterations. Return unresolved policy or
contracts outside the grant promptly; normal investigation stays with the worker.

## Implement and verify

- Before designing or changing Axl-owned runtime prompts, model-facing schema
  rendering or guidance, retry feedback, routing instructions, built-in tool
  descriptions, or LLM scorers, load and follow `$prompt-iteration`.
- For bugs, establish a behavior-focused failing test first when feasible.
- For substantive new behavior or changed contracts, have `behavioral-test-analyst` freeze a discriminating
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
gets a pragmatic re-check; use a fresh premium pass only for new seam behavior, changed invariants, or a
concrete escalated question.

Resume the idle implementer that built a seam for related fixes, and resume the
reviewer for a focused re-check of its own findings. Spawn fresh for a different
seam or stale context. Never cross the independence boundary: implementers do
not review their own work and `behavioral-test-analyst` remains blind.

Before resumed work edits the tree, require it to re-read the current plan,
status, diff, and owned files. If review or new evidence changes the design,
update the plan first and derive every remaining implementation brief from the
current plan rather than an earlier handoff.

- **Ordinary milestone:** one `pragmatic-code-reviewer` with a composite
  correctness, journeys, architecture, and tests charter.
- **Distinct failure surfaces:** add an independent reviewer only when a separate
  meaningful charter warrants it; user-facing work alone is not a second-review rule.
- **Consequential seams:** require one focused `adversarial-code-reviewer` for
  provider wire behavior, state/data loss, streaming/redaction, security,
  concurrency, usage/cost, lifecycle, or public API compatibility.
- Add another premium pass only for a concrete unresolved high-consequence question.
  Stronger models alone do not establish equivalent review coverage. Explicit
  comprehensive session review still requires at least two perspectives.

Brief reviewers with raw requirements, the concrete diff, and verification
artifacts, without a persuasive account of why the implementation is correct.
Explicitly prohibit edits and artifact-writing commands; confirm the review wave
did not mutate the working tree before accepting findings or committing.

De-duplicate and verify findings. Record `REAL BUG`, `NOT A BUG`,
`NEEDS-LIVE-API-VERIFICATION`, or `ESCALATE-ADVERSARIAL`; fix confirmed defects and
rerun targeted verification.

Maintain one live-API checklist and close it with `$live-api-verification`.
Never claim real-provider behavior from `MockProvider` or static inspection.
