# API Reference

Complete reference for all Axl factories, context primitives, and configuration options.

## Factories

### `tool(config)`

Define a tool with Zod-validated input and a handler function.

```typescript
import { tool } from '@axlsdk/axl';
import { z } from 'zod';

const search = tool({
  name: 'search',
  description: 'Search the web',
  input: z.object({ query: z.string() }),
  handler: async ({ query }) => fetchResults(query),
  retry: { attempts: 3, backoff: 'exponential' },
  sensitive: false,
  requireApproval: false,
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | **required** | Unique tool name |
| `description` | `string` | **required** | Description shown to the LLM |
| `input` | `ZodType` | **required** | Zod schema for input validation |
| `handler` | `(input, ctx) => T \| Promise<T>` | **required** | Function that executes the tool. `ctx` is a child `WorkflowContext` for nested agent invocations (see below) |
| `retry` | `RetryPolicy` | see below | Retry configuration for the handler |
| `sensitive` | `boolean` | `false` | When `true`, return value is redacted from LLM context in subsequent turns |
| `maxStringLength` | `number` | `10000` | Max length for any string argument. Set to `0` to disable |
| `requireApproval` | `boolean` | `false` | When `true`, agent-initiated calls trigger `ctx.awaitHuman()` before execution. Skipped for direct `tool.run()` calls |
| `hooks` | `ToolHooks` | — | Lifecycle hooks (see below) |

#### `RetryPolicy`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `attempts` | `number` | `1` | Total attempts (1 = no retry) |
| `backoff` | `'none' \| 'linear' \| 'exponential'` | `'exponential'` | `none`: no delay. `linear`: attempt * 1s. `exponential`: 2^(attempt-1) * 1s |
| `on` | `(error: Error & { status?: number }) => boolean` | all errors | Return `true` to retry this error, `false` to stop |

#### `ToolHooks`

| Hook | Signature | Description |
|------|-----------|-------------|
| `before` | `(input: TInput, ctx: WorkflowContext) => TInput \| Promise<TInput>` | Transform input before handler runs |
| `after` | `(output: TOutput, ctx: WorkflowContext) => TOutput \| Promise<TOutput>` | Transform output after handler runs |

Execution order for agent-initiated calls: approval gate → `hooks.before` → handler → `hooks.after`. For direct `tool.run()` calls: `hooks.before` → handler → `hooks.after` (no approval gate).

#### Child Context in Tool Handlers

When a tool is invoked by an agent, the handler receives a child `WorkflowContext` as its second parameter. This enables the "agent-as-tool" composition pattern — tools can invoke other agents via `ctx.ask()`.

```typescript
const researchTool = tool({
  name: 'research',
  description: 'Delegate a research question to a specialist agent',
  input: z.object({ question: z.string() }),
  handler: async (input, ctx) => {
    return ctx.ask(researcher, input.question);
  },
});
```

The child context shares budget tracking, abort signals, and trace emission with the parent, while isolating session history, step counters, and streaming callbacks. Created internally via `WorkflowContext.createChildContext()`.

---

### `agent(config)`

Define an agent with a model, system prompt, tools, and optional handoffs.

```typescript
import { agent } from '@axlsdk/axl';

const myAgent = agent({
  model: 'openai-responses:gpt-5.4',
  system: 'You are a helpful assistant.',
  tools: [search, calculator],
  temperature: 0.7,
  maxTokens: 8192,
  effort: 'high',
  maxTurns: 10,
  timeout: '30s',
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | model string or `Agent_N` | Display name used in traces |
| `model` | `string \| (ctx) => string` | **required** | Provider URI (e.g., `'openai:gpt-4o'`, `'anthropic:claude-sonnet-4-6'`). Function form enables dynamic model routing |
| `system` | `string \| (ctx) => string` | **required** | System prompt. Function form enables per-request customization |
| `tools` | `Tool[]` | `[]` | Tools this agent can call. Acts as an ACL — the agent cannot call tools not in this list |
| `handoffs` | `HandoffDescriptor[] \| (ctx) => HandoffDescriptor[]` | `[]` | Agents this agent can hand off to. Function form receives `{ metadata?: Record<string, unknown> }` for dynamic routing (see below) |
| `mcp` | `string[]` | `[]` | MCP server names to connect. Tools from these servers are merged into the agent's tool set |
| `mcpTools` | `string[]` | — | Whitelist: only expose these specific MCP tools |
| `temperature` | `number` | provider default | LLM sampling temperature |
| `maxTokens` | `number` | `4096` | Maximum tokens in the LLM response |
| `effort` | `Effort` | — | Unified effort level: `'none'` \| `'low'` \| `'medium'` \| `'high'` \| `'max'`. Controls reasoning depth across all providers |
| `thinkingBudget` | `number` | — | Explicit thinking token budget (advanced). Overrides effort-based allocation. Set to `0` to disable thinking while keeping effort |
| `includeThoughts` | `boolean` | — | Return reasoning summaries in responses. Supported on OpenAI Responses API and Gemini |
| `toolChoice` | `'auto' \| 'none' \| 'required' \| { type: 'function', function: { name } }` | — | Tool choice strategy: `'auto'` lets the model decide, `'none'` forbids tool use, `'required'` forces at least one tool call, or specify a function name to force a specific tool |
| `stop` | `string[]` | — | Stop sequences — generation stops when any sequence is encountered. Not supported by the `openai-responses` provider (silently ignored) |
| `providerOptions` | `Record<string, unknown>` | — | Provider-specific options shallow-merged into the raw API request body via `Object.assign`. Not portable across providers. See [shallow merge caveat](providers.md#provideroptions) |
| `maxTurns` | `number` | `25` | Maximum tool-call loop iterations before throwing `MaxTurnsError` |
| `timeout` | `string` | none | Duration string (e.g., `'30s'`, `'5m'`, `'1h'`). Throws `TimeoutError` when exceeded |
| `maxContext` | `number` | — | Estimated token limit for context window management |
| `version` | `string` | — | Prompt version label attached to trace events |
| `guardrails` | `GuardrailsConfig` | — | Input/output validation (see [Guardrails](#guardrails)) |

#### `HandoffDescriptor`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `agent` | `Agent` | **required** | Target agent |
| `description` | `string` | — | Description shown to the LLM to help it decide when to hand off |
| `mode` | `'oneway' \| 'roundtrip'` | `'oneway'` | `oneway`: transfers the conversation — source agent's loop exits. `roundtrip`: delegates and returns the result to the source agent |

#### Dynamic Handoffs

The `handoffs` option accepts a function for runtime-conditional routing. The function receives `{ metadata?: Record<string, unknown> }` (from `AskOptions.metadata` or workflow metadata) and returns the handoff array:

```typescript
const router = agent({
  name: 'support-router',
  model: 'openai-responses:gpt-5-mini',
  system: 'Route to the right specialist.',
  handoffs: (ctx) => {
    const base = [
      { agent: billingAgent, description: 'Billing issues' },
      { agent: shippingAgent, description: 'Shipping questions' },
    ];
    if (ctx.metadata?.tier === 'enterprise') {
      base.push({ agent: priorityAgent, description: 'Priority support' });
    }
    return base;
  },
});
```

---

### `workflow(config)`

Define a named workflow with typed input/output.

```typescript
import { workflow } from '@axlsdk/axl';
import { z } from 'zod';

const myWorkflow = workflow({
  name: 'MyWorkflow',
  input: z.object({ query: z.string() }),
  output: z.object({ answer: z.string() }),
  handler: async (ctx) => {
    const answer = await ctx.ask(myAgent, ctx.input.query);
    return { answer };
  },
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | **required** | Workflow name used for `runtime.execute(name, input)` |
| `input` | `ZodType` | **required** | Zod schema for workflow input |
| `output` | `ZodType` | — | Optional Zod schema for output validation |
| `handler` | `(ctx: WorkflowContext) => Promise<T>` | **required** | Async function receiving the workflow context |

### `runtime.createContext(options?)`

Create a `WorkflowContext` for ad-hoc use outside of workflows — evals, tool testing, prototyping. The context automatically emits trace events to the runtime's EventEmitter and tracks cost. Traces from ad-hoc contexts are visible in Studio's cost dashboard and trace explorer.

```typescript
const ctx = runtime.createContext();
const answer = await ctx.ask(myAgent, 'hello');
console.log(ctx.totalCost); // accumulated cost from all agent calls
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `metadata` | `Record<string, unknown>` | `{}` | Metadata passed to the context |
| `budget` | `string` | — | Cost budget (e.g., `'$0.50'`). Enforced via `finish_and_stop` policy |
| `signal` | `AbortSignal` | — | Abort signal for cancellation/timeouts |
| `sessionHistory` | `ChatMessage[]` | — | Prior conversation history for multi-turn testing |
| `onToken` | `(token: string) => void` | — | Token streaming callback |
| `awaitHumanHandler` | `(options) => Promise<HumanDecision>` | — | Handler for tool approval requests. Required when the agent uses tools with `requireApproval` — without it, the call throws a clear error |

**When to use vs. workflows:** Use `createContext()` when you want to call agents without registering a workflow — eval files, one-off scripts, tests, API endpoints. Use `runtime.execute()` when you want execution lifecycle tracking (status, duration, history in Studio's executions panel).

**Budget and timeout:**

```typescript
const controller = new AbortController();
setTimeout(() => controller.abort(), 30_000);

const ctx = runtime.createContext({
  budget: '$1.00',
  signal: controller.signal,
});
```

**Tool approval in evals:**

```typescript
const ctx = runtime.createContext({
  awaitHumanHandler: async () => ({ approved: true }), // auto-approve in evals
});
```

### `runtime.trackCost(fn)`

Track cost across any runtime operations within `fn`. Returns `{ result, cost }`. Uses `AsyncLocalStorage` for per-call scoping — correct with concurrent calls. Works with both `createContext()` and `execute()` inside `fn`.

```typescript
const { result, cost } = await runtime.trackCost(async () => {
  const ctx = runtime.createContext();
  return ctx.ask(myAgent, 'hello');
});
console.log(`Cost: $${cost}`);
```

The eval runner uses `trackCost` internally to capture cost automatically for each eval item, including evals that use custom `executeWorkflow` functions.

---

## Context Primitives

All primitives are available on `ctx` inside workflow handlers.

### `ctx.ask(agent, prompt, options?)`

Invoke an agent. Runs the tool-call loop until the agent produces a final response or hits `maxTurns`.

```typescript
const answer = await ctx.ask(myAgent, 'What is 2+2?');

// With structured output
const data = await ctx.ask(myAgent, 'Extract the user profile', {
  schema: UserProfile,
  retries: 3,
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `schema` | `ZodType<T>` | — | Validates and parses the response as structured output. On validation failure, retries with accumulating context |
| `retries` | `number` | `3` | Number of schema validation retries |
| `validate` | `OutputValidator<T>` | — | Post-schema business rule validation. Receives the parsed typed object. Only runs when `schema` is set. See [Validate](#validate) |
| `validateRetries` | `number` | `2` | Maximum retries for `validate` failures |
| `metadata` | `Record<string, unknown>` | — | Merged with workflow metadata and passed to dynamic `model`/`system` selector functions |
| `temperature` | `number` | agent config | Override sampling temperature for this call |
| `maxTokens` | `number` | agent config or `4096` | Override max tokens for this call |
| `effort` | `Effort` | agent config | Override effort level for this call |
| `thinkingBudget` | `number` | agent config | Override thinking budget for this call |
| `includeThoughts` | `boolean` | agent config | Override includeThoughts for this call |
| `toolChoice` | `'auto' \| 'none' \| 'required' \| { type: 'function', function: { name } }` | agent config | Override tool choice for this call |
| `stop` | `string[]` | agent config | Override stop sequences for this call |
| `providerOptions` | `Record<string, unknown>` | agent config | Override provider-specific options for this call. Shallow-merged; see [caveat](providers.md#provideroptions) |

**Precedence:** Per-call `AskOptions` > agent-level `AgentConfig` > internal defaults.

**Returns:** `Promise<T>` — parsed output if `schema` is provided, otherwise `string`.

**Retry mechanics:** All output retries (guardrail, schema, validate) use **accumulating context** — the LLM's failed response is appended as an assistant message, followed by a system message explaining the error. On subsequent retries, the LLM sees all prior failed attempts, giving it increasing context for self-correction. Failed responses are **not** persisted to session history; only the final successful response is recorded. See the [Output Pipeline](#output-pipeline) for the full gate-by-gate flow.

**Streaming:** `validate` cannot be used with streaming (`runtime.stream()`). Validate requires `schema`, which means the output is structured JSON — not text that benefits from progressive rendering. Using both throws an error. For structured output with validation, use a non-streaming call and work with the parsed result directly.

---

### `ctx.delegate(agents, prompt, options?)`

Select the best agent from a list of candidates and invoke it. Creates a temporary router agent that uses handoffs to pick the right specialist.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `agents` | `Agent[]` | Candidate agents to choose from (at least 1) |
| `prompt` | `string` | The prompt to route and process |
| `options.schema` | `z.ZodType<T>` | Zod schema for structured output from the selected agent |
| `options.routerModel` | `string` | Model URI for the internal router (default: first candidate's model) |
| `options.metadata` | `Record<string, unknown>` | Additional metadata passed to router and selected agent |
| `options.retries` | `number` | Retries for structured output validation |
| `options.validate` | `OutputValidator<T>` | Post-schema business rule validation. Forwarded to the final `ctx.ask()` call |
| `options.validateRetries` | `number` | Maximum retries for validate failures (default: 2) |

**Returns:** `Promise<T>` — the selected agent's response.

**Behavior:**
- With 1 agent: calls `ctx.ask()` directly (no routing overhead)
- With 2+ agents: creates a temporary router agent with `temperature: 0` and `maxTurns: 2` that hands off to the best candidate
- Emits a `delegate` trace event with candidate names and router model

**Example:**
```typescript
const result = await ctx.delegate(
  [billingAgent, shippingAgent, generalAgent],
  customerMessage,
);
```

**With structured output:**
```typescript
const result = await ctx.delegate(
  [billingAgent, shippingAgent],
  customerMessage,
  {
    schema: z.object({ answer: z.string(), category: z.string() }),
    routerModel: 'openai-responses:gpt-5-mini',
  },
);
```

---

### `ctx.spawn(n, fn, options?)`

Run N concurrent tasks in parallel.

```typescript
// Wait for all 3
const results = await ctx.spawn(3, (i) => ctx.ask(agent, prompts[i]));

// Wait for 2 of 3, cancel the rest
const results = await ctx.spawn(3, (i) => ctx.ask(agent, prompts[i]), { quorum: 2 });
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `quorum` | `number` | — | Resolve as soon as this many tasks succeed. Remaining tasks are cancelled via `AbortController`. Throws `QuorumNotMet` if fewer than `quorum` succeed |

**Returns:** `Promise<Result<T>[]>` where `Result<T>` is `{ ok: true, value: T } | { ok: false, error: string }`.

---

### `ctx.vote(results, options)`

Pick a winner from an array of `Result<T>` values. All built-in strategies are deterministic — no LLM involved. Use `scorer` or `reducer` for async/LLM-based judging.

```typescript
const winner = await ctx.vote(results, { strategy: 'majority', key: 'answer' });
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `strategy` | `VoteStrategy` | **required** | See strategy table below |
| `key` | `string` | — | Field name to compare when results are objects |
| `scorer` | `(value: T) => number \| Promise<number>` | — | Score each candidate. **Only works with `highest` and `lowest`** |
| `reducer` | `(values: T[]) => T \| Promise<T>` | — | Custom aggregation function. **Only works with `custom`** |

#### Vote Strategies

| Strategy | Description | Compatible options |
|----------|-------------|-------------------|
| `'majority'` | Picks the value that appeared most often | `key` |
| `'unanimous'` | Returns the value if all agree; throws `NoConsensus` if they differ | `key` |
| `'highest'` | Picks the candidate with the highest numeric value | `key` or `scorer` |
| `'lowest'` | Picks the candidate with the lowest numeric value | `key` or `scorer` |
| `'mean'` | Computes the arithmetic mean | Values must be numbers |
| `'median'` | Computes the median | Values must be numbers |
| `'custom'` | Delegates to your `reducer` function | `reducer` |

**Throws:** `NoConsensus` if no successful results, if `unanimous` values differ, or if an invalid strategy/option combination is used.

---

### `ctx.verify(fn, schema, options?)`

Retry-until-valid loop with schema and business rule validation. Calls `fn`, validates the result against `schema` (and optionally `validate`). On failure, calls `fn` again with a retry context describing what went wrong.

Use `ctx.verify()` to validate and retry any async operation — API calls, data transformations, multi-step pipelines — or to wrap `ctx.ask()` as a programmatic repair fallback when the LLM can't satisfy business rules on its own:

```typescript
const OrderSchema = z.object({
  items: z.array(z.object({ sku: z.string(), qty: z.number() })),
  shipping: z.enum(['standard', 'express']),
});

const orderValidator = (order: z.infer<typeof OrderSchema>) => {
  if (order.items.some(i => i.qty <= 0)) {
    return { valid: false, reason: 'All quantities must be positive' } as const;
  }
  return { valid: true } as const;
};

// ctx.ask() retries internally (schema: 3, validate: 2 by default).
// If it still fails, ctx.verify() catches the error and provides retry.parsed.
const order = await ctx.verify(
  async (retry) => {
    if (retry?.parsed) {
      // LLM couldn't get it right — repair programmatically
      return { ...retry.parsed, items: retry.parsed.items.filter(i => i.qty > 0) };
    }
    return ctx.ask(extractAgent, 'Extract the order from this email', {
      schema: OrderSchema,
      validate: orderValidator,
    });
  },
  OrderSchema,
  { retries: 1, validate: orderValidator },
);
```

**`fn` signature:** `(retry?: VerifyRetry<T>) => Promise<unknown>`

On the first call, `retry` is `undefined`. On retries, it contains:

| Field | Type | Description |
|-------|------|-------------|
| `retry.error` | `string` | Error message from the failed attempt |
| `retry.output` | `unknown` | Raw return value from the previous `fn` call |
| `retry.parsed` | `T \| undefined` | Schema-parsed object — **only present when schema passed but validate failed**. Safe to modify and return. Absent on schema failures |

See [Validated Data Extraction](use-cases.md#validated-data-extraction) for more patterns including API data repair and non-LLM use cases.

**Error extraction from `fn()` throws:** When `fn()` throws instead of returning, `verify` inspects the error and extracts structured output so the next retry has data to work with. Since `fn()` never returned a value, `retry.output` would normally be `undefined` — but `verify` recovers it from the error's `lastOutput` property:

- **`ValidationError`** (e.g., `ctx.ask()` with `validate` exhausted its retries): `retry.parsed` and `retry.output` are both populated from `err.lastOutput` — the schema-valid, parsed object that passed schema but failed business rules. Use `retry?.parsed` to repair it programmatically.
- **`VerifyError`** (e.g., `ctx.ask()` with `schema` exhausted its retries, or nested `ctx.verify()`): `retry.output` is populated from `err.lastOutput` — the raw LLM response string that failed schema parsing. `retry.parsed` remains `undefined` since the output couldn't be parsed.
- **Other errors**: `retry.output` and `retry.parsed` are both `undefined` (no structured output to extract).

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `retries` | `number` | `3` | Maximum retry attempts |
| `fallback` | `T` | — | Return this value instead of throwing when retries are exhausted |
| `validate` | `OutputValidator<T>` | — | Post-schema business rule validation. Runs after schema parse succeeds |

**Throws:** `VerifyError` (schema failure) or `ValidationError` (validate failure) if retries exhausted and no fallback provided. When `fn()` throws a `VerifyError` or `ValidationError`, `verify` re-throws the original error (not a new wrapper) after retries are exhausted.

**Retry mechanics:** `ctx.verify()` is **not** conversation-aware. It is a plain loop that calls your function, validates the return value (schema then validate), and on failure passes a `VerifyRetry` context to your next call. What you do with that context is entirely up to you — `ctx.verify()` does not modify any LLM conversation or session history. This makes it suitable for retrying any async operation, not just LLM calls.

---

### `ctx.budget(options, fn)`

Cost-bounded execution. Tracks LLM spend inside `fn` and enforces the limit based on the `onExceed` policy.

```typescript
const result = await ctx.budget({ cost: '$5.00', onExceed: 'hard_stop' }, async () => {
  return await ctx.ask(agent, prompt);
});

if (result.budgetExceeded) {
  console.log(`Spent $${result.totalCost}, budget exceeded`);
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `cost` | `string` | **required** | Dollar amount (e.g., `'$5.00'`, `'$0.50'`) |
| `onExceed` | `'finish_and_stop' \| 'hard_stop' \| 'warn'` | `'finish_and_stop'` | See policies below |

#### `onExceed` Policies

| Policy | Behavior |
|--------|----------|
| `'finish_and_stop'` | Let the current LLM call finish, then prevent further calls. The function completes normally with whatever result is available |
| `'hard_stop'` | Abort immediately via `AbortController`. The current LLM call is cancelled mid-flight. Returns `{ value: null, budgetExceeded: true }` |
| `'warn'` | Log a warning but allow execution to continue past the budget |

**Returns:** `BudgetResult<T>`: `{ value: T | null, budgetExceeded: boolean, totalCost: number }`

**Nesting:** Budget blocks can be nested. Inner budgets roll their costs up to the parent.

### `ctx.totalCost`

Read-only getter returning the total cost accumulated by agent calls in this context. Inside a `ctx.budget()` block, returns only that block's accumulated cost; after the block completes, the nested cost is rolled up into the parent total.

```typescript
const ctx = runtime.createContext();
await ctx.ask(agent, 'hello');
console.log(ctx.totalCost); // e.g. 0.05
```

---

### `ctx.race(fns, options?)`

Run multiple functions in parallel, return the first successful result. Remaining functions are cancelled.

```typescript
const fastest = await ctx.race([
  () => ctx.ask(fastAgent, question),
  () => ctx.ask(smartAgent, question),
], { schema: AnswerSchema });
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `schema` | `ZodType` | — | Validate each result. Invalid results are discarded and the race continues until a valid result is produced |
| `validate` | `OutputValidator<T>` | — | Post-schema business rule validation. Results that fail are discarded like schema failures. Requires `schema` |

**Returns:** `Promise<T>` — the first valid result.

---

### `ctx.parallel(fns)`

Run independent tasks concurrently. Unlike `race`, waits for all to complete.

```typescript
const [users, orders] = await ctx.parallel([
  () => ctx.ask(agentA, 'fetch users'),
  () => ctx.ask(agentB, 'fetch orders'),
]);
```

No options. Returns a tuple of results matching the input array.

---

### `ctx.map(items, fn, options?)`

Map over an array with bounded concurrency. Like `Array.map()` but with parallel workers and optional quorum.

```typescript
const results = await ctx.map(reviews, async (review) => {
  return await ctx.ask(analyst, review, { schema: SentimentScore });
}, { concurrency: 10, quorum: 150 });
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `concurrency` | `number` | `5` | Maximum number of concurrent workers |
| `quorum` | `number` | — | Resolve when this many items succeed. Remaining work is cancelled. Throws `QuorumNotMet` if not met |

**Returns:** `Promise<Result<U>[]>` — results in the same order as `items`. Some may be `{ ok: false }` if they errored.

---

### `ctx.awaitHuman(options)`

Suspend the workflow and wait for a human decision. The pending decision is persisted to the state store and survives process restarts.

```typescript
const decision = await ctx.awaitHuman({
  channel: 'manager_approval',
  prompt: `Refund of $${amount} requires approval`,
  metadata: { orderId, amount },
});

if (decision.approved) {
  // proceed
} else {
  console.log(`Denied: ${decision.reason}`);
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `channel` | `string` | **required** | Channel name for routing decisions in your host app |
| `prompt` | `string` | **required** | Human-readable description of what needs approval |
| `metadata` | `Record<string, unknown>` | — | Arbitrary data attached to the decision (e.g., order ID, amount) |

**Returns:** `HumanDecision`:
- `{ approved: true, data?: string }` — approved, with optional response data
- `{ approved: false, reason?: string }` — denied, with optional reason

**Resolution:** The host app resolves decisions via `runtime.getPendingDecisions()` and `runtime.resolveDecision(executionId, decision)`. See [Security > Approval Gates](./security.md#approval-gates).

---

### `ctx.checkpoint(fn)`

Durable execution. If the workflow is replayed (e.g., after a process restart), checkpointed results are restored from the state store instead of re-executing.

```typescript
const value = await ctx.checkpoint(async () => expensiveOperation());
```

No options. Returns the result of `fn`.

---

### `ctx.remember(key, value, options?)`

Store a value in working memory.

```typescript
await ctx.remember('user_preference', { theme: 'dark' }, { scope: 'global', embed: true });
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `scope` | `'session' \| 'global'` | `'session'` | `session`: scoped to the current session. `global`: accessible across all sessions |
| `metadata` | `Record<string, unknown>` | — | Arbitrary metadata stored alongside the value |
| `embed` | `boolean` | `false` | When `true`, also generates an embedding for semantic search. Requires a vector store and embedder in the runtime config |

---

### `ctx.recall(key, options?)`

Retrieve a value from memory by exact key, or perform semantic similarity search.

```typescript
// Exact key lookup
const pref = await ctx.recall('user_preference');

// Semantic search
const related = await ctx.recall('preferences', {
  query: 'What color theme does the user like?',
  topK: 3,
  scope: 'global',
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `scope` | `'session' \| 'global'` | `'session'` | Memory scope to search |
| `query` | `string` | — | When provided, performs semantic similarity search instead of exact key lookup. Requires a vector store and embedder |
| `topK` | `number` | `5` | Number of results to return from semantic search |

**Returns:** `unknown | null` for exact lookup, `VectorResult[]` for semantic search.

---

### `ctx.forget(key, options?)`

Delete a memory entry.

```typescript
await ctx.forget('user_preference', { scope: 'global' });
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `scope` | `'session' \| 'global'` | `'session'` | Memory scope |

---

### `ctx.log(event, data?)`

Emit a structured trace event.

```typescript
ctx.log('custom_event', { userId: '123', action: 'checkout' });
```

No options beyond the event name and optional data payload.

---

## Guardrails

User-defined validation functions that run at the agent boundary, before and after each LLM call.

```typescript
const safe = agent({
  model: 'openai-responses:gpt-5.4',
  system: 'You are a helpful assistant.',
  guardrails: {
    input: async (prompt, ctx) => {
      if (containsPII(prompt)) return { block: true, reason: 'PII detected' };
      return { block: false };
    },
    output: async (response, ctx) => {
      if (isOffTopic(response)) return { block: true, reason: 'Off-topic response' };
      return { block: false };
    },
    onBlock: 'retry',
    maxRetries: 2,
  },
});
```

### `GuardrailsConfig`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `input` | `InputGuardrail` | — | Runs before each LLM call |
| `output` | `OutputGuardrail` | — | Runs after each LLM response |
| `onBlock` | `'retry' \| 'throw' \| GuardrailBlockHandler` | `'throw'` | What to do when a guardrail blocks. See policies below |
| `maxRetries` | `number` | `2` | Maximum retries when `onBlock` is `'retry'` |

### `onBlock` Policies

| Policy | Behavior |
|--------|----------|
| `'retry'` | Append the LLM's blocked output (as an assistant message) and the block reason (as a system correction prompt) to the conversation, then re-call the LLM so it can self-correct. Only applies to **output** guardrails — input guardrails always throw since the prompt is user-supplied |
| `'throw'` | Throw a `GuardrailError` immediately |
| `(reason, ctx) => string` | Custom function that receives the block reason and returns a fallback response (does not retry the LLM) |

**Retry mechanics:** On each retry, the LLM's blocked response is appended to the conversation as an assistant message, followed by a system message: *"Your previous response was blocked by a safety guardrail: {reason}. Please provide a different response that complies with the guidelines."* These messages **accumulate** across retries — if the guardrail blocks twice, the LLM sees both failed attempts and both correction prompts before its third try, giving it increasing context about what to avoid. All retry messages are ephemeral — they exist only within the `ctx.ask()` call and are **not** persisted to session history. Only the final successful response is recorded in the session, so subsequent turns never see the blocked attempts.

Schema retries and validate retries use the same accumulating pattern — see [Validate](#validate) and the [Output Pipeline](#output-pipeline) for the full flow.

### Callback Signatures

```typescript
type InputGuardrail = (
  prompt: string,
  ctx: { metadata: Record<string, unknown> },
) => GuardrailResult | Promise<GuardrailResult>;

type OutputGuardrail = (
  response: string,
  ctx: { metadata: Record<string, unknown> },
) => GuardrailResult | Promise<GuardrailResult>;

type GuardrailResult = { block: boolean; reason?: string };
```

---

## Validate

Post-schema business rule validation that receives the **parsed, typed object** — not the raw LLM string. Configured per-call on `AskOptions`, co-located with the `schema` it validates. Designed for domain-specific constraints that can't be expressed in a Zod schema (e.g., cross-field relationships, computed totals, referential integrity).

```typescript
const result = await ctx.ask(agent, prompt, {
  schema: MySchema,
  validate: (data) => {
    if (!isValid(data)) return { valid: false, reason: 'explain what is wrong' };
    return { valid: true };
  },
});
```

**Requires `schema`.** Without a schema, `validate` is silently skipped — use output guardrails for raw text validation instead. This enforces a clean separation: guardrails own content safety (raw text, per-agent), validate owns business rules (typed object, per-call).

**Supported on:** `ctx.ask()`, `ctx.delegate()`, `ctx.race()`, and `ctx.verify()`. On delegate and handoffs, validate is forwarded to the final agent call. On race, results that fail validate are discarded (same as schema failures).

See [Validated Data Extraction](use-cases.md#validated-data-extraction) for complete examples.

### `OutputValidator`

```typescript
type OutputValidator<T = unknown> = (
  output: T,
  ctx: { metadata: Record<string, unknown> },
) => ValidateResult | Promise<ValidateResult>;

// Note: uses `valid: true` = pass, unlike GuardrailResult which uses `block: true` = fail
type ValidateResult = { valid: boolean; reason?: string };
```

| AskOptions field | Type | Default | Description |
|--------|------|---------|-------------|
| `validate` | `OutputValidator<T>` | — | Validation function. Receives the schema-parsed object. `T` is inferred from `schema` |
| `validateRetries` | `number` | `2` | Maximum retries before throwing `ValidationError` |

**Retry mechanics:** The LLM's failed response and the validation error are appended to the conversation history as assistant + system messages. Context **accumulates** across retries, so the LLM sees all previous failed attempts and can reason about what to fix. The validation `reason` is fed back in the system message: *"Your response parsed correctly but failed validation: {reason}."* If the validator throws an exception, it's treated as a validation failure — the error message is fed back and the retry counter is incremented.

On retry, the new LLM response goes through the **full output pipeline** again (guardrail → schema → validate). See [Output Pipeline](#output-pipeline) below.

### Output Pipeline

Every LLM response passes through three gates in order. Each gate has its own retry counter. On any failure, the loop restarts from the LLM call — the new response goes through **all gates** again:

```
LLM response (raw string)
  → Gate 1: Output guardrail  (raw text — content safety)
  → Gate 2: Schema validation (JSON parse + Zod — structural correctness)
  → Gate 3: Validate          (typed object — business rules)
  → Return result
```

| Gate | Receives | Configured by | Default retries | Error on exhaustion |
|------|----------|---------------|-----------------|---------------------|
| Output guardrail | Raw string | `AgentConfig.guardrails.maxRetries` | 2 | `GuardrailError` |
| Schema validation | Raw string | `AskOptions.retries` | 3 | `VerifyError` |
| Validate | Parsed object | `AskOptions.validateRetries` | 2 | `ValidationError` |

Retry counts refer to **retries only** — the initial LLM call does not count. With the defaults (guardrail: 2, schema: 3, validate: 2), the worst case is `1 + 2 + 3 + 2 = 8` total LLM calls: 1 initial call plus up to 7 retries across all gates.

Retries are **additive, not multiplicative** — each gate has its own counter that only increments when *that gate* fails. A response that passes gate 1 but fails gate 2 only increments the gate 2 counter. Counters are persistent across the entire `ctx.ask()` call and do not reset when a different gate fails. The `maxTurns` limit (default 25) provides a hard ceiling on total LLM calls regardless of gate failures.

---

## Sessions

Multi-turn conversation state that persists across HTTP requests.

```typescript
const session = runtime.session('user-123', {
  history: {
    maxMessages: 100,
    summarize: true,
    summaryModel: 'openai-responses:gpt-5-mini',
  },
  persist: true,
});

const result = await session.send('HandleSupport', { msg: 'Help me' });
```

### `SessionOptions`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `history.maxMessages` | `number` | — | Keep the last N messages. Older messages are trimmed (or summarized if `summarize` is `true`) |
| `history.summarize` | `boolean` | `false` | When `true` and `maxMessages` is exceeded, summarize old messages instead of dropping them |
| `history.summaryModel` | `string` | — | Model URI for summarization (e.g., `'openai:gpt-4o-mini'`). **Required** when `summarize` is `true` |
| `persist` | `boolean` | `true` | Save session history to the state store. When `false`, history exists only in memory for the session lifetime |

### Session Methods

| Method | Description |
|--------|-------------|
| `session.send(workflow, input)` | Execute a workflow with session history. Returns the result |
| `session.stream(workflow, input)` | Execute a workflow with session history. Returns an `AxlStream` |
| `session.history()` | Get the full message history |
| `session.handoffs()` | Get the handoff history for this session |
| `session.end()` | Close the session and delete history from the store |
| `session.fork(newId)` | Create a copy of this session with a new ID (including history and metadata) |

---

## AxlRuntime

The central orchestrator. Manages workflow registration, provider resolution, state storage, execution lifecycle, and eval history.

```typescript
import { AxlRuntime } from '@axlsdk/axl';

const runtime = new AxlRuntime({
  state: { store: 'sqlite', sqlite: { path: './data/axl.db' } },
});
```

### Registration

| Method | Description |
|--------|-------------|
| `register(workflow)` | Register a workflow |
| `registerTool(...tools)` | Register one or more standalone tools |
| `registerAgent(...agents)` | Register one or more standalone agents |
| `registerProvider(name, provider)` | Register a custom provider instance |
| `registerEval(name, config, executeWorkflow?)` | Register an eval configuration |

### Execution

| Method | Returns | Description |
|--------|---------|-------------|
| `execute(name, input, options?)` | `Promise<unknown>` | Execute a workflow and return the full result. Tracks execution lifecycle (status, duration, cost, traces) |
| `stream(name, input, options?)` | `AxlStream` | Execute a workflow and return a stream of events. Same lifecycle tracking as `execute()` |
| `session(id, options?)` | `Session` | Create or resume a multi-turn session (see [Sessions](#sessions)) |
| `abort(executionId)` | `void` | Abort a running execution by ID |
| `resumeExecution(executionId)` | `Promise<unknown>` | Resume a suspended execution (after `awaitHuman` is resolved) |
| `resumePending()` | `Promise<string[]>` | Resume all pending executions from the state store. Call on startup to recover suspended workflows |
| `getPendingDecisions()` | `Promise<PendingDecision[]>` | List all pending human decisions |
| `resolveDecision(executionId, decision)` | `Promise<void>` | Resolve a pending human decision. The suspended workflow resumes automatically |

`ExecuteOptions`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `metadata` | `Record<string, unknown>` | `{}` | Metadata passed to the workflow context. Reserved keys: `sessionId`, `sessionHistory`, `resumeMode` |

### Execution History

Completed and failed executions are automatically persisted to the state store (when the store implements `saveExecution`). Historical executions are lazy-loaded on first access.

| Method | Returns | Description |
|--------|---------|-------------|
| `getExecutions()` | `Promise<ExecutionInfo[]>` | All executions (active + historical), sorted by `startedAt` descending. Merges in-memory active executions with historical data from the state store |
| `getExecution(id)` | `Promise<ExecutionInfo \| undefined>` | Look up a specific execution. Checks in-memory first, then falls through to the state store |

`ExecutionInfo`:

| Field | Type | Description |
|-------|------|-------------|
| `executionId` | `string` | Unique execution ID |
| `workflow` | `string` | Workflow name |
| `status` | `'running' \| 'completed' \| 'failed' \| 'waiting'` | Current status |
| `steps` | `TraceEvent[]` | All trace events for this execution |
| `totalCost` | `number` | Accumulated cost in USD |
| `startedAt` | `number` | Start timestamp (ms) |
| `completedAt` | `number \| undefined` | Completion timestamp (ms) |
| `duration` | `number` | Duration in ms |
| `error` | `string \| undefined` | Error message (when `status === 'failed'`) |

### Eval History

Eval results are automatically persisted when using `runRegisteredEval()`. Historical results are lazy-loaded on first access.

| Method | Returns | Description |
|--------|---------|-------------|
| `runRegisteredEval(name)` | `Promise<unknown>` | Run a registered eval by name. Automatically persists the result to eval history |
| `getEvalHistory()` | `Promise<EvalHistoryEntry[]>` | All eval results, most recent first. Merges in-memory results with historical data from the state store |
| `saveEvalResult(entry)` | `Promise<void>` | Manually save an eval result to history |
| `eval(config)` | `Promise<unknown>` | Run an ad-hoc eval (not registered). Does **not** auto-persist to history |
| `evalCompare(baseline, candidate)` | `Promise<unknown>` | Compare two eval results for regressions/improvements |

`EvalHistoryEntry`:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique result ID |
| `eval` | `string` | Eval name |
| `timestamp` | `number` | When the eval was run (ms) |
| `data` | `unknown` | Full `EvalResult` object from `@axlsdk/eval` |

### Introspection

| Method | Returns | Description |
|--------|---------|-------------|
| `getWorkflows()` | `Workflow[]` | All registered workflows |
| `getWorkflow(name)` | `Workflow \| undefined` | Look up a workflow by name |
| `getWorkflowNames()` | `string[]` | All registered workflow names |
| `getAgents()` | `Agent[]` | All registered agents |
| `getAgent(name)` | `Agent \| undefined` | Look up an agent by name |
| `getTools()` | `Tool[]` | All registered tools |
| `getTool(name)` | `Tool \| undefined` | Look up a tool by name |
| `getRegisteredEvals()` | `Array<{ name, workflow, dataset, scorers }>` | All registered eval configs |
| `getRegisteredEval(name)` | `{ config, executeWorkflow? } \| undefined` | Look up a specific eval registration |
| `resolveProvider(uri)` | `{ provider, model }` | Resolve a `provider:model` URI to a Provider instance and model name |
| `getStateStore()` | `StateStore` | The runtime's state store instance |
| `getMcpManager()` | `McpManager \| undefined` | The runtime's MCP manager (if initialized) |

### Lifecycle

| Method | Returns | Description |
|--------|---------|-------------|
| `initializeTelemetry()` | `Promise<void>` | Enable OpenTelemetry span emission. Call before executing workflows |
| `initializeMcp()` | `Promise<void>` | Connect to configured MCP servers |
| `shutdown()` | `Promise<void>` | Abort all in-flight executions, close MCP connections, memory manager, state store, and span manager |

### Ad-hoc Context and Cost Tracking

See [`runtime.createContext()`](#runtimecreatecontextoptions) and [`runtime.trackCost()`](#runtimetrackcostfn) above.

---

## StateStore

Pluggable persistence interface. Built-in implementations: `MemoryStore` (in-memory, for development), `SQLiteStore` (file-based, for single-process production), `RedisStore` (distributed, for multi-process production).

```typescript
import { AxlRuntime, SQLiteStore, RedisStore } from '@axlsdk/axl';

// String shortcut
const runtime = new AxlRuntime({ state: { store: 'sqlite' } });

// Instance for full control
const runtime2 = new AxlRuntime({
  state: { store: await RedisStore.create('redis://localhost:6379') },
});
```

### Required Methods

Every `StateStore` implementation must provide these methods.

**Checkpoints** (for `ctx.checkpoint()` / suspend-resume):

| Method | Description |
|--------|-------------|
| `saveCheckpoint(executionId, step, data)` | Save a checkpoint |
| `getCheckpoint(executionId, step)` | Get a specific checkpoint |
| `getLatestCheckpoint(executionId)` | Get the most recent checkpoint for an execution |

**Sessions**:

| Method | Description |
|--------|-------------|
| `saveSession(sessionId, history)` | Save session message history |
| `getSession(sessionId)` | Get session message history (returns `[]` if not found) |
| `deleteSession(sessionId)` | Delete a session and its metadata |
| `saveSessionMeta(sessionId, key, value)` | Save session metadata (e.g., context summaries) |
| `getSessionMeta(sessionId, key)` | Get session metadata |

**Human-in-the-loop decisions**:

| Method | Description |
|--------|-------------|
| `savePendingDecision(executionId, decision)` | Persist a pending human decision |
| `getPendingDecisions()` | List all pending decisions |
| `resolveDecision(executionId, result)` | Resolve a pending decision |

**Execution state** (for suspend/resume):

| Method | Description |
|--------|-------------|
| `saveExecutionState(executionId, state)` | Save execution state for resume |
| `getExecutionState(executionId)` | Get execution state |
| `listPendingExecutions()` | List execution IDs with status `'waiting'` |

### Optional Methods

These methods are optional (`?` on the interface). The runtime checks for their existence before calling. All three built-in stores implement all optional methods.

**Memory** (for `ctx.remember()` / `ctx.recall()` / `ctx.forget()`):

| Method | Description |
|--------|-------------|
| `saveMemory?(scope, key, value)` | Save a memory entry |
| `getMemory?(scope, key)` | Get a memory entry |
| `getAllMemory?(scope)` | Get all entries for a scope |
| `deleteMemory?(scope, key)` | Delete a memory entry |

**Execution history** (for `runtime.getExecutions()`):

| Method | Description |
|--------|-------------|
| `saveExecution?(execution)` | Save a completed/failed `ExecutionInfo` to history |
| `getExecution?(executionId)` | Get a specific execution from history |
| `listExecutions?(limit?)` | List recent executions, most recent first. Pass `undefined` for no limit |

**Eval history** (for `runtime.getEvalHistory()`):

| Method | Description |
|--------|-------------|
| `saveEvalResult?(entry)` | Save an `EvalHistoryEntry` to history |
| `listEvalResults?(limit?)` | List eval results, most recent first. Pass `undefined` for no limit |

**Introspection and lifecycle**:

| Method | Description |
|--------|-------------|
| `listSessions?()` | List all session IDs (used by Studio's session browser) |
| `close?()` | Close the underlying connection (called by `runtime.shutdown()`) |
| `deleteCheckpoints?(executionId)` | Delete all checkpoints for an execution (called on successful completion) |

### Implementing a Custom StateStore

Implement the required methods. Optional methods are only called if they exist on the object — omitting them is safe.

```typescript
import type { StateStore } from '@axlsdk/axl';

class MyStore implements StateStore {
  // Required: implement all checkpoint, session, decision, and execution state methods
  // Optional: implement saveExecution/listExecutions for execution history,
  //           saveEvalResult/listEvalResults for eval history, etc.
}

const runtime = new AxlRuntime({ state: { store: new MyStore() } });
```

---

## TraceEvent

Every agent call, tool invocation, handoff, and system event emits a `TraceEvent`. These accumulate in `ExecutionInfo.steps` and are broadcast via WebSocket in Studio.

| Field | Type | Description |
|-------|------|-------------|
| `executionId` | `string` | Execution this event belongs to |
| `step` | `number` | Auto-incrementing step counter |
| `type` | `string` | Event type: `'agent_call'`, `'tool_call'`, `'tool_denied'`, `'handoff'`, `'delegate'`, `'verify'`, `'guardrail'`, `'validate'`, `'log'`, `'workflow_start'`, `'workflow_end'` |
| `workflow` | `string?` | Workflow name (on workflow events) |
| `agent` | `string?` | Agent name |
| `tool` | `string?` | Tool name (on tool events) |
| `model` | `string?` | Model URI (on agent_call events) |
| `promptVersion` | `string?` | Agent version (on agent_call events) |
| `cost` | `number?` | Cost in USD for this step |
| `tokens` | `{ input?, output?, reasoning? }?` | Token usage from the provider (on `agent_call` events). Maps from `ProviderResponse.usage` |
| `duration` | `number?` | Duration in ms |
| `data` | `unknown?` | Event-specific payload (prompt/response for agent_call, args/result for tool_call, etc.) |
| `timestamp` | `number` | Event timestamp (ms) |

---

## Error Types

All errors extend `AxlError`.

| Error | Thrown by | Description |
|-------|----------|-------------|
| `VerifyError` | `ctx.ask()`, `ctx.verify()` | Schema validation failed after all retries. Includes `.lastOutput`, `.zodError`, `.retries` |
| `ValidationError` | `ctx.ask()`, `ctx.verify()` | Post-schema business rule validation failed after all retries. Includes `.lastOutput`, `.reason`, `.retries` |
| `QuorumNotMet` | `ctx.spawn()`, `ctx.map()` | Fewer tasks succeeded than the required quorum. Includes `.results` |
| `NoConsensus` | `ctx.vote()` | No successful results to vote on, unanimous vote failed, or invalid strategy/option combination |
| `TimeoutError` | `ctx.ask()` | Agent exceeded its configured `timeout` |
| `MaxTurnsError` | `ctx.ask()` | Agent exceeded its configured `maxTurns` |
| `BudgetExceededError` | `ctx.budget()` | Budget exceeded with `hard_stop` policy. Includes `.limit`, `.spent`, `.policy` |
| `GuardrailError` | `ctx.ask()` | Guardrail blocked and retries exhausted. Includes `.guardrailType`, `.reason` |
| `ToolDenied` | `ctx.ask()` | Agent attempted to call a tool not in its ACL. Includes `.toolName`, `.agentName` |

---

## Evaluation Types

Types from `@axlsdk/eval` used by `runEval()`, `runtime.eval()`, and the CLI.

### `EvalConfig`

Configuration for `runEval()` and `runtime.eval()`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `workflow` | `string` | required | Workflow name (label for results; must match a registered workflow when using `runtime.eval()`) |
| `dataset` | `Dataset` | required | Dataset to evaluate against |
| `scorers` | `Scorer[]` | required | Scoring functions to apply to each output |
| `concurrency` | `number` | `5` | Maximum parallel item executions |
| `budget` | `string` | — | Cost limit (e.g., `"$10.00"`). Stops processing when exceeded |
| `metadata` | `Record<string, unknown>` | — | Arbitrary metadata attached to the result (e.g., model version, prompt variant) |

### `DatasetConfig`

Configuration for `dataset()`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | required | Dataset name (appears in results and comparisons) |
| `schema` | `z.ZodType` | required | Zod schema for dataset item inputs |
| `annotations` | `z.ZodType` | — | Zod schema for ground-truth annotations |
| `items` | `DatasetItem[]` | — | Inline dataset items (each has `input` and optional `annotations`) |
| `file` | `string` | — | Path to a JSON file containing items (alternative to inline `items`) |
| `basePath` | `string` | `cwd` | Base directory for resolving relative `file` paths |

### `ScorerResult`

Rich result from a scorer, returned instead of a plain number when the scorer needs to convey metadata or cost.

| Field | Type | Description |
|-------|------|-------------|
| `score` | `number` | Score value (0-1) |
| `metadata` | `Record<string, unknown>?` | Arbitrary metadata (e.g., `reasoning`, `confidence`). LLM scorers populate this with the full schema response |
| `cost` | `number?` | LLM cost incurred by this scorer invocation |

### `ScorerDetail`

Per-scorer data stored on each `EvalItem`, providing richer detail than the `scores` map.

| Field | Type | Description |
|-------|------|-------------|
| `score` | `number \| null` | Score value, or `null` if the scorer failed |
| `metadata` | `Record<string, unknown>?` | Scorer metadata (e.g., reasoning from LLM scorers) |
| `duration` | `number?` | Scorer execution time in ms |
| `cost` | `number?` | LLM cost for this scorer invocation |

### `EvalItem`

Per-item result from an eval run. `scores` provides quick numeric access; `scoreDetails` provides the full picture (metadata, per-scorer timing, per-scorer cost).

| Field | Type | Description |
|-------|------|-------------|
| `input` | `unknown` | The dataset input |
| `annotations` | `unknown?` | Ground truth annotations |
| `output` | `unknown` | Workflow output |
| `error` | `string?` | Workflow-level error message |
| `scorerErrors` | `string[]?` | Scorer-level error messages (thrown exceptions or out-of-range scores) |
| `scores` | `Record<string, number \| null>` | Quick numeric access to scores. `null` = scorer error (see `scorerErrors`) |
| `duration` | `number?` | Workflow execution time in ms (set even when workflow errors) |
| `cost` | `number?` | Workflow LLM cost |
| `scorerCost` | `number?` | Total scorer cost for this item (sum of all `scoreDetails[*].cost`) |
| `scoreDetails` | `Record<string, ScorerDetail>?` | Rich per-scorer data — includes `metadata` (e.g., LLM reasoning), per-scorer `duration`, and `cost` |

### `EvalResult`

Full result from an eval run.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique eval run ID |
| `workflow` | `string` | Workflow name |
| `dataset` | `string` | Dataset name |
| `metadata` | `Record<string, unknown>` | User-provided metadata (from `EvalConfig.metadata`) |
| `timestamp` | `string` | ISO 8601 timestamp |
| `totalCost` | `number` | Total LLM cost (workflow + LLM scorers) |
| `duration` | `number` | Wall-clock time in ms |
| `items` | `EvalItem[]` | Per-item results |
| `summary` | `EvalSummary` | Aggregate statistics |

### `EvalSummary`

Aggregate statistics across all items.

| Field | Type | Description |
|-------|------|-------------|
| `count` | `number` | Total items |
| `failures` | `number` | Items where the workflow threw an error |
| `scorers` | `Record<string, { mean, min, max, p50, p95 }>` | Per-scorer aggregate stats (all values 0-1) |
| `timing` | `{ mean, min, max, p50, p95 }?` | Per-item duration statistics in ms |

### `Scorer`

A scoring function returned by `scorer()` or `llmScorer()`.

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Unique scorer name |
| `description` | `string` | What this scorer evaluates |
| `isLlm` | `boolean` | `true` for LLM scorers |
| `score` | `(output, input, annotations?, context?) => number \| ScorerResult \| Promise<number \| ScorerResult>` | Scoring function (returns 0-1 or a `ScorerResult` with metadata/cost). `context` is a `ScorerContext` passed by the eval runner |

### `LlmScorerConfig`

Configuration for `llmScorer()`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | required | Unique scorer name |
| `description` | `string` | required | What this scorer evaluates |
| `model` | `string` | required | Provider:model URI (e.g., `openai:gpt-4o`) |
| `system` | `string` | required | System prompt for the judge LLM |
| `schema` | `z.ZodType<{ score: number; ... }>` | `z.object({ score: z.number(), reasoning: z.string() })` | Response schema — converted to JSON Schema and included in the prompt so the LLM knows the exact structure to produce |
| `temperature` | `number` | `0.2` | Low for scoring consistency |

### `ScorerContext`

Context passed to scorers by the eval runner.

| Field | Type | Description |
|-------|------|-------------|
| `resolveProvider` | `(modelUri: string) => { provider, model }` | Resolves a `provider:model` URI to a provider instance and stripped model name. Used by LLM scorers to obtain their provider |

### `EvalComparison`

Result from `evalCompare()` comparing a baseline and candidate eval run.

| Field | Type | Description |
|-------|------|-------------|
| `baseline` | `{ id, metadata }` | Baseline run identity |
| `candidate` | `{ id, metadata }` | Candidate run identity |
| `scorers` | `Record<string, { baselineMean, candidateMean, delta, deltaPercent }>` | Per-scorer mean comparison |
| `timing` | `{ baselineMean, candidateMean, delta, deltaPercent }?` | Per-item duration comparison |
| `cost` | `{ baselineTotal, candidateTotal, delta, deltaPercent }?` | Total cost comparison |
| `regressions` | `EvalRegression[]` | Items that got worse |
| `improvements` | `EvalImprovement[]` | Items that got better |
| `summary` | `string` | Human-readable summary |

### `EvalRegression` / `EvalImprovement`

Individual item that regressed or improved between runs.

| Field | Type | Description |
|-------|------|-------------|
| `itemIndex` | `number` | Index into the items array for lookup |
| `input` | `unknown` | The dataset input for this item |
| `scorer` | `string` | Which scorer detected the change |
| `baselineScore` | `number` | Score in the baseline run |
| `candidateScore` | `number` | Score in the candidate run |
| `delta` | `number` | Score difference (candidate - baseline) |

### `normalizeScorerResult(result)`

Converts a scorer return value (`number | ScorerResult`) to a `ScorerResult`. Returns the input as-is if already a `ScorerResult`, or wraps a plain number as `{ score: result }`.

### `runEval(config, executeWorkflow, runtime)`

Run an evaluation. LLM scorer providers are auto-resolved from the runtime's provider registry using each scorer's `model` URI. No explicit provider export is needed from eval files -- ensure the relevant API key environment variable is set or register providers via `runtime.registerProvider()`.

---

## Multi-Agent Decision Tree

A guide for choosing the right primitive for multi-agent coordination:

```
START: I need to coordinate multiple agents
|
+-- Do I know WHICH agent to call?
|   +-- YES -> ctx.ask(agent, prompt)
|   |   +-- Need structured output? -> { schema }
|   |   +-- Need business rule validation? -> { schema, validate }
|   |
|   +-- NO, I need to pick from candidates
|       +-- The AGENT's LLM should decide (mid-conversation) -> Handoffs
|       |   +-- Static candidate list -> handoffs: [{ agent, description }]
|       |   +-- Context-dependent list -> handoffs: (ctx) => [...]
|       |   +-- Transfer control permanently -> mode: 'oneway'
|       |   +-- Get result back and continue -> mode: 'roundtrip'
|       |
|       +-- The WORKFLOW should decide (orchestration level)
|           -> ctx.delegate(agents, prompt, { schema, validate })
|
+-- Do I need MULTIPLE agents working simultaneously?
|   +-- Same task, different perspectives -> ctx.spawn(n, fn)
|   |   +-- Need to pick a winner? -> ctx.vote(results, { strategy })
|   |
|   +-- Different items, same processing -> ctx.map(items, fn, { concurrency })
|   |
|   +-- First-to-finish wins -> ctx.race(fns, { schema, validate })
|   |
|   +-- Different tasks, need typed results -> ctx.parallel(fns)
|
+-- Do I need to VALIDATE and RETRY non-LLM operations?
|   +-- YES -> ctx.verify(fn, schema, { validate })
|       +-- LLM can't satisfy rules? -> Wrap ctx.ask() in ctx.verify()
|           for programmatic repair via retry.parsed
|
+-- Do I need SEQUENTIAL agent stages?
|   +-- YES -> Sequential ctx.ask() calls (imperative TypeScript)
|
+-- Do I need an AGENT to orchestrate other agents?
|   +-- YES -> Agent-as-tool pattern:
|       +-- Define tools whose handlers call ctx.ask(subAgent, ...)
|           +-- Give those tools to the orchestrator agent
|
+-- Do I need COST CONTROL across the whole workflow?
    +-- YES -> Wrap with ctx.budget({ cost: '$10' }, fn)
```
