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

**This section addresses the orchestrating root.** Subagents receive this file
verbatim: if you are one, it explains how you were selected, not licence to
invoke a workflow or spawn agents beyond what your agent definition allows.

Both platforms run the same five lanes. Model and effort live only in the agent
definitions (`.claude/agents/*.md` frontmatter, `.codex/agents/*.toml`); retune
there, never in this table.

| Agent | Use for |
| --- | --- |
| `Explore` | Read-only discovery; file-backed evidence, not judgment |
| `implementer` | Bounded, settled implementation using established contracts and patterns |
| `senior-implementer` | Ambiguous diagnosis and consequential implementation, including settled seam changes under a brief |
| `reviewer` | Full correctness review against established contracts; plan review applying established architecture |
| `senior-reviewer` | Consequential contracts, interacting failure modes, architectural changes, and blind scenario/test analysis |

Route by uncertainty, consequence, and the evidence needed to establish
correctness, not diff size. A substantial feature on established contracts can
be routine; a small change to public types/Zod, provider wire or `effort`
mapping, streaming/redaction, state durability, usage/cost, or concurrency is
consequential even with a settled design. Consequential implementation gets a
seam brief (invariants plus a verification plan) and one consolidated
`senior-reviewer` pass on the quiescent seam diff. Review classes share one
evidence standard and are selected by charter, not run as a sequential approval
chain. Unresolved architecture, product, and policy decisions stay with the lead.

Both fleets' agent bodies point to shared procedures under
`.claude/references/agents/`. Keep behavior there; keep discovery descriptions,
model/effort, tool or sandbox controls, and report delivery in the platform
entrypoints. Workflow routing policy belongs in the shared skill procedures;
`.claude/references/workflow-handoffs.md` owns sequencing and evidence reuse.

The host selects the root lead; skills cannot switch it. Preserve explicit user
choices and report unknown resolved settings honestly. Raise root effort only
for a concrete unresolved reasoning problem; plan length alone does not warrant
a stronger lead. Fresh sessions load agent definitions; file edits do not
reconfigure live agents, so check the available roles before dispatch.

Read-only role configuration is defense in depth, not a portable hard boundary:
the host's permission profile may override `disallowedTools` or `sandbox_mode`.
Discovery and review agents must still be explicitly instructed not to edit or
run artifact-writing commands, and the lead must confirm a review wave did not
mutate the working tree before accepting its findings or committing.

## Workflow skills

Claude skills live in `.claude/skills/`. Codex discovers repository skills
through `.agents/skills`, which points to `.codex/skills`. The Codex directory
links `live-api-verification` and `prompt-iteration` back here individually. The
four orchestration workflows (`plan-doc`, `tackle-plan`, `session-review`,
`scenario-review`) keep one platform-neutral procedure each in
`.claude/skills/<skill>/references/procedure.md`, written in lane language; each
platform's `SKILL.md` only binds those lanes to its agents and platform
mechanics, and `.codex/skills/<skill>/references` links to the shared directory.
Edit the procedure for a workflow change and the bindings for a roster change.

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
