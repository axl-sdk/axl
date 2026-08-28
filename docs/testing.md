# Testing

Since Axl runs in-process in Node.js, tests use your existing test framework (Vitest, Jest, etc.) with Axl-specific test utilities from `@axlsdk/testing`.

## Quick Start

```typescript
import { AxlTestRuntime, MockProvider } from '@axlsdk/testing';
import { describe, it, expect } from 'vitest';

describe('HandleSupport workflow', () => {
  it('returns a refund confirmation', async () => {
    const axl = new AxlTestRuntime();

    // Register the workflow
    axl.register(HandleSupport);

    // Mock the LLM — no real API calls
    axl.mockProvider('openai', MockProvider.sequence([
      { content: '{"action": "refund", "order_id": "123"}' },
      { content: 'Your refund has been processed.' },
    ]));

    // Mock host tools
    axl.mockTool('get_order', async ({ orderId }) => ({
      id: orderId, status: 'delivered', amount: 49.99,
    }));
    axl.mockTool('refund_order', async ({ orderId }) => ({
      success: true,
    }));

    // Execute
    const result = await axl.execute('HandleSupport', {
      msg: 'I want a refund for order 123',
    });

    // Assert
    expect(result).toContain('refund');
    expect(axl.toolCalls('refund_order')).toHaveLength(1);
    expect(axl.totalCost()).toBe(0); // mocked, no real spend
  });
});
```

## MockProvider Modes

| Mode | Usage | Description |
|------|-------|-------------|
| `MockProvider.sequence([...])` | Ordered responses | Returns responses in order. Fails if more calls than responses. Each response accepts an optional `chunks?: string[]` to drive the streaming path one delta per chunk (must satisfy `chunks.join('') === content`). |
| `MockProvider.chunked(contents, chunkSize?)` | Partial-content streaming | Convenience over `sequence()`: takes plain content strings and splits each into fixed-size chunks (default 4 chars ≈ 1 token). Use to exercise partial-JSON parsing, structural-boundary throttling, and cross-attempt token retention. |
| `MockProvider.echo()` | Parrot mode | Returns the user prompt back as the response. Useful for testing plumbing. |
| `MockProvider.json(schema)` | Schema-conforming | Generates random valid JSON matching the given Zod schema. Useful for fuzz testing `verify`. |
| `MockProvider.replay(file)` | Recorded sessions | Replays a recorded session from a JSON file. See snapshot testing below. |
| `MockProvider.fn(handler)` | Custom logic | Custom response function receiving `(messages, callIndex)`. Returns `{ content, tool_calls? }`. |

MockProvider also supports tool call simulation:

```typescript
const provider = MockProvider.sequence([
  {
    content: '',
    tool_calls: [{
      id: 'call_1',
      type: 'function',
      function: { name: 'calculator', arguments: '{"expression":"2+2"}' },
    }],
  },
  { content: 'The answer is 4.' },
]);
```

### Model Parameters in Tests

All model parameters — including `effort`, `temperature`, `maxTokens`, `toolChoice`, and `stop` — are passed through to MockProvider and recorded in test assertions. MockProvider ignores these parameters (it returns pre-configured responses), but they are captured in `agentCalls()` and `traceLog()` so you can verify your agent configuration:

```typescript
const runtime = new AxlTestRuntime();
runtime.mockProvider('openai', MockProvider.sequence([{ content: 'done' }]));

// After execution:
const calls = runtime.agentCalls();
expect(calls[0].effort).toBe('high');
expect(calls[0].temperature).toBe(0.5);
```

## Snapshot Testing

Record a real workflow execution and replay it in tests for deterministic, fast CI runs:

```typescript
// Record (run once, manually)
const axl = new AxlTestRuntime({ record: './snapshots/support.json' });
// ... execute workflow with real providers ...

// Replay (run in CI, fast, no API keys needed)
const axl = new AxlTestRuntime();
axl.mockProvider('openai', MockProvider.replay('./snapshots/support.json'));
```

## Assertion Helpers

`AxlTestRuntime` provides inspection methods:

| Method | Returns | Description |
|--------|---------|-------------|
| `.toolCalls(name?)` | `RecordedToolCall[]` | Accepted tool calls recorded from their terminal v2 events, optionally filtered by canonical tool name. |
| `.agentCalls(name?)` | `AgentCall[]` | All LLM calls made, optionally filtered by agent name. |
| `.totalCost()` | `number` | Total cost incurred (0 if mocked). |
| `.steps()` | `RecordedStep[]` | All workflow steps in execution order (test-runtime-internal recording). |
| `.traceLog()` | `AxlEvent[]` | Full structured `AxlEvent` trace of the execution. Narrow on `event.type` (e.g., `'agent_call_end'`, `'tool_call_end'`). |

Filter `traceLog()` results with the unified event tag names:

```typescript
const agentCalls = runtime.traceLog().filter((e) => e.type === 'agent_call_end');
const toolCalls = runtime.traceLog().filter((e) => e.type === 'tool_call_end');
```

`RecordedToolCall` carries `name`, `args`, `outcome`, and the complete
`(executionId, askId, callId)` correlation key. Narrow the discriminated outcome
before reading status-specific fields; failed, denied, and pre-result cancelled
calls do not invent a `result`:

```typescript
const [call] = runtime.toolCalls('get_order');

if (call.outcome.status === 'succeeded') {
  expect(call.outcome.result).toEqual({ id: '123', status: 'delivered' });
} else {
  throw new Error(`Expected get_order to succeed, got ${call.outcome.status}`);
}
```

Pre-start rejections are not accepted calls, so inspect `.traceLog()` for them:

```typescript
const rejected = runtime
  .traceLog()
  .filter((event) => event.type === 'tool_call_rejected');
expect(rejected[0]?.data.reason).toBe('invalid_arguments');
```

To test model-facing recovery rather than host diagnostics, drive an invalid
local call with `MockProvider.sequence()` and inspect the next request in
`provider.calls`. Its correlated tool message should contain bounded
schema-derived guidance; do not assert that host `issues[].message` is forwarded.

In a complete, non-overflowed test trace, assert one end per start by the full
correlation key rather than by tool name. Deliberately capped or interrupted
streams may be incomplete and should not manufacture a terminal outcome.

## Testing observability — `ctx.events`, `partialObjects`, overflow

For workflows that consumers observe via `ctx.events`, drive deterministic streaming with `MockProvider.sequence([{ chunks }])` or `MockProvider.chunked(...)`. The streaming code path activates when an observer is present (the test below subscribes via `ctx.events`), so `partial_object` events fire as the chunked content crosses each structural boundary.

```typescript
import { AxlTestRuntime, MockProvider } from '@axlsdk/testing';
import { agent, workflow } from '@axlsdk/axl';
import { z } from 'zod';

const myAgent = agent({ model: 'openai:gpt-4o', system: 'extract' });

const provider = MockProvider.sequence([
  { content: '{"v":3}', chunks: ['{"v":', '3', '}'] },
]);
const runtime = new AxlTestRuntime();
runtime.mockProvider('openai', provider);

const seen: Array<{ attempt: number; v: unknown }> = [];
runtime.register(workflow({
  name: 'observe',
  input: z.object({}),
  handler: async (ctx) => {
    // Allocate the bus before the first ctx.ask() so the streaming
    // code path activates for it.
    const events = ctx.events;
    void (async () => {
      for await (const partial of events.partialObjects) {
        seen.push({ attempt: partial.attempt, v: (partial.object as { v: unknown }).v });
      }
    })().catch(() => {});
    return ctx.ask(myAgent, 'go', { schema: z.object({ v: z.number() }) });
  },
}));
await runtime.execute('observe', {});

// `partialObjects` coalesces to the latest snapshot per ask. With chunks
// crossing one structural boundary (`}`), one yield is expected.
expect(seen).toEqual([{ attempt: 1, v: 3 }]);
```

To test the overflow safety net or strict-mode failure, pass `events` config to `execute()`:

```typescript
import { EventStreamOverflowError } from '@axlsdk/axl';

await expect(
  runtime.execute('observe', {}, { events: { maxQueued: 1, onOverflow: 'throw' } }),
).rejects.toBeInstanceOf(EventStreamOverflowError);
```

To test schema-retry coalescing — that attempt-N partials don't leak across a `pipeline(failed)` boundary — drive a `MockProvider.sequence` with two responses where the first fails the schema:

```typescript
const provider = MockProvider.sequence([
  { content: '{"v":"oops"}', chunks: ['{"v":"', 'oops', '"}'] }, // attempt 1: wrong type
  { content: '{"v":2}', chunks: ['{"v":', '2', '}'] },           // attempt 2: corrects
]);

// After execute, assert: NO attempt: 1 snapshot leaked through, only
// attempt: 2 surfaces.
expect(seen.find((s) => s.attempt === 1)).toBeUndefined();
expect(seen.some((s) => s.attempt === 2 && s.v === 2)).toBe(true);
```

### Schema diagnostics & `nativeStructuredOutput`

`schema_diagnostic` events (oversized schema, dropped `.refine()`s, streaming disabled, `schemaPrompt:'none'`, `native_output_unsupported`) are ordinary `AxlEvent`s — capture them off `ctx.events` / `onTrace` and filter by `type`/`data.kind`:

```typescript
const diags = seen.filter((e) => e.type === 'schema_diagnostic');
expect(diags.some((e) => e.data.kind === 'dropped_refinements')).toBe(true);
```

Two behaviors to test around, both driven purely by MockProvider:

- **`streaming_disabled` is observer-gated** — it only fires when streaming is active (allocate `ctx.events` *before* the ask). A plain `runtime.execute()` with no observer emits nothing.
- **`native_output_unsupported` depends on the provider's capability tier.** `MockProvider` does **not** implement `nativeStructuredOutputSupport`, so the runtime treats it as `'schema'` (fully supported) — meaning the diagnostic will **not** fire under a plain mock even with `nativeStructuredOutput: true`. To test the `downgraded`/`lossy`/`unsupported` paths, give your mock the method: `Object.assign(provider, { nativeStructuredOutputSupport: () => 'unsupported' })`. The real per-provider tiers are exercised in the live tier (`pnpm test:integration`, `integration-structured-output.test.ts`) — a green MockProvider run does **not** prove a real provider honors `json_schema`.

## AxlTestRuntime

`AxlTestRuntime` supports the **full `ctx.*` primitive set** — `ask`, `spawn`, `vote`, `verify`, `budget`, `race`, `parallel`, `map`, `awaitHuman`, `checkpoint`, and `log` — so that workflows under test exercise the same code paths as production.

Internally, `AxlTestRuntime` creates a real `WorkflowContext` and delegates all primitive calls to it. This ensures behavioral parity — budget tracking, signal threading, quorum semantics, and checkpoint-replay all behave identically in tests and production.

### Extension Points

| Extension | Purpose |
|-----------|---------|
| `axl.mockTool(name, handler)` | Mock a tool's handler. When an agent invokes the tool, the mock runs instead of the real handler. |
| `humanDecisions` constructor option | Resolve `ctx.awaitHuman()` calls immediately instead of suspending. Test approval/rejection flows without human interaction. |

```typescript
const axl = new AxlTestRuntime({
  humanDecisions: (opts) => ({ approved: true }),
});
axl.register(HandleSupport);

axl.mockTool('get_order', async ({ orderId }) => ({ id: orderId, status: 'delivered' }));

const result = await axl.execute('HandleSupport', { msg: 'Refund please' });
```

When the mocked name matches a configured local tool, the mock still bypasses the configured schema, approval, retry, hooks, and real handler. Provider arguments must still be valid JSON because parsing belongs to the agent-call boundary, before the mock is selected. The configured tool contributes only its model-output policy: `sensitive` and `toModelOutput`. This lets a test return the same complete application artifact the host would render while asserting the smaller tool message the provider receives:

```typescript
import { agent, tool, workflow } from '@axlsdk/axl';
import { AxlTestRuntime, MockProvider } from '@axlsdk/testing';
import { z } from 'zod';

const getOrder = tool({
  name: 'get_order',
  description: 'Look up an order',
  input: z.object({ orderId: z.string() }),
  handler: async ({ orderId }) => ({
    humanMessage: `Order ${orderId} is ready`,
    internalId: `host-only-${orderId}`,
  }),
  toModelOutput: (result) => ({ message: result.humanMessage }),
});

const supportAgent = agent({
  model: 'openai:test',
  system: 'Use the order tool.',
  tools: [getOrder],
});

const ProjectedSupport = workflow({
  name: 'ProjectedSupport',
  input: z.object({ msg: z.string() }),
  handler: (ctx) => ctx.ask(supportAgent, ctx.input.msg),
});

const provider = MockProvider.sequence([
  { content: '', tool_calls: [{
    id: 'call-1',
    type: 'function',
    function: { name: 'get_order', arguments: '{"orderId":"123"}' },
  }] },
  { content: 'Done.' },
]);

const axl = new AxlTestRuntime();
axl.register(ProjectedSupport);
axl.mockProvider('openai', provider);
axl.mockTool('get_order', () => ({
  humanMessage: 'Ready for pickup',
  internalId: 'host-only-123',
}));

await axl.execute('ProjectedSupport', { msg: 'Check order 123' });

const [call] = axl.toolCalls('get_order');
expect(call.outcome).toEqual({
  status: 'succeeded',
  result: {
    humanMessage: 'Ready for pickup',
    internalId: 'host-only-123',
  },
});
expect(provider.calls[1].messages.find((m) => m.role === 'tool')?.content)
  .toBe('{"message":"Ready for pickup"}');
```

A normally returned error-shaped value is a successful result and may be
projected. A thrown `ToolFailure` bypasses projection, records
`failed / handler / tool_failure`, and continues with its model-safe message; an
ordinary throw records `failed / handler / unexpected` and aborts the ask. A
configured sensitive mock always sends the fixed redaction marker on success
and never invokes its mapper. An override whose name is not in the agent's
configured tools keeps normal JSON serialization. Use
`config: { trace: { level: 'full' } }` when asserting that the next
`agent_call_start.data.messages` snapshot contains the projected content.

This design means you never need a separate "test mode" for individual primitives. If your workflow uses `ctx.budget()` wrapping `ctx.spawn()` with `ctx.vote()`, all of that runs as-is in tests — only the LLM and tool I/O are mocked.

## Testing vs. Evaluation

Testing and [evaluation](../packages/axl-eval/README.md) are complementary but distinct:

- **Testing** uses mocked providers (`MockProvider`), runs in CI on every build, is fast and free, and makes deterministic assertions about workflow logic ("did the agent call the right tool?", "does the output match the schema?").
- **Evaluation** uses real LLM calls, runs on demand during prompt iteration, costs money, and measures semantic output quality with scoring functions ("is this workout plan actually good?").

Use testing to verify your workflow works correctly. Use evaluation to verify your prompts produce quality outputs — and to catch regressions when you change them.

## Live provider gates

Live tests are opt-in and load provider keys from the repository-root `.env`:

```bash
pnpm test:integration           # routine cross-provider contract coverage
pnpm test:integration:frontier  # paid exact newest-model certification
```

The routine gate uses inexpensive models and excludes the current-model matrix. Run the
frontier gate when the catalog changes and before release; it checks exact IDs, streaming,
tool continuation, usage, and pricing. Static-priced calls must report positive cost, while
response-priced providers may report a nonnegative total. Record catalog changes in a dated,
secret-free file under `docs/verification/`.
