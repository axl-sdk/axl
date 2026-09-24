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
  HistoricalExecutionInfo,
  ChatMessage,
  PendingDecision,
  HistoricalAxlEvent,
  EvalHistoryEntry,
} from '@axlsdk/axl';
import { redactCapturedRequest, redactHistoricalEvent } from '@axlsdk/axl';
import type { CapturedRequestRecord } from '@axlsdk/axl';
import type {
  EvalComparison,
  EvalItem,
  EvalItemFailure,
  EvalRegression,
  EvalResult,
  ScorerDetail,
} from '@axlsdk/eval';

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
 * `tool_call_start.data.args`, historical v1 `tool_denied.data.*`). Defense in depth —
 * core `emitEvent` scrubs most variants at emission, but the REST
 * serialization boundary is the last line before PII leaves the
 * observability envelope.
 */
export function redactExecutionInfo(
  info: HistoricalExecutionInfo,
  redact: boolean,
): HistoricalExecutionInfo {
  if (!redact) return info;
  return {
    ...info,
    ...(info.result !== undefined ? { result: REDACTED } : {}),
    ...(info.error !== undefined ? { error: REDACTED } : {}),
    // `metadata` carries operator-supplied tags (userId/tenantId/correlation
    // ids per the docs) — exactly the surface trace.redact is supposed to
    // protect. Without this scrub, REST consumers see the metadata bag
    // even when redaction is enabled, while events[*].data.* is properly
    // scrubbed. Use a `{ redacted: true }` marker to keep the field
    // queryable/serializable rather than dropping it (mirrors
    // `redactPendingDecision` on `decision.metadata`).
    ...(info.metadata !== undefined ? { metadata: { redacted: true } } : {}),
    events: info.events.map((e) => redactStreamEvent(e, true)),
  } as HistoricalExecutionInfo;
}

/** List variant: maps each entry through the single-item redactor. */
export function redactExecutionList(
  infos: HistoricalExecutionInfo[],
  redact: boolean,
): HistoricalExecutionInfo[] {
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
 *   - `agent`                                      — config-time agent name on
 *     assistant messages (non-PII identifier)
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
    ...(msg.agent !== undefined ? { agent: msg.agent } : {}),
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
 * Scrub an `AxlEvent` before broadcasting it to Studio WS subscribers or
 * serializing it through a REST response.
 *
 * Per-variant scrub logic lives in core's `REDACTION_RULES` table
 * (`packages/axl/src/redaction.ts`). Both this WS-boundary scrubber and
 * core's emit-time scrubber consult the same rules, so adding a new
 * `AxlEvent` variant updates both layers in one place — no drift.
 *
 * The defense-in-depth value of this layer remains: when a runtime emits
 * events with `redact: false` (rare but possible — e.g. a multi-tenant
 * setup where the per-request decision is made later) and they land in
 * `ExecutionInfo.events` for a REST read with `redact: true`, this
 * second pass catches the missed scrub. Structural metadata
 * (`executionId`/`step`/`timestamp`/`askId`/`agent`/etc.) and numeric
 * observability fields (`cost`/`tokens`/`duration`) are preserved by
 * every rule.
 *
 * Programmatic callers of `runtime.execute()` and direct StateStore
 * reads still receive raw events — redaction is an observability-boundary
 * filter, not a data-at-rest transform.
 */
export function redactStreamEvent(event: HistoricalAxlEvent, redact: boolean): HistoricalAxlEvent {
  if (!redact) return event;
  return redactHistoricalEvent(event);
}

/**
 * Rich media errors may echo attacker-controlled provider diagnostics. Keep
 * ordinary text-only traces intact while making media-run terminal failures
 * safe for Studio's REST/WS observability boundary even with redact disabled.
 */
export function sanitizeRichInputFailure(event: HistoricalAxlEvent): HistoricalAxlEvent {
  const message = 'Playground media input failed';
  if (event.type === 'ask_end' && !event.outcome.ok) {
    return { ...event, outcome: { ok: false, error: message } };
  }
  if (event.type === 'agent_call_end' && event.data.error !== undefined) {
    return { ...event, data: { ...event.data, error: message } };
  }
  if (event.type === 'error') {
    return { ...event, data: { ...event.data, message } };
  }
  return event;
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
 *   failure (projected to name/provider/status/retryable/requestId — see
 *            projectItemFailure; any other key is dropped)
 *   scoreDetails[*].{score, duration, cost, skipped} (but not metadata)
 *   metadata (execution metadata: models, tokens, agentCalls, workflows)
 *   traces (trace events — already redacted at emission time)
 */
/**
 * Metadata keys the RUNTIME measured. Everything else on `EvalItem.metadata` is
 * the workflow callback's own free-form return value — the same category as
 * `output` and `callerReport.metadata`, and just as capable of echoing user
 * input — so it is masked rather than passed through.
 *
 * Kept as an allowlist, not a denylist: a new caller key must not become a new
 * leak simply because nobody thought to add it to a blocklist.
 */
const MEASURED_METADATA_KEYS: ReadonlySet<string> = new Set([
  'models',
  'modelCallCounts',
  'workflows',
  'workflowCallCounts',
  'tokens',
  'agentCalls',
]);

function redactItemMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return metadata;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    out[key] = MEASURED_METADATA_KEYS.has(key) ? value : REDACTED;
  }
  return out;
}

/**
 * Project `EvalItem.failure` onto its five known keys, each only when present
 * with the type `@axlsdk/eval` writes. The runner never records a body or
 * message there, but an imported artifact is stored verbatim and a newer writer
 * could add a key — an allowlist keeps either from becoming a leak. Without a
 * string `name` there is no cause to show, so the record is dropped.
 */
function projectItemFailure(failure: unknown): EvalItemFailure | undefined {
  if (!failure || typeof failure !== 'object') return undefined;
  const f = failure as Record<string, unknown>;
  if (typeof f.name !== 'string') return undefined;
  return {
    name: f.name,
    ...(typeof f.provider === 'string' ? { provider: f.provider } : {}),
    ...(typeof f.status === 'number' && Number.isFinite(f.status) ? { status: f.status } : {}),
    ...(typeof f.retryable === 'boolean' ? { retryable: f.retryable } : {}),
    ...(typeof f.requestId === 'string' ? { requestId: f.requestId } : {}),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Redact one scorer detail, or replace it when it is not an object. Only the
 * structural keys survive; `metadata` (LLM scorer reasoning) never does.
 */
function redactScorerDetail(detail: unknown): ScorerDetail {
  if (!isPlainObject(detail)) return REDACTED as unknown as ScorerDetail;
  const d = detail as ScorerDetail;
  return {
    score: d.score,
    ...(d.duration !== undefined ? { duration: d.duration } : {}),
    ...(d.cost !== undefined ? { cost: d.cost } : {}),
    // `skipped` is a structural boolean (the `applies` predicate verdict),
    // not user/LLM content — preserve it so the client's N/A chip renders.
    ...(d.skipped !== undefined ? { skipped: d.skipped } : {}),
    // `outcome` and `accounting` are structural (a classification and a set
    // of counts), so they survive redaction the way `skipped` does — without
    // them a compliance-mode reader cannot tell a judge that was stopped on
    // budget from one that scored 0.
    ...(d.outcome !== undefined ? { outcome: d.outcome } : {}),
    ...(d.accounting !== undefined ? { accounting: d.accounting } : {}),
    // `diagnostics` survives for the same reason `accounting` does: it is a
    // list of operation ids and statuses, not content.
    ...(d.diagnostics !== undefined ? { diagnostics: d.diagnostics } : {}),
    // metadata deliberately omitted — may contain LLM scorer reasoning
  };
}

/**
 * Redact one item. Total by design: a history row is whatever import or an
 * older writer stored, so a part that does not have the expected shape is
 * replaced with the sentinel — never forwarded (a leak) and never allowed to
 * throw (which would fail the whole redacted history list). Same stance as
 * `redactRecordLine` on an unparseable line.
 */
function redactEvalItem(item: unknown): EvalItem {
  if (!isPlainObject(item)) return REDACTED as unknown as EvalItem;
  const { failure, ...rest } = item as EvalItem;
  const typed = item as EvalItem;
  const projectedFailure = failure !== undefined ? projectItemFailure(failure) : undefined;
  const scrubbed: EvalItem = {
    ...rest,
    ...(projectedFailure ? { failure: projectedFailure } : {}),
    input: REDACTED,
    output: REDACTED,
    // `diagnostics` is spread through untouched on purpose: it holds operation
    // IDs, kinds, turn/attempt indexes and a status — pointers into an artifact,
    // never content. The records themselves are redacted by the core rule at
    // both write time and delivery time (`redactRecordLine`).
    ...(typed.metadata !== undefined
      ? {
          metadata: isPlainObject(typed.metadata)
            ? redactItemMetadata(typed.metadata)
            : (REDACTED as unknown as Record<string, unknown>),
        }
      : {}),
    ...(typed.annotations !== undefined ? { annotations: REDACTED } : {}),
    ...(typed.error !== undefined ? { error: REDACTED } : {}),
    ...(typed.scorerErrors !== undefined
      ? {
          scorerErrors: Array.isArray(typed.scorerErrors)
            ? typed.scorerErrors.map(() => REDACTED)
            : (REDACTED as unknown as string[]),
        }
      : {}),
    // `callerReport.metadata` is whatever the workflow callback returned — free-
    // form user content, exactly like `output`, so it is dropped rather than
    // masked (same treatment as scorer metadata below). Its sibling `cost` is a
    // plain number and stays. (`outcome` and `accounting` are spread through
    // untouched: both are structural counts and classifications, no content.)
    ...(typed.callerReport !== undefined
      ? {
          callerReport: isPlainObject(typed.callerReport)
            ? typeof typed.callerReport.cost === 'number'
              ? { cost: typed.callerReport.cost }
              : {}
            : (REDACTED as unknown as EvalItem['callerReport']),
        }
      : {}),
  };
  if (typed.scoreDetails !== undefined) {
    if (isPlainObject(typed.scoreDetails)) {
      const detailsOut: Record<string, ScorerDetail> = {};
      for (const [name, detail] of Object.entries(typed.scoreDetails)) {
        detailsOut[name] = redactScorerDetail(detail);
      }
      scrubbed.scoreDetails = detailsOut;
    } else {
      scrubbed.scoreDetails = REDACTED as unknown as Record<string, ScorerDetail>;
    }
  }
  return scrubbed;
}

/**
 * Scrub an `EvalResult` for an observability-boundary read. Items are
 * mapped through `redactEvalItem`; result-level metadata (`dataset`, `id`,
 * `timestamp`, `totalCost`, `duration`, `summary`, `metadata`) is
 * preserved so the Eval Runner UI can still render summary stats,
 * timing, score distributions, and cost aggregates under compliance mode.
 *
 * One narrow exception: `metadata.batchFailure` is the raw error message
 * from a partial-batch failure. Studio-generated batches pre-redact this
 * at the run endpoint, but CLI-imported artifacts can carry an unredacted
 * error string that may quote user input (e.g. a guardrail rejection that
 * echoes the prompt). Scrub it here so imports under redact mode don't
 * leak.
 *
 * A sync multi-run response also carries `_multiRun.allRuns` — every run's
 * full `EvalResult`, items included — so each run is scrubbed the same way,
 * along with `_multiRun.batchFailure`. `_multiRun.aggregate` is scorer
 * statistics, cost and counts, and passes through.
 */
export function redactEvalResult(result: EvalResult, redact: boolean): EvalResult {
  if (!redact) return result;
  return redactResultShape(result);
}

/**
 * The redacting walk behind `redactEvalResult`, total over whatever was stored:
 * `items` that is not an array, and `_multiRun` / `allRuns` / a nested run that
 * does not have the expected shape, are replaced with the sentinel.
 */
function redactResultShape(result: EvalResult): EvalResult {
  const scrubbedMetadata = redactResultMetadata(result.metadata);
  const hasMultiRun = '_multiRun' in result;
  const multiRun = (result as { _multiRun?: unknown })._multiRun;
  return {
    ...result,
    metadata: scrubbedMetadata,
    items: Array.isArray(result.items)
      ? result.items.map(redactEvalItem)
      : (REDACTED as unknown as EvalItem[]),
    ...(hasMultiRun && multiRun !== undefined
      ? {
          _multiRun: isPlainObject(multiRun) ? redactMultiRun(multiRun) : REDACTED,
        }
      : {}),
  };
}

/** Result-level metadata is structural except `batchFailure`, a raw error message. */
function redactResultMetadata<M>(metadata: M): M {
  const meta = metadata as unknown;
  return isPlainObject(meta) && typeof meta.batchFailure === 'string'
    ? ({ ...meta, batchFailure: REDACTED } as M)
    : metadata;
}

function redactMultiRun(multiRun: Record<string, unknown>): Record<string, unknown> {
  const { allRuns } = multiRun;
  return {
    ...multiRun,
    ...(allRuns !== undefined
      ? {
          allRuns: Array.isArray(allRuns)
            ? allRuns.map((run) =>
                isPlainObject(run) && Array.isArray(run.items)
                  ? redactResultShape(run as unknown as EvalResult)
                  : REDACTED,
              )
            : REDACTED,
        }
      : {}),
    ...(typeof multiRun.batchFailure === 'string' ? { batchFailure: REDACTED } : {}),
  };
}

/**
 * Scrub an `EvalComparison` for `POST /api/evals/compare`.
 *
 * Compare copies the baseline item's `input` onto every regression and
 * improvement, and each side's result `metadata` onto `baseline` / `candidate`.
 * Those are the same fields `redactEvalResult` scrubs on history, so they get
 * the same rule here — otherwise comparing two history ids bypasses the scrub.
 * `input` is masked rather than dropped (it is a required key); `itemIndex`,
 * scores and every statistic stay. `summary` is built from scorer names and
 * numbers only, so it passes through.
 */
export function redactEvalComparison(comparison: EvalComparison, redact: boolean): EvalComparison {
  if (!redact) return comparison;
  const maskInput = (r: EvalRegression): EvalRegression => ({ ...r, input: REDACTED });
  const side = <S extends { metadata: Record<string, unknown> }>(s: S): S => ({
    ...s,
    metadata: redactResultMetadata(s.metadata),
  });
  return {
    ...comparison,
    baseline: side(comparison.baseline),
    candidate: side(comparison.candidate),
    regressions: comparison.regressions.map(maskInput),
    improvements: comparison.improvements.map(maskInput),
  };
}

/**
 * Scrub one captured-request JSONL line on its way out of the server.
 *
 * Records are ALREADY redacted at write time when the runtime has redaction on,
 * so under normal configuration this is a no-op that re-applies an idempotent
 * rule. It earns its place for the configurations where it is not a no-op:
 * an artifact captured before redaction was enabled, and an artifact imported
 * from another deployment. Neither should be able to serve raw prompts out of
 * a Studio that is running in compliance mode.
 *
 * A line that does not parse is replaced rather than forwarded — an unparseable
 * line cannot be redacted, and forwarding it would be exactly the bypass this
 * function exists to close.
 */
export function redactRecordLine(line: string, redact: boolean): string {
  if (!redact) return line;
  let parsed: CapturedRequestRecord;
  try {
    parsed = JSON.parse(line) as CapturedRequestRecord;
  } catch {
    // A line that will not parse still has to leave the door as a VALID record:
    // this stream is re-importable, and `validateRequestSidecar` rejects the
    // whole bundle over one line missing `operationId` or a known `phase`. A
    // stub that says plainly it stands in for something unreadable keeps the
    // rest of the artifact importable.
    const stub: CapturedRequestRecord = {
      v: 1,
      phase: 'end',
      operationId: 'unknown',
      kind: 'chat',
      transportAttempts: 1,
      provider: 'unknown',
      model: 'unknown',
      termination: 'the stored record could not be parsed',
      captured: {
        fidelity: 'runtime_request',
        redacted: true,
        truncated: true,
        omitted: ['record'],
      },
    };
    return JSON.stringify(stub);
  }
  return JSON.stringify(redactCapturedRequest(parsed));
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
