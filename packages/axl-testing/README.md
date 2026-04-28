# @axlsdk/testing

[![npm version](https://img.shields.io/npm/v/@axlsdk/testing)](https://www.npmjs.com/package/@axlsdk/testing)

Testing utilities for [Axl](https://github.com/axl-sdk/axl) agentic workflows. Provides deterministic mocks and assertions for unit testing workflows without hitting real LLM APIs.

## Installation

```bash
npm install @axlsdk/testing --save-dev
```

## API

### `MockProvider`

Mock LLM provider with multiple response modes:

```typescript
import { MockProvider } from '@axlsdk/testing';

// Sequence mode — return responses in order
const provider = MockProvider.sequence([
  { content: 'Hello!' },
  { content: 'World!' },
]);

// With custom usage/cost per response (defaults: 10/10 tokens, $0)
const provider = MockProvider.sequence([
  { content: 'Hello!', usage: { prompt_tokens: 50, completion_tokens: 100, total_tokens: 150 }, cost: 0.003 },
  { content: 'World!' }, // uses defaults
]);

// Per-response streaming chunks. Each response can carry an optional
// `chunks?: string[]` that drives the streaming path one delta per chunk.
// Must satisfy `chunks.join('') === content`.
const provider = MockProvider.sequence([
  { content: 'Hello world', chunks: ['Hel', 'lo ', 'world'] },
]);

// Chunked mode — convenience over `sequence()`. Takes plain content
// strings and splits each into fixed-size chunks (default 4 chars ≈
// 1 token). Use to exercise partial-JSON parsing, structural-boundary
// throttling, and cross-attempt token retention.
const provider = MockProvider.chunked(['Hello world', 'Goodbye world']);
const provider2 = MockProvider.chunked(['{"answer":42}'], 2); // 2-char chunks

// Echo mode — return the user's prompt back
const provider = MockProvider.echo();

// JSON mode — return data matching a Zod schema
const provider = MockProvider.json(z.object({ answer: z.number() }));

// Replay mode — replay from a recorded file
const provider = MockProvider.replay('./fixtures/conversation.json');

// Function mode — custom response logic
const provider = MockProvider.fn((messages, callIndex) => {
  const lastMessage = messages[messages.length - 1];
  return { content: `You said: ${lastMessage.content}` };
});

// Function mode with custom usage/cost
const provider = MockProvider.fn(() => ({
  content: 'response',
  usage: { prompt_tokens: 120, completion_tokens: 200, total_tokens: 320 },
  cost: 0.005,
}));
```

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

All model parameters (`effort`, `thinkingBudget`, `includeThoughts`, `temperature`, `maxTokens`, `toolChoice`, `stop`) flow through MockProvider transparently. They don't affect mock responses but are recorded in `provider.calls` for assertion:

```typescript
expect(provider.calls[0].options.effort).toBe('high');
```

### `MockTool`

Create a mock tool to intercept and record calls:

```typescript
import { MockTool } from '@axlsdk/testing';

const mock = MockTool.create('calculator', async ({ expression }) => ({
  result: eval(expression),
}));

// Inspect calls after execution
console.log(mock.calls); // [{ input: { expression: '2+2' } }]
```

### `AxlTestRuntime`

Test runtime that wraps `WorkflowContext` for deterministic testing:

```typescript
import { AxlTestRuntime, MockProvider } from '@axlsdk/testing';

const runtime = new AxlTestRuntime();
runtime.register(myWorkflow);

// Mock the LLM
runtime.mockProvider('openai', MockProvider.sequence([
  { content: '42' },
]));

// Mock tools
runtime.mockTool('calculator', async ({ expression }) => ({ result: 4 }));

// Execute
const result = await runtime.execute('my-workflow', { question: 'What is 2+2?' });

// Inspect recorded calls
expect(runtime.agentCalls()).toHaveLength(1);
expect(runtime.toolCalls()).toHaveLength(1);
expect(runtime.totalCost()).toBe(0);
```

For testing human-in-the-loop flows:

```typescript
const runtime = new AxlTestRuntime({
  humanDecisions: (opts) => ({ approved: true }),
});
```

`AxlTestRuntime` also accepts a `config` option that is threaded into the underlying `WorkflowContext`. `trace.level` and `trace.redact` work identically in tests and production:

```typescript
import { AxlTestRuntime } from '@axlsdk/testing';

// Verbose trace mode — populates agent_call_end.data.messages
const runtime = new AxlTestRuntime({
  config: { trace: { level: 'full' } },
});

// Redaction mode — scrubs prompt/response/messages on emitted events
const redacted = new AxlTestRuntime({
  config: { trace: { redact: true } },
});
```

### Assertions

```typescript
const runtime = new AxlTestRuntime();
runtime.register(myWorkflow);
runtime.mockProvider('openai', provider);

// After running your workflow:
runtime.agentCalls();   // All recorded agent invocations
runtime.toolCalls();    // All recorded tool invocations
runtime.totalCost();    // Cumulative cost
runtime.steps();        // All recorded steps (agents + tools)
runtime.traceLog();     // All trace events
```

## Example: Testing a Workflow

```typescript
import { describe, it, expect } from 'vitest';
import { AxlTestRuntime, MockProvider } from '@axlsdk/testing';
import { z } from 'zod';
import { HandleSupport } from '../workflows/support';

describe('HandleSupport workflow', () => {
  it('processes a refund', async () => {
    const runtime = new AxlTestRuntime();
    runtime.register(HandleSupport);

    runtime.mockProvider('openai', MockProvider.sequence([
      { content: 'Your refund has been processed.' },
    ]));

    runtime.mockTool('get_order', async ({ orderId }) => ({
      id: orderId, status: 'delivered', amount: 49.99,
    }));
    runtime.mockTool('refund_order', async ({ orderId }) => ({
      success: true,
    }));

    const result = await runtime.execute('HandleSupport', {
      msg: 'I want a refund for order 123',
    });

    expect(result).toContain('refund');
    expect(runtime.toolCalls('refund_order')).toHaveLength(1);
  });
});
```

## License

[Apache 2.0](../../LICENSE)
