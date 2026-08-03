---
name: scenario-review
description: Derive Axl developer scenarios blind to the implementation, freeze them, map them to the session's code and tests, and close confirmed behavioral gaps. Use only when the user explicitly invokes $scenario-review.
---

# Scenario Review

Review what the SDK should do before looking at how the session implemented it.
The root lead owns product-scope decisions and gap triage.

## Derive scenarios blind

Pin product scope, then use `behavioral-test-analyst` (Terra/high). Give it
requirements, acceptance criteria, and durable public context only—no diff,
changed-file list, implementation summary, suspected gaps, or intended answer.
Have it derive developer journeys, integration paths, edge cases, failures,
recovery, compatibility boundaries, and a discriminating test matrix. Freeze
both matrices before mapping anything to code.

This independent reasoning boundary is load-bearing. Do not use Luna for
scenario completeness.

## Verify after freezing

For every scenario, establish expected behavior and verify it by the strongest
cheap method. Prefer discriminating Vitest, type-level, e2e, Studio, or
integration tests over code reading. Use `repo-explorer` for bounded source
mapping, `routine-implementer` for mechanical test additions or clear fixes, and
`balanced-implementer` when the harness or fix needs judgment. Keep new product
scope and architecture with the lead.

Emit `scenario | expected behavior | status | evidence | gap`.

Do not mark real-provider behavior satisfied from `MockProvider` or static
inspection.

## Close gaps

- Incorrect implemented behavior is a bug: write a failing test when practical,
  fix it, and verify.
- Entirely unhandled behavior may be new scope: recommend a decision instead of
  silently building it.
- Commit verified fixes in logical chunks and keep unrelated fixes separate.
- Put provider-gated scenarios into the plan's one live-API checklist, or one
  review-local checklist, and close it with `$live-api-verification`.

Maintain healthy skepticism without inventing scope. Verify before declaring a
gap.
