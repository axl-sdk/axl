# Scenario review — shared procedure

Follow `.claude/references/workflow-handoffs.md` for journey sequencing,
scope, and evidence reuse (read once per task).

Platform-neutral black-box behavioral review: derive what the SDK should
do before looking at how the session implemented it. Lanes: **blind
analyst**, **discovery**, **implementation**, **hard problems**,
**verification/fix review**, **live-API pass**. The white-box session review
finds bugs in what was written; this finds what is missing or behaviorally
wrong.

## Step 1: derive scenarios blind

Pin the product scope, then have the blind analyst derive developer journeys,
integration paths, edge cases, failure and recovery paths, compatibility
boundaries, and a discriminating test matrix from requirements and durable
product context only: no diff, changed-file list, implementation summary,
suspected gaps, or intended answer. The lead may already know the
implementation; the blind agent is the isolation boundary. Freeze both
matrices before anyone maps a scenario to code. Scenario completeness is
judgment-heavy: this step runs on the judgment-lane agent, never a cheaper
substitute. Use plans and docs as a guide, acknowledging the session may have
drifted on purpose.

## Step 2: verify after freezing

After freezing, the verification/fix-review lane maps established expectations
to source and test evidence; consequential contracts use the focused-seam lane.
The lead can perform a small bounded check directly. Reviewers remain read-only:
the implementation owner or lead runs tests and supplies artifacts.

For each scenario, choose evidence that discriminates the failure: focused
Vitest, type-level (`*.test-d.ts`), e2e, Studio, or integration tests. Record
static inspection as such. Only provider-dependent claims enter the live-API
checklist; never mark real-provider behavior satisfied from `MockProvider` or
static inspection. Use discovery for bounded source mapping when the owner is
not already localized.

Emit a matrix: `scenario | expected behavior | status | evidence | gap`. It
graduates into `.internal/spec/` acceptance criteria and feeds test coverage.

## Step 3: close gaps by type

- Incorrect implemented behavior is a bug: failing test first where
  practical, fix, verify. Route fixes to the implementation lane; an unclear
  root cause or stagnant diagnosis goes to the hard-problem lane. Consequential
  seam changes also belong to the hard-problem lane even under a settled
  design; they need a seam brief and the focused-seam review binding. Consuming
  an unchanged contract alone is not consequential. Review classes share the
  same evidence standard and inspect beyond the diff as needed; a focused
  review needs no preliminary ordinary pass or automatic second approval.
- Entirely unhandled behavior may be new product scope: surface it with a
  recommendation rather than silently building it.
- Review behavior-changing fixes with the verification/fix-review binding, or
  the focused-seam binding for consequential changes. Resume the same reviewer;
  no preliminary ordinary pass is needed for a seam. The lead checks small
  nonbehavioral corrections directly. Record unrelated fixes as follow-ups.
  Keep new product scope and architecture with the lead; commit verified chunks.
- Put every provider-gated scenario into the plan's single live-API checklist
  (or one review-local checklist) and close it with the live-API pass.

## Stance

Skeptical without inventing scope; verify before declaring a gap; recommend
before building net-new product.
