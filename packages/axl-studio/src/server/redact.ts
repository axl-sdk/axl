/**
 * Server-side redaction for observability responses.
 *
 * `config.trace.redact` was originally scoped to trace events emitted via
 * `emitTrace()` — it scrubs user/LLM content in prompts, responses, memory
 * values, tool args, etc. But data returned through Studio's REST surface
 * (execution results, memory values, session history) bypassed trace
 * emission entirely and leaked raw content even when trace redaction was
 * on. That inconsistency made "compliance mode" misleading: a user would
 * see `[redacted]` in the Trace Explorer timeline and then see raw user
 * data in the sibling Result pane, Memory Browser, or Session Manager.
 *
 * The right user mental model for this config is "what can the observability
 * layer see?". We keep the config name `trace.redact` but broaden its scope
 * at the REST read boundary to also scrub:
 *
 *   - `ExecutionInfo.result` / `.error` (/api/executions, /api/executions/:id)
 *   - Memory values (/api/memory/:scope, /api/memory/:scope/:key)
 *   - Session message content + tool call arguments (/api/sessions/:id)
 *
 * Structural metadata (workflow names, agent names, tool names, keys, IDs,
 * timestamps, cost/token metrics) is preserved so the Trace Explorer,
 * Memory Browser, and Session Manager still render useful context when
 * compliance mode is on.
 *
 * Programmatic callers of `runtime.execute()` and direct StateStore access
 * still receive raw values — redaction is an *observability boundary* filter,
 * not a data-at-rest transform. If a user needs scrubbed state-at-rest they
 * configure their own StateStore to store scrubbed values.
 */
import type {
  ExecutionInfo,
  ChatMessage,
  PendingDecision,
  AxlEvent,
  EvalHistoryEntry,
} from '@axlsdk/axl';
import type { EvalResult, EvalItem, ScorerDetail } from '@axlsdk/eval';

// Stream events on the wire are `AxlEvent` — the translation layer was
// deleted in PR 1 commit 4. The legacy `StreamEvent` shapes are gone;
// consumers narrow on the AxlEvent union.

const REDACTED = '[redacted]';

/**
 * Error `name` values whose `message` is purely structural (codes, counts,
 * identifiers) and safe to surface verbatim under redact mode. Every other
 * error — `ValidationError`, `GuardrailError`, `VerifyError`, arbitrary
 * provider errors, `Error` from user code — is treated as potentially
 * echoing user/LLM content and has its message scrubbed.
 *
 * Kept in sync with the allow-list in
 * `server/middleware/error-handler.ts`; both sites must match so a route
 * that surfaces errors inline has identical redaction semantics to one
 * that throws through the global handler.
 */
const SAFE_ERROR_NAMES = new Set([
  'QuorumNotMet',
  'NoConsensus',
  'TimeoutError',
  'MaxTurnsError',
  'BudgetExceededError',
  'ToolDenied',
]);

/**
 * Scrub an error's `.message` for inclusion in a REST error envelope or WS
 * error event. Under redact mode, only messages from the structural
 * allow-list above pass through; everything else becomes `[redacted]`. The
 * `code`/`name` stay untouched so clients can still branch programmatically.
 *
 * Call sites that catch an error and build a `{ code, message }` envelope
 * locally (instead of re-throwing through `errorHandler`) should use this
 * helper so their redaction behavior stays consistent with the global path.
 */
export function redactErrorMessage(err: unknown, redact: boolean): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (!redact) return raw;
  const name = err instanceof Error ? err.name : '';
  return SAFE_ERROR_NAMES.has(name) ? raw : REDACTED;
}

/**
 * Generic "scrub any value to the redacted sentinel" helper. Used by
 * routes that return a single opaque payload (workflow execute result,
 * tool test result, playground done data) where the value could be
 * anything — string, object, array, null, number — and we just want a
 * consistent scrubbed marker regardless of shape.
 */
export function redactValue(value: unknown, redact: boolean): unknown {
  if (!redact) return value;
  return REDACTED;
}

/**
 * Return a shallow-cloned ExecutionInfo with user-content fields scrubbed
 * when `redact` is true. Never mutates the input. When `redact` is false,
 * returns the input unchanged (reference equality preserved).
 *
 * Event scrubbing: every event in `events[]` is piped through
 * `redactStreamEvent` to catch per-variant payloads that emit-time
 * redaction may have missed (e.g., `partial_object.data.object`,
 * `verify.data.lastError`, `pipeline.reason`, terminal `done`/`error`,
 * `tool_call_start.data.args`, `tool_denied.data.*`). Defense in depth —
 * core `emitEvent` scrubs most variants at emission, but the REST
 * serialization boundary is the last line before PII leaves the
 * observability envelope.
 */
export function redactExecutionInfo(info: ExecutionInfo, redact: boolean): ExecutionInfo {
  if (!redact) return info;
  return {
    ...info,
    ...(info.result !== undefined ? { result: REDACTED } : {}),
    ...(info.error !== undefined ? { error: REDACTED } : {}),
    events: info.events.map((e) => redactStreamEvent(e, true)),
  };
}

/** List variant: maps each entry through the single-item redactor. */
export function redactExecutionList(infos: ExecutionInfo[], redact: boolean): ExecutionInfo[] {
  if (!redact) return infos;
  return infos.map((info) => redactExecutionInfo(info, redact));
}

/**
 * Scrub a memory value read through Studio's REST API. Memory values
 * don't flow through `emitTrace` (the memory_remember / memory_recall log
 * events deliberately exclude values — operation-only audit trail), so
 * this isn't closing a trace-to-REST inconsistency. It's broadening the
 * observability-boundary scope to cover memory browser reads.
 *
 * Keys are deliberately preserved so the Memory Browser stays navigable —
 * users with redact on can still see which keys exist and which ones
 * their code is writing to. Keys are programmer-chosen identifiers; if a
 * specific deployment has PII in keys it's a code-level problem and
 * should be fixed at the `ctx.remember()` call site.
 */
export function redactMemoryValue(value: unknown, redact: boolean): unknown {
  if (!redact) return value;
  return REDACTED;
}

/**
 * Memory list variant. Scrubs values on every `{ key, value }` entry;
 * preserves keys for navigation.
 */
export function redactMemoryList(
  entries: Array<{ key: string; value: unknown }>,
  redact: boolean,
): Array<{ key: string; value: unknown }> {
  if (!redact) return entries;
  return entries.map((entry) => ({ key: entry.key, value: REDACTED }));
}

/**
 * Scrub a single ChatMessage for session history responses. Removes:
 *   - `content`                                    — user/LLM text
 *   - `tool_calls[*].function.arguments`           — tool inputs (JSON string)
 *   - `providerMetadata`                           — opaque provider bag that
 *     may contain encoded reasoning / thinking signatures / cache keys
 *
 * Preserves:
 *   - `role`                                       — system/user/assistant/tool
 *   - `name`                                       — tool/function name on
 *     role='tool' messages (non-PII identifier)
 *   - `tool_call_id`                               — join key for tool responses
 *   - `tool_calls[*].id`                           — call ID
 *   - `tool_calls[*].type`                         — always 'function'
 *   - `tool_calls[*].function.name`                — tool name (non-PII)
 *
 * The preserved fields are exactly the structural metadata you need to
 * understand the shape of a conversation (who said what, which tools
 * were called) without seeing any user/LLM content.
 */
function redactChatMessage(msg: ChatMessage): ChatMessage {
  // We deliberately hand-build the output with an explicit allow-list
  // instead of spreading `msg`, so any new field added to `ChatMessage`
  // in the future (e.g. `refusal`, `reasoning_content`) is silently
  // dropped rather than passing through unscrubbed. The `satisfies`
  // assertion catches the case where a new REQUIRED field is added to
  // `ChatMessage` — typecheck will fail and force a code review on
  // whether the new field should be scrubbed or preserved.
  const scrubbed = {
    role: msg.role,
    content: REDACTED,
    ...(msg.name !== undefined ? { name: msg.name } : {}),
    ...(msg.tool_call_id !== undefined ? { tool_call_id: msg.tool_call_id } : {}),
    ...(msg.tool_calls !== undefined
      ? {
          tool_calls: msg.tool_calls.map((tc) => ({
            id: tc.id,
            type: tc.type,
            function: {
              name: tc.function.name,
              arguments: REDACTED,
            },
          })),
        }
      : {}),
    // providerMetadata deliberately omitted — opaque content.
  } satisfies ChatMessage;
  return scrubbed;
}

/**
 * Scrub a session history response. Maps every message through
 * `redactChatMessage`. HandoffRecord entries (on the same response) have
 * no content fields — just source/target/mode/timestamp/duration — so
 * they don't need scrubbing.
 */
export function redactSessionHistory(history: ChatMessage[], redact: boolean): ChatMessage[] {
  if (!redact) return history;
  return history.map(redactChatMessage);
}

// ── Stream events (WS broadcast) ─────────────────────────────────────

/**
 * Scrub an `AxlEvent` before broadcasting it to Studio WS subscribers.
 * Playground, workflow-execute, AND the trace-channel firehose all run
 * events through this function under `trace.redact: true`. The core
 * `emitEvent` already redacts most fields at emission time (prompts,
 * responses, system, etc.); this function is the wire-boundary
 * defense-in-depth pass.
 *
 * Per-variant scrubbing per spec §5.1:
 *
 * | Event             | Scrubbed                          | Preserved (structural) |
 * | ----------------- | --------------------------------- | ---------------------- |
 * | token             | data (token text)                 | askId/depth/agent      |
 * | tool_call_start   | data.args                         | tool/callId/askId      |
 * | tool_call_end     | data.args, data.result            | tool/callId/duration   |
 * | tool_approval     | data.args, data.reason            | data.approved/tool     |
 * | tool_denied       | data.args, data.reason            | tool/callId            |
 * | ask_start         | prompt                            | askId/agent/depth      |
 * | ask_end           | outcome.{result,error}            | cost/duration/ok       |
 * | handoff           | data.message (roundtrip arg)      | source/target/mode     |
 * | partial_object    | data.object                       | attempt/askId          |
 * | verify            | data.lastError                    | passed/attempts        |
 * | memory_*          | data.key                          | scope/count/cost       |
 * | done              | data.result                       | -                      |
 * | error             | data.message                      | data.name/code         |
 * | delegate          | (nothing — all structural)        | all                    |
 * | pipeline          | reason (only on `failed`)         | stage/status/attempt   |
 *
 * Top-level `cost`, `tokens`, `duration` are NEVER scrubbed (numeric
 * observability metrics). `askId`/`parentAskId`/`depth`/`agent`/
 * `executionId`/`step`/`timestamp` are NEVER scrubbed (random IDs and
 * structural metadata).
 */
export function redactStreamEvent(event: AxlEvent, redact: boolean): AxlEvent {
  if (!redact) return event;
  switch (event.type) {
    case 'token':
      return { ...event, data: REDACTED };
    case 'tool_call_start':
      return { ...event, data: { args: REDACTED } };
    case 'tool_call_end':
      return { ...event, data: { args: REDACTED, result: REDACTED, callId: event.data.callId } };
    case 'tool_approval':
      return {
        ...event,
        data: {
          ...event.data,
          args: REDACTED,
          ...(event.data.reason !== undefined ? { reason: REDACTED } : {}),
        },
      };
    case 'tool_denied':
      // The variant carries `data?: ToolDeniedData` — may be undefined.
      // Scrub args/reason if present; preserve callId for correlation.
      return event.data
        ? {
            ...event,
            data: {
              ...event.data,
              ...(event.data.args !== undefined ? { args: REDACTED } : {}),
              ...(event.data.reason !== undefined ? { reason: REDACTED } : {}),
            },
          }
        : event;
    case 'done':
      return { ...event, data: { result: REDACTED } };
    case 'error':
      return { ...event, data: { ...event.data, message: REDACTED } };
    case 'ask_start':
      return { ...event, prompt: REDACTED };
    case 'ask_end':
      return event.outcome.ok
        ? { ...event, outcome: { ok: true, result: REDACTED } }
        : { ...event, outcome: { ok: false, error: REDACTED } };
    case 'handoff':
      return event.data.message !== undefined
        ? { ...event, data: { ...event.data, message: REDACTED } }
        : event;
    case 'partial_object':
      // Progressive structured-output snapshots — same risk surface as
      // the final result on `done`.
      return { ...event, data: { object: REDACTED } };
    case 'verify':
      return event.data.lastError !== undefined
        ? { ...event, data: { ...event.data, lastError: REDACTED } }
        : event;
    case 'memory_remember':
    case 'memory_recall':
    case 'memory_forget':
      // `key` may echo user input on semantic recall. `scope`, `count`,
      // numeric `cost` and `usage.tokens` are structural — preserve.
      return event.data.key !== undefined
        ? { ...event, data: { ...event.data, key: REDACTED } }
        : event;
    case 'pipeline':
      // Only the `failed` status carries `reason` (the feedback message
      // about to be injected into the conversation — may echo user
      // input or LLM output).
      return event.status === 'failed' ? { ...event, reason: REDACTED } : event;
    // Structural / numeric events pass through. `agent_call_end` and
    // legacy gate events (guardrail/schema_check/validate) are scrubbed
    // at emission time by core `emitEvent` — second-pass would be
    // wasteful and could mask a missing emitter-level scrub.
    // `delegate`, `agent_call_start`, `tool_call_start` (data.args
    // already scrubbed above), `workflow_*`, `log` (already scrubbed at
    // emission) all fall through.
    default:
      return event;
  }
}

// ── Eval results ─────────────────────────────────────────────────────

/**
 * Scrub a single `EvalItem`. Per-item user/LLM content lives in:
 *   input        — the dataset item that drove the workflow
 *   output       — the workflow's return value
 *   error        — failure message (may echo user input)
 *   annotations  — user-supplied per-item labels/ground truth
 *   scorerErrors — scorer-thrown error strings that can echo content
 *   scoreDetails[*].metadata — especially LLM-scorer reasoning,
 *                              which mirrors agent_call response content
 *
 * Preserved fields (structural / metrics):
 *   scores (numeric), duration, cost, scorerCost
 *   scoreDetails[*].{score, duration, cost} (but not metadata)
 *   metadata (execution metadata: models, tokens, agentCalls, workflows)
 *   traces (trace events — already redacted at emission time)
 */
function redactEvalItem(item: EvalItem): EvalItem {
  const scrubbed: EvalItem = {
    ...item,
    input: REDACTED,
    output: REDACTED,
    ...(item.annotations !== undefined ? { annotations: REDACTED } : {}),
    ...(item.error !== undefined ? { error: REDACTED } : {}),
    ...(item.scorerErrors !== undefined
      ? { scorerErrors: item.scorerErrors.map(() => REDACTED) }
      : {}),
  };
  if (item.scoreDetails) {
    const detailsOut: Record<string, ScorerDetail> = {};
    for (const [name, detail] of Object.entries(item.scoreDetails)) {
      detailsOut[name] = {
        score: detail.score,
        ...(detail.duration !== undefined ? { duration: detail.duration } : {}),
        ...(detail.cost !== undefined ? { cost: detail.cost } : {}),
        // metadata deliberately omitted — may contain LLM scorer reasoning
      };
    }
    scrubbed.scoreDetails = detailsOut;
  }
  return scrubbed;
}

/**
 * Scrub an `EvalResult` for an observability-boundary read. Items are
 * mapped through `redactEvalItem`; result-level metadata (`dataset`, `id`,
 * `timestamp`, `totalCost`, `duration`, `summary`, `metadata`) is
 * preserved so the Eval Runner UI can still render summary stats,
 * timing, score distributions, and cost aggregates under compliance mode.
 */
export function redactEvalResult(result: EvalResult, redact: boolean): EvalResult {
  if (!redact) return result;
  return {
    ...result,
    items: result.items.map(redactEvalItem),
  };
}

/**
 * Scrub an `EvalHistoryEntry`. Entry-level metadata (id, eval name,
 * timestamp) is preserved; the nested `data` (an `EvalResult`) is
 * scrubbed recursively.
 */
export function redactEvalHistoryEntry(entry: EvalHistoryEntry, redact: boolean): EvalHistoryEntry {
  if (!redact) return entry;
  return {
    ...entry,
    data: redactEvalResult(entry.data as EvalResult, redact),
  };
}

/** List variant for eval history. */
export function redactEvalHistoryList(
  entries: EvalHistoryEntry[],
  redact: boolean,
): EvalHistoryEntry[] {
  if (!redact) return entries;
  return entries.map((e) => redactEvalHistoryEntry(e, redact));
}

// ── Pending decisions (human-in-the-loop) ───────────────────────────

/**
 * Scrub a `PendingDecision`. The `prompt` field is the human-visible
 * approval question that typically echoes user or agent content (e.g.
 * "Approve sending this email to `user@acme.com`?"). Metadata is also
 * scrubbed because it's a free-form bag that may contain arbitrary
 * user data. Structural fields (executionId, channel, createdAt) stay
 * visible so the Decisions panel can still render the approval queue.
 */
export function redactPendingDecision(decision: PendingDecision, redact: boolean): PendingDecision {
  if (!redact) return decision;
  return {
    ...decision,
    prompt: REDACTED,
    ...(decision.metadata !== undefined ? { metadata: { redacted: true } } : {}),
  };
}

/** List variant for pending decisions. */
export function redactPendingDecisionList(
  decisions: PendingDecision[],
  redact: boolean,
): PendingDecision[] {
  if (!redact) return decisions;
  return decisions.map((d) => redactPendingDecision(d, redact));
}
