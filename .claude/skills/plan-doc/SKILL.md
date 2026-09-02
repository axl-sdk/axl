---
name: plan-doc
description: Create a living plan/design doc — journeys → requirements → architecture → phases → acceptance criteria — that feeds tackle-plan and graduates into spec/docs when done.
disable-model-invocation: true
---

Create a living plan for the work in the user's request. The root lead owns
product decisions, architecture, acceptance criteria, and final synthesis. Use
`repo-explorer` for bounded read-only discovery with a precise question and
file-backed evidence. Ask discovery questions rather than design questions and
verify negative claims before they enter the plan under
`.claude/rules/discovery-evidence.md`; do not delegate plan authorship or
trivial discovery.

Default location:
`.internal/plans/<product-area>/active/<name>/plan.md`. Choose the narrowest
durable product owner using `.internal/README.md`, and keep reviews or other
supporting artifacts in the same workstream directory. Public `docs/` are
lasting references, not working plans. Add the workstream to the active index
in `.internal/plans/README.md`. Never force-add `.internal/` content.

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

## Review consequential plans

Before asking for approval on a plan that changes public contracts, structured
output or provider mapping, streaming/events/redaction, durable state,
concurrency, usage/cost accounting, or Axl-owned runtime prompts, give the named
plan artifact to one `pragmatic-code-reviewer`. Charter architecture,
production reachability of every proposed path, and unresolved product forks.
Fold confirmed findings into the plan. A blind `behavioral-test-analyst` pass is
optional for product-heavy behavior; it is not a default plan-review tax.

## Longevity and questions

Mark durable versus ephemeral content. At completion, fold lasting internal
design into `.internal/spec/` and user-facing reference material into public
`docs/`, then move the complete workstream directory from `active/` to
`graduated/`. Preserve useful execution and review evidence there; remove
redundant scratch material. Remove it from the active index in
`.internal/plans/README.md`. Use `paused/` only for accepted work with a
documented reason and resume condition. Update `CHANGELOG.md` for user-visible
changes.

Resolve questions through source inspection or research before asking. Ask only
about real product forks, include a recommendation, and record
architecture-changing assumptions explicitly.

In plan mode, present the full proposed document through the approval surface
before writing it. In normal mode, write it directly.
