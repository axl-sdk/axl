# Documentation is living — update it in the same change

All docs are living documents. When you add, rename, remove, or change an API, flag,
file, or behavior, update the documentation in the **same** change. Prefer pointers to
source over restating volatile specifics (versions, prices, model lists, exact
defaults) — those rot, and the source is the ground truth.

## Authority order
1. `docs/api-reference.md` — authoritative for option types, valid values, defaults.
2. Other `docs/` guides — deep narrative + recipes.
3. Package `README.md` — package-level quick start.
4. `CLAUDE.md` / `.claude/rules/` — durable conventions for agents; never a changelog.

## Writing style

Public docs (`docs/`, package READMEs, `CHANGELOG.md`, `ROADMAP.md`) are written for
the people using Axl. Specs and plans under `.internal/` can be as detailed as the
design needs.

- **Organize guides around tasks.** Start a section with what it lets the reader do,
  then show a short, runnable example, then cover the details. Show a concept before
  you explain how the pieces fit together.
- **Use the reader's words.** Avoid internal or review vocabulary ("facade",
  "projection", "settlement", "admission", "truthful", "disjoint") in public docs. Say
  "the request Axl sent", "when the call finished", "the repair retry".
- **Say what happens, not what doesn't.** Write "cost is absent when you didn't report
  one," not "never fabricated as zero." Answering a reviewer's objection belongs in the
  spec.
- **Put each fact in one place.** Field lists, defaults and exhaustive guarantees go in
  `docs/api-reference.md`; guides link to them. State a caveat once and link to it from
  elsewhere.
- **Use structure where it helps scanning.** Use a table for field → meaning or
  provider → behavior. Use bullets for lists of three or more parallel items. Keep
  paragraphs to about five lines.
- **Don't write rot-prone words.** "New", "now" and "older v1 records" only make sense
  in `CHANGELOG.md`; elsewhere describe current behavior.
- **Keep changelog entries scannable.** Start with a short bold label, then say what a
  user can now do in one or two sentences, followed by any migration step or caveat. Leave
  out implementation detail and link to the guide.
- **Keep READMEs brief.** A package README gets a capability sentence, a minimal example
  and a link to the guide, not the full contract.
- **Fix as you go.** When you edit near a passage that breaks these rules, rewrite it in
  the same change, keeping every factual claim.

## Where each subsystem is documented (update these when you touch it)
| Subsystem | Authoritative docs |
|---|---|
| Providers, effort/thinking, rate limiting, pricing | `docs/providers.md` |
| Events / streaming / `ctx.events` / trace levels / aggregates | `docs/observability.md`, `docs/migration/*` |
| Redaction | `docs/observability.md` + `docs/security.md` |
| Guardrails / validate / approval / right-to-be-forgotten / multi-tenant | `docs/security.md` |
| State stores / RedisStore / streaming persistence / recovery | `docs/integration.md`, `docs/migration/state-store-durability.md` |
| Memory + embedder cost | `docs/observability.md` |
| Studio REST / WS / middleware | `docs/studio-api.md` |
| Testing / MockProvider / assertions | `docs/testing.md` |
| Eval scorers / CLI / compare | `docs/testing.md` (+ `docs/api-reference.md`) |
| Architecture overview | `docs/architecture.md` |
| Examples / patterns | `docs/use-cases.md` |

## Also keep current
- `CHANGELOG.md` — an entry under `[Unreleased]` for every user-visible change (Keep a
  Changelog format; SemVer per the 0.x rule in `releasing.md`).
- `ROADMAP.md` — when scope or direction changes.
- `.internal/spec/` — durable gitignored design contracts; update alongside the
  feature they describe.
- `.internal/plans/<product-area>/<lifecycle>/<workstream>/` — gitignored living
  plans and their review artifacts. Follow `.internal/README.md`; graduate a
  completed workstream only after lasting content reaches `.internal/spec/` or
  public `docs/`.
- `.internal/research/<subject-area>/` — durable gitignored decision inputs that
  are neither authoritative specs nor accepted implementation plans. Revalidate
  time-sensitive research before using it.
- **Never `git add -f` `.internal/` content.**
- Package `README.md` files when their package's public surface changes.

## Known doc gaps (don't assume coverage)
The eval failure-rate gates, conditional scorers, and the full `axl-eval` CLI flag set
are richer in code than in `docs/` today. If you extend them, expand the docs rather
than leaning on this rule. See `.claude/rules/eval.md`.
