---
name: tackle-plan
description: Drive a plan to completion autonomously — implement, test, review, commit, parallelizing disjoint work via subagents. Use only when the user explicitly invokes this skill on a named plan or scope.
disable-model-invocation: true
---

Drive the requested plan to genuine completion. The root lead owns requirements,
architecture, decomposition, product decisions, final coverage judgment, and
finding triage. Lead at medium effort; raise it only when unresolved architecture
or conflicting evidence gives deeper reasoning a concrete payoff.

## Establish done

Turn the plan into explicit acceptance criteria and affected developer journeys
before implementation. Treat an uncovered journey as unfinished work. Continue
through research, implementation, testing, repair, and review; stop only for a
genuine product fork, irreversible action, or missing authority. Never push,
publish, or deploy without explicit approval.

## Route work by cost and risk

- **Discovery:** `repo-explorer` (Sonnet/low) for bounded read-only questions.
- **Behavior and test design:** `behavioral-test-analyst` (Sonnet/high), blind to
  the diff and implementation rationale until its scenario and test matrices
  are frozen.
- **Routine implementation:** `routine-implementer` (Sonnet/low) for patterned,
  highly specified, objectively verifiable work and mechanical implementation
  of a frozen test matrix.
- **Moderate implementation:** `balanced-implementer` (Sonnet/medium) for settled
  work needing cross-file or framework judgment.
- **Settled boundary implementation:** `boundary-implementer` (Sonnet/high) only
  after the lead supplies design, invariants, acceptance criteria, ownership,
  verification, and compatibility expectations. Require a focused
  `adversarial-code-reviewer` (Opus/high) pass before acceptance.
- **Lead-only:** unresolved architecture, meaningful product decisions, breaking
  public API policy, provider/model support policy, security or tenant policy,
  destructive migrations, and irreversible actions.

Do not delegate because a slot exists. The chunk must repay context and review
overhead. Parallelize only disjoint scopes, core/shared types first, under
`.claude/rules/parallel-agents.md`; isolate concurrent writers in worktrees.

## Implement and verify

- For bugs, establish the behavior-focused failing test first when feasible.
- For new features, have `behavioral-test-analyst` freeze a discriminating
  matrix from acceptance criteria and public behavior, then give it to a fresh
  implementer. The root owns coverage judgment and product questions.
- Run targeted tests and typechecks while iterating, then the appropriate final
  repository gate once work is consolidated.
- Commit logical verified chunks in the repository's conventional style. Never
  work on the default branch.

## Scale independent review

- **Small, low-risk diff:** one `pragmatic-code-reviewer` with a composite
  correctness, architecture, and tests charter.
- **Moderate or user-facing diff:** two pragmatic reviewers with disjoint
  correctness/journey and architecture/boundary/test charters.
- **High-risk diff:** those ordinary lanes plus one focused
  `adversarial-code-reviewer` for provider wire behavior, state/data loss,
  streaming/redaction, security, concurrency, usage/cost, lifecycle, or public
  API compatibility.
- Add another premium pass only for a concrete unresolved high-consequence
  question, never as a generic duplicate.

De-duplicate and verify findings. Record `REAL BUG`, `NOT A BUG`,
`NEEDS-LIVE-API-VERIFICATION`, or `ESCALATE-OPUS`; fix confirmed defects and
rerun targeted verification.

Maintain one live-API checklist in the plan and close it with
`/live-api-verification`. Never claim real-provider behavior from
`MockProvider` or static inspection.
