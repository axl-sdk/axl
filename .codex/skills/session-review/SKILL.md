---
name: session-review
description: Perform a comprehensive white-box review of the session's concrete Axl net diff using independent, risk-scaled Codex reviewers; triage findings, fix confirmed defects, verify, and commit. Use only when the user explicitly invokes $session-review.
---

# Session Review

Review the session's net change, not isolated commits or remembered intent. The
root lead owns scope, risk classification, cross-review triage, fixes, and final
judgment.

## Pin scope

Resolve the session base and head and define one concrete diff. Pass that exact
range and relevant plan documents to every reviewer.

## Choose the review wave

Use the smallest wave that covers the risk deeply. A comprehensive session
review needs at least two independent perspectives; single-reviewer coverage is
for low-risk milestone checks inside `$tackle-plan`.

- **Small, low-risk:** two `pragmatic-code-reviewer` agents with disjoint
  correctness/journey and boundary/test/edge-case charters.
- **Moderate:** two pragmatic reviewers covering correctness/lifecycle/journeys
  and architecture/types/boundaries/tests/silent failures.
- **High-risk:** those two plus one focused `adversarial-code-reviewer` (Sol/high)
  for provider semantics, state/data loss, streaming/redaction, security,
  concurrency, usage/cost, lifecycle, performance, or compatibility.

Add another Sol/high reviewer only in a later wave for a concrete unresolved
high-consequence question. Assign reviewers read-only and avoid overlapping
charters. Treat role `sandbox_mode` as defense in depth because the host may
override it: reviewer instructions must prohibit edits and artifact-writing
commands, and the lead must confirm the wave did not mutate the working tree.
Each finding must include `REAL BUG`, `NOT A BUG`,
`NEEDS-LIVE-API-VERIFICATION`, or `ESCALATE-SOL` with file-backed evidence.

## Triage and close

1. De-duplicate findings and assign severity.
2. Verify every claim before editing; avoid address-all churn.
3. Fix confirmed defects and high-value, low-risk adjacent issues. Log larger
   improvements instead of ballooning the review.
4. Run targeted verification. Consolidate provider-only findings into the
   plan's one live-API checklist, or one review-local checklist, and close it
   with `$live-api-verification`. If live verification changes code, rerun the
   affected targeted checks before continuing.
5. Re-pin the final net diff and the review-fix delta, then run at least one
   focused independent regression review. Use a premium reviewer when the fixes
   touch a consequential seam. If that pass requires material fixes, repeat
   steps 4–5 on the new final diff.
6. Commit only after the final-diff review is clean. Keep unrelated fixes in
   separate logical commits.

Be comprehensive about real risk, economical about redundant review, and
willing to ship when evidence supports it.
