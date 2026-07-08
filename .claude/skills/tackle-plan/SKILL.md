---
name: tackle-plan
description: Drive a plan to completion autonomously — implement, test, review, commit, parallelizing disjoint work via subagents. Use only when the user explicitly invokes this skill on a named plan or scope.
disable-model-invocation: true
---

Tackle the plan, doc, or work described in the user's request.

Do not stop until everything is done. Find ways to unblock yourself (research, deep-dive the code, test, typecheck) rather than asking. Any live-API integration verification can wait until the end.

Implement, test, review, and commit as you go. Explore / re-plan if needed for large pieces of work.

## Definition of done

"Done" = the plan's explicit acceptance criteria are met and every affected user journey is covered. If the request doesn't carry acceptance criteria / per-journey coverage, establish them first (think like an owner) and treat an uncovered journey as unfinished scope — don't declare done against a vague target.

## When to keep going vs. stop

- **Keep going** for anything you can resolve by research or digging — most blockers.
- **Stop and ask** ONLY for a genuine product fork or an irreversible / destructive action. Otherwise decide as an owner, record the decision + rationale inline, and continue so it can be reviewed later. Never push, publish, or deploy without explicit approval.

## Parallelism (reduce wall-clock + preserve context)

- Parallelize only genuinely **disjoint** chunks, per `.claude/rules/parallel-agents.md`, respecting dependency order: foundation / shared-type changes in the core package (`packages/axl`) land **first**, then fan out across the disjoint dependent packages (`axl-testing`, `axl-eval`, `axl-studio`).
- Delegate parallelizable chunks to subagents, using `isolation: "worktree"` when they mutate files concurrently (each worktree needs `pnpm install`; the repo-root `.env`/API keys are NOT auto-copied — copy them in only if the chunk runs `pnpm test:integration`). Don't isolate work too small to justify the worktree overhead.
- Routine, mechanical, objectively-verifiable chunks can go to the Sonnet `balanced-implementer`; keep silent-failure landmines (Zod schema / structured-output validation, provider effort/thinking mapping & clamping, streaming / redaction / telemetry aggregates, state-store durability & suspend/resume, cost/usage accounting, public-barrel backward-compat) inline and review them.

## Commit & review cadence

- Commit small logical chunks freely as you go (conventional-commit messages, matching the repo's git-log style: `feat(axl):`, `fix(axl):`, `test(axl):`, `docs:`). Never work on the default branch.
- Run the **independent adversarial review at meaningful milestones and on risky surfaces** (Zod schema / structured-output, provider effort/thinking mapping, streaming / redaction / telemetry, state-store durability, cost accounting, public-API/backward-compat) — NOT once per commit.

## Test & review principles

- **Tests try to break things** — hunt gaps/bugs in the logic, not just happy paths.
  - Bug fixes: write the failing test **first** (you), then fix.
  - New features/modules: an **independent subagent** authors the tests after implementation, so coverage isn't biased by the implementer's mental model.
- **Reviews are adversarial**, conducted by **independent `adversarial-code-reviewer` subagents** with disjoint concrete charters: user journeys / scenarios / requirements, edge cases, bugs, architecture, type-safety, provider behavior, and anything else that matters. Each finding gets a verdict (REAL BUG / NOT A BUG / NEEDS-LIVE-API-VERIFICATION) with file:line evidence. Fix what's real before moving on.

## Operating rules

- Maintain a healthy degree of skepticism.
- Be grounded in the source code. Do not make assumptions — answer your own questions with research or by digging into the codebase.
- Always think about different users and their journeys.
- Always think long-term and address the root problem, not the symptom.
- When making product decisions, think like an owner.
- Do not be lazy, do not take shortcuts.
- Defer live-API integration verification to the end, but flag integration-gated risks (real provider behavior — effort/thinking mapping, streaming, `providerMetadata` round-trips, cost accounting) into an end-of-run checklist as you go, and don't mark those surfaces "verified" from `MockProvider` tests alone until `pnpm test:integration` runs.
