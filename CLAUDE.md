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
pnpm test:e2e | test:studio | test:smoke | test:integration   # integration needs API keys
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
- **Tests use `MockProvider`** (no real keys). Live-API tests are gated
  `skipIf(!…_API_KEY)` and run only via `pnpm test:integration` — cheapest model, tiny
  payloads.
- **Never commit gitignored paths** (`.internal/**`); no `git add -f`.
- **Never commit, push, or tag without explicit approval.**

> Note: `GEMINI.md` is a symlink to this file. `.claude/rules/` is Claude-Code-specific; the
> `docs/` and source pointers above are what keep this index useful for any tool.
