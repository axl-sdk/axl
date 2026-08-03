# Axl — TypeScript SDK for Agentic Systems

Axl is an open-source TypeScript SDK for orchestrating agentic systems. It treats
concurrency, structured output, uncertainty, and cost as first-class primitives.

> **This file is the index.** Task-scoped conventions live in `.claude/rules/` (auto-loaded
> when you touch the matching package). Deep reference lives in `docs/`. **The source code
> and `docs/api-reference.md` are the ground truth** — when this file disagrees with the
> code, the code wins; fix the doc. Prefer pointers over restating volatile specifics
> (versions, prices, model lists, exact defaults) — those rot.

## Architecture
Monorepo (pnpm workspaces), four packages:
- `packages/axl` — Core SDK: `tool()`, `agent()`, `workflow()`, `AxlRuntime`,
  `WorkflowContext`, provider adapters, state stores, memory, telemetry.
- `packages/axl-testing` — `MockProvider`, `MockTool`, `AxlTestRuntime`.
- `packages/axl-eval` — `dataset()`, `scorer()`, `llmScorer()`, eval runner + `axl-eval` CLI.
- `packages/axl-studio` — Local dev UI: Hono server + React SPA wrapping a runtime; also
  embeddable middleware.

## Tech stack
TypeScript (strict, ESM) · Zod v4 (peer dep `zod@^4`) · Vitest · pnpm workspaces · Node 20+ ·
tsup (ESM + CJS + DTS).

## Core conventions
- **Agentic primitives are on `ctx`**: `ctx.ask` / `delegate` / `spawn` / `vote` / `verify` /
  `race` / `parallel` / `map` / `budget` / `awaitHuman` / `remember` / `recall` / `forget` /
  `log` / `checkpoint`. Signatures: `docs/api-reference.md`.
- **Provider URI scheme**: `provider:model` (e.g. `openai:gpt-4o`, `anthropic:…`,
  `openai-responses:…`). `ProviderRegistry` resolves + lazy-instantiates.
- **Agents are inert** definitions until called via `ctx.ask()` / `agent.ask()`.
  **Workflows** are named async functions receiving a `WorkflowContext`.
- **Schemas are Zod**; tool input and structured output both validate through Zod
  (`zodToJsonSchema` wraps `z.toJSONSchema()`).
- **`effort`** is the unified cross-provider reasoning knob (`'none'`…`'max'`); per-provider
  mapping/clamping lives in the adapters — see `.claude/rules/providers.md` + `docs/providers.md`.
- **ESM imports use the `.js` extension** in source (`import './x.js'`), even from `.ts`.
- **Public API = the barrel** (`packages/*/src/index.ts`). Read the barrel; don't maintain a
  hand-written export list.

## Living documentation (always)
Docs are living. **In the same change that touches code, update the affected docs.** Authority
order: `docs/api-reference.md` (option types/values/defaults) > other `docs/` guides > package
READMEs. Also keep `CHANGELOG.md` (`[Unreleased]`), `ROADMAP.md`, and the gitignored
`.internal/spec/` + `.internal/docs/` current. The subsystem → doc map is in
`.claude/rules/documentation.md`.

## Commands
```bash
pnpm test            # all tests (unit + e2e + studio) — MockProvider, no API keys
pnpm -r typecheck    # type-check, no emit
pnpm build           # build all packages (tsup)
pnpm test:e2e | test:studio | test:smoke | test:integration   # routine live integration
pnpm test:integration:frontier                                # paid newest-model certification
pnpm --filter @axlsdk/studio dev    # Studio: concurrent Vite + server dev
```
Run from the repo root. Per-area detail: `.claude/rules/testing.md` and the package rules.

## `.claude/rules/` map
- `documentation.md` — what to update where (always loaded)
- `core-sdk.md` — `packages/axl` orchestration core
- `providers.md` — provider adapters
- `events-streaming-redaction.md` — AxlEvent model, streaming views, redaction
- `state-and-memory.md` — state stores, memory + embedder
- `eval.md` — `axl-eval` scorers, runner, CLI
- `studio.md` — Studio server / middleware / client
- `testing.md` — test conventions
- `parallel-agents.md` — concurrent-agent worktree/stash discipline (always loaded)
- `releasing.md` — version bump + publish

## Repo-specific conventions
- **0.x SemVer**: patch = features *and* fixes; bump minor *only* for breaking changes.
- **Tests use `MockProvider`** (no real keys). Routine live-API tests are gated
  `skipIf(!…_API_KEY)` and run via `pnpm test:integration` with cheap models and tiny
  payloads. Exact newest-model certification is the separate, paid
  `pnpm test:integration:frontier` gate.
- **Never commit gitignored paths** (`.internal/**`); no `git add -f`.
- **Never commit, push, or tag without explicit approval.**

## Agent routing

The project roles are cost- and risk-tiered. Codex uses `repo-explorer`
(Luna/medium) for bounded discovery, `routine-implementer` (Luna default effort)
for highly specified pattern work, `balanced-implementer` (Terra/medium) for
moderate implementation, `behavioral-test-analyst` (Terra/high) for blind
scenario and test design, `boundary-implementer` (Terra/high) for settled
consequential seams, `pragmatic-code-reviewer` (Terra/high) for ordinary review,
and `adversarial-code-reviewer` (Sol/high) only for consequential risk. Use
Sol/medium to lead orchestrated plan and review work; raise lead effort only
when architecture or conflicting evidence makes the lead the primary reasoner.

Claude mirrors those outcomes with Sonnet/low for exploration and routine work,
Sonnet/medium for balanced implementation, Sonnet/high for behavioral analysis,
boundary implementation, and pragmatic review, and Opus/high for premium
adversarial review. Fable is the preferred Claude lead for long-horizon
orchestration, with Opus as the economical alternative; lead at medium effort
and raise it only for consequential synthesis or adjudication.

Do not delegate merely because a slot exists. `boundary-implementer` receives
only settled designs and always requires a focused premium review. Review waves
scale from one pragmatic reviewer on a small milestone to two ordinary lanes
plus one focused premium pass on a high-risk diff.

Read-only role configuration is defense in depth, not a portable hard boundary:
the host's permission profile may override a role's `sandbox_mode`. Discovery,
behavioral-analysis, and review agents must still be explicitly instructed not
to edit or run artifact-writing commands, and the lead must confirm a review
wave did not mutate the working tree before accepting its findings or committing.

## Workflow skills

Claude skills live in `.claude/skills/`. Codex discovers repository skills
through `.agents/skills`, which points to `.codex/skills`. The Codex directory
links `live-api-verification` back here individually, so its Axl knowledge still
has one source. The four orchestration workflows are native Codex
variants because they name Codex agents and choose Terra/Sol tiers; keep the two
platform variants aligned on outcomes, not implementation details.

All five workflows are explicit-invoke (`disable-model-invocation: true` in
Claude; `policy.allow_implicit_invocation: false` in Codex). Invoke them with
Claude's `/skill` syntax or Codex's `$skill` syntax. This list is the model's
only index of explicit skills, so keep it complete and synchronized with both
skill directories.

- `/plan-doc` — create a living journeys-to-architecture plan under
  `.internal/spec/`.
- `/tackle-plan` — implement, test, independently review, and commit a named
  plan to completion.
- `/session-review` — adversarial white-box review of a concrete net diff.
- `/scenario-review` — black-box scenario derivation before implementation
  inspection, followed by evidence-based gap closure.
- `/live-api-verification` — close the canonical provider-gated checklist with
  bounded paid integration tests and explicit provider/model evidence.

> `AGENTS.md` is the agent-neutral entrypoint that routes Codex and other tools
> through this index and the applicable shared `.claude/rules/` files.
