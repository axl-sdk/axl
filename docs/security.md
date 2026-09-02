# Security Model

## Prompt Confidentiality and the Trusted Backend

Axl is a Node.js backend SDK. Keep provider credentials, system prompts, tool
definitions, and provider requests on infrastructure controlled by the
application operator:

```text
untrusted client  -- user input / public output -->  your Axl backend
                                                       |
                                                       | HTTPS provider request
                                                       v
                                                  model provider
```

With this topology, a passive packet capture or a trusted interception
certificate installed **only on the end user's device** cannot inspect the
backend-to-provider request. The client never originates that connection. A
trusted proxy installed on the backend host is different: it is inside the
execution trust boundary, as are host administrators, process instrumentation,
application logs, and the selected model provider.

Axl's built-in providers, `OpenAIEmbedder`, and HTTP MCP client reject plaintext
remote HTTP endpoints by default. HTTPS is always accepted; HTTP is accepted
without an override only for literal loopback (`localhost`, IPv4 `127/8`, and
IPv6 `::1`). Deliberate Docker, private-network, or other remote HTTP deployments
must set `dangerouslyAllowInsecureHttp: true` on that specific provider,
embedder, or MCP server entry. Provider, embedding, and HTTP MCP requests do not
follow redirects. See
[Providers > Transport security](./providers.md#transport-security) for the
configuration and migration details. Custom `Provider` implementations own
their transport policy.

This is a network-boundary guarantee, not prompt DRM. A model can repeat,
paraphrase, or help an adversarial user infer its system instructions. Do not put
credentials or true secrets in prompts. Keep valuable deterministic logic in
server-side tools or application code, minimize the guidance sent to the model,
and treat output guardrails as risk reduction rather than a non-disclosure
guarantee.

Raw `AxlEvent` streams, lifecycle events, traces, execution history, and Studio
are trusted/operator surfaces and can contain prompts, resolved system messages,
tool data, and provider output. Studio agent/tool routes intentionally expose
static prompt configuration even when `trace.redact` is enabled, so deployed
Studio middleware requires HTTP authentication plus WebSocket `verifyUpgrade`.
In production, `upgradeWebSocket()` fails closed when that verifier is absent;
the dangerous opt-out is only for hosts that independently authenticate the
raw upgrade. Standalone Studio also rejects non-local Host and Origin values on
REST and WebSocket requests, preventing browser CSRF and DNS-rebinding access.
A public application should consume an
output-only view on the server and send its own DTO to the client; do not forward
the raw event firehose. See the
[server-to-client streaming guidance](./observability.md#server-to-client-streaming-boundary).

## Tool Access Control

Agents can **only** invoke tools listed in their `tools` configuration. This is enforced at runtime.

```typescript
const SupportBot = agent({
  model: 'openai-responses:gpt-5.5',
  tools: [getOrder, refundOrder],
  // SupportBot CANNOT call deleteUser — runtime will reject the call
});
```

If an LLM attempts to invoke a tool not in the agent's `tools` list (including MCP tools), the runtime:

1. Blocks the call.
2. Emits `tool_call_rejected` with `reason: 'unavailable'` and no
   `tool_call_start` (visible in traces).
3. Sends a correction to the LLM: "Tool X is not available. Available tools: [...]"
4. The LLM continues with available tools.

**Handoff ACL (Access Control List) isolation:** When an agent hands off to another agent, the target agent operates with its own tool ACL. A handoff does not inherit the source agent's tools. This means a compromised agent cannot escalate its capabilities by handing off to a more privileged agent — the target agent only has access to its own declared tools.

## Input Sanitization

Tool arguments received from the LLM are validated against the tool's Zod input schema before the handler is called:
- **Type checking:** Zod validates all arguments against the schema.
- **String length limits:** Configurable max length per parameter (default: 10,000 chars).
- **No code execution:** There is no `eval`, `exec`, or dynamic code generation in Axl. Agents cannot produce or run arbitrary code.

When local validation rejects a call, Axl gives the model bounded correction
using paths and constraints resolved from the provider-facing JSON Schema. The
separate string-length guard may also report its configured Axl limit. Rejected
values, Zod issue messages, custom issue parameters, dynamic record keys, and
homogeneous-array indices are not copied into provider content. Unresolved paths
and unsupported schema shapes fail closed to masked or generic guidance.

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

### Image handling

Axl never host-fetches image URLs. Providers that natively support an HTTP
image source receive the locator directly. Gemini is deliberately narrower:
its certified Interactions paths are inline bytes/base64 or an explicit,
caller-owned Gemini Files URI, so direct HTTP image URLs fail before dispatch.
Axl does not silently fetch, upload, retain, or delete chat images. Applications
that choose a Gemini Files workflow own URL retrieval controls, upload cleanup,
and Google's temporary retention boundary.

### Recorded-audio handling

`ctx.transcribe()` accepts only finite caller-supplied bytes, canonical base64,
or a provider-owned reference. Axl does not fetch URLs or local paths, host
media, persist inline audio into chat history, or use a chat-model fallback.
Transcription events never contain audio bytes, base64, raw provider-file
identifiers, authorization headers, or raw provider response bodies. With
tracing unredacted, their terminal event contains transcript text; enable
`trace.redact` when transcript text or error content is sensitive. Byte count
is emitted only for a bytes source, never inferred for base64 or a provider
reference. Gemini inline audio is the narrow exception to the
no-upload rule: its adapter temporarily uploads solely to complete one
transcription request and attempts deletion; a failed deletion can leave the
file at Gemini for up to 48 hours. Use caller-owned Gemini references for reuse
and assess that retention period before submitting sensitive recordings.
Provider failures retain only safe HTTP diagnostics—status, retryability,
optional retry delay, and optional request ID—on the boundary error and event;
the raw error body remains confined to the non-enumerable cause.

- API keys configured in `axl.config.ts` or environment variables are **never** included in LLM prompts or logged in traces.
- Tools marked with `sensitive: true` have their return values redacted from LLM context in subsequent calls.

### Minimize tool results sent to the model

For a rich application result that is not wholly sensitive, configure `toModelOutput` as an explicit allowlist. The host continues to observe the complete result through the result-bearing `tool_call_end.data.outcome` variant while the next provider request receives only the projection. A projection failure is fail-closed: Axl records `failed` / `projection` and never falls back to the raw result. `sensitive: true` has higher precedence and skips projection entirely.

Ordinary thrown hook/handler messages are never provider content. When a known
failure is safe for model recovery, tool authors must opt in by throwing
`ToolFailure` with a separate `modelMessage`; only that author-declared content
is sent, unless `sensitive: true` replaces it with the fixed sensitive-failure
marker. A normal return always means success, even if the application value has
an `error` property.

This boundary minimizes **model/provider-facing** data; it does not scrub host observability. `trace.redact` remains the control for event content, and a full trace can show the successfully projected tool message in the next `agent_call_start.data.messages`. `ToolModelOutputError.message` is generic, but its host-only `.cause` may contain an exception thrown by application mapper code. The cause is non-enumerable to keep it out of ordinary `JSON.stringify(error)` output; serializers that inspect non-enumerable properties can still expose it, so do not export `.cause` blindly.

Events are observation, not a durable application-command bus. Critical actions and persistence belong in the tool handler or workflow. A renderer or artifact harvester consuming `ctx.events`, `AxlStream`, or trace listeners must retain the existing redaction, queue-overflow, and state-persistence considerations; projection adds no delivery guarantee.

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

In-process resolution is automatic. The runtime deletes the persisted pending
request before releasing the workflow, so a store failure leaves the gate
closed and retryable. Cross-process resolution is not supported: built-in
stores retain the pending request for visibility, but not its continuation.
The current contract does not durably retain/claim a resolved decision or bind
checkpoints to a resume lineage. Applications
that must approve across process loss should use an application-managed durable
command/idempotency protocol until that state-store contract is added; do not
assume `resolveDecision()` alone prevents repeated side effects after a crash.
The runtime fails such a resolution with `CROSS_PROCESS_RESUME_UNSUPPORTED`
before deleting the pending request or starting any handler, so operators can
route it through their durable application protocol without data loss.

Cancellation and public resolution share one store-mutation claim. An abort
waits for an in-flight resolution, compensates only after a failed write, and
treats a rejected `savePendingDecision()` as possibly committed. If that
compensation also fails, the pending row remains visible and the runtime emits
`decision_cleanup_failed` with `{ executionId, workflow?, operation, error }`.
Alert on this trusted-host event and retry cleanup or call
`runtime.deleteExecution(executionId)`; event-listener failures are isolated
from the workflow's original failure.

Decisions are validated before resolver/store mutation. They must be plain
objects with an exact boolean `approved` discriminator and only the matching
optional string field (`data` for approval, `reason` for denial). Truthy strings,
arrays, accessors, symbol/unknown keys, and contradictory fields fail closed.

**Axl Studio** provides a Decisions panel (`GET /api/decisions`, `POST /api/decisions/:id/resolve`) that renders pending approvals in a web UI, useful during development.

On denial, the runtime emits `tool_approval` with `approved: false`, then closes
the accepted call with `tool_call_end.data.outcome.status === 'denied'`. Safe
denial content is sent to the LLM, giving the agent an opportunity to try a
different approach. Denial is distinct from `tool_call_rejected`, which occurs
before execution can start.

## Agent Guardrails

You define your own validation functions — Axl calls them within the `ctx.ask()` loop, before and after each LLM call:

```typescript
// Your validation logic — Axl doesn't ship these, you bring your own
const containsPII = (text: string) => /\b\d{3}-\d{2}-\d{4}\b/.test(text);
const isOffTopic = (text: string) => !text.toLowerCase().includes('support');

const safe = agent({
  model: 'openai-responses:gpt-5.5',
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

## Right-to-be-Forgotten / Execution Deletion

Two operator-facing primitives implement the GDPR deletion contract:

**`runtime.deleteExecution(id)`** — total per-execution sweep. Removes from the in-memory caches, the configured `StateStore`, AND every execution-scoped side surface:

- Canonical execution-history row + indexes (legacy SET + sorted-set)
- All checkpoints for the id
- Suspended-state row + pending-set membership
- Streaming-buffer events list + in-flight ids set (when `state.persist: 'streaming'`)
- Pending `awaitHuman` decision (so it stops surfacing in `runtime.getPendingDecisions()` and the Studio Decisions panel)
- In-memory resolver closure + abort controller

If the execution is still running, `deleteExecution` aborts it via the registered controller AND adds the id to a `pendingDeletedExecutions` set so the workflow's eventual `workflow_end` does NOT resurrect the row in `persistExecution`. Aborting also correctly wakes a paused `ctx.awaitHuman()` (fixed in 0.17.7 — previously the awaitHuman Promise had no signal listener and hung forever on abort). Before sweeping the store, deletion joins any active approval resolution or cancellation-compensation barrier, so a late decision mutation cannot recreate approval state after the delete.

```typescript
await runtime.deleteExecution(executionId);

// Audit trail
runtime.on('execution_deleted', (e) => {
  // e: { executionId, wasActive, hadPendingDecision, removed }
  auditLog.write({ event: 'execution.deleted', operator: currentOperator(), ...e });
});
```

The `execution_deleted` event fires on every call — including attempts against unknown ids (`removed: false`, `workflow: undefined`) — so compliance pipelines can log attempted deletes too. The `workflow` field is captured before delete and lets the audit log categorize by workflow without a follow-up lookup. `runtime.deleteEvalResult(id)` symmetrically emits `eval_deleted` with `{ id, eval, removed }` — subscribe to both for parity.

**`DELETE /api/executions/:id`** (Studio) — wraps `runtime.deleteExecution` AND scrubs the WebSocket replay buffer for the deleted execution channel via `ConnectionManager.clearChannelBuffer('execution:{id}')`. Without this scrub, late WebSocket subscribers could replay events for a deleted run for up to 30 seconds after stream completion. Blocked in `readOnly` mode (405 with `error.code: 'READ_ONLY'`).

**For bulk eviction by age**, use `RedisStore` TTLs (`defaultTtl` / `ttls.<category>`) instead — the deleteExecution path is for targeted operator-driven scrubs, not retention policy.

See [docs/migration/state-store-durability.md](./migration/state-store-durability.md#1-runtimedeleteexecutionid) for the full delete contract and the per-store sweep table.

**Custom `StateStore` implementers:** `resolveDecision` must be idempotent because cancellation uses a denial as compensation when a save may have committed before rejecting. `deleteExecution` must then sweep every per-execution surface your store maintains in one call. The runtime serializes that total sweep behind known in-process approval cleanup, but delegates the sweep itself to your method — it does NOT call separate `deleteCheckpoints` / `finalizeStreamingEvents` after. See the JSDoc on `StateStore.deleteExecution?`.

## Observability-Boundary Redaction

`config.trace.redact: true` enables a three-layer filter that scrubs user/LLM content everywhere it would otherwise flow to observability consumers, while preserving structural metadata (IDs, keys, agent/tool/workflow names, roles, cost/token metrics, durations, timestamps, `askId`/`parentAskId`/`depth`) so observability stays useful under compliance mode.

```typescript
const runtime = new AxlRuntime({
  trace: { redact: true, level: 'steps' },
});
```

**The three layers:**

1. **AxlEvents** at emission — `agent_call_start.data.prompt`/`.system`/`.messages`, `agent_call_end.data.response`/`.thinking`/`.error`, `ask_start.prompt`, `ask_end.outcome` (`outcome.result` on success, `outcome.error` on failure), gate-event `reason`/`feedbackMessage`, rejected-tool args/messages, `tool_call_start.data.args`, tool-end args/results/reasons/error details, `tool_approval.data.args`/`.reason`, `handoff_start.data.message` (roundtrip only), `workflow_start.data.input`, `workflow_end.data.result`/`.error`, `done.data.result`, `error.data.message`, string fields on `log` events (one-level walk — nested numeric/boolean fields like `usage.tokens` / `usage.cost` survive so the Cost Dashboard's byEmbedder bucket still works).
2. **Studio REST route responses** at serialization — `GET /api/executions{,/:id}` (also scrubs `ExecutionInfo.metadata` to `{ redacted: true }` — caller-supplied `userId`/`tenantId`/correlation ids are PII surfaces compliance mode must protect), `GET /api/memory/:scope{,/:key}` (keys preserved so Memory Browser remains navigable), `GET /api/sessions/:id`, `GET /api/evals/history`, `POST /api/evals/:name/run` (sync), `POST /api/evals/:name/rescore`, `GET /api/decisions`, `POST /api/tools/:name/test`, `POST /api/workflows/:name/execute` (sync).
3. **Studio WebSocket broadcasts** — `AxlEvent` content scrubbed on `POST /api/workflows/:name/execute` with `stream: true` and `POST /api/playground/chat` (`token.data`, rejected-tool args/messages, `tool_call_start.data.args`, tool-end args/results/reasons/error details, `tool_approval.data.args`/`.reason`, `ask_start.prompt`, `ask_end.outcome`, `done.data.result`, `error.data.message`, `handoff_start.data.message`). The **trace firehose channel** (`trace:*`) applies the same event redaction filter, so it cannot bypass the per-route scrub.

Session routes follow the same serialization boundary:
`POST /api/sessions/:id/send` scrubs its result, while
`POST /api/sessions/:id/stream` scrubs every event before the Studio WebSocket
broadcast. Both endpoints still accept and persist the caller's raw input.

**What's NOT scrubbed:** Programmatic callers of `runtime.execute()` and direct `StateStore` access still receive raw data — redaction is an observability-boundary filter, **not** a data-at-rest transform. For a data-at-rest scrub of a specific execution (GDPR right-to-be-forgotten), use `runtime.deleteExecution(id)` instead. Write endpoints (`PUT /api/memory`, `POST /api/sessions/:id/send`) still accept raw data. Top-level numeric fields (`cost`, `tokens`, `duration`) on every event are never scrubbed — they're load-bearing for `trackExecution` and the cost aggregator. Structural ask-graph metadata (`askId`, `parentAskId`, `depth`, `executionId`, `step`, `timestamp`) is also preserved (random IDs, no PII surface). Caller-supplied `ExecutionInfo.metadata` is scrubbed at the observability boundary when `redact: true` but persists raw in the store — operators wanting the raw values should query `runtime.getExecutions()` programmatically.

Studio consumers should check the flag via `runtime.isRedactEnabled(): boolean` rather than reaching into the config (the full config was intentionally not exposed because `Readonly<T>` is shallow — consumers could mutate `trace.redact` via sub-object access). Separately, `GET /api/health` reports `readOnly: boolean` so a client can gate mutating UI affordances (e.g., the Eval Runner hides its Import / Run buttons in readOnly mode); the redact flag is not surfaced on the health endpoint because it's only consumed server-side at response serialization time.

See [observability.md](./observability.md#pii-and-redaction) for the complete per-route scrubbed/preserved field table.

### `ProviderError.body` is intentionally off the event stream

When a provider returns a non-2xx response, the adapter throws a `ProviderError`
carrying the **raw provider error body** on `.body`. Provider error bodies can echo
prompt text (vendors often reflect part of the offending request), so `.body` is
**redaction-eligible** content. It lives **only on the thrown error object** and is
**never** placed on the event stream: the `agent_call_end` error event carries the
error *message* (`data.error`, already subject to `trace.redact`) plus the structural
`data.status` / `data.retryable`, but not `body`. This keeps the redaction surface
unchanged — operators who need the raw body must inspect the caught `ProviderError`
programmatically. See [providers.md](./providers.md#typed-provider-errors).

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

Studio's WebSocket broadcast layer also enforces a 64KB soft frame cap via `truncateIfOversized`. Oversized `agent_call_start.data.messages` request snapshots (verbose mode) are replaced with a `{ __truncated: true, originalBytes, maxBytes, hint }` placeholder that preserves `type`/`step`/`agent`/`tool` so the Trace Explorer still renders the row.

**Storage isolation in shared Redis clusters:** `RedisStore.create({ keyPrefix })` namespaces every key the store writes. For multi-tenant SaaS deployments running multiple Axl runtimes against one Redis cluster (e.g., `'axl:tenant-a:'` vs `'axl:tenant-b:'`), the prefix is the storage-layer isolation primitive. The `verifyUpgrade` + `filterTraceEvent` hooks above scope the observability surface; `keyPrefix` scopes the persistence surface. Empty string is rejected to prevent accidental collisions with non-Axl keys. See [api-reference.md `RedisStoreOptions`](./api-reference.md#statestore) for the option table.
