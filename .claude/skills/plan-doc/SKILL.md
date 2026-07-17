---
name: plan-doc
description: Create a living plan/design doc — journeys → requirements → architecture → phases → acceptance criteria — that feeds tackle-plan and graduates into spec/docs when done.
disable-model-invocation: true
---

Create a living plan doc for the work described in the user's request.

The root/orchestrating lead owns final synthesis because it holds the product
conversation and decision context. Delegate bounded code discovery when useful,
but do not delegate authorship of product decisions, architecture choices,
acceptance criteria, or the final plan.

Default location: `.internal/spec/<name>-plan.md` (the gitignored internal-spec staging area; the public `docs/` tree is flat reference guides, not a home for working plans, and must never accrue changelog-style plan docs). For a large multi-increment program, give the durable architecture its own numbered `.internal/spec/` doc and make this a thinner per-increment plan that references it. **Never `git add -f` anything under `.internal/`.**

## What the doc must contain, in this flow

1. **User journeys & scenarios** — lead with these (J1, J2…). Be thorough; think about edge cases and different user types up front.
2. **Product & functional requirements** — what must be supported, tagged to the journeys they serve.
3. **Acceptance criteria / definition of done** — explicit and testable, per journey. Treat an uncovered journey as unfinished scope. (This is what the `tackle-plan` skill drives to — emit it deliberately.)
4. **Architecture** — the best long-term design, type-safe, making invalid states unrepresentable. Ground it in the actual source; reference real files/types/schemas by name, not assumptions.
5. **Implementation phases** — specific, logical phases that map to independently-reviewable commits. **Every phase ends in a working product** (unless it logically can't). Note where visual UI changes occur (Studio is the only UI surface) — each gets a Studio dev-server iteration pass (`pnpm --filter @axlsdk/studio dev`, seed demo state, visually review and drive the design).
6. **Parallelization** — clearly outline which phases/chunks can run concurrently. Only genuinely **disjoint** scopes, foundation/shared-type changes in the core package (`packages/axl`) first, then the dependent packages, per `.claude/rules/parallel-agents.md`.
7. **In-progress section** — a living status area we update during implementation (what's done, what's in flight, deferred follow-ups).

## Longevity — staging now, graduate later

This doc is a **working/staging artifact**, not a permanent home. Mark each section's longevity (durable vs ephemeral). When the work completes, **graduate** the durable content to its permanent tier — durable design/requirements/architecture → the numbered internal specs in `.internal/spec/` (gitignored); user-facing reference → the public `docs/` guides (authority order in `.claude/rules/documentation.md`: `docs/api-reference.md` for option types/values/defaults) — and let the ephemeral execution scaffolding (phases, parallelization map, in-progress log) archive or die with this doc. Update `CHANGELOG.md` (`[Unreleased]`) for user-visible changes. Don't leave a combined doc to rot (`docs/` are references, not changelogs).

## Open questions

Resolve everything you can by digging into the code or research — do that first, don't punt. For questions that genuinely need the owner's input because they **meaningfully change the product**, ask at the end **with your recommendation included** (think long-term; accept short-term pain for a better long-term state). If a question changes the _architecture_, don't silently bake in a guess — record it as an explicit assumption ("assumed X; if wrong, Phase N changes") so it's visible.

## Principles

- Think like a great architect and PM. Sections should be logical and flow into each other.
- Be grounded in the source code. Do not make assumptions you can resolve by reading it.
- Maintain a healthy degree of skepticism; think long-term and address the root problem.

## Plan-mode behavior

If invoked in a product surface with plan mode, do all research, code-grounding,
and derivation normally, then present the **full doc content as the proposed
plan** through that surface's approval mechanism. In Claude Code this is
`ExitPlanMode`; in Codex use the available plan approval workflow. Write the doc
to `.internal/spec/` only after approval. Plan mode gates the file write, not the
thinking. In normal mode, write the doc directly.
