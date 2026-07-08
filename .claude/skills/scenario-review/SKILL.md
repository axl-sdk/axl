---
name: scenario-review
description: Black-box behavioral review — derive the user scenarios the work should support (blind to the diff), then verify the implementation satisfies them and fix the gaps. Use only when the user explicitly invokes this skill.
disable-model-invocation: true
---

Outline the user scenarios and journeys the work from this session should support, then verify our implementation satisfies them. Honor any scope note in the user's request; otherwise default to this session's work.

This is **black-box**: derive what the product _should_ do from product/business reasoning — NOT from the implementation. (Its job is to find what's missing or behaviorally wrong; the white-box `session-review` skill finds bugs in what was written.)

## Step 1 — Derive scenarios FIRST, blind to the code

- Think from multiple perspectives; choose the ones that make the most sense (personas, journey families, edge cases, failure/recovery, business-logic boundaries).
- Reason from **business logic and requirements, not implementation details.** Use docs/plans as a _guide_ only, acknowledging we may have drifted on purpose — we want what's best for our architecture, product, and users.
- **Anti-anchoring (load-bearing):** derive the scenarios BEFORE reading the diff. Ideally have an **independent subagent** produce the scenario list **without seeing the implementation**, so coverage isn't biased toward what the code already happens to handle.
- Maintain a healthy degree of skepticism. Think hard about edge cases.

## Step 2 — Only then, verify the implementation

- For each scenario, verify by the **strongest cheap method** — prefer a **test that encodes the scenario** (Vitest + `MockProvider`) over reading code. Green `MockProvider` tests ≠ real provider behavior; flag scenarios that depend on a live provider (effort/thinking mapping, streaming, `providerMetadata` round-trips, cost accounting) into the end-of-run live-API integration checklist and don't mark those "satisfied" from `MockProvider` tests or code-reading alone.
- Emit a **scenario → status matrix**: scenario | expected behavior | satisfied? | evidence | gap. (Reusable — graduates into `.internal/spec/` acceptance criteria and feeds test coverage.)

## Step 3 — Close the gaps, by type

- **Scenario the code gets wrong** = a bug → fix it directly (failing test first where practical), then verify.
- **Scenario the code doesn't handle at all** = possibly real new scope → surface it with a recommendation (the `plan-doc` open-questions pattern); don't silently build meaningful new product. Accept short-term pain for the better long-term state.
- Don't skip unrelated quick fixes. Commit fixes in logical chunks. Parallelize disjoint work via subagents (worktree isolation only when concurrent fixers mutate files).

## Stance

Act like an owner — methodical and thorough, grounded in real product reasoning. Verify before asserting a gap; recommend before building net-new scope.
