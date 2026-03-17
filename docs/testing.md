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
| `MockProvider.sequence([...])` | Ordered responses | Returns responses in order. Fails if more calls than responses. |
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
| `.toolCalls(name?)` | `ToolCall[]` | All tool calls made, optionally filtered by tool name. |
| `.agentCalls(name?)` | `AgentCall[]` | All LLM calls made, optionally filtered by agent name. |
| `.totalCost()` | `number` | Total cost incurred (0 if mocked). |
| `.steps()` | `Step[]` | All workflow steps in execution order. |
| `.traceLog()` | `TraceEvent[]` | Full structured trace of the execution. |

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

This design means you never need a separate "test mode" for individual primitives. If your workflow uses `ctx.budget()` wrapping `ctx.spawn()` with `ctx.vote()`, all of that runs as-is in tests — only the LLM and tool I/O are mocked.

## Testing vs. Evaluation

Testing and [evaluation](../packages/axl-eval/README.md) are complementary but distinct:

- **Testing** uses mocked providers (`MockProvider`), runs in CI on every build, is fast and free, and makes deterministic assertions about workflow logic ("did the agent call the right tool?", "does the output match the schema?").
- **Evaluation** uses real LLM calls, runs on demand during prompt iteration, costs money, and measures semantic output quality with scoring functions ("is this workout plan actually good?").

Use testing to verify your workflow works correctly. Use evaluation to verify your prompts produce quality outputs — and to catch regressions when you change them.
