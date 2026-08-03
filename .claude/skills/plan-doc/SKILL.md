---
name: plan-doc
description: Create a living plan/design doc — journeys → requirements → architecture → phases → acceptance criteria — that feeds tackle-plan and graduates into spec/docs when done.
disable-model-invocation: true
---

Create a living plan for the work in the user's request. The root lead owns
product decisions, architecture, acceptance criteria, and final synthesis. Use
`repo-explorer` for bounded read-only discovery with a precise question and
file-backed evidence; do not delegate plan authorship or trivial discovery.

Default location: `.internal/spec/<name>-plan.md`. This is the gitignored plan
staging area; public `docs/` are lasting references, not working plans. Never
force-add `.internal/` content.

## Required flow

1. **User journeys and scenarios** — define J1, J2, edge cases, and failure or
   recovery paths first.
2. **Product and functional requirements** — tag requirements to the journeys
   they serve.
3. **Acceptance criteria** — make completion explicit and testable per journey.
   An uncovered journey remains unfinished scope.
4. **Architecture** — ground the long-term design in actual files, public types,
   schemas, package boundaries, state/event paths, and provider contracts. Make
   assumptions visible.
5. **Implementation phases** — map work to independently reviewable commits.
   Each phase should leave a working product when logically possible.
6. **Parallelization** — identify only disjoint scopes. Land foundation and
   shared-type changes in `packages/axl` before dependent packages and follow
   `.claude/rules/parallel-agents.md`.
7. **In progress** — track completed, active, live-provider-gated, and deferred
   work.

For Studio UI phases, include a dev-server iteration pass. Keep one live-API
verification checklist with the scenario, provider/model, expected behavior,
and evidence required.

## Longevity and questions

Mark durable versus ephemeral content. At completion, graduate lasting internal
design to the numbered `.internal/spec/` docs and user-facing reference material
to public `docs/`; archive or remove execution-only phases and status logs.
Update `CHANGELOG.md` for user-visible changes.

Resolve questions through source inspection or research before asking. Ask only
about real product forks, include a recommendation, and record
architecture-changing assumptions explicitly.

In plan mode, present the full proposed document through the approval surface
before writing it. In normal mode, write it directly.
