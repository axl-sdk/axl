# Plan doc — shared procedure

Follow `.claude/references/workflow-handoffs.md` for journey sequencing,
scope, and evidence reuse (read once per task).

Platform-neutral. Lanes: **discovery**, **review** (plan-review charter),
**blind analyst** (opt-in).

The lead owns product decisions, architecture, acceptance criteria, and the
final synthesis, because it holds the conversation. Delegate bounded
read-only discovery when it separates cleanly from decisions: give the
discovery lane a precise discovery question, not a design question, require
file-backed evidence, and verify every negative claim yourself before it
enters the plan (`.claude/rules/discovery-evidence.md`). Do not delegate
authorship, and do not spawn an agent for discovery small enough to do
directly.

Default location: `.internal/plans/<product-area>/active/<name>/plan.md`.
Choose the narrowest durable product owner using `.internal/README.md`; ask
only when the area is genuinely ambiguous. Keep reviews and other supporting
artifacts in the same workstream directory, and add the workstream to the
active index in `.internal/plans/README.md`. Public `docs/` are lasting
references, not working plans. Never force-add `.internal/` content. For a
large multi-increment program, give the durable design its own
`.internal/spec/` home and make this a thinner per-increment plan that
references it.

## Required flow

1. **Developer journeys and scenarios** first (J1, J2, edge, failure, and
   recovery paths; direct SDK use, provider adapters, testing/eval, Studio).
2. **Product and functional requirements**, tagged to the journeys they
   serve.
3. **Acceptance criteria**: explicit and testable per journey. An uncovered
   accepted journey is unfinished scope; a newly discovered journey outside
   it is a proposed decision. This is what tackle-plan drives to.
4. **Architecture**: the best long-term, type-safe design, grounded in real
   files, public types, Zod schemas, package boundaries, state/event paths,
   and provider contracts. Make assumptions visible. Verified premises,
   file:line citations, and internal seam names belong here or in a separate
   `discovery.md`, never in sections 1–3: the blind analyst reads those.
5. **Implementation phases** that map to independently reviewable commits,
   each leaving a working product when logically possible. Mark Studio UI
   phases; each gets a dev-server iteration pass.
6. **Parallelization**: only genuinely disjoint scopes, `packages/axl` core
   and shared types first, at most three concurrent writers per wave with
   further workstreams queued into later waves
   (`.claude/rules/parallel-agents.md`).
7. **In progress**: a living status section for completed, active,
   live-provider-gated, and deferred work, including the single live-API
   checklist (scenario, provider/model, expected behavior, evidence needed).

## Plan review

Before approval, if the plan touches a seam (public types/Zod or barrels,
structured output or provider mapping, streaming/events/redaction, durable
state, concurrency, usage/cost accounting) or an Axl-owned runtime prompt, run
one review pass with the plan-review charter: architecture, production
reachability of every edited or added path, product forks, verdict of at most
ten lines first. Fold its findings into the plan before the approval step. A
blind-analyst scenario pass is opt-in for product-heavy plans, not default:
one targeted reviewer finds real blockers cheaply before code exists.

Use the plan-review binding for established architecture or consequential
contract/architectural changes as appropriate. Both classes use the same
evidence standard and may trace beyond the proposed edits; no preliminary
ordinary review or automatic second approval is required. The opt-in blind
analyst uses its dedicated binding, sees only requirements/public behavior,
and freezes its matrices before receiving implementation detail. Name the
artifact path each reviewer writes to in the workstream directory. Resume the
same reviewer for related rechecks; never reuse an implementer as its reviewer.

## Longevity

The doc is a staging artifact. Mark each section durable or ephemeral. When
the work completes, fold lasting internal design into `.internal/spec/` and
user-facing reference material into public `docs/`, update `CHANGELOG.md` for
user-visible changes, then move the whole workstream directory from `active/`
to `graduated/` and remove it from the active index. Preserve useful execution
and review evidence; remove redundant scratch material. Use `paused/` only for
accepted work with a documented reason and resume condition.

## Open questions

Resolve what the code or research can settle before asking. Ask only about
questions that meaningfully change the product, at the end, with a
recommendation; think long-term and accept short-term pain for a better end
state. An architecture-changing guess is recorded as an explicit assumption
("assumed X; if wrong, Phase N changes"), never baked in silently.

## Plan-mode behavior

In a surface with plan mode, research and derive normally, then present the
full document through that surface's approval mechanism and write it only
after approval; plan mode gates the write, not the thinking. In normal mode,
write it directly.
