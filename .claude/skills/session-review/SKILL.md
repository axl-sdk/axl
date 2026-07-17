---
name: session-review
description: Comprehensive adversarial white-box review of the session's net diff via independent reviewer subagents — triage findings, fix the confirmed ones, commit. Use only when the user explicitly invokes this skill.
disable-model-invocation: true
---

Do a comprehensive adversarial multi-perspective **code review** of all the work done this session, using independent reviewer subagents. Choose the perspectives that make the most sense. Honor any base ref or scope note in the user's request; otherwise default to the session's diff.

## Scope (pin it before fanning out)

- Define the review target as a **concrete diff** — the session's commit range / `git diff <base>...HEAD` (base = where this session's work started, or the ref the user supplied). Establish it first.
- Pass that exact diff **and** the relevant plan doc(s) to every reviewer so they all review the same net change. Use the plan(s) as a guide, recognizing we may have deviated on purpose.

## Reviewers (independent, read-only → no isolation)

Launch independent `adversarial-code-reviewer` subagents with **disjoint,
concrete charters**. Default to three composite charters so one review wave is
deep without duplicating expensive work:

- **Correctness / lifecycle / user journeys** — implementation bugs, async
  hazards, and real SDK or Studio consumer paths.
- **Architecture / type-safety / boundary safety** — design fit, invalid states,
  package and public-barrel boundaries, schema/provider/state/event seams, and
  0.x backward compatibility.
- **Tests / edge cases / silent failures** — weak assertions, partial failure,
  concurrency, durability, streaming/redaction/telemetry, usage and cost
  accounting, and places where `MockProvider` cannot prove provider behavior.

Add a dedicated provider/live-API, security, state/data-loss, performance, or
Studio/runtime reviewer only when the diff warrants another high-cost pass.
Respect the session's concurrency limit and use a later wave rather than
oversubscribing the host.

Each finding gets a **verdict** (REAL BUG / NOT A BUG / NEEDS-LIVE-API-VERIFICATION) with **file:line evidence**.

## When reviews finish — triage, don't address-all

1. **De-dupe and triage** across reviewers; assign severity.
2. **Adversarially verify each finding is real before acting** — don't churn code on false positives or stylistic noise. Record a verdict for everything; fix the confirmed ones.
3. **Address additional improvements with a scope guardrail:** fold in high-value / low-risk improvements and adjacent quick fixes (don't skip unrelated quick fixes), but **defer large or risky improvements to logged follow-ups** rather than ballooning this pass.
4. **Commit** the fixes in logical chunks (conventional messages); keep opportunistic/unrelated fixes in **separate commits** per repo convention. Concurrent fix subagents that mutate files get worktree isolation.
5. Consolidate every `NEEDS-LIVE-API-VERIFICATION` verdict into the plan's
   single live-API checklist, or one review-local checklist when no plan exists,
   with the scenario, provider/model, expected behavior, and required evidence.
   Close it with `/live-api-verification`.

## Stance

Act like an owner — methodical and thorough, but an owner also ships and avoids gold-plating. Be grounded in the source; verify before asserting a bug is real.
