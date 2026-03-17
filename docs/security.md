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

When `onBlock` is `'retry'`, the LLM sees the block reason and self-corrects. Throws `GuardrailError` if retries are exhausted.
