---
name: plan-doc
description: Create a living Axl plan or design doc grounded in developer journeys, requirements, acceptance criteria, architecture, implementation phases, and safe parallelization. Use only when the user explicitly invokes $plan-doc for a named body of work.
---

# Plan Doc

Create the requested living plan. The root lead owns product decisions,
architecture, acceptance criteria, and final synthesis. When model selection is
available, use Sol/medium for the lead and raise effort only for consequential
unresolved ambiguity.

Use `repo-explorer` (Luna/medium) for bounded read-only discovery with a precise
question and file-backed evidence. Do not delegate plan authorship or trivial
discovery.

Default location: `.internal/spec/<name>-plan.md`. This is the gitignored plan
staging area; public `docs/` are lasting references. Never force-add
`.internal/` content.

## Required flow

1. **Developer journeys and scenarios** — define J1, J2, edge cases, and failure
   or recovery paths first.
2. **Product and functional requirements** — tag requirements to journeys.
3. **Acceptance criteria** — make completion explicit and testable per journey.
4. **Architecture** — ground the design in actual files, public types, schemas,
   package boundaries, state/event paths, and provider contracts.
5. **Implementation phases** — map work to independently reviewable commits;
   each phase should leave a working product when possible.
6. **Parallelization** — identify only disjoint scopes. Land core/shared-type
   work before dependent packages and follow `.claude/rules/parallel-agents.md`.
7. **In progress** — track completed, active, live-provider-gated, and deferred
   work.

For Studio UI phases, include a dev-server iteration pass. Maintain one live-API
checklist with scenario, provider/model, expected behavior, and evidence.

Mark durable versus ephemeral content. At completion, graduate lasting internal
design to numbered `.internal/spec/` docs and user-facing material to public
`docs/`; remove or archive execution scaffolding and update `CHANGELOG.md` for
user-visible changes.

Resolve questions through source inspection or research. Ask only about real
product forks, include a recommendation, and record architecture-changing
assumptions. In plan mode, present the full proposal for approval before writing;
in normal mode, write it directly.
