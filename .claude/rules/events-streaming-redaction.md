---
paths:
  - "packages/axl/src/event-stream.ts"
  - "packages/axl/src/stream.ts"
  - "packages/axl/src/streaming-walker.ts"
  - "packages/axl/src/string-stream-from-events.ts"
  - "packages/axl/src/event-utils.ts"
  - "packages/axl/src/partial-json.ts"
  - "packages/axl/src/redaction.ts"
  - "packages/axl-studio/src/server/redact.ts"
  - "packages/axl-studio/src/server/ws/**"
---

# Events, streaming & redaction

**One unified event model.** `TraceEvent` and `StreamEvent` collapse into a single
`AxlEvent` discriminated union — the wire format *is* the trace format, no translation.
`AxlEventBus` (`event-stream.ts`) backs both `AxlStream` and `ctx.events`, exposing the raw
iterable plus curated views (`.text`, `.lifecycle`, `.textByAsk`, `.partialObjects`,
`.stringStream`).

## Adding an event variant — do all of these together
1. Add the variant + its data shape to the union in `types.ts`.
2. Add it to the `AXL_EVENT_TYPES` const tuple (the discriminator's single source of truth).
3. Add a rule to `REDACTION_RULES` in `redaction.ts` — the `Record<AxlEventType, …>` mapped
   type **won't compile** until you do.
4. The exhaustiveness fixture (`__tests__/axl-event-exhaustive.test-d.ts`) catches anything
   missed.

Skipping any step is a typecheck or test failure by design — lean on the compiler, don't
route around it.

## Invariants
- **AskScoped** events carry `askId` / `parentAskId` / `depth` / `agent`; rebuild ask trees
  by group-by(`askId`) + parent-link(`parentAskId`). `step` is monotonic across the whole
  execution tree.
- **Redaction is a boundary filter, not a data-at-rest transform.** `redactEvent()` +
  `REDACTION_RULES` are the single source of truth, shared by emit-time, Studio REST
  serialization, and Studio WS broadcast. **Never scrub** top-level numeric fields
  (`cost`/`tokens`/`duration`) or structural ids (`askId`/`step`/`timestamp`/`executionId`/…)
  — they are load-bearing for cost aggregation. Scrub only the content fields the table
  names.
- **Streaming gating**: `partial_object` + `string_delta` emit only in schema mode (a schema
  is set, no tools, root is a `ZodObject`), driven by the single `StreamingWalker`. They are
  stream-only — never persisted to `ExecutionInfo.events`. Subscribe to `ctx.events`
  *before* the first `ctx.ask()`, or that ask won't stream.
- **Bounded queue**: `AxlEventBus` defaults to a bounded queue with drop-oldest-non-terminal
  overflow; terminal events (`done`/`error`/`workflow_end`) always bypass the cap.

Deep reference + React recipes: `docs/observability.md`. Keep it and the redaction matrix in
`docs/security.md` in sync with `REDACTION_RULES`.
