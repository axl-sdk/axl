# Security Model

## Tool Access Control

Agents can **only** invoke tools listed in their `tools` configuration. This is enforced at runtime.

```typescript
const SupportBot = agent({
  model: 'openai-responses:gpt-5.4',
  tools: [getOrder, refundOrder],
  // SupportBot CANNOT call deleteUser — runtime will reject the call
});
```

If an LLM attempts to invoke a tool not in the agent's `tools` list (including MCP tools), the runtime:
1. Blocks the call.
2. Logs a `tool_denied` event (visible in traces).
3. Sends a correction to the LLM: "Tool X is not available. Available tools: [...]"
4. The LLM continues with available tools.

**Handoff ACL (Access Control List) isolation:** When an agent hands off to another agent, the target agent operates with its own tool ACL. A handoff does not inherit the source agent's tools. This means a compromised agent cannot escalate its capabilities by handing off to a more privileged agent — the target agent only has access to its own declared tools.

## Input Sanitization

Tool arguments received from the LLM are validated against the tool's Zod input schema before the handler is called:
- **Type checking:** Zod validates all arguments against the schema.
- **String length limits:** Configurable max length per parameter (default: 10,000 chars).
- **No code execution:** There is no `eval`, `exec`, or dynamic code generation in Axl. Agents cannot produce or run arbitrary code.

## Prompt Injection Mitigations

Prompt injection is an inherent risk in any system where untrusted text is passed to an LLM. Axl does not claim to solve prompt injection, but provides structural mitigations:

| Mechanism | How it helps |
|-----------|-------------|
| **Tool ACL** | Even if an agent is tricked, it can only call its allowed tools. |
| **`ctx.ask({ schema })`** | Validates output structure — a prompt-injected response that doesn't match the schema is rejected and retried. |
| **`ctx.awaitHuman()`** | High-stakes actions require human approval, regardless of what the agent says. |
| **`ctx.budget()`** | A compromised agent cannot run up unlimited costs. |
| **`maxTurns`** | Limits how many tool-call loops an agent can execute, preventing infinite loops from injection. |
| **Guardrails** | Input/output validation at the agent boundary can detect and block suspicious content. |

**Recommendation:** Treat agent outputs as untrusted. Use `schema` validation for structured outputs. Use `awaitHuman` for destructive actions. Never pass raw agent output to `eval()` or SQL queries in your host app.

## Secrets Handling

- API keys configured in `axl.config.ts` or environment variables are **never** included in LLM prompts or logged in traces.
- Tools marked with `sensitive: true` have their return values redacted from LLM context in subsequent calls.

## Approval Gates

Tools with `requireApproval: true` trigger a human approval step before execution. When an agent tries to call the tool, the workflow **suspends** — the pending decision is saved to the state store and the execution waits until a human approves or denies.

```typescript
const deleteTool = tool({
  name: 'delete_record',
  description: 'Delete a database record',
  input: z.object({ id: z.string() }),
  handler: async ({ id }) => db.delete(id),
  requireApproval: true,
});
```

### How humans resolve decisions

The runtime exposes two methods for your host application to integrate with:

```typescript
// 1. List pending decisions (e.g., on a polling interval or webhook)
const pending = await runtime.getPendingDecisions();
// [{ executionId, channel: 'tool_approval', prompt: 'Tool "delete_record" wants to execute...', metadata, createdAt }]

// 2. Approve or deny
await runtime.resolveDecision(executionId, { approved: true });
// or
await runtime.resolveDecision(executionId, { approved: false, reason: 'Not authorized' });
```

This works across restarts — if the process restarts while waiting, the decision persists in the state store and `resolveDecision` triggers a replay from the last checkpoint.

**Axl Studio** provides a Decisions panel (`GET /api/decisions`, `POST /api/decisions/:id/resolve`) that renders pending approvals in a web UI, useful during development.

On denial, the runtime emits a `tool_denied` trace event and sends the denial reason back to the LLM as a tool response, giving the agent an opportunity to try a different approach.

## Agent Guardrails

You define your own validation functions — Axl calls them within the `ctx.ask()` loop, before and after each LLM call:

```typescript
// Your validation logic — Axl doesn't ship these, you bring your own
const containsPII = (text: string) => /\b\d{3}-\d{2}-\d{4}\b/.test(text);
const isOffTopic = (text: string) => !text.toLowerCase().includes('support');

const safe = agent({
  model: 'openai-responses:gpt-5.4',
  system: 'You are a helpful assistant.',
  guardrails: {
    input: async (prompt, ctx) => {
      if (containsPII(prompt)) return { block: true, reason: 'PII detected' };
      return { block: false };
    },
    output: async (response, ctx) => {
      if (isOffTopic(response)) return { block: true, reason: 'Off-topic' };
      return { block: false };
    },
    onBlock: 'retry',   // 'retry' | 'throw' | custom function
    maxRetries: 2,
  },
});
```

When `onBlock` is `'retry'`, the LLM's blocked output is appended to the conversation as an assistant message, followed by a system message containing the block reason. These messages **accumulate** across retries — if the guardrail blocks multiple times, the LLM sees all prior failed attempts and corrections, giving it increasing context about what to avoid. These retry messages are ephemeral — they only exist within the `ctx.ask()` call and are **not** persisted to session history, so subsequent turns never see the blocked attempts. Input guardrails always throw (the prompt is user-supplied and can't be retried by the LLM). Throws `GuardrailError` if retries are exhausted.

For **business rule validation** on the parsed typed object (not raw text), use `validate` (per-call, co-located with the `schema` it validates). This runs after schema parsing and receives the fully typed object, letting you enforce domain constraints (cross-field relationships, referential integrity, etc.). Supported on `ctx.ask()`, `ctx.delegate()`, `ctx.race()`, and `ctx.verify()`. Requires a `schema` — without one, use output guardrails for raw text validation instead. See the [API Reference](api-reference.md#validate) for details.

## Observability-Boundary Redaction

`config.trace.redact: true` enables a three-layer filter that scrubs user/LLM content everywhere it would otherwise flow to observability consumers, while preserving structural metadata (IDs, keys, agent/tool/workflow names, roles, cost/token metrics, durations, timestamps, `askId`/`parentAskId`/`depth`) so observability stays useful under compliance mode.

```typescript
const runtime = new AxlRuntime({
  trace: { redact: true, level: 'steps' },
});
```

**The three layers:**

1. **AxlEvents** at emission — `agent_call_end.data.prompt`/`.response`/`.system`/`.thinking`/`.messages`, `ask_start.prompt`, `ask_end.outcome` (`outcome.result` on success, `outcome.error` on failure), gate-event `reason`/`feedbackMessage`, `tool_call_start.data.args`, `tool_call_end.data.args`/`.result`, `tool_approval.data.args`/`.reason`, `handoff_start.data.message` (roundtrip only), `workflow_start.data.input`, `workflow_end.data.result`/`.error`, `done.data.result`, `error.data.message`, string fields on `log` events (one-level walk — nested numeric/boolean fields like `usage.tokens` / `usage.cost` survive so the Cost Dashboard's byEmbedder bucket still works).
2. **Studio REST route responses** at serialization — `GET /api/executions{,/:id}`, `GET /api/memory/:scope{,/:key}` (keys preserved so Memory Browser remains navigable), `GET /api/sessions/:id`, `GET /api/evals/history`, `POST /api/evals/:name/run` (sync), `POST /api/evals/:name/rescore`, `GET /api/decisions`, `POST /api/tools/:name/test`, `POST /api/workflows/:name/execute` (sync).
3. **Studio WebSocket broadcasts** — `AxlEvent` content scrubbed on `POST /api/workflows/:name/execute` with `stream: true` and `POST /api/playground/chat` (`token.data`, `tool_call_start.data.args`, `tool_call_end.data.args`/`.result`, `tool_approval.data.args`/`.reason`, `ask_start.prompt`, `ask_end.outcome`, `done.data.result`, `error.data.message`, `handoff_start.data.message`). The **trace firehose channel** (`trace:*`) also applies the same `redactStreamEvent` filter as of 0.16.0 — closing a previous gap where the live trace stream could bypass the per-route scrub.

**What's NOT scrubbed:** Programmatic callers of `runtime.execute()` and direct `StateStore` access still receive raw data — redaction is an observability-boundary filter, **not** a data-at-rest transform. Write endpoints (`PUT /api/memory`, `POST /api/sessions/:id/send`) still accept raw data. Top-level numeric fields (`cost`, `tokens`, `duration`) on every event are never scrubbed — they're load-bearing for `trackExecution` and the cost aggregator. Structural ask-graph metadata (`askId`, `parentAskId`, `depth`, `executionId`, `step`, `timestamp`) is also preserved (random IDs, no PII surface).

Studio consumers should check the flag via `runtime.isRedactEnabled(): boolean` rather than reaching into the config (the full config was intentionally not exposed because `Readonly<T>` is shallow — consumers could mutate `trace.redact` via sub-object access). Separately, `GET /api/health` reports `readOnly: boolean` so a client can gate mutating UI affordances (e.g., the Eval Runner hides its Import / Run buttons in readOnly mode); the redact flag is not surfaced on the health endpoint because it's only consumed server-side at response serialization time.

See [observability.md](./observability.md#pii-and-redaction) for the complete per-route scrubbed/preserved field table.

## Multi-Tenant Deployments (Studio Middleware)

When `@axlsdk/studio/middleware` is mounted inside a multi-tenant application, two hooks scope what each connection can see:

**Per-connection metadata via `verifyUpgrade`:**

```typescript
const studio = createStudioMiddleware({
  runtime,
  verifyUpgrade: (req) => {
    const userId = authenticate(req);
    if (!userId) return { allowed: false };
    return { allowed: true, metadata: { userId, tenantId: lookupTenant(userId) } };
  },
});
```

The `verifyUpgrade` callback can return a bare `boolean` (back-compat) OR `{ allowed, metadata }`. The `metadata` is attached to the connection and passed to every `filterTraceEvent` call. `verifyUpgrade` may be sync or async (return a `Promise`). If omitted in production (`NODE_ENV === 'production'`) the middleware logs a warning — WebSocket upgrades bypass Express/Fastify/Koa HTTP middleware, so relying on host auth middleware alone leaves WS connections unauthenticated.

**Broadcast filter via `filterTraceEvent`:**

```typescript
const studio = createStudioMiddleware({
  runtime,
  filterTraceEvent: (event, metadata) => {
    // Only let a connection see events from its own tenant
    return event.metadata?.tenantId === metadata?.tenantId;
  },
});
```

The filter runs on every outbound broadcast — including historical replay buffers for late subscribers — so cross-tenant events can't leak even on reconnect. Predicate errors are **fail-closed** (event dropped) so a buggy filter can't accidentally widen visibility. `event` is typed `unknown` because the filter runs across every channel (`trace:*` carries `AxlEvent`, `costs` carries `CostData`, `execution:*` / `eval:*` also carry `AxlEvent`); narrow via the channel-specific union at the call site.

Studio's WebSocket broadcast layer also enforces a 64KB soft frame cap via `truncateIfOversized`. Oversized `agent_call_end.data.messages` snapshots (verbose mode) are replaced with a `{ __truncated: true, originalBytes, maxBytes, hint }` placeholder that preserves `type`/`step`/`agent`/`tool` so the Trace Explorer still renders the row.
