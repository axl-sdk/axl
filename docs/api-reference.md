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
  model: 'openai:gpt-4o',
  system: 'You are a helpful assistant.',
  tools: [search, calculator],
  temperature: 0.7,
  maxTokens: 8192,
  reasoningEffort: 'high',
  maxTurns: 10,
  timeout: '30s',
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | model string or `Agent_N` | Display name used in traces |
| `model` | `string \| (ctx) => string` | **required** | Provider URI (e.g., `'openai:gpt-4o'`, `'anthropic:claude-sonnet-4-5'`). Function form enables dynamic model routing |
| `system` | `string \| (ctx) => string` | **required** | System prompt. Function form enables per-request customization |
| `tools` | `Tool[]` | `[]` | Tools this agent can call. Acts as an ACL — the agent cannot call tools not in this list |
| `handoffs` | `HandoffDescriptor[] \| (ctx) => HandoffDescriptor[]` | `[]` | Agents this agent can hand off to. Function form receives `{ metadata?: Record<string, unknown> }` for dynamic routing (see below) |
| `mcp` | `string[]` | `[]` | MCP server names to connect. Tools from these servers are merged into the agent's tool set |
| `mcpTools` | `string[]` | — | Whitelist: only expose these specific MCP tools |
| `temperature` | `number` | provider default | LLM sampling temperature |
| `maxTokens` | `number` | `4096` | Maximum tokens in the LLM response |
| `thinking` | `Thinking` | — | Thinking/reasoning level. `'low'` \| `'medium'` \| `'high'` \| `'max'` or `{ budgetTokens?: number, includeThoughts?: boolean }`. Works across all providers. `includeThoughts` returns thought summaries (Gemini only) |
| `reasoningEffort` | `ReasoningEffort` | — | OpenAI-specific reasoning effort escape hatch. Values: `'none'` \| `'minimal'` \| `'low'` \| `'medium'` \| `'high'` \| `'xhigh'`. Prefer `thinking` |
| `toolChoice` | `'auto' \| 'none' \| 'required' \| { type: 'function', function: { name } }` | — | Tool choice strategy: `'auto'` lets the model decide, `'none'` forbids tool use, `'required'` forces at least one tool call, or specify a function name to force a specific tool |
| `stop` | `string[]` | — | Stop sequences — generation stops when any sequence is encountered. Not supported by the `openai-responses` provider (silently ignored) |
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
  model: 'openai:gpt-4o-mini',
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

Create a lightweight `WorkflowContext` for ad-hoc use outside of workflows (e.g., tool testing, prototyping). The context has access to the runtime's providers, state store, MCP, telemetry, and memory — but no session history, streaming callbacks, or budget tracking.

```typescript
const ctx = runtime.createContext({ metadata: { env: 'test' } });
const result = await myTool.run(ctx, { query: 'hello' });
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `metadata` | `Record<string, unknown>` | `{}` | Metadata passed to the context |

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
| `schema` | `ZodType` | — | Validates and parses the response as structured output. On validation failure, feeds the Zod error back to the LLM for self-correction |
| `retries` | `number` | `3` | Number of schema validation retries |
| `metadata` | `Record<string, unknown>` | — | Merged with workflow metadata and passed to dynamic `model`/`system` selector functions |
| `temperature` | `number` | agent config | Override sampling temperature for this call |
| `maxTokens` | `number` | agent config or `4096` | Override max tokens for this call |
| `thinking` | `Thinking` | agent config | Override thinking level for this call |
| `reasoningEffort` | `ReasoningEffort` | agent config | Override reasoning effort (OpenAI-specific) |
| `toolChoice` | `'auto' \| 'none' \| 'required' \| { type: 'function', function: { name } }` | agent config | Override tool choice for this call |
| `stop` | `string[]` | agent config | Override stop sequences for this call |

**Precedence:** Per-call `AskOptions` > agent-level `AgentConfig` > internal defaults.

**Returns:** `Promise<T>` — parsed output if `schema` is provided, otherwise `string`.

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
    routerModel: 'openai:gpt-4o-mini',
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
const winner = ctx.vote(results, { strategy: 'majority', key: 'answer' });
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

Self-correcting validation loop. Calls `fn`, validates against `schema`. On failure, passes the last output and error message back to `fn` for correction.

```typescript
const valid = await ctx.verify(
  async (lastOutput, error) => ctx.ask(agent, error ? `Fix: ${error}` : prompt),
  UserProfile,
  { retries: 3, fallback: defaultProfile },
);
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `retries` | `number` | `3` | Maximum retry attempts |
| `fallback` | `T` | — | Return this value instead of throwing when retries are exhausted |

**Throws:** `VerifyError` (includes last output and Zod error) if retries exhausted and no fallback provided.

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
  model: 'openai:gpt-4o',
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
| `onBlock` | `'retry' \| 'throw' \| BlockHandler` | `'throw'` | What to do when a guardrail blocks. See policies below |
| `maxRetries` | `number` | — | Maximum retries when `onBlock` is `'retry'` |

### `onBlock` Policies

| Policy | Behavior |
|--------|----------|
| `'retry'` | Feed the block reason back to the LLM as a correction prompt. The agent self-corrects and tries again |
| `'throw'` | Throw a `GuardrailError` immediately |
| `(reason, ctx) => string` | Custom function that receives the block reason and returns a correction prompt for the LLM |

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

## Sessions

Multi-turn conversation state that persists across HTTP requests.

```typescript
const session = runtime.session('user-123', {
  history: {
    maxMessages: 100,
    summarize: true,
    summaryModel: 'openai:gpt-4o-mini',
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

## Error Types

All errors extend `AxlError`.

| Error | Thrown by | Description |
|-------|----------|-------------|
| `VerifyError` | `ctx.verify()` | Schema validation failed after all retries. Includes `.lastOutput` and `.zodError` |
| `QuorumNotMet` | `ctx.spawn()`, `ctx.map()` | Fewer tasks succeeded than the required quorum. Includes `.required`, `.actual`, and `.results` |
| `NoConsensus` | `ctx.vote()` | No successful results to vote on, unanimous vote failed, or invalid strategy/option combination |
| `TimeoutError` | `ctx.ask()` | Agent exceeded its configured `timeout` |
| `MaxTurnsError` | `ctx.ask()` | Agent exceeded its configured `maxTurns` |
| `BudgetExceededError` | `ctx.budget()` | Budget exceeded with `hard_stop` policy |
| `GuardrailError` | `ctx.ask()` | Guardrail blocked and retries exhausted. Includes `.reason` |
| `ToolDenied` | `ctx.ask()` | Agent attempted to call a tool not in its ACL |

---

## Multi-Agent Decision Tree

A guide for choosing the right primitive for multi-agent coordination:

```
START: I need to coordinate multiple agents
|
+-- Do I know WHICH agent to call?
|   +-- YES -> ctx.ask(agent, prompt)
|   |   +-- Need structured output? -> ctx.ask(agent, prompt, { schema })
|   |
|   +-- NO, I need to pick from candidates
|       +-- The AGENT's LLM should decide (mid-conversation) -> Handoffs
|       |   +-- Static candidate list -> handoffs: [{ agent, description }]
|       |   +-- Context-dependent list -> handoffs: (ctx) => [...]
|       |   +-- Transfer control permanently -> mode: 'oneway'
|       |   +-- Get result back and continue -> mode: 'roundtrip'
|       |
|       +-- The WORKFLOW should decide (orchestration level)
|           -> ctx.delegate(agents, prompt)
|
+-- Do I need MULTIPLE agents working simultaneously?
|   +-- Same task, different perspectives -> ctx.spawn(n, fn)
|   |   +-- Need to pick a winner? -> ctx.vote(results, { strategy })
|   |
|   +-- Different items, same processing -> ctx.map(items, fn, { concurrency })
|   |
|   +-- First-to-finish wins -> ctx.race(fns)
|   |
|   +-- Different tasks, need typed results -> ctx.parallel(fns)
|
+-- Do I need SEQUENTIAL agent stages?
|   +-- YES -> Sequential ctx.ask() calls (imperative TypeScript)
|       +-- Need to validate between stages? -> ctx.verify(fn, schema)
|
+-- Do I need an AGENT to orchestrate other agents?
|   +-- YES -> Agent-as-tool pattern:
|       +-- Define tools whose handlers call ctx.ask(subAgent, ...)
|           +-- Give those tools to the orchestrator agent
|
+-- Do I need COST CONTROL across the whole workflow?
    +-- YES -> Wrap with ctx.budget({ cost: '$10' }, fn)
```
