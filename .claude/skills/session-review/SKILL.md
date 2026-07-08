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

Launch independent `adversarial-code-reviewer` subagents with **disjoint, concrete charters**. Default perspectives (adapt to the work):

- **Correctness / lifecycle** — implementation bugs, gaps, async/lifecycle hazards.
- **User journeys & edge-case scenarios** — does the change hold up across real and adversarial user paths.
- **Architecture & type-safety** — DRY, KISS, SRP, DiP; type-safety; invalid states unrepresentable; convention/dependency-boundary fit.
- **Silent-failure landmines** — Zod schema / structured-output validation, provider effort/thinking mapping & clamping, streaming / redaction / telemetry aggregates, state-store durability & suspend/resume, cost/usage accounting, public-barrel backward-compat (0.x SemVer).
- **Tests & coverage** — gaps, weak assertions, missing edge cases; `MockProvider` tests that stand in for real provider behavior only a live-API integration test can prove.

Each finding gets a **verdict** (REAL BUG / NOT A BUG / NEEDS-LIVE-API-VERIFICATION) with **file:line evidence**.

## When reviews finish — triage, don't address-all

1. **De-dupe and triage** across reviewers; assign severity.
2. **Adversarially verify each finding is real before acting** — don't churn code on false positives or stylistic noise. Record a verdict for everything; fix the confirmed ones.
3. **Address additional improvements with a scope guardrail:** fold in high-value / low-risk improvements and adjacent quick fixes (don't skip unrelated quick fixes), but **defer large or risky improvements to logged follow-ups** rather than ballooning this pass.
4. **Commit** the fixes in logical chunks (conventional messages); keep opportunistic/unrelated fixes in **separate commits** per repo convention. Concurrent fix subagents that mutate files get worktree isolation.

## Stance

Act like an owner — methodical and thorough, but an owner also ships and avoids gold-plating. Be grounded in the source; verify before asserting a bug is real.
