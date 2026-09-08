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
TypeScript (strict, ESM) · Zod v4 (peer dep `zod@^4`) · Vitest · pnpm workspaces · Node 22+ ·
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
READMEs. Also keep `CHANGELOG.md` (`[Unreleased]`), `ROADMAP.md`, and the gitignored durable
specs under `.internal/spec/` current. Time-bounded work belongs under the product- and
lifecycle-organized `.internal/plans/`; durable decision inputs belong under
`.internal/research/`. Follow `.internal/README.md`. The subsystem → doc map is in
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
- `discovery-evidence.md` — decision-grade discovery evidence (always loaded)
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
- **Commit verified, logical chunks by default** on a feature branch (conventional
  commits; never directly on `main`). **Never push, tag, merge, or publish without
  explicit approval.**
- **Releases are changelog-backed and tag-triggered.** After npm trusted publishing
  succeeds, the publish workflow creates the GitHub Release and an Announcements
  discussion from the matching versioned `CHANGELOG.md` section. Follow
  `.claude/rules/releasing.md`; do not duplicate release prose manually.

## Agent routing

Route by uncertainty, consequence, and critical-path latency. Codex defaults:

| Role | Model / effort | Assignment |
| --- | --- | --- |
| Root lead | Sol / medium | Settled execution, including long plans |
| Root lead, primary reasoner | Astra / medium | Unresolved architecture, contracts, conflicting evidence, or consequential interactions |
| `repo-explorer` | Luna / medium | Bounded read-only discovery |
| `routine-implementer` | Luna / high | Highly specified patterned work |
| `budget-implementer` | Luna / max | Optional settled moderate work with executable checks and scheduling slack |
| `balanced-implementer` | Sol / medium | Settled moderate work, especially on the critical path |
| `boundary-implementer` | Sol / high | Settled consequential seams under a five-part grant |
| `behavioral-test-analyst` | Sol / high | Blind behavioral scenarios and discriminating test design |
| `pragmatic-code-reviewer` | Sol / high | Ordinary substantive review |
| `adversarial-code-reviewer` | Astra / high | Focused consequential-risk review |
| `deep-debugger` | Astra / medium | Uncertain root causes and stalled diagnosis |

Role TOML files under `.codex/agents/` configure workers; this table records routing
intent. Root model selection belongs to the host, not the skill. Preserve explicit
user choices, verify resolved settings when exposed, and report unknown settings
honestly. A running session may retain older role definitions. Check available
roles before dispatch: skip the optional budget lane if unavailable; keep uncertain
diagnosis with the lead if the debugger is unavailable. Use a fresh session to
load updated role definitions; do not claim file edits reconfigured live agents.
Raise root or debugger effort only for a concrete unresolved reasoning
problem. Plan length alone does not warrant a stronger lead. Terra remains a
candidate for measured recurring workloads, not an automatic escalation rung.
Benchmark rankings motivate these defaults; accepted repo results must validate them.

Claude uses Sonnet/low for exploration and routine patterned work. Opus/medium
handles settled implementation and pragmatic review; Opus/high handles blind
behavioral analysis, hard debugging, and premium adversarial review. Claude's
single `implementer` covers moderate work and consequential seams; Codex separates
balanced and boundary roles. Claude uses Fable for demanding orchestration and
Opus as the economical alternative, at medium effort unless consequential
synthesis warrants more. Preserve Claude model choices independently of Codex
benchmark results. On both platforms, `deep-debugger` owns uncertain diagnosis;
unresolved architecture and product policy remain with the lead.

Do not delegate merely because a slot exists. Give workers whole owned chunks
and local engineering discretion within settled behavior and invariants. A
consequential implementation grant must include design, invariants, acceptance
criteria, owned files, and verification; require one focused premium review of
the consolidated quiescent seam diff. Start ordinary milestone review with one
composite reviewer and add independent charters for distinct meaningful failure
surfaces. Explicit comprehensive session review retains at least two perspectives.
Resume relevant agents for related work without crossing implementation/review or
blind behavioral-analysis independence boundaries. Escalate stagnant diagnosis
(two repetitions of the same ineffective approach without new evidence), not
productive test failures. Return unresolved policy or contracts outside a grant
promptly. The `tackle-plan` lead records orchestration outcomes and adjusts routing
within authorized scope using its shared accountability reference.

Read-only role configuration is defense in depth, not a portable hard boundary:
the host's permission profile may override a role's `sandbox_mode`. Discovery,
behavioral-analysis, and review agents must still be explicitly instructed not
to edit or run artifact-writing commands, and the lead must confirm a review
wave did not mutate the working tree before accepting its findings or committing.

## Workflow skills

Claude skills live in `.claude/skills/`. Codex discovers repository skills
through `.agents/skills`, which points to `.codex/skills`. The Codex directory
links `live-api-verification` and `prompt-iteration` back here individually, so
their Axl knowledge still has one source. The four orchestration workflows are
native Codex
variants because they name Codex agents and choose Codex model tiers; keep the two
platform variants aligned on outcomes, not implementation details.

The five orchestration and live-verification workflows are explicit-invoke
(`disable-model-invocation: true` in Claude;
`policy.allow_implicit_invocation: false` in Codex). Invoke them with Claude's
`/skill` syntax or Codex's `$skill` syntax. `prompt-iteration` is methodology and
may be selected automatically when Axl-owned runtime model-facing behavior
changes. Keep this index complete and synchronized with both skill directories.

- `/plan-doc` — create a living journeys-to-architecture workstream under
  `.internal/plans/<product-area>/active/` and graduate it after completion.
- `/tackle-plan` — orchestrate a named plan to completion through delegated
  implementation, testing, independent review, and logical commits.
- `/session-review` — adversarial white-box review of a concrete net diff.
- `/scenario-review` — black-box scenario derivation before implementation
  inspection, followed by evidence-based gap closure.
- `/live-api-verification` — close the canonical provider-gated checklist with
  bounded paid integration tests and explicit provider/model evidence.
- `/prompt-iteration` — improve Axl-owned runtime model-facing behavior with
  zero-provider diagnosis, explicitly approved minimal paid probes, complete
  qualitative mining, and one final evidence lock.

> `AGENTS.md` is the agent-neutral entrypoint that routes Codex and other tools
> through this index and the applicable shared `.claude/rules/` files.
