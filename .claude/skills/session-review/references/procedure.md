# Session review — shared procedure

Follow `.claude/references/workflow-handoffs.md` for journey sequencing,
scope, and evidence reuse (read once per task).

Platform-neutral white-box review of the session's net diff by independent
read-only reviewers. Lanes: **review** (composite or focused charter),
**implementation** for fixes, **hard problems** for diagnosis/consequential
fixes, **live-API pass** for provider-only findings.

## Pin scope

Pin the requested scope before reviewing. For a whole-session review, include
committed work since the session base, staged and unstaged changes, and relevant
untracked files. Resolve the base commit (or merge-base with the supplied ref)
explicitly; `git diff <base>...HEAD` alone excludes local work. Use the base-to-
working-tree diff plus `git status --short` and inspect in-scope untracked files.
If the user requests a commit-only range, honor it and name excluded local work.

Give every reviewer the same base SHA, HEAD SHA, path scope, and local-change
inventory. Hold the scoped tree stable; record a content fingerprint or retained
diff for local changes so later edits cannot masquerade as the reviewed revision.
Do not stash or commit user work merely to obtain a review snapshot. Pass raw
requirements and relevant plans, never persuasive correctness rationale. Name the
artifact path each reviewer writes to (the plan's workstream directory when one
exists). Reviewers are read-only; check the scoped snapshot still matches before
accepting findings.

## Choose the wave

Map the diff's failure surfaces to explicit charters before choosing
reviewers. A comprehensive session review always has at least two
independent perspectives with distinct primary responsibilities and intentional
overlap at consequential boundaries; the single-reviewer milestone
check belongs to tackle-plan. One reviewer takes the composite correctness,
journeys, architecture, and tests charter; when the diff carries a
consequential surface (provider wire or effort mapping, structured output,
streaming/redaction, state durability, usage/cost, concurrency, public API
compatibility, security), a second reviewer takes that focused charter.
Without a consequential surface, split ordinary responsibilities explicitly
between the two reviewers (for example correctness/lifecycle/journeys versus
architecture/types/boundaries/tests/silent failures). Use the composite-review
binding for ordinary responsibilities and the focused-seam binding for the
consequential perspective. The classes share an evidence standard; neither is
a surface-only pass. No automatic senior approval follows an ordinary approval.
Add a third only for a distinct uncovered charter or a concrete unresolved
consequential question, not because the diff is large.

For a consequential seam, one of the perspectives may come from the other
platform's review lane (a Claude reviewer on a Codex session or the reverse).
That cross-platform pass is how the fleets get model diversity on the seams
that matter; do not spend a third within-fleet reviewer to get it.

Every finding carries a verdict with file:line evidence: `REAL BUG`,
`NOT A BUG`, `NEEDS-INVESTIGATION`, or `NEEDS-LIVE-API-VERIFICATION`.
Use `NEEDS-INVESTIGATION` for evidence-backed uncertainty: name the unresolved
question, owner, and smallest discriminating check. Do not patch it as a
confirmed defect or approve affected behavior while consequential uncertainty
remains.

## Triage and close

1. De-duplicate across reviewers and assign severity.
2. Verify each finding adversarially before editing; no address-all churn on
   false positives or style noise. Record a verdict for everything.
3. Route settled fixes using established contracts to the implementation
   binding; consequential seam changes go to its senior owner even with a
   settled design, under a seam brief and focused review. Uncertain causes
   or stagnant diagnosis also go to the senior implementation owner.
   Fix confirmed in-scope defects; record unrelated improvements as follow-ups.
4. Verify fixes with the narrowest meaningful gates. Consolidate every
   `NEEDS-LIVE-API-VERIFICATION` verdict into the plan's single live-API
   checklist (or one review-local checklist when no plan exists) and close it
   with the live-API pass; if that pass changes code, rerun the affected gates.
5. Re-pin the net diff and the fix delta. A fix wave that changed behavior is
   reviewed again with the same charter; formatting, documentation, or
   fixture maintenance with unchanged assertions and production behavior is
   verified by the lead. Changed test oracles, weakened assertions, and
   executable configuration are behavior. This exception applies after the
   initial two perspectives, never instead of them.
6. Select final verification from `CLAUDE.md` → Commands and
   `.claude/rules/testing.md`; a review completion does not itself trigger a
   full sweep. Documentation, agent, and skill instruction changes use focused
   validation unless the user requests more or the change affects
   application/build/test behavior. Start any required final full repository
   gate only after implementation has stopped, required reviews have returned,
   and confirmed findings are resolved. Record the reviewed revision, findings,
   gate result, and documentation updates. Commit verified work in logical
   chunks after the required reviews are clean.

## Stance

An owner: thorough about real risk, economical about redundant review,
willing to ship when the evidence supports it. Verify before asserting a bug
is real.
