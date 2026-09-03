---
paths:
  - "packages/axl/src/**"
---

# Core SDK (`packages/axl`)

The orchestration core. `WorkflowContext` (`context.ts`) is the central object — every
`ctx.*` primitive lives there. `AxlRuntime` (`runtime.ts`) registers, executes, streams,
runs sessions, and owns execution history + cost tracking.

## Where things are (entry points → scoped rules)
- `context.ts` — `WorkflowContext`, the heart: every `ctx.*` primitive. `runtime.ts` —
  `AxlRuntime` (register / execute / stream / session / createContext).
- `agent.ts` / `tool.ts` / `workflow.ts` — factories (inert definitions); `config.ts`,
  `session.ts`, `errors.ts`, `types.ts` fill out the top level.
- Subsystems each have a narrower rule that loads alongside this one: `providers/` →
  providers.md · `state/` + `memory/` → state-and-memory.md · the event/stream/redaction
  files → events-streaming-redaction.md · `telemetry/` + `mcp/` (OTel spans / MCP clients).

`ls packages/axl/src` is the source of truth for the file list — the above is just routing.

## Conventions & invariants
- **`ctx.ask()` output pipeline**: guardrail (raw text) → schema (parse + Zod) →
  `validate` (typed object). Each stage has an independent retry counter and accumulates
  corrective context; `validate` requires a `schema` (it's skipped without one).
- **Errors**: throw from the `AxlError` hierarchy (`errors.ts`) — don't invent ad-hoc
  `Error` subclasses. Boundaries (route handlers, CLI, primitives) surface errors;
  interior code propagates them.
- **Child contexts** (`ctx.createChildContext()`, and the second arg passed to tool
  handlers) share budget/abort/traces but isolate session/streaming/steps. Agent-as-tool
  works because nested asks inherit the parent's callbacks and event bus.
- **Handoffs**: `'oneway'` (default; exits the source loop) vs `'roundtrip'` (returns a
  result to the source). Routing is static or a function of `ctx.metadata`.
- **Cost** flows through one budget rail: `ctx.budget()` enforces across agent calls *and*
  semantic memory. Per-ask cost excludes nested asks (they roll up to their own ask) —
  don't double-count `ask_end`. The rail is **honest but not omniscient about unpriced
  spend**: an unpriced model (pricing-table miss) sets `BudgetResult.unpriced` /
  `getBudgetStatus().unpriced` and makes `totalCost` a lower bound, but the limit /
  `hard_stop` **cannot enforce** on it (the enforcement path never sees the unknown cost).
- New cross-provider model params go on `ChatOptions` (configurable on `AgentConfig`,
  overridable per-call on `AskOptions`; precedence AskOptions > AgentConfig > defaults).
  `docs/api-reference.md` is authoritative for the exact defaults. A portable knob must
  express **provider-neutral intent** that each adapter realizes or no-ops (`effort`,
  `includeThoughts`, `promptCache`); a field that only one provider's wire format
  understands is not a knob — it goes through `providerOptions` or the provider's profile.
- Imports use the `.js` extension even from `.ts`; verify no circular import before
  adding one.
