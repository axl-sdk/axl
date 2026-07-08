import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import type {
  Result,
  BudgetResult,
  HumanDecision,
  BudgetOptions,
  MapOptions,
  SpawnOptions,
  VoteOptions,
  VerifyOptions,
  AwaitHumanOptions,
  AskOptions,
  SchemaPromptOption,
  DelegateOptions,
  RaceOptions,
  AxlEvent,
  CallbackMeta,
  ChatMessage,
  ToolCallMessage,
  ProviderResponse,
  AgentCallInfo,
  AgentCallParams,
  ValidateResult,
  VerifyRetry,
} from './types.js';
import {
  VerifyError,
  QuorumNotMet,
  NoConsensus,
  TimeoutError,
  MaxTurnsError,
  BudgetExceededError,
  GuardrailError,
  ValidationError,
} from './errors.js';
import type { Agent } from './agent.js';
import { parsePartialJson } from './partial-json.js';
import { StreamingWalker } from './streaming-walker.js';
import { COST_BEARING_LEAF_TYPES, hasPositiveTokens, isUsableCost } from './event-utils.js';
import { AxlEventBus, EventStreamOverflowError, type EventStreamOptions } from './event-stream.js';
import { redactEvent } from './redaction.js';
import {
  detectDroppedRefinements,
  warnSchemaDiagnosticOnce,
  DEFAULT_SCHEMA_OVERSIZED_TOKENS,
} from './schema-diagnostics.js';
import type { Provider, ChatOptions, ToolDefinition } from './providers/types.js';
import { ProviderError } from './providers/errors.js';
import type { ProviderRegistry } from './providers/registry.js';
import type { AxlConfig } from './config.js';
import { parseDuration, parseCost } from './config.js';
import type { StateStore } from './state/types.js';
import type { McpManager } from './mcp/manager.js';
import type { SpanManager } from './telemetry/types.js';
import type { MemoryManager } from './memory/manager.js';
import type { RememberOptions, RecallOptions, VectorResult } from './memory/types.js';

/**
 * AsyncLocalStorage for per-branch abort signals.
 * Used by race/spawn/map/budget to thread signals through async contexts
 * without mutating shared state on the WorkflowContext instance.
 */
const signalStorage = new AsyncLocalStorage<AbortSignal>();

/**
 * Per-ask frame propagated via AsyncLocalStorage.
 *
 * - `askId` / `depth` / `agent`: identify the ask this event belongs to so
 *   consumers can group, indent, and link nested asks without consulting
 *   parent context.
 * - `parentAskId`: set on every nested frame so the consumer can reconstruct
 *   the ask tree; absent on the root ask.
 * - `stepRef`: a single mutable counter shared across the entire execution
 *   (root ask + every nested ask + every branch primitive). Atomically
 *   incremented on each event emission so `event.step` is monotonic across
 *   the whole tree, not per-context.
 */
type AskFrame = {
  askId: string;
  parentAskId?: string;
  depth: number;
  agent?: string;
  stepRef: { value: number };
  /**
   * Cost incurred by THIS ask only — agent_call_end + tool_call_end events
   * emitted within this frame (NOT including nested asks, which have their
   * own frame and own counter). `emitEvent` increments this on every event
   * that carries `cost` as long as the event's frame matches `this`. Read
   * by `ask_end` to populate `cost` per spec decision 10.
   */
  askCost: { value: number };
  /**
   * True when a cost-bearing leaf in THIS frame did measurable work (returned
   * usage/tokens) but had no usable cost (unpriced model / pricing-table miss).
   * Set in `emitEvent` alongside the cost rollup. Read by `ask_end` to surface
   * `unpriced`, so an ask's `cost` (which silently omits the unknown component)
   * is shown as a lower bound rather than a misleading exact figure.
   */
  askUnpriced: boolean;
};
const askStorage = new AsyncLocalStorage<AskFrame>();

/**
 * Memoized inline JSON-Schema conversions, keyed by Zod schema identity.
 *
 * The conversion (`z.toJSONSchema`) walks the entire schema tree; the tool-def
 * hot path (`buildToolDefs`) re-derives the same schema on every turn from a
 * stable `tool.inputSchema`, and const / agent-config prompt schemas are also
 * stable. A `WeakMap` on schema identity turns those into cache hits while
 * inline per-call schemas (a fresh object each call) miss cleanly and are GC'd
 * with no leak. Best-effort: correctness never depends on a hit.
 *
 * The cached object is shared by reference — callers MUST treat it as read-only.
 * Audited consumers (`buildToolDefs` wrapping, Gemini `sanitizeSchemaForGemini`
 * which clones, Studio introspection which serializes, prompt stringify) never
 * mutate it.
 */
const inlineSchemaCache = new WeakMap<z.ZodType, Record<string, unknown>>();

/** Convert a Zod schema to JSON Schema. Exported for Studio tool introspection.
 *  Wraps Zod v4's built-in `z.toJSONSchema()`, stripping the `$schema` key
 *  since tool parameter schemas are embedded objects, not standalone documents.
 *
 *  **Inline** rendering: shared subschemas are duplicated in place rather than
 *  hoisted into `$defs`/`$ref`. This is the safe rendering for provider tool
 *  definitions — notably Gemini's `sanitizeSchemaForGemini` strips `$ref`/`$defs`,
 *  which would silently reduce a hoisted schema to a typeless `{}`. (Note: a
 *  genuinely RECURSIVE schema still emits `$ref`/`$defs` even inline — recursion
 *  can't be inlined — so such tool schemas remain lossy on Gemini regardless;
 *  that's a pre-existing provider limitation, independent of this rendering.)
 *  The extra `reused:'ref'` compaction lives in the private
 *  `renderSchemaForPrompt` and is scoped to prompt text, where `$ref` is opaque
 *  bytes on the wire. */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const cached = inlineSchemaCache.get(schema);
  if (cached !== undefined) return cached;
  const result = z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>;
  delete result.$schema;
  // Shallow-freeze the cached object so an accidental top-level mutation by a
  // consumer (this is a public barrel export) fails loudly in strict mode
  // rather than silently poisoning the shared cache. Audited callers are all
  // read-only; nested objects stay mutable (shallow), which is enough to catch
  // the realistic footguns (adding/deleting a top-level key).
  Object.freeze(result);
  inlineSchemaCache.set(schema, result);
  return result;
}

/**
 * Memoized compact prompt renderings, keyed by Zod schema identity. Same
 * best-effort caching rationale as `inlineSchemaCache`, for the prompt path.
 */
const promptSchemaCache = new WeakMap<z.ZodType, string>();

/**
 * Memoized estimated token count of a schema's INLINE JSON-Schema serialization,
 * keyed by schema identity. Used by the tool-def oversized diagnostic, which
 * runs once per ask on stable `tool.inputSchema` values — without this the
 * `JSON.stringify` would re-run every ask even though the result is a static
 * property of the schema (AC-J7 "no measurable cost").
 */
const inlineSchemaTokenCache = new WeakMap<z.ZodType, number>();
function estimateInlineSchemaTokens(schema: z.ZodType): number {
  const cached = inlineSchemaTokenCache.get(schema);
  if (cached !== undefined) return cached;
  const tokens = estimateTokens(JSON.stringify(zodToJsonSchema(schema)));
  inlineSchemaTokenCache.set(schema, tokens);
  return tokens;
}

/**
 * Memoized provider schema for the NATIVE structured-output path
 * (`nativeStructuredOutput`), keyed by schema identity.
 *
 * Rendered with `io: 'input'` — the same side the prompt uses — because native
 * structured output constrains the model's OUTPUT, which then becomes the
 * `.parse` INPUT. Deriving from the output side (as the tool-def converter does)
 * would (a) collapse a `.transform()`/`.pipe()` schema to an empty `{}` on the
 * wire and (b) contradict the prompt for `.default()`ed / `.optional()` fields
 * (output marks them required, input doesn't). Inline (no `$ref`) to stay safe
 * on Gemini's sanitizer, matching the tool-def rendering.
 */
const nativeSchemaCache = new WeakMap<z.ZodType, Record<string, unknown>>();
function deriveNativeSchema(schema: z.ZodType): Record<string, unknown> {
  const cached = nativeSchemaCache.get(schema);
  if (cached !== undefined) return cached;
  const json = z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  nativeSchemaCache.set(schema, json);
  return json;
}

/**
 * Render a Zod schema as compact JSON-Schema TEXT for the prompt guidance path
 * ONLY (`Respond with valid JSON matching this schema: …`). Private by design.
 *
 * Two divergences from the exported `zodToJsonSchema`:
 *  - `reused: 'ref'` hoists subschemas shared across (e.g.) discriminated-union
 *    arms into `$defs`/`$ref` once instead of duplicating them inline — the big
 *    token win for large unions.
 *  - `JSON.stringify` WITHOUT `null, 2` — drops pretty-print indentation.
 *
 * Both are safe here because this string is pure prompt text: `$ref` is opaque
 * bytes to every provider on the prompt path (no provider parses prompt JSON
 * structurally), so the Gemini `$ref`-stripping cliff — which only bites the
 * structural tool-def / responseSchema paths — does not apply. Keeping this
 * rendering physically separate from the exported converter makes the Gemini
 * footgun unrepresentable rather than an easy-to-miss flag on a shared symbol.
 */
function renderSchemaForPrompt(schema: z.ZodType): string {
  const cached = promptSchemaCache.get(schema);
  if (cached !== undefined) return cached;
  // `io: 'input'` renders the shape the model must PRODUCE — the schema's INPUT.
  // This matters for `.transform()`/`.pipe()` schemas: the default ('output')
  // mode renders the post-transform type, which for a transform is opaque and
  // collapses to `{}` — a schema-in-prompt with zero guidance. Input mode shows
  // the pre-transform fields the model actually supplies. For plain schemas it's
  // identical except non-strict objects correctly omit `additionalProperties:
  // false` (they DO accept extra keys), while `.strict()` keeps it.
  const json = z.toJSONSchema(schema, {
    unrepresentable: 'any',
    io: 'input',
    reused: 'ref',
  }) as Record<string, unknown>;
  delete json.$schema;
  const rendered = JSON.stringify(json);
  promptSchemaCache.set(schema, rendered);
  return rendered;
}

/** Simple token estimator: ~4 chars per token. Good enough for context management. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Extract JSON from LLM response content.
 * Handles: raw JSON, markdown fenced blocks (```json ... ```),
 * and content with leading/trailing text around a JSON object/array.
 */
export function extractJson(content: string): string {
  const trimmed = content.trim();

  // Content starts with { or [ — extract balanced JSON (handles trailing text)
  if (trimmed.startsWith('{')) {
    return extractBalanced(trimmed, 0, '{', '}') ?? trimmed;
  }
  if (trimmed.startsWith('[')) {
    return extractBalanced(trimmed, 0, '[', ']') ?? trimmed;
  }

  // Extract from markdown fenced code block
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  // Find the first balanced { ... } or [ ... ]
  const open = trimmed.indexOf('{');
  if (open >= 0) {
    const extracted = extractBalanced(trimmed, open, '{', '}');
    if (extracted) return extracted;
  }

  const openBracket = trimmed.indexOf('[');
  if (openBracket >= 0) {
    const extracted = extractBalanced(trimmed, openBracket, '[', ']');
    if (extracted) return extracted;
  }

  // Nothing found — return as-is and let JSON.parse produce the error
  return trimmed;
}

/** Extract a balanced substring from `start` matching open/close chars, respecting JSON strings. */
function extractBalanced(
  str: string,
  start: number,
  openChar: string,
  closeChar: string,
): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return str.slice(start, i + 1);
    }
  }
  return null;
}

/** Estimate tokens for a message array. */
/**
 * Append the assistant's failed attempt and the corrective feedback message to
 * the conversation so the next LLM turn sees both. Shared across guardrail,
 * schema_check, and validate retry paths — keeps the exact message shape in
 * one place so fixes (e.g. preserving providerMetadata for Gemini) apply to
 * all three gates at once.
 */
function appendRetryMessages(
  messages: ChatMessage[],
  content: string,
  feedbackMessage: string,
  providerMetadata?: Record<string, unknown>,
): void {
  messages.push({
    role: 'assistant',
    content,
    ...(providerMetadata ? { providerMetadata } : {}),
  });
  messages.push({ role: 'system', content: feedbackMessage });
}

function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content);
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += estimateTokens(tc.function.name + tc.function.arguments);
      }
    }
    total += 4; // per-message overhead (role, separators)
  }
  return total;
}

/**
 * Active `ctx.budget()` accounting state. One mutable object per budget block,
 * shared by reference across the block's async branches (spawn/race/map).
 */
type BudgetContextState = {
  totalCost: number;
  limit: number;
  exceeded: boolean;
  policy: string;
  abortController?: AbortController;
  /**
   * Set true when a cost-bearing leaf inside this budget did measurable work
   * (positive tokens) but produced no usable cost (unpriced model / pricing-table
   * miss). `totalCost` then UNDERSTATES real spend — it's a lower bound. The budget
   * rail REPORTS this (via {@link BudgetResult.unpriced} / `getBudgetStatus`) but
   * does NOT enforce on it: `_accumulateBudgetCost` never receives the unknown
   * component, so a cost limit / hard_stop cannot trip on unpriced spend.
   */
  unpriced: boolean;
  /** Monotonic count of unpriced leaves observed in this budget scope. */
  unpricedCount: number;
  /** Dedup guard so the unpriced warning fires at most once per budget block. */
  unpricedWarned: boolean;
};

export type WorkflowContextInit = {
  input: unknown;
  executionId: string;
  metadata?: Record<string, unknown>;
  config: AxlConfig;
  providerRegistry: ProviderRegistry;
  sessionHistory?: ChatMessage[];
  onTrace?: (event: AxlEvent) => void;
  /** Per-token streaming callback. `meta` carries `askId`/`parentAskId`/
   *  `depth`/`agent` so consumers can route or filter (e.g., `meta.depth === 0`
   *  for root-only chat UIs). */
  onToken?: (token: string, meta: CallbackMeta) => void;
  /** Pre-execution tool-call callback. `meta` carries the ask correlation. */
  onToolCall?: (call: { name: string; args: unknown; callId?: string }, meta: CallbackMeta) => void;
  pendingDecisions?: Map<string, (d: HumanDecision) => void>;
  budgetContext?: BudgetContextState;
  stateStore?: StateStore;
  signal?: AbortSignal;
  workflowName?: string;
  mcpManager?: McpManager;
  /** SpanManager for OpenTelemetry instrumentation. */
  spanManager?: SpanManager;
  /** MemoryManager for ctx.remember() / ctx.recall() operations. */
  memoryManager?: MemoryManager;
  /** When true, the context replays from checkpoints before executing. */
  resumeMode?: boolean;
  /** Override tool handlers by name. Bypasses normal tool lookup in executeAgentCall. */
  toolOverrides?: Map<string, (args: unknown) => Promise<unknown>>;
  /** Handler for awaitHuman — when set, returns immediately instead of waiting for pendingDecisions. */
  awaitHumanHandler?: (options: AwaitHumanOptions) => HumanDecision | Promise<HumanDecision>;
  /** Callback fired when an agent LLM call is about to start. */
  onAgentStart?: (info: { agent: string; model: string }, meta: CallbackMeta) => void;
  /** Callback fired after each ctx.ask() completes (once per ask invocation). */
  onAgentCallComplete?: (call: AgentCallInfo) => void;
  /** Options for the lazy `ctx.events` `AxlEventBus`. Forwarded by
   *  `runtime.createContext({ events })` / `runtime.execute(name, input,
   *  { events })` / `runtime.stream(name, input, { events })`. If unset,
   *  the bus uses its built-in defaults (`maxQueued: 10_000`,
   *  `onOverflow: 'drop-oldest-non-terminal'`). Child contexts share the
   *  parent's bus instance, so this option has no effect on
   *  `createChildContext()` callers. */
  eventStreamOptions?: EventStreamOptions;
  /** Internal: shared mutable holder for the lazy `AxlEventBus`. Set by
   *  `createChildContext` so parent + children read and write the same
   *  slot — late allocation in the parent (after children exist) is
   *  visible to those children, and child allocation is visible to the
   *  parent. Direct callers should not pass this. */
  _busRef?: { current: AxlEventBus | undefined };
  /** Internal: shared auto-checkpoint counters. Set by `createChildContext`
   *  so parent + child share the same number space, preventing checkpoint
   *  store key collisions across nested `WorkflowContext` instances.
   *
   *  - `byAgent` — per-agent counter for `ctx.ask` auto-checkpoints; each
   *    agent's first ask gets `0`, second gets `1`, etc. Composed name:
   *    `__auto/<agent>/ask/<n>`. Reads naturally as "orchestrator's first
   *    ask, second ask…" instead of a global ordinal.
   *  - `root` — counter for `ctx.spawn` / `race` / `parallel` / `map`
   *    wrappers, which don't have an agent context (they wrap arbitrary
   *    fn callbacks). Composed name: `__auto/<primitive>/<n>`.
   *
   *  Root contexts default to a fresh `{ byAgent: new Map(), root: 0 }`. */
  autoCheckpointCounters?: { byAgent: Map<string, number>; root: number };
};

/**
 * The central coordination object for all Axl primitives.
 * Carries execution state, tracing, budget tracking, and session history.
 */
export class WorkflowContext<TInput = unknown> {
  readonly input: TInput;
  readonly executionId: string;
  readonly metadata: Record<string, unknown>;

  /**
   * Total cost accumulated by agent calls in this context.
   * Inside a `ctx.budget()` block, returns only that block's cost.
   * After the block completes, the nested cost is rolled up into the parent total.
   */
  get totalCost(): number {
    return this.budgetContext?.totalCost ?? 0;
  }

  private config: AxlConfig;
  private providerRegistry: ProviderRegistry;
  private sessionHistory: ChatMessage[];
  private onTrace?: (event: AxlEvent) => void;
  private onToken?: (token: string, meta: CallbackMeta) => void;
  private onToolCall?: (
    call: { name: string; args: unknown; callId?: string },
    meta: CallbackMeta,
  ) => void;
  private pendingDecisions?: Map<string, (d: HumanDecision) => void>;
  private budgetContext?: BudgetContextState;
  private stateStore?: StateStore;
  /** Root step counter for this execution. Inherited by every ctx.ask()
   *  frame so all events from this WorkflowContext (root + nested) share
   *  a single monotonic counter, even when concurrent branch primitives
   *  fire asks before any single parent ask exists. Per-instance so
   *  separate executions don't cross-talk. */
  private stepRefRoot: { value: number } = { value: 0 };
  /**
   * Auto-checkpoint counters for internal `_checkpoint` callers. Held by
   * reference so child contexts created via `createChildContext` share
   * the same number space — otherwise a tool handler's nested `ctx.ask()`
   * (which auto-checkpoints) would collide with the parent's
   * auto-checkpoints in the state store. See `WorkflowContextInit
   * .autoCheckpointCounters` for the per-agent vs root split.
   * User-facing `ctx.checkpoint(name, fn)` requires an explicit name and
   * does NOT touch these counters — it goes straight to the store under
   * the caller-supplied key.
   */
  private autoCheckpointCounters: { byAgent: Map<string, number>; root: number };
  /** Idempotency guards for `workflow_start` / `workflow_end` emission.
   *  Both `runtime.execute()` and `runtime.stream()` have paths where a
   *  post-emit side-effect (checkpoint deletion, state-store persistence)
   *  can throw AFTER `_emitWorkflowEnd({status: 'completed'})` has already
   *  fired — the outer catch would then fire `_emitWorkflowEnd({status:
   *  'failed'})` for a second time. These flags make both emitters
   *  single-fire so consumers never see paired-then-conflicting terminal
   *  events for one execution. */
  private _workflowStartEmitted = false;
  private _workflowEndEmitted = false;
  private signal?: AbortSignal;
  private summaryCache?: string;
  private workflowName?: string;
  private mcpManager?: McpManager;
  private spanManager?: SpanManager;
  private memoryManager?: MemoryManager;
  private resumeMode: boolean;
  private toolOverrides?: Map<string, (args: unknown) => Promise<unknown>>;
  private awaitHumanHandler?: (
    options: AwaitHumanOptions,
  ) => HumanDecision | Promise<HumanDecision>;
  private onAgentStart?: (info: { agent: string; model: string }, meta: CallbackMeta) => void;
  private onAgentCallComplete?: (call: AgentCallInfo) => void;

  /** Shared mutable slot for the lazy `AxlEventBus`. The slot is shared
   *  by reference across parent/child contexts so a late allocation
   *  (consumer subscribes after a child context exists) is visible
   *  everywhere. Until first access `_busRef.current` is undefined and
   *  `emitEvent` skips the bus fan-out entirely (zero overhead for
   *  contexts that never observe). */
  private readonly _busRef: { current: AxlEventBus | undefined };
  private readonly _eventStreamOptions?: EventStreamOptions;
  /** Removes the constructor-registered `'abort'` listener from
   *  `this.signal` so a long-lived signal (e.g., a request-scoped or
   *  process-wide signal reused across many `runtime.createContext()` /
   *  `runtime.execute()` calls) doesn't accumulate listeners forever.
   *  Called from `disposeEvents()` and from the workflow_end/error
   *  emission in `emitEvent`. Undefined when no abort listener was
   *  registered (no signal, signal already aborted, or non-root
   *  context). */
  private abortListenerCleanup?: () => void;

  /**
   * Iterable + EventEmitter view over every `AxlEvent` emitted by this
   * context (and its child contexts — agent-as-tool nested asks bubble up).
   *
   * Use cases:
   *  - **Inside a workflow handler**: subscribe before the first `ctx.ask()`
   *    to observe `partial_object`, `agent_call_*`, `tool_call_*`, etc.
   *    *between* asks. `ctx.events.partialObjects` is the coalescing view
   *    designed for streaming-structured-output UIs.
   *  - **Ad-hoc contexts** from `runtime.createContext()`: the same
   *    iterable replaces the legacy `onToken` / `onToolCall` /
   *    `onAgentStart` callbacks.
   *  - **Cross-execution**: prefer `runtime.on('trace', …)` instead — that
   *    fans out across all executions, while `ctx.events` is per-context.
   *
   * Lazy: the bus is allocated on first access. The bus's iterator
   * queue retains events emitted before any consumer iterates, so a
   * late `for await (const e of ctx.events)` still drains queued
   * events. The `partialObjects` view additionally seeds from a
   * per-bus `latestPartialByAsk` map, so a late subscriber may see
   * the latest coalesced state per ask even when earlier events were
   * already drained by another iterator. **Neither rescues a late
   * subscriber from the streaming-gate behavior** (see below).
   *
   * **Subscribe before the first `ctx.ask()`.** The streaming code
   * path inside `ctx.ask()` activates only when an observer is
   * present at the time the ask starts (`_streamingEnabled` — either
   * the legacy `onToken` callback is set or `ctx.events` has been
   * allocated). If you allocate `ctx.events` AFTER a `ctx.ask()` has
   * begun, that in-flight ask will not stream `token` /
   * `partial_object` events at all (the agent loop went through
   * `provider.chat` instead of `provider.stream`). Subsequent asks
   * will stream normally — the gate is re-checked per ask. The
   * unambiguous pattern is `const events = ctx.events;` on the first
   * line of the handler.
   *
   * Auto-termination: `emitEvent` calls `_eventBus._finish()` after
   * emitting `workflow_end` or `error`, so iterators terminate
   * cleanly with `done: true`. For ad-hoc contexts that never run a
   * workflow (no terminal event), pass `signal: AbortSignal.timeout(...)`
   * to `runtime.createContext` (the bus auto-disposes on abort) or
   * call `ctx.disposeEvents()` when done observing.
   */
  get events(): AxlEventBus {
    if (!this._busRef.current) {
      this._busRef.current = new AxlEventBus(this._eventStreamOptions);
      // If the context's signal was already aborted at construction time,
      // the constructor's abort listener was skipped (it only attaches
      // when the signal is still alive). A consumer accessing `ctx.events`
      // after abort would otherwise get a never-finishing bus. Finish
      // immediately so iterators resolve cleanly with `done: true`.
      if (this.signal?.aborted) {
        this._busRef.current._finish();
      }
    }
    return this._busRef.current;
  }

  /** Manually finish the `ctx.events` bus, terminating any active
   *  iterators with `done: true`. Idempotent. Useful for ad-hoc contexts
   *  from `runtime.createContext()` that never emit a `workflow_end` /
   *  `error` terminal — observers iterating `for await (const e of
   *  ctx.events)` would otherwise hang. Workflow-driven contexts
   *  (`runtime.execute` / `runtime.stream`) terminate automatically and
   *  don't need this.
   *
   *  Also removes the constructor-registered abort listener so a
   *  long-lived `signal` reused across many ad-hoc contexts doesn't
   *  accumulate listeners. */
  disposeEvents(): void {
    this._busRef.current?._finish();
    this.abortListenerCleanup?.();
  }

  /** True if any observer wants per-token streaming for asks started
   *  from this context: either the legacy `onToken` callback is set
   *  (e.g., `runtime.stream()` plumbs a sentinel) OR `ctx.events` has
   *  been allocated (a workflow-handler consumer subscribed before
   *  the ask). `ctx.ask` reads this to decide whether to enter the
   *  streaming code path; the gate is re-checked per ask, so a
   *  consumer subscribing AFTER the first ask started still gets
   *  streaming on the next one. The check `_busRef.current !== undefined`
   *  is a one-way flag — `_finish` does not unset the reference, so
   *  once an observer was present, every subsequent ask streams. */
  private get _streamingEnabled(): boolean {
    return this.onToken !== undefined || this._busRef.current !== undefined;
  }

  constructor(init: WorkflowContextInit) {
    this.input = init.input as TInput;
    this.executionId = init.executionId;
    this.metadata = init.metadata ?? {};
    this.config = init.config;
    this.providerRegistry = init.providerRegistry;
    this.sessionHistory = init.sessionHistory ?? [];
    this.onTrace = init.onTrace;
    this.onToken = init.onToken;
    this.onToolCall = init.onToolCall;
    this.pendingDecisions = init.pendingDecisions;
    this.budgetContext = init.budgetContext;
    this.stateStore = init.stateStore;
    this.signal = init.signal;
    this.workflowName = init.workflowName;
    this.mcpManager = init.mcpManager;
    this.spanManager = init.spanManager;
    this.memoryManager = init.memoryManager;
    this.resumeMode = init.resumeMode ?? false;
    this.toolOverrides = init.toolOverrides;
    this.awaitHumanHandler = init.awaitHumanHandler;
    this.onAgentStart = init.onAgentStart;
    this.onAgentCallComplete = init.onAgentCallComplete;
    // The bus slot is shared mutable state across parent + children so a
    // late allocation in either is visible to all of them. Root contexts
    // get a fresh `{ current: undefined }`; child contexts inherit the
    // parent's ref. `emitEvent` reads `_busRef.current` on every call so
    // it picks up an allocation that happened after this context was
    // constructed.
    this._busRef = init._busRef ?? { current: undefined };
    this._eventStreamOptions = init.eventStreamOptions;
    // Auto-dispose the events bus when this context's signal aborts.
    // The leak this prevents: a `runtime.createContext({ signal })` flow
    // that iterates `ctx.events` and never emits a `workflow_end` /
    // `error` terminal (because there's no workflow). Without this, an
    // aborted signal would orphan the iterator and leak the listener
    // pool. For workflow-driven flows the natural terminal already
    // dominates; this hook is harmless when both fire (`_finish` is
    // idempotent). Only the root context registers the listener — child
    // contexts share the same `_busRef` and would otherwise double-fire.
    // `init._busRef === undefined` is the root-context marker.
    //
    // The listener is auto-removed by `{ once: true }` if the signal
    // ever aborts, but the success path leaves it attached. To prevent
    // listener accumulation when a long-lived signal is reused across
    // many contexts, capture the removal fn and call it from
    // `disposeEvents()` and from the workflow_end/error path in
    // `emitEvent`.
    if (init._busRef === undefined && this.signal && !this.signal.aborted) {
      const signal = this.signal;
      const onAbort = () => {
        this._busRef.current?._finish();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.abortListenerCleanup = () => {
        signal.removeEventListener('abort', onAbort);
        this.abortListenerCleanup = undefined;
      };
    }
    // Inherit auto-checkpoint counters from parent if provided; otherwise
    // start a fresh ref. Shared by reference so child contexts increment
    // the same counters and never collide with the parent in the store.
    this.autoCheckpointCounters = init.autoCheckpointCounters ?? {
      byAgent: new Map(),
      root: 0,
    };
    // Restore cached summary from session metadata (survives across requests)
    if (init.metadata?.summaryCache) {
      this.summaryCache = init.metadata.summaryCache as string;
    }
  }

  /**
   * Create a child context for nested agent invocations (e.g., agent-as-tool).
   * Shares: budget tracking, abort signals, trace emission, provider registry,
   *         state store, span manager, memory manager, MCP manager, config,
   *         awaitHuman handler, pending decisions, tool overrides, AND the
   *         streaming callbacks (onToken / onAgentStart / onToolCall).
   * Isolates: session history.
   *
   * Streaming callbacks now propagate into nested asks because every callback
   * invocation carries `meta.askId`/`meta.parentAskId`/`meta.depth` so
   * consumers that want root-only behavior can filter on `meta.depth === 0`
   * instead of relying on the runtime to drop nested events. This is the
   * "nested ask visibility" fix from spec §3.2.
   *
   * The shared step counter lives in `askStorage` (ALS), so there is no
   * per-context counter to pass through anymore. Nested events are
   * correlated to their parent via `parentAskId` (set on every nested ask
   * by ALS frame allocation) — the deprecated `parentToolCallId` field
   * was removed in 0.16.0.
   */
  createChildContext(): WorkflowContext {
    return new WorkflowContext({
      input: this.input,
      executionId: this.executionId,
      config: this.config,
      providerRegistry: this.providerRegistry,
      metadata: { ...this.metadata },
      // Shared infrastructure
      budgetContext: this.budgetContext,
      stateStore: this.stateStore,
      mcpManager: this.mcpManager,
      spanManager: this.spanManager,
      memoryManager: this.memoryManager,
      onTrace: this.onTrace,
      onToken: this.onToken,
      onToolCall: this.onToolCall,
      onAgentStart: this.onAgentStart,
      onAgentCallComplete: this.onAgentCallComplete,
      awaitHumanHandler: this.awaitHumanHandler,
      pendingDecisions: this.pendingDecisions,
      toolOverrides: this.toolOverrides,
      signal: this.signal,
      workflowName: this.workflowName,
      // Share the parent's auto-checkpoint counters so internal checkpoints
      // emitted from `ctx.ask` / spawn / race / parallel / map in this
      // child context don't collide with the parent's in the state store.
      autoCheckpointCounters: this.autoCheckpointCounters,
      // Share the parent's bus slot (mutable ref). Late allocation in
      // either parent or child propagates because both read the same
      // slot. Nested-ask events (agent-as-tool pattern) bubble up to
      // the parent's iterator with `parentAskId`/`depth` correlation
      // intact.
      _busRef: this._busRef,
      eventStreamOptions: this._eventStreamOptions,
      // Isolated: sessionHistory (empty)
    });
  }

  /**
   * Resolve the current abort signal.
   * Branch-scoped signals (from race/spawn/map/budget) in AsyncLocalStorage
   * take priority over the instance-level signal.
   */
  private get currentSignal(): AbortSignal | undefined {
    return signalStorage.getStore() ?? this.signal;
  }

  /**
   * Build a `CallbackMeta` for the current ask frame. Used at every
   * `onToken`/`onToolCall`/`onAgentStart` call site so consumers can
   * route or filter by ask correlation (`meta.depth === 0` for root
   * chat UIs, etc.).
   *
   * If the call is somehow outside an ask frame (e.g., a programmatic
   * `tool.run()` test harness), falls back to a synthetic meta keyed off
   * `executionId` so the type contract holds — consumers see `depth: 0`
   * and can ignore those events.
   */
  private currentCallbackMeta(agentName: string): CallbackMeta {
    const frame = askStorage.getStore();
    if (frame) {
      return {
        askId: frame.askId,
        ...(frame.parentAskId ? { parentAskId: frame.parentAskId } : {}),
        depth: frame.depth,
        agent: agentName,
      };
    }
    return { askId: this.executionId, depth: 0, agent: agentName };
  }

  // ── ctx.ask() ─────────────────────────────────────────────────────────

  async ask<T = string>(agent: Agent, prompt: string, options?: AskOptions<T>): Promise<T> {
    const agentName = agent._name;
    return this._checkpoint(
      this._autoCheckpointName('ask', agentName),
      async () => {
        // Allocate the ask frame BEFORE entering askStorage.run so the
        // emitEvent calls inside the run() callback see the new frame in ALS.
        const parentFrame = askStorage.getStore();
        const askId = randomUUID();
        const depth = (parentFrame?.depth ?? -1) + 1;
        // Nested asks inherit the parent frame's counter; top-level asks
        // share the WorkflowContext's instance-level `stepRefRoot` so all
        // top-level asks (including concurrent ones from spawn / parallel /
        // race) share a single monotonic counter. Spec §3.7.
        const stepRef = parentFrame?.stepRef ?? this.stepRefRoot;
        const frame: AskFrame = {
          askId,
          parentAskId: parentFrame?.askId,
          depth,
          agent: agent._name,
          stepRef,
          askCost: { value: 0 },
          askUnpriced: false,
        };

        return askStorage.run(frame, async () => {
          const askStart = Date.now();
          this.emitEvent({ type: 'ask_start', prompt });

          // `costBefore` snapshots the global budget so we can pass the per-ask
          // cost delta to onAgentCallComplete (legacy callback that reports the
          // whole-tree spend). `frame.askCost` is the spec-correct, this-ask-only
          // figure used on `ask_end` (decision 10).
          const costBefore = this.budgetContext?.totalCost ?? 0;
          const unpricedCountBefore = this.budgetContext?.unpricedCount ?? 0;
          const resolveCtx = options?.metadata
            ? { metadata: { ...this.metadata, ...options.metadata } }
            : { metadata: this.metadata };

          // Use a mutable container to capture usage from executeAgentCall
          // without relying on an instance property (which is racy under
          // concurrent calls).
          const usageCapture: {
            value?: {
              prompt_tokens: number;
              completion_tokens: number;
              total_tokens: number;
              cached_tokens?: number;
            };
          } = {};

          const doCall = async () => {
            const result = await this.executeAgentCall(
              agent,
              prompt,
              options as AskOptions<unknown>,
              undefined,
              usageCapture,
            );
            return result as T;
          };

          // Spec decision 9 invariant: every `ask_start` has a matching
          // `ask_end`. Implemented via try/finally so ANY exit path —
          // current catches (gate exhaustion, budget, abort) AND any
          // future failure path added between `ask_start` and the
          // success emit — surfaces as `ask_end`. The workflow-level
          // `error` event is reserved for failures with no ask_end
          // available; consumers must never see both for the same failure.
          let outcome: { ok: true; result: T } | { ok: false; error: string } | undefined;
          try {
            const result: T = this.spanManager
              ? await this.spanManager.withSpanAsync(
                  'axl.agent.ask',
                  {
                    'axl.agent.name': agent._name,
                    'axl.agent.model': agent.resolveModel(resolveCtx),
                  },
                  async (span) => {
                    const r = await doCall();
                    const costAfter = this.budgetContext?.totalCost ?? 0;
                    span.setAttribute('axl.agent.cost', costAfter - costBefore);
                    span.setAttribute('axl.agent.duration', Date.now() - askStart);
                    if (usageCapture.value) {
                      span.setAttribute(
                        'axl.agent.prompt_tokens',
                        usageCapture.value.prompt_tokens,
                      );
                      span.setAttribute(
                        'axl.agent.completion_tokens',
                        usageCapture.value.completion_tokens,
                      );
                      if (usageCapture.value.cached_tokens)
                        span.setAttribute(
                          'axl.agent.cached_tokens',
                          usageCapture.value.cached_tokens,
                        );
                    }
                    return r;
                  },
                )
              : await doCall();
            outcome = { ok: true, result };

            // Success path: invoke the legacy onAgentCallComplete hook.
            // Isolate consumer bugs (mirror the onTrace pattern at
            // emitEvent): a hook throw is post-success observability —
            // the agent's run already succeeded, so we must NOT
            // overwrite the outcome to ok:false. Swallow + console.error
            // so reliability dashboards keyed off ask_end.outcome aren't
            // poisoned by hook bugs.
            const costAfter = this.budgetContext?.totalCost ?? 0;
            const unpricedCountAfter = this.budgetContext?.unpricedCount ?? 0;
            if (this.onAgentCallComplete) {
              try {
                this.onAgentCallComplete({
                  agent: agent._name,
                  prompt,
                  response: typeof result === 'string' ? result : JSON.stringify(result),
                  model: agent.resolveModel(resolveCtx),
                  cost: costAfter - costBefore,
                  unpriced: frame.askUnpriced || unpricedCountAfter > unpricedCountBefore,
                  duration: Date.now() - askStart,
                  promptVersion: agent._config.version,
                  temperature: options?.temperature ?? agent._config.temperature,
                  maxTokens: options?.maxTokens ?? agent._config.maxTokens ?? 4096,
                  effort: options?.effort ?? agent._config.effort,
                  thinkingBudget: options?.thinkingBudget ?? agent._config.thinkingBudget,
                  includeThoughts: options?.includeThoughts ?? agent._config.includeThoughts,
                  toolChoice: options?.toolChoice ?? agent._config.toolChoice,
                  stop: options?.stop ?? agent._config.stop,
                  providerOptions: options?.providerOptions ?? agent._config.providerOptions,
                });
              } catch (hookErr) {
                console.error(
                  '[axl] onAgentCallComplete hook threw; ask outcome unchanged:',
                  hookErr instanceof Error ? hookErr.message : String(hookErr),
                );
              }
            }
            return result;
          } catch (err) {
            outcome = {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            };
            throw err;
          } finally {
            // Defensive: `outcome` is always set by either the success
            // or catch branch above. The fallback covers an internal
            // bug (e.g., a future synchronous throw before either
            // branch runs) so we never silently drop the ask_end event.
            //
            // Overflow protection on the error path: under `onOverflow:
            // 'throw'`, this `emitEvent` can throw
            // `EventStreamOverflowError`. If we're already unwinding
            // an in-flight error from the catch branch, letting the
            // overflow propagate would replace it — the user wants to
            // see WHY their ask failed, not that an unrelated event
            // couldn't be queued. Log the overflow so it's still
            // observable; preserve the original error.
            try {
              this.emitEvent({
                type: 'ask_end',
                outcome:
                  outcome ??
                  ({
                    ok: false,
                    error: 'ask_end emitted without outcome — internal bug',
                  } as const),
                cost: frame.askCost.value,
                ...(frame.askUnpriced ? { unpriced: true } : {}),
                duration: Date.now() - askStart,
              });
            } catch (emitErr) {
              if (emitErr instanceof EventStreamOverflowError && outcome && !outcome.ok) {
                console.error(
                  '[axl] ask_end emit overflowed during error path; preserving original error:',
                  emitErr.message,
                );
              } else {
                // Success-path overflow MUST propagate (documented
                // strict-mode policy); non-overflow emit errors
                // (unexpected) shouldn't be silently dropped either.
                // The branch above explicitly protects the
                // in-flight-error case where masking would be wrong;
                // everything else legitimately surfaces from here.
                // eslint-disable-next-line no-unsafe-finally
                throw emitErr;
              }
            }
          }
        });
      },
      { agent: agentName },
    );
  }

  private async executeAgentCall(
    agent: Agent,
    prompt: string,
    options?: AskOptions<unknown>,
    handoffMessages?: ChatMessage[],
    usageCapture?: {
      value?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        cached_tokens?: number;
      };
    },
  ): Promise<unknown> {
    // Budget check
    if (this.budgetContext?.exceeded) {
      const { limit, totalCost: spent, policy } = this.budgetContext;
      if (policy === 'warn') {
        this.emitEvent({
          type: 'log',
          data: { warning: 'Budget exceeded', limit, spent, policy },
        });
      } else if (policy === 'finish_and_stop') {
        throw new BudgetExceededError(limit, spent, policy);
      } else {
        // hard_stop: the AbortController in budget() handles in-flight cancellation.
        // This path is reached on the *next* ctx.ask() call after budget was exceeded.
        throw new BudgetExceededError(limit, spent, policy);
      }
    }

    // Merge workflow metadata with per-call metadata (per-call takes precedence)
    const resolveCtx = options?.metadata
      ? { metadata: { ...this.metadata, ...options.metadata } }
      : { metadata: this.metadata };
    const modelUri = agent.resolveModel(resolveCtx);
    const systemPrompt = agent.resolveSystem(resolveCtx);
    const { provider, model } = this.providerRegistry.resolve(modelUri, this.config);

    // Resolve dynamic handoffs once per call to ensure consistency
    // between tool definitions and handoff lookup within the same turn.
    let resolvedHandoffs:
      | Array<{ agent: Agent; description?: string; mode?: 'oneway' | 'roundtrip' }>
      | undefined;
    if (typeof agent._config.handoffs === 'function') {
      try {
        resolvedHandoffs = agent._config.handoffs(resolveCtx);
      } catch (err) {
        this.log('handoff_resolve_error', {
          agent: agent._name,
          error: err instanceof Error ? err.message : String(err),
        });
        resolvedHandoffs = undefined;
      }
    } else {
      resolvedHandoffs = agent._config.handoffs;
    }

    // Build tool definitions
    const toolDefs = this.buildToolDefs(agent, resolvedHandoffs);

    // Build messages
    const messages: ChatMessage[] = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    // Include session history (with context window management)
    const maxContext = agent._config.maxContext;
    if (maxContext && this.sessionHistory.length > 0) {
      const reserveTokens = this.config.contextManagement?.reserveTokens ?? 2000;
      const systemTokens = systemPrompt ? estimateTokens(systemPrompt) : 0;
      const toolTokens = toolDefs.length > 0 ? estimateTokens(JSON.stringify(toolDefs)) : 0;
      const overhead = systemTokens + toolTokens + reserveTokens;
      const availableForHistory = maxContext - overhead;

      const historyTokens = estimateMessagesTokens(this.sessionHistory);
      if (historyTokens > availableForHistory) {
        // Need to summarize: find the split point
        const summarizedMessages = await this.summarizeHistory(
          provider,
          model,
          this.sessionHistory,
          availableForHistory,
        );
        for (const msg of summarizedMessages) {
          messages.push(msg);
        }
      } else {
        for (const msg of this.sessionHistory) {
          messages.push(msg);
        }
      }
    } else {
      for (const msg of this.sessionHistory) {
        messages.push(msg);
      }
    }

    // Build user prompt. `schemaPrompt` controls the model-facing rendering
    // (spec 22, Problem B); the `.parse` gate downstream is unaffected — the Zod
    // schema still validates the reply whichever rendering is chosen.
    // Precedence: AskOptions > AgentConfig > default ('json-schema').
    const schemaPromptMode: SchemaPromptOption =
      options?.schemaPrompt ?? agent._config.schemaPrompt ?? 'json-schema';
    let userContent = prompt;
    let appendedSchemaText: string | undefined;
    if (options?.schema) {
      const schema = options.schema as z.ZodType;
      if (schemaPromptMode === 'none') {
        // Zero prompt text — the schema is the parse gate only. R7 diagnostic
        // fires from emitSchemaDiagnostics (the model gets no shape guidance).
      } else if (schemaPromptMode === 'json-schema') {
        // Prompt-only rendering: `$ref`-hoisted + compact (see
        // `renderSchemaForPrompt`). This is TEXT the model reads, not a
        // structural schema on the wire, so the Gemini `$ref` cliff does not
        // apply here (it only bites tool-def schemas).
        appendedSchemaText = renderSchemaForPrompt(schema);
        userContent += `\n\nRespond with valid JSON matching this schema:\n${appendedSchemaText}`;
      } else {
        // Custom rendering: append exactly what the author supplies (string or
        // function of the schema). No wrapper phrasing — they own the guidance.
        appendedSchemaText =
          typeof schemaPromptMode.render === 'function'
            ? schemaPromptMode.render(schema)
            : schemaPromptMode.render;
        userContent += `\n\n${appendedSchemaText}`;
      }
    }

    messages.push({ role: 'user', content: userContent });

    // Schema-capability diagnostics (spec 22, Problems B + E). Once per ask — the
    // prompt schema and tool-def schemas are both known here, before the
    // tool-calling turn loop begins.
    this.emitSchemaDiagnostics(agent, options, toolDefs, {
      mode: schemaPromptMode,
      appendedSchemaText,
      provider,
      model,
    });

    // If this agent was reached via handoff, include the source agent's conversation
    if (handoffMessages && handoffMessages.length > 0) {
      // Inject handoff context as a system message summarizing the source agent's work,
      // then append the raw tool-call exchanges so the target agent has full context.
      const handoffContext = handoffMessages.filter(
        (m) => m.role === 'assistant' || m.role === 'tool',
      );
      if (handoffContext.length > 0) {
        messages.push({
          role: 'system',
          content:
            'The following is the conversation history from the previous agent that handed off to you:',
        });
        for (const msg of handoffContext) {
          // Flatten tool messages into user messages to avoid protocol issues
          const content =
            msg.role === 'tool'
              ? `[Tool result for ${msg.tool_call_id}]: ${msg.content}`
              : msg.content;
          // Skip empty content (e.g. assistant messages with only tool calls)
          if (!content) continue;
          messages.push({ role: 'user', content });
        }
      }
    }

    // -- Input guardrail --
    const guardrails = agent._config.guardrails;
    if (guardrails?.input) {
      const inputResult = await guardrails.input(prompt, { metadata: this.metadata });
      this.emitEvent({
        type: 'guardrail',
        agent: agent._name,
        data: {
          guardrailType: 'input',
          blocked: inputResult.block,
          ...(inputResult.reason ? { reason: inputResult.reason } : {}),
          // Input guardrails can't retry (prompt is user-supplied), so attempt
          // and maxAttempts are always 1 — emit them for shape consistency with
          // output guardrails so consumers don't need two narrowers.
          attempt: 1,
          maxAttempts: 1,
        },
      });
      this.spanManager?.addEventToActiveSpan('axl.guardrail.check', {
        'axl.guardrail.type': 'input',
        'axl.guardrail.blocked': inputResult.block,
        'axl.guardrail.attempt': 1,
        'axl.guardrail.maxAttempts': 1,
        ...(inputResult.reason ? { 'axl.guardrail.reason': inputResult.reason } : {}),
      });
      if (inputResult.block) {
        const onBlock = guardrails.onBlock ?? 'throw';
        if (typeof onBlock === 'function') {
          return onBlock(inputResult.reason ?? 'Input blocked by guardrail', {
            metadata: this.metadata,
          });
        }
        // 'retry' behaves as 'throw' for input guardrails (prompt is user-supplied, can't retry)
        throw new GuardrailError('input', inputResult.reason ?? 'Input blocked by guardrail');
      }
    }

    const maxTurns = agent._config.maxTurns ?? 25;
    const timeoutMs = parseDuration(agent._config.timeout ?? '60s');
    const startTime = Date.now();

    // Streaming + validate is supported as of the unified event model
    // (spec §4.1). With pipeline events landing in PR 2, retry boundaries
    // are visible to consumers via `pipeline(status: 'failed' | 'committed')`
    // and `AxlStream.fullText` only commits the winning attempt's tokens.
    // Until pipeline events ship, retried tokens still concatenate; the
    // tradeoff is acceptable because the throw was a worse failure mode
    // (refused to run a valid configuration).

    const currentMessages = [...messages];
    let turns = 0;
    let guardrailOutputRetries = 0;
    let schemaRetries = 0;
    let validateRetries = 0;
    const maxGuardrailRetries = guardrails?.maxRetries ?? 2;
    // Set before `continue`ing to a retry turn; read when emitting the next
    // agent_call so consumers can see *why* a given LLM call is a retry.
    let pendingRetryReason: 'schema' | 'validate' | 'guardrail' | undefined;
    // `trace.level === 'full'` opts into verbose traces: we include the full ChatMessage[]
    // snapshot on each agent_call so the trace explorer can reconstruct exactly what the
    // model saw (growing with tool results + retry feedback across turns).
    const verboseTrace = this.config.trace?.level === 'full';

    // Track the most recent pipeline `start` so the terminal `committed`
    // event can carry the matching stage/attempt/maxAttempts. Spec §4.2.
    let lastStartStage: 'initial' | 'schema' | 'validate' | 'guardrail' = 'initial';
    let lastStartAttempt = 1;
    let lastStartMaxAttempts = 1;

    while (turns < maxTurns) {
      // Timeout check
      if (Date.now() - startTime > timeoutMs) {
        throw new TimeoutError('ctx.ask()', timeoutMs);
      }

      turns++;
      // Emit pipeline `start` only on the FIRST turn of the ask OR when
      // entering a gate-rejection retry. Tool-calling continuations
      // within the same ask do NOT produce additional starts — they're
      // agent-loop iterations, not retry attempts. Spec §4.2 invariant.
      const isFirstTurn = turns === 1;
      const isRetryTurn = pendingRetryReason !== undefined;
      if (isFirstTurn || isRetryTurn) {
        const stage: 'initial' | 'schema' | 'validate' | 'guardrail' =
          pendingRetryReason ?? 'initial';
        let pipelineAttempt = 1;
        let pipelineMaxAttempts = 1;
        if (stage === 'guardrail') {
          pipelineAttempt = guardrailOutputRetries + 1;
          pipelineMaxAttempts = maxGuardrailRetries + 1;
        } else if (stage === 'schema') {
          pipelineAttempt = schemaRetries + 1;
          pipelineMaxAttempts = (options?.retries ?? 3) + 1;
        } else if (stage === 'validate') {
          pipelineAttempt = validateRetries + 1;
          pipelineMaxAttempts = (options?.validateRetries ?? 2) + 1;
        }
        lastStartStage = stage;
        lastStartAttempt = pipelineAttempt;
        lastStartMaxAttempts = pipelineMaxAttempts;
        this.emitEvent({
          type: 'pipeline',
          agent: agent._name,
          status: 'start',
          stage,
          attempt: pipelineAttempt,
          maxAttempts: pipelineMaxAttempts,
        });
      }
      // Per-turn start time for accurate `duration` on each agent_call event.
      // `startTime` above is the start of the entire ask() call; without this,
      // turn N's duration would include all prior turns' latency and gates.
      const turnStart = Date.now();

      const chatOptions: ChatOptions = {
        model,
        temperature: options?.temperature ?? agent._config.temperature,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        maxTokens: options?.maxTokens ?? agent._config.maxTokens ?? 4096,
        effort: options?.effort ?? agent._config.effort,
        thinkingBudget: options?.thinkingBudget ?? agent._config.thinkingBudget,
        includeThoughts: options?.includeThoughts ?? agent._config.includeThoughts,
        toolChoice: options?.toolChoice ?? agent._config.toolChoice,
        stop: options?.stop ?? agent._config.stop,
        providerOptions: options?.providerOptions ?? agent._config.providerOptions,
        signal: this.currentSignal,
      };

      // If schema requested and no tools, use JSON mode. With
      // `nativeStructuredOutput`, derive the provider schema from the SAME Zod
      // schema (never a second, contradictable one) and take the native
      // `json_schema` path; each adapter maps or downgrades it per its
      // capabilities (a `native_output_unsupported` diagnostic already warned if
      // it can't be honored). Otherwise fall back to plain `json_object`.
      if (options?.schema && toolDefs.length === 0) {
        const nativeOut =
          options?.nativeStructuredOutput ?? agent._config.nativeStructuredOutput ?? false;
        chatOptions.responseFormat = nativeOut
          ? {
              type: 'json_schema',
              json_schema: {
                name: 'response',
                // Input-side rendering — see `deriveNativeSchema`. Keeps the
                // native schema consistent with the prompt and non-empty for
                // `.transform()` schemas.
                schema: deriveNativeSchema(options.schema as z.ZodType),
              },
            }
          : { type: 'json_object' };
      }

      const callbackMeta = this.currentCallbackMeta(agent._name);

      // Build the request-side payload BEFORE the call. Everything here is
      // known at dispatch time, so consumers see "what's being asked" the
      // moment the call leaves the runtime — they don't have to wait for a
      // response (or a hung connection) to inspect prompt/system/params.
      const callParams: AgentCallParams = {
        ...(chatOptions.temperature !== undefined ? { temperature: chatOptions.temperature } : {}),
        maxTokens: chatOptions.maxTokens,
        ...(chatOptions.effort !== undefined ? { effort: chatOptions.effort } : {}),
        ...(chatOptions.thinkingBudget !== undefined
          ? { thinkingBudget: chatOptions.thinkingBudget }
          : {}),
        ...(chatOptions.includeThoughts !== undefined
          ? { includeThoughts: chatOptions.includeThoughts }
          : {}),
        ...(chatOptions.toolChoice !== undefined ? { toolChoice: chatOptions.toolChoice } : {}),
        ...(chatOptions.stop !== undefined ? { stop: chatOptions.stop } : {}),
      };

      // Verbose-mode message snapshot — clone defensively so post-call
      // mutations (tool results, retry feedback) don't bleed back into the
      // already-emitted event.
      let messagesSnapshot: ChatMessage[] | undefined;
      if (verboseTrace) {
        try {
          messagesSnapshot = structuredClone(currentMessages);
        } catch (err) {
          console.warn(
            '[axl] verbose trace messages snapshot failed to clone; emitting shallow copy:',
            err instanceof Error ? err.message : String(err),
          );
          messagesSnapshot = [...currentMessages];
        }
      }

      // Capture-and-clear pendingRetryReason BEFORE start so both start and
      // end carry the same retryReason for this turn.
      const retryReason = pendingRetryReason;
      pendingRetryReason = undefined;

      this.emitEvent({
        type: 'agent_call_start',
        agent: agent._name,
        model: modelUri,
        turn: turns,
        data: {
          prompt,
          ...(systemPrompt ? { system: systemPrompt } : {}),
          params: callParams,
          turn: turns,
          ...(retryReason ? { retryReason } : {}),
          ...(toolDefs.length > 0 ? { toolNames: toolDefs.map((t) => t.function.name) } : {}),
          ...(messagesSnapshot ? { messages: messagesSnapshot } : {}),
        },
      });
      this.onAgentStart?.({ agent: agent._name, model: modelUri }, callbackMeta);

      let response: ProviderResponse;

      // Provider call wrapped so any throw still emits a paired
      // `agent_call_end` — consumers (Studio waterfall, cost rollup, AsyncLocalStorage
      // accumulators) rely on the start/end pair invariant. Without this, a
      // provider 5xx or abort leaves an orphan start in the trace and the
      // ask_end / workflow_end terminal events still fire — but downstream
      // groupers never see the close, so per-ask cost rollup and ask-tree
      // reconstruction silently drift. We rethrow after emit so the existing
      // ask-loop error handling (ask_end({ok:false}), MaxTurnsError, etc.) is
      // unchanged.
      try {
        // Activate the streaming code path when ANY observer is interested:
        // - `onToken` is set (legacy callback path; runtime.stream() sets a
        //   sentinel `() => {}` to enable streaming without any consumer)
        // - `ctx.events` has been allocated (a workflow-handler consumer
        //   subscribed via `for await (const p of ctx.events.partialObjects)`
        //   or similar). Without this branch, runtime.execute() would skip
        //   streaming and the partial_object events the customer wanted to
        //   observe would never fire.
        if (this._streamingEnabled) {
          // Use streaming to emit tokens in real-time
          let content = '';
          const toolCalls: ToolCallMessage[] = [];
          const toolCallBuffers = new Map<
            string,
            { id: string; name: string; arguments: string }
          >();
          let streamProviderMetadata: Record<string, unknown> | undefined;

          let thinkingContent = '';

          // Streaming structured-output emission gating (spec/17):
          //   - schema is set
          //   - no tools (JSON-mode response, not tool-calling)
          //   - schema root is a ZodObject (only object roots get partials)
          // When enabled, a `StreamingWalker` is fed each text chunk and
          // emits two AxlEvent variants:
          //   - `string_delta`: per-chunk batches of unescaped chars inside
          //     string values, keyed by JSON Pointer path. For chat-style
          //     typewriter rendering of long string fields.
          //   - `partial_object`: at structural boundaries (`,` / `}` / `]`
          //     outside strings), the accumulated content is re-parsed via
          //     `parsePartialJson` and a snapshot is emitted. Same trigger
          //     as the pre-spec-17 walker; the structural-boundary throttle
          //     avoids parse cost on every char.
          // The walker is re-created per agent-call (per turn). Each
          // streaming response from the provider gets a fresh walker —
          // including across schema retries (which is what we want, since
          // attempt N+1 replays the conversation and re-streams from a
          // clean slate).
          const streamingObjectEnabled =
            !!options?.schema && toolDefs.length === 0 && options.schema instanceof z.ZodObject;
          const currentAttempt = schemaRetries + 1;
          const walker = streamingObjectEnabled
            ? new StreamingWalker({
                onStringDelta: (path, delta) => {
                  this.emitEvent({
                    type: 'string_delta',
                    agent: agent._name,
                    attempt: currentAttempt,
                    data: { path, delta },
                  });
                },
              })
            : undefined;

          for await (const chunk of provider.stream(currentMessages, chatOptions)) {
            if (chunk.type === 'text_delta') {
              content += chunk.content;
              // Emit a `token` AxlEvent so wire consumers (AxlStream) and
              // trace listeners both see it. Stream-only — `runtime.execute`'s
              // onTrace skips persisting tokens to ExecutionInfo.events.
              this.emitEvent({ type: 'token', data: chunk.content });
              // `onToken` is optional — the streaming branch can also be
              // entered solely because `ctx.events` is being observed.
              this.onToken?.(chunk.content, callbackMeta);
              if (walker) {
                // Walker drives both `string_delta` (via the onStringDelta
                // callback above) and structural-boundary detection (via
                // `consumeBoundary()` below). Order within a chunk:
                // string_delta events fire first (from inside processChunk),
                // then partial_object on boundary — so a consumer subscribed
                // to both sees deltas land before the snapshot reflecting
                // them, matching natural read order.
                walker.processChunk(chunk.content);
                if (walker.consumeBoundary()) {
                  let parsed: unknown;
                  try {
                    parsed = parsePartialJson(extractJson(content));
                  } catch {
                    // Mid-document malformed (not just truncation) — skip
                    // this delta. The next structural boundary outside a
                    // string will get another shot once the model writes
                    // valid syntax.
                    parsed = undefined;
                  }
                  if (parsed !== undefined) {
                    this.emitEvent({
                      type: 'partial_object',
                      agent: agent._name,
                      attempt: currentAttempt,
                      data: { object: parsed },
                    });
                  }
                }
              }
            } else if (chunk.type === 'thinking_delta') {
              thinkingContent += chunk.content;
            } else if (chunk.type === 'tool_call_delta') {
              let buffer = toolCallBuffers.get(chunk.id);
              if (!buffer) {
                buffer = { id: chunk.id, name: '', arguments: '' };
                toolCallBuffers.set(chunk.id, buffer);
              }
              if (chunk.name) buffer.name = chunk.name;
              if (chunk.arguments) buffer.arguments += chunk.arguments;
            } else if (chunk.type === 'done') {
              streamProviderMetadata = chunk.providerMetadata;
              // Usage and cost info from done chunk if available
              if (chunk.usage) {
                response = {
                  content,
                  tool_calls: undefined,
                  usage: chunk.usage,
                  cost: chunk.cost,
                };
              }
            }
          }

          // Convert tool call buffers to ToolCallMessage format
          for (const buffer of toolCallBuffers.values()) {
            toolCalls.push({
              id: buffer.id,
              type: 'function',
              function: {
                name: buffer.name,
                arguments: buffer.arguments,
              },
            });
          }

          // Parity with the non-streaming path: only attach usage if the
          // provider actually reported it (via the `done` chunk above). A
          // fabricated zero-usage object would make a no-usage streamed call
          // look like it "did measurable work" and falsely trip the unpriced
          // signal (T2.5) for $0 local providers and usage-omitting gateways.
          response ??= { content };
          if (toolCalls.length > 0) {
            response.tool_calls = toolCalls;
          }
          if (streamProviderMetadata) {
            response.providerMetadata = streamProviderMetadata;
          }
          if (thinkingContent) {
            response.thinking_content = thinkingContent;
          }
        } else {
          response = await provider.chat(currentMessages, chatOptions);
        }
      } catch (err) {
        // Emit the paired `agent_call_end` before rethrowing. Empty response,
        // error message in `data.error`. No usage/cost — provider didn't
        // deliver one. `duration` reflects time-to-failure.
        this.emitEvent({
          type: 'agent_call_end',
          agent: agent._name,
          model: modelUri,
          promptVersion: agent._config.version,
          duration: Date.now() - turnStart,
          data: {
            response: '',
            turn: turns,
            ...(retryReason ? { retryReason } : {}),
            error: err instanceof Error ? err.message : String(err),
            // Enrich with typed-error metadata when available. `body` is
            // deliberately NOT emitted — it's redaction-eligible (see
            // docs/security.md). `data.error` already carries the message.
            ...(err instanceof ProviderError
              ? { status: err.status, retryable: err.retryable }
              : {}),
          },
        });
        throw err;
      }

      // Capture usage for span instrumentation (per-call, not per-instance)
      if (usageCapture && response.usage) {
        usageCapture.value = response.usage;
      }

      // Track cost
      if (response.cost) {
        this._accumulateBudgetCost(response.cost);
      }

      // Snapshot of what we actually sent the provider this turn (excluding the
      // new assistant message that's about to be appended). Consumers can use
      // this to reconstruct the model's exact view on any given turn.
      // structuredClone avoids sharing references with `currentMessages` — later
      // turns mutate pushed-into arrays (e.g. tool_calls), and async consumers
      this.emitEvent({
        type: 'agent_call_end',
        agent: agent._name,
        model: modelUri,
        promptVersion: agent._config.version,
        cost: response.cost,
        tokens: response.usage
          ? {
              input: response.usage.prompt_tokens,
              output: response.usage.completion_tokens,
              reasoning: response.usage.reasoning_tokens,
            }
          : undefined,
        duration: Date.now() - turnStart,
        data: {
          response: response.content,
          ...(response.thinking_content ? { thinking: response.thinking_content } : {}),
          turn: turns,
          ...(retryReason ? { retryReason } : {}),
        },
      });

      // Handle tool calls
      if (response.tool_calls && response.tool_calls.length > 0) {
        currentMessages.push({
          role: 'assistant',
          content: response.content || '',
          tool_calls: response.tool_calls,
          ...(response.providerMetadata ? { providerMetadata: response.providerMetadata } : {}),
        });

        for (const toolCall of response.tool_calls) {
          const toolName = toolCall.function.name;

          // Check for handoff
          if (toolName.startsWith('handoff_to_')) {
            const targetName = toolName.replace('handoff_to_', '');
            const descriptor = resolvedHandoffs?.find((h) => h.agent._name === targetName);
            if (descriptor) {
              const mode = descriptor.mode ?? 'oneway';

              // For roundtrip, parse the message parameter from tool call args
              let handoffPrompt = prompt;
              if (mode === 'roundtrip') {
                try {
                  const args = JSON.parse(toolCall.function.arguments);
                  if (args.message) handoffPrompt = args.message;
                } catch {
                  // Fall back to original prompt if args can't be parsed
                }
              }

              const handoffStart = Date.now();
              // Capture the source ask's frame for handoff correlation.
              // Review B-7 / B-8: we now allocate a REAL ask frame for
              // the target and run its executeAgentCall under
              // `askStorage.run(targetFrame, …)` so events emitted from
              // the target's tool-calling loop carry the proper
              // `askId: handoffToAskId` + `parentAskId: handoffFromAskId`.
              // Previously `toAskId` was a synthesized UUID with no
              // matching frame, so consumers grouping by `askId` saw
              // the handoff row as an orphan.
              const sourceFrame = askStorage.getStore();
              const handoffFromAskId = sourceFrame?.askId ?? this.executionId;
              const handoffSourceDepth = sourceFrame?.depth ?? 0;
              const handoffToAskId = randomUUID();
              const handoffTargetDepth = handoffSourceDepth + 1;
              const targetFrame: AskFrame = {
                askId: handoffToAskId,
                parentAskId: handoffFromAskId,
                depth: handoffTargetDepth,
                agent: descriptor.agent._name,
                stepRef: sourceFrame?.stepRef ?? this.stepRefRoot,
                askCost: { value: 0 },
                askUnpriced: false,
              };

              // Pass accumulated messages so the target agent can see the source agent's work.
              // Forward schema/retries/validate/metadata — the target agent uses its own model params.
              // schemaPrompt/nativeStructuredOutput must travel too: on the
              // multi-candidate `delegate` path the handoff TARGET (not the
              // router) produces the structured reply, so these controls only
              // take effect if forwarded here (spec 22 R11).
              const handoffOptions = options
                ? {
                    schema: options.schema,
                    schemaPrompt: options.schemaPrompt,
                    nativeStructuredOutput: options.nativeStructuredOutput,
                    retries: options.retries,
                    metadata: options.metadata,
                    validate: options.validate,
                    validateRetries: options.validateRetries,
                  }
                : undefined;
              // Execute the target's ask frame. Wraps `executeAgentCall`
              // in ask_start/ask_end so the target has the same event
              // shape as a regular `ctx.ask()` call — consumers grouping
              // by askId can resolve the target agent via its ask_start,
              // and the tree view's per-ask summary (duration, cost,
              // outcome) works uniformly for direct and handoff asks.
              const handoffFn = () =>
                askStorage.run(targetFrame, async () => {
                  this.emitEvent({ type: 'ask_start', prompt: handoffPrompt });
                  const targetAskStart = Date.now();
                  try {
                    const result = await this.executeAgentCall(
                      descriptor.agent,
                      handoffPrompt,
                      handoffOptions,
                      currentMessages,
                      usageCapture,
                    );
                    this.emitEvent({
                      type: 'ask_end',
                      outcome: { ok: true, result },
                      cost: targetFrame.askCost.value,
                      ...(targetFrame.askUnpriced ? { unpriced: true } : {}),
                      duration: Date.now() - targetAskStart,
                    });
                    return result;
                  } catch (err) {
                    this.emitEvent({
                      type: 'ask_end',
                      outcome: {
                        ok: false,
                        error: err instanceof Error ? err.message : String(err),
                      },
                      cost: targetFrame.askCost.value,
                      ...(targetFrame.askUnpriced ? { unpriced: true } : {}),
                      duration: Date.now() - targetAskStart,
                    });
                    throw err;
                  }
                });

              // Emit handoff_start BEFORE the target ask begins so it
              // orders correctly in step-sorted timelines (ahead of the
              // target's ask_start / agent_call_* events). Always fired
              // regardless of mode — this event represents the transition.
              this.emitEvent({
                type: 'handoff_start',
                agent: agent._name,
                fromAskId: handoffFromAskId,
                toAskId: handoffToAskId,
                sourceDepth: handoffSourceDepth,
                targetDepth: handoffTargetDepth,
                data: {
                  source: agent._name,
                  target: targetName,
                  mode,
                  ...(mode === 'roundtrip' && handoffPrompt !== prompt
                    ? { message: handoffPrompt }
                    : {}),
                },
              });

              if (mode === 'roundtrip') {
                // Roundtrip: execute target, feed result back to source as tool response,
                // then emit `handoff_return` to mark control returning to source.
                // The target's return value is observable on its `ask_end.outcome`.
                const executeRoundtrip = async (): Promise<unknown> => {
                  const result = await handoffFn();
                  const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
                  currentMessages.push({
                    role: 'tool',
                    content: resultStr,
                    tool_call_id: toolCall.id,
                  });
                  return result;
                };

                // `handoff_return` always emits — success OR failure. If the
                // target throws, control still returns to source (via the
                // exception path); without the event the timeline shows a
                // `handoff_start` with no completion. Try/finally re-throws
                // any error so the source's loop sees the failure.
                if (this.spanManager) {
                  await this.spanManager.withSpanAsync(
                    'axl.agent.handoff',
                    {
                      'axl.handoff.source': agent._name,
                      'axl.handoff.target': targetName,
                      'axl.handoff.mode': mode,
                    },
                    async (span) => {
                      try {
                        return await executeRoundtrip();
                      } finally {
                        const duration = Date.now() - handoffStart;
                        span.setAttribute('axl.handoff.duration', duration);
                        this.emitEvent({
                          type: 'handoff_return',
                          agent: agent._name,
                          fromAskId: handoffFromAskId,
                          toAskId: handoffToAskId,
                          sourceDepth: handoffSourceDepth,
                          targetDepth: handoffTargetDepth,
                          data: { source: agent._name, target: targetName, duration },
                        });
                      }
                    },
                  );
                } else {
                  try {
                    await executeRoundtrip();
                  } finally {
                    this.emitEvent({
                      type: 'handoff_return',
                      agent: agent._name,
                      fromAskId: handoffFromAskId,
                      toAskId: handoffToAskId,
                      sourceDepth: handoffSourceDepth,
                      targetDepth: handoffTargetDepth,
                      data: {
                        source: agent._name,
                        target: targetName,
                        duration: Date.now() - handoffStart,
                      },
                    });
                  }
                }
                continue; // Source agent loop continues
              }

              // Oneway (default): return target's result, exiting source's loop.
              // No `handoff_return` event — control doesn't come back to source.
              // The target's `ask_end` already marks the end of this chain.
              if (this.spanManager) {
                return this.spanManager.withSpanAsync(
                  'axl.agent.handoff',
                  {
                    'axl.handoff.source': agent._name,
                    'axl.handoff.target': targetName,
                    'axl.handoff.mode': mode,
                  },
                  async (span) => {
                    const result = await handoffFn();
                    span.setAttribute('axl.handoff.duration', Date.now() - handoffStart);
                    return result;
                  },
                );
              }
              return await handoffFn();
            }
          }

          // Check toolOverrides first (for mock tool interception)
          const toolOverride = this.toolOverrides?.get(toolName);
          if (toolOverride) {
            let toolArgs: unknown;
            try {
              toolArgs = JSON.parse(toolCall.function.arguments);
            } catch {
              currentMessages.push({
                role: 'tool',
                content: `Error: Invalid JSON in tool arguments. Please provide valid JSON.`,
                tool_call_id: toolCall.id,
              });
              continue;
            }
            this.emitEvent({
              type: 'tool_call_start',
              tool: toolName,
              callId: toolCall.id,
              data: { args: toolArgs },
            });
            this.onToolCall?.(
              { name: toolName, args: toolArgs, callId: toolCall.id },
              callbackMeta,
            );
            const toolStart = Date.now();

            const executeOverride = async () => {
              let toolResult: unknown;
              try {
                toolResult = await toolOverride(toolArgs);
              } catch (err) {
                toolResult = { error: err instanceof Error ? err.message : String(err) };
              }
              return toolResult;
            };

            const toolResult = this.spanManager
              ? await this.spanManager.withSpanAsync(
                  'axl.tool.call',
                  {
                    'axl.tool.name': toolName,
                    'axl.agent.name': agent._name,
                  },
                  async (span) => {
                    const r = await executeOverride();
                    span.setAttribute('axl.tool.duration', Date.now() - toolStart);
                    const isError =
                      r && typeof r === 'object' && 'error' in (r as Record<string, unknown>);
                    span.setAttribute('axl.tool.success', !isError);
                    if (isError)
                      span.setStatus('error', (r as Record<string, unknown>).error as string);
                    return r;
                  },
                )
              : await executeOverride();

            const resultContent = JSON.stringify(toolResult);
            this.emitEvent({
              type: 'tool_call_end',
              agent: agent._name,
              tool: toolName,
              duration: Date.now() - toolStart,
              data: { args: toolArgs, result: toolResult, callId: toolCall.id },
            });
            currentMessages.push({
              role: 'tool',
              content: resultContent,
              tool_call_id: toolCall.id,
            });
            continue;
          }

          // Find the tool (check local tools first, then MCP tools)
          const tool = agent._config.tools?.find((t) => t.name === toolName);
          const isMcpTool = !tool && this.mcpManager?.isMcpTool(toolName);

          if (!tool && !isMcpTool) {
            // Tool denied
            this.emitEvent({ type: 'tool_denied', agent: agent._name, tool: toolName });
            currentMessages.push({
              role: 'tool',
              content: `Tool "${toolName}" is not available. Available tools: ${agent._config.tools?.map((t) => t.name).join(', ') ?? 'none'}`,
              tool_call_id: toolCall.id,
            });
            continue;
          }

          // Parse tool arguments
          let toolArgs: unknown;
          try {
            toolArgs = JSON.parse(toolCall.function.arguments);
          } catch {
            currentMessages.push({
              role: 'tool',
              content: `Error: Invalid JSON in tool arguments. Please provide valid JSON.`,
              tool_call_id: toolCall.id,
            });
            continue;
          }

          this.emitEvent({
            type: 'tool_call_start',
            tool: toolName,
            callId: toolCall.id,
            data: { args: toolArgs },
          });
          this.onToolCall?.({ name: toolName, args: toolArgs, callId: toolCall.id }, callbackMeta);

          const toolStart = Date.now();

          // Approval gate: if tool requires approval, ask the human first.
          // Note: MCP tools have no `tool` object here (isMcpTool is true instead),
          // so they bypass the approval gate entirely. This is intentional — MCP tools
          // are externally managed and don't carry requireApproval config.
          if (tool && tool.requireApproval) {
            const approvalFn = async (): Promise<{ approved: boolean; reason?: string }> => {
              const decision = await this.awaitHuman({
                channel: 'tool_approval',
                prompt: `Tool "${toolName}" wants to execute with args: ${JSON.stringify(toolArgs)}`,
                metadata: { toolName, args: toolArgs, agent: agent._name },
              });
              if (!decision.approved) {
                const reason = decision.reason ?? 'Denied by human';
                currentMessages.push({
                  role: 'tool',
                  content: JSON.stringify({ error: `Tool denied by human: ${reason}` }),
                  tool_call_id: toolCall.id,
                });
                return { approved: false, reason };
              }
              return { approved: true };
            };

            let approvalOutcome: { approved: boolean; reason?: string };
            if (this.spanManager) {
              approvalOutcome = await this.spanManager.withSpanAsync(
                'axl.tool.approval',
                {
                  'axl.tool.name': toolName,
                  'axl.agent.name': agent._name,
                },
                async (span) => {
                  const result = await approvalFn();
                  span.setAttribute('axl.tool.approval.approved', result.approved);
                  return result;
                },
              );
            } else {
              approvalOutcome = await approvalFn();
            }

            this.emitEvent({
              type: 'tool_approval',
              agent: agent._name,
              tool: toolName,
              data: {
                approved: approvalOutcome.approved,
                args: toolArgs,
                ...(approvalOutcome.reason ? { reason: approvalOutcome.reason } : {}),
              },
            });

            if (!approvalOutcome.approved) continue;
          }

          // Before hook: transform input before execution
          if (tool && tool.hooks?.before) {
            try {
              toolArgs = await tool.hooks.before(toolArgs, this);
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              currentMessages.push({
                role: 'tool',
                content: JSON.stringify({ error: `Before hook error: ${errorMsg}` }),
                tool_call_id: toolCall.id,
              });
              continue;
            }
          }

          const executeTool = async (): Promise<{ toolResult: unknown; resultContent: string }> => {
            let toolResult: unknown;
            let resultContent: string;

            if (isMcpTool && this.mcpManager) {
              // Execute MCP tool
              try {
                const mcpResult = await this.mcpManager.callTool(toolName, toolArgs);
                toolResult = mcpResult;
                // Extract text content from MCP result
                resultContent = mcpResult.content
                  .map((c: { type: string; text?: string }) =>
                    c.type === 'text' ? c.text : `[${c.type}]`,
                  )
                  .join('\n');
                if (mcpResult.isError) {
                  resultContent = `Error: ${resultContent}`;
                }
              } catch (err) {
                toolResult = { error: err instanceof Error ? err.message : String(err) };
                resultContent = JSON.stringify(toolResult);
              }
            } else if (tool) {
              // Execute local tool with a child context for nested agent
              // invocations (agent-as-tool pattern). Nested events are
              // correlated to the outer ask via `parentAskId` from the
              // ALS frame, so the child context doesn't need to thread
              // anything explicitly.
              const childCtx = this.createChildContext();
              try {
                toolResult = await tool._execute(toolArgs, childCtx);
              } catch (err) {
                toolResult = { error: err instanceof Error ? err.message : String(err) };
              }

              // After hook: transform output after execution (only on success)
              if (
                tool.hooks?.after &&
                !(
                  toolResult &&
                  typeof toolResult === 'object' &&
                  'error' in (toolResult as Record<string, unknown>)
                )
              ) {
                try {
                  toolResult = await tool.hooks.after(toolResult, this);
                } catch (err) {
                  toolResult = {
                    error: `After hook error: ${err instanceof Error ? err.message : String(err)}`,
                  };
                }
              }

              // Redact sensitive tool results
              resultContent = tool.sensitive
                ? '[REDACTED - sensitive tool output]'
                : JSON.stringify(toolResult);
            } else {
              toolResult = undefined;
              resultContent = 'Tool execution error';
            }

            return { toolResult, resultContent };
          };

          // Use qualified "server:tool_name" for MCP tools in traces
          const traceName =
            isMcpTool && this.mcpManager
              ? (this.mcpManager.getQualifiedName(toolName) ?? toolName)
              : toolName;

          const { toolResult, resultContent } = this.spanManager
            ? await this.spanManager.withSpanAsync(
                'axl.tool.call',
                {
                  'axl.tool.name': traceName,
                  'axl.agent.name': agent._name,
                },
                async (span) => {
                  const r = await executeTool();
                  span.setAttribute('axl.tool.duration', Date.now() - toolStart);
                  const isError =
                    r.toolResult &&
                    typeof r.toolResult === 'object' &&
                    'error' in (r.toolResult as Record<string, unknown>);
                  span.setAttribute('axl.tool.success', !isError);
                  if (isError)
                    span.setStatus(
                      'error',
                      (r.toolResult as Record<string, unknown>).error as string,
                    );
                  return r;
                },
              )
            : await executeTool();

          this.emitEvent({
            type: 'tool_call_end',
            agent: agent._name,
            tool: traceName,
            duration: Date.now() - toolStart,
            data: { args: toolArgs, result: toolResult, callId: toolCall.id },
          });

          currentMessages.push({
            role: 'tool',
            content: resultContent,
            tool_call_id: toolCall.id,
          });
        }

        continue; // Next turn
      }

      // No tool calls — we have the final response
      const content = response.content;

      // -- Gate 1: Output guardrail (raw text — content safety) --
      if (guardrails?.output) {
        const outputResult = await guardrails.output(content, { metadata: this.metadata });

        // Compute retry intent *before* emitting the trace so the feedback message
        // the LLM will see on its next attempt is visible in the same event.
        const attempt = guardrailOutputRetries + 1;
        const maxAttempts = maxGuardrailRetries + 1;
        const onBlock = guardrails.onBlock ?? 'throw';
        let feedbackMessage: string | undefined;
        if (
          outputResult.block &&
          onBlock === 'retry' &&
          guardrailOutputRetries < maxGuardrailRetries
        ) {
          feedbackMessage = `Your previous response was blocked by a safety guardrail: ${outputResult.reason ?? 'Output blocked'}. Please provide a different response that complies with the guidelines.`;
        }

        this.emitEvent({
          type: 'guardrail',
          agent: agent._name,
          data: {
            guardrailType: 'output',
            blocked: outputResult.block,
            ...(outputResult.reason ? { reason: outputResult.reason } : {}),
            attempt,
            maxAttempts,
            ...(feedbackMessage ? { feedbackMessage } : {}),
          },
        });
        this.spanManager?.addEventToActiveSpan('axl.guardrail.check', {
          'axl.guardrail.type': 'output',
          'axl.guardrail.blocked': outputResult.block,
          'axl.guardrail.attempt': attempt,
          'axl.guardrail.maxAttempts': maxAttempts,
          ...(outputResult.reason ? { 'axl.guardrail.reason': outputResult.reason } : {}),
        });

        if (outputResult.block) {
          if (feedbackMessage) {
            this.emitEvent({
              type: 'pipeline',
              agent: agent._name,
              status: 'failed',
              stage: 'guardrail',
              attempt: guardrailOutputRetries + 1,
              maxAttempts: maxGuardrailRetries + 1,
              reason: feedbackMessage,
            });
            guardrailOutputRetries++;
            appendRetryMessages(
              currentMessages,
              content,
              feedbackMessage,
              response.providerMetadata,
            );
            pendingRetryReason = 'guardrail';
            continue; // Re-enter the while loop for another LLM turn
          }
          if (typeof onBlock === 'function') {
            return onBlock(outputResult.reason ?? 'Output blocked by guardrail', {
              metadata: this.metadata,
            });
          }
          throw new GuardrailError('output', outputResult.reason ?? 'Output blocked by guardrail');
        }
      }

      // -- Gate 2: Schema validation (parse + Zod) --
      let validated: unknown = undefined;
      if (options?.schema) {
        const maxSchemaRetries = options.retries ?? 3;
        const schemaAttempt = schemaRetries + 1;
        const schemaMaxAttempts = maxSchemaRetries + 1;
        let schemaValid = false;
        let schemaReason: string | undefined;
        let schemaFeedback: string | undefined;
        let schemaErr: unknown;
        try {
          const parsed = JSON.parse(extractJson(content));
          validated = (options.schema as z.ZodType).parse(parsed);
          schemaValid = true;
        } catch (err) {
          schemaErr = err;
          schemaReason = err instanceof Error ? err.message : String(err);
          if (schemaRetries < maxSchemaRetries) {
            schemaFeedback = `Your response was not valid JSON or did not match the required schema: ${schemaReason}. Please fix and try again.`;
          }
        }

        this.emitEvent({
          type: 'schema_check',
          agent: agent._name,
          data: {
            valid: schemaValid,
            ...(schemaReason ? { reason: schemaReason } : {}),
            attempt: schemaAttempt,
            maxAttempts: schemaMaxAttempts,
            ...(schemaFeedback ? { feedbackMessage: schemaFeedback } : {}),
          },
        });
        this.spanManager?.addEventToActiveSpan('axl.schema.check', {
          'axl.schema.valid': schemaValid,
          'axl.schema.attempt': schemaAttempt,
          'axl.schema.maxAttempts': schemaMaxAttempts,
          ...(schemaReason ? { 'axl.schema.reason': schemaReason } : {}),
        });

        if (!schemaValid) {
          if (schemaFeedback) {
            this.emitEvent({
              type: 'pipeline',
              agent: agent._name,
              status: 'failed',
              stage: 'schema',
              attempt: schemaRetries + 1,
              maxAttempts: (options.retries ?? 3) + 1,
              reason: schemaFeedback,
            });
            schemaRetries++;
            appendRetryMessages(
              currentMessages,
              content,
              schemaFeedback,
              response.providerMetadata,
            );
            pendingRetryReason = 'schema';
            continue; // Re-enter the while loop for another LLM turn
          }
          const zodErr =
            schemaErr instanceof ZodError
              ? schemaErr
              : new ZodError([
                  {
                    code: 'custom',
                    path: [],
                    message: schemaReason ?? 'Schema parse failed',
                  },
                ]);
          throw new VerifyError(content, zodErr, maxSchemaRetries);
        }
      }

      // -- Gate 3: Business rule validation (typed object) --
      // Only runs when both a schema and validate function are provided.
      // Without a schema, use output guardrails for raw text validation instead.
      if (options?.schema && options.validate) {
        // Wrap user-supplied validator in try/catch — treat exceptions as validation failures
        // so they get the same retry semantics instead of crashing the pipeline.
        let validateResult: ValidateResult;
        try {
          validateResult = await options.validate(validated, {
            metadata: this.metadata,
          });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          validateResult = { valid: false, reason: `Validator error: ${reason}` };
        }

        const maxValidateRetries = options.validateRetries ?? 2;
        const validateAttempt = validateRetries + 1;
        const validateMaxAttempts = maxValidateRetries + 1;
        let validateFeedback: string | undefined;
        if (!validateResult.valid && validateRetries < maxValidateRetries) {
          validateFeedback = `Your response parsed correctly but failed validation: ${validateResult.reason ?? 'Validation failed'}. Previous attempts are visible above. Please fix and try again.`;
        }

        this.emitEvent({
          type: 'validate',
          agent: agent._name,
          data: {
            valid: validateResult.valid,
            ...(validateResult.reason ? { reason: validateResult.reason } : {}),
            attempt: validateAttempt,
            maxAttempts: validateMaxAttempts,
            ...(validateFeedback ? { feedbackMessage: validateFeedback } : {}),
          },
        });
        this.spanManager?.addEventToActiveSpan('axl.validate.check', {
          'axl.validate.valid': validateResult.valid,
          'axl.validate.attempt': validateAttempt,
          'axl.validate.maxAttempts': validateMaxAttempts,
          ...(validateResult.reason ? { 'axl.validate.reason': validateResult.reason } : {}),
        });

        if (!validateResult.valid) {
          if (validateFeedback) {
            this.emitEvent({
              type: 'pipeline',
              agent: agent._name,
              status: 'failed',
              stage: 'validate',
              attempt: validateRetries + 1,
              maxAttempts: (options.validateRetries ?? 2) + 1,
              reason: validateFeedback,
            });
            validateRetries++;
            appendRetryMessages(
              currentMessages,
              content,
              validateFeedback,
              response.providerMetadata,
            );
            pendingRetryReason = 'validate';
            continue; // Re-enter the while loop — goes through all gates again
          }
          throw new ValidationError(
            validated,
            validateResult.reason ?? 'Validation failed',
            maxValidateRetries,
          );
        }
      }

      // All gates passed — emit pipeline `committed`, push to session
      // history, and return. Spec §4.2: terminal pipeline event for this
      // ask, fires before `done`.
      this.emitEvent({
        type: 'pipeline',
        agent: agent._name,
        status: 'committed',
        stage: lastStartStage,
        attempt: lastStartAttempt,
        maxAttempts: lastStartMaxAttempts,
      });
      this.pushAssistantToSessionHistory(content, agent._name, response.providerMetadata);
      return validated ?? content;
    }

    throw new MaxTurnsError('ctx.ask()', maxTurns);
  }

  /**
   * Push the final assistant message into session history, preserving providerMetadata
   * (e.g., Gemini thought signatures needed for multi-turn reasoning context) and
   * stamping the agent name for observability + future per-agent scoping.
   */
  private pushAssistantToSessionHistory(
    content: string,
    agentName: string,
    providerMetadata?: Record<string, unknown>,
  ): void {
    this.sessionHistory.push({
      role: 'assistant',
      content,
      agent: agentName,
      ...(providerMetadata ? { providerMetadata } : {}),
    });
  }

  /**
   * Emit `schema_diagnostic` events for the silent structured-output cliffs
   * (spec 22, Problems B + E). Called once per ask. Covers:
   *  - the appended **prompt** schema (oversized; dropped refinements; or the
   *    zero-guidance `schemaPrompt:'none'` footgun),
   *  - each user **tool-def** schema (oversized, dropped refinements),
   *  - the **streaming** gate (disabled by a non-object root or by tools),
   *  - **native structured output** the resolved provider can't honor (R10).
   *
   * The structured event always fires (persisted + streamed). For the genuinely
   * surprising, low-frequency cliffs it ALSO fires a one-time deduped
   * `console.warn` so the median consumer — who never wires up `ctx.events` and
   * runs with the trace console off — still sees it. `oversized` is event-only
   * (O3: it's tunable/noisy); the `tools` streaming cause is event-only too
   * (expected behavior for any tool-using agent, not a surprise).
   */
  private emitSchemaDiagnostics(
    agent: Agent,
    options: AskOptions<unknown> | undefined,
    toolDefs: ToolDefinition[],
    ctx: {
      mode: SchemaPromptOption;
      /** The text actually appended to the prompt (`undefined` for `'none'`). */
      appendedSchemaText: string | undefined;
      provider: Provider;
      model: string;
    },
  ): void {
    const silent = this.config.diagnostics?.silent;
    const threshold =
      this.config.diagnostics?.schemaOversizedTokens ?? DEFAULT_SCHEMA_OVERSIZED_TOKENS;
    const schema = options?.schema as z.ZodType | undefined;

    // ── Prompt schema ──────────────────────────────────────────────────────
    if (schema) {
      if (ctx.mode === 'none') {
        // Zero model-facing guidance (R7) — the schema is the parse gate only,
        // so the model is likely to loop on parse failures. This is the surprise;
        // warn once. Skip oversized/dropped-refinement (nothing was appended).
        this.emitEvent({
          type: 'schema_diagnostic',
          agent: agent._name,
          data: { kind: 'schema_prompt_none_no_guidance' },
        });
        warnSchemaDiagnosticOnce(
          `${agent._name}\0schema_prompt_none`,
          `schemaPrompt:'none' is set on agent '${agent._name}' with an output schema and no ` +
            `custom guidance — the model receives zero shape hints while the reply is still ` +
            `parsed against the schema, which invites a parse-failure retry loop. Provide a ` +
            `custom { render } or drop 'none'.`,
          silent,
        );
      } else {
        // 'json-schema' or custom { render }: the appended text is a recurring
        // input cost — check its size. (For custom text, we measure exactly what
        // the author appended.)
        const promptTokens = estimateTokens(ctx.appendedSchemaText ?? '');
        if (promptTokens > threshold) {
          this.emitEvent({
            type: 'schema_diagnostic',
            agent: agent._name,
            data: {
              kind: 'prompt_schema_oversized',
              estimatedTokens: promptTokens,
              threshold,
              site: 'prompt',
            },
          });
        }

        // Dropped refinements are only meaningful for the DEFAULT rendering,
        // which provably omits them. With a custom renderer the author owns the
        // guidance text (they may well describe the rule), so we don't claim it.
        if (ctx.mode === 'json-schema') {
          const dropped = detectDroppedRefinements(schema);
          if (dropped.count > 0) {
            this.emitEvent({
              type: 'schema_diagnostic',
              agent: agent._name,
              data: {
                kind: 'dropped_refinements',
                count: dropped.count,
                paths: dropped.paths,
                site: 'prompt',
              },
            });
            warnSchemaDiagnosticOnce(
              `${agent._name}\0dropped_refinements\0prompt\0${dropped.count}\0${dropped.paths.join(',')}`,
              `${dropped.count} refinement(s) on the output schema for agent '${agent._name}' ` +
                `(at ${dropped.paths.join(', ')}) are dropped from the model-facing JSON Schema — ` +
                `the model is never told the rule, then parsing rejects it. Surface it in the prompt ` +
                `(schemaPrompt) or repair with ctx.verify.`,
              silent,
            );
          }
        }
      }

      // ── Native structured output the provider can't honor (R10) ────────────
      const nativeOut = options?.nativeStructuredOutput ?? agent._config.nativeStructuredOutput;
      if (nativeOut && toolDefs.length === 0) {
        const support = ctx.provider.nativeStructuredOutputSupport?.(ctx.model) ?? 'schema';
        if (support !== 'schema') {
          this.emitEvent({
            type: 'schema_diagnostic',
            agent: agent._name,
            data: {
              kind: 'native_output_unsupported',
              ...(ctx.provider.name ? { provider: ctx.provider.name } : {}),
              support,
            },
          });
          warnSchemaDiagnosticOnce(
            `${agent._name}\0native_output_unsupported\0${ctx.provider.name ?? ctx.model}`,
            `nativeStructuredOutput is set on agent '${agent._name}' but provider ` +
              `'${ctx.provider.name ?? ctx.model}' ${support === 'downgraded' ? 'downgrades it to plain JSON mode' : support === 'lossy' ? 'sanitizes the schema lossily' : 'ignores it structurally'} — ` +
              `the schema shape is not natively enforced. The prompt text remains the parse ` +
              `contract; the call proceeds.`,
            silent,
          );
        }
      }

      // ── Streaming gate — mirrors the gate at the stream site: progressive
      //    `partial_object` requires a `ZodObject` root and no tools. Only
      //    surface it when streaming is actually active (an observer is
      //    present); telling a non-streaming caller that streaming is "disabled"
      //    is pure noise and would fire on every plain `execute()`. This is
      //    exactly J5's situation (they subscribe to `ctx.events`/`AxlStream`). ─
      const rootIsObject = schema instanceof z.ZodObject;
      const hasTools = toolDefs.length > 0;
      if (this._streamingEnabled && (!rootIsObject || hasTools)) {
        // Prefer the more actionable cause when both hold: a non-object root is
        // the surprising one J5 hits (`z.discriminatedUnion` looks streamable);
        // `tools` is expected. Only the non-object cause earns a console.warn.
        const cause: 'non-object' | 'tools' = !rootIsObject ? 'non-object' : 'tools';
        const rootType = schema.constructor?.name ?? 'unknown';
        this.emitEvent({
          type: 'schema_diagnostic',
          agent: agent._name,
          data: { kind: 'streaming_disabled', rootType, cause },
        });
        if (cause === 'non-object') {
          warnSchemaDiagnosticOnce(
            `${agent._name}\0streaming_disabled\0${rootType}`,
            `Progressive object streaming is disabled for agent '${agent._name}' because the ` +
              `output schema root is ${rootType}, not a ZodObject. Wrap it — ` +
              `z.object({ result: <yourSchema> }) — to re-enable partial_object streaming.`,
            silent,
          );
        }
      }
    }

    // ── Tool-def schemas ───────────────────────────────────────────────────
    for (const tool of agent._config.tools ?? []) {
      const toolTokens = estimateInlineSchemaTokens(tool.inputSchema);
      if (toolTokens > threshold) {
        this.emitEvent({
          type: 'schema_diagnostic',
          agent: agent._name,
          data: {
            kind: 'prompt_schema_oversized',
            estimatedTokens: toolTokens,
            threshold,
            site: 'tool',
            tool: tool.name,
          },
        });
      }

      const droppedTool = detectDroppedRefinements(tool.inputSchema);
      if (droppedTool.count > 0) {
        this.emitEvent({
          type: 'schema_diagnostic',
          agent: agent._name,
          data: {
            kind: 'dropped_refinements',
            count: droppedTool.count,
            paths: droppedTool.paths,
            site: 'tool',
            tool: tool.name,
          },
        });
        warnSchemaDiagnosticOnce(
          `${agent._name}\0dropped_refinements\0tool\0${tool.name}\0${droppedTool.count}`,
          `${droppedTool.count} refinement(s) on tool '${tool.name}' input schema ` +
            `(at ${droppedTool.paths.join(', ')}) are dropped from the tool definition — the ` +
            `model is never told the constraint. Validate inside the tool handler instead.`,
          silent,
        );
      }
    }
  }

  private buildToolDefs(
    agent: Agent,
    resolvedHandoffs?: Array<{ agent: Agent; description?: string; mode?: 'oneway' | 'roundtrip' }>,
  ): ToolDefinition[] {
    const defs: ToolDefinition[] = [];

    if (agent._config.tools) {
      for (const tool of agent._config.tools) {
        defs.push({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: zodToJsonSchema(tool.inputSchema),
          },
        });
      }
    }

    // Add handoff tools (already resolved by caller)
    if (resolvedHandoffs) {
      for (const { agent: handoffAgent, description, mode } of resolvedHandoffs) {
        const isRoundtrip = mode === 'roundtrip';
        const defaultDesc = isRoundtrip
          ? `Delegate a task to ${handoffAgent._name} and receive the result back`
          : `Hand off the conversation to ${handoffAgent._name}`;
        defs.push({
          type: 'function',
          function: {
            name: `handoff_to_${handoffAgent._name}`,
            description: description ?? defaultDesc,
            parameters: isRoundtrip
              ? {
                  type: 'object',
                  properties: { message: { type: 'string', description: 'The task to delegate' } },
                  required: ['message'],
                }
              : { type: 'object', properties: {} },
          },
        });
      }
    }

    // Add MCP tools
    if (this.mcpManager) {
      const mcpDefs = this.mcpManager.getToolDefinitions(agent._config.mcp, agent._config.mcpTools);
      defs.push(...mcpDefs);
    }

    return defs;
  }

  /**
   * Summarize old messages to fit within context window.
   * Keeps recent messages intact, summarizes older ones.
   */
  private async summarizeHistory(
    provider: Provider,
    model: string,
    history: ChatMessage[],
    availableTokens: number,
  ): Promise<ChatMessage[]> {
    // If we have a cached summary and the history hasn't grown much, reuse it
    if (this.summaryCache) {
      const summaryMsg: ChatMessage = {
        role: 'system',
        content: `Summary of earlier conversation:\n${this.summaryCache}`,
      };
      const summaryTokens = estimateTokens(summaryMsg.content) + 4;
      const remaining = availableTokens - summaryTokens;

      // Find how many recent messages fit
      let recentTokens = 0;
      let splitIdx = history.length;
      for (let i = history.length - 1; i >= 0; i--) {
        const msgTokens = estimateTokens(history[i].content) + 4;
        if (recentTokens + msgTokens > remaining) break;
        recentTokens += msgTokens;
        splitIdx = i;
      }

      if (splitIdx < history.length) {
        return [summaryMsg, ...history.slice(splitIdx)];
      }
    }

    // No cache or cache insufficient — generate a new summary
    // Find the split: keep as many recent messages as possible
    let recentTokens = 0;
    let splitIdx = history.length;
    const targetRecent = Math.floor(availableTokens * 0.6); // 60% for recent messages

    for (let i = history.length - 1; i >= 0; i--) {
      const msgTokens = estimateTokens(history[i].content) + 4;
      if (recentTokens + msgTokens > targetRecent) break;
      recentTokens += msgTokens;
      splitIdx = i;
    }

    // If nothing to summarize (all messages are "recent"), just return all
    if (splitIdx === 0) return history;

    const oldMessages = history.slice(0, splitIdx);

    // Summarize old messages using the configured summary model or the same model
    const summaryModelUri = this.config.contextManagement?.summaryModel;
    let summaryProvider: Provider;
    let summaryModel: string;

    if (summaryModelUri) {
      const resolved = this.providerRegistry.resolve(summaryModelUri, this.config);
      summaryProvider = resolved.provider;
      summaryModel = resolved.model;
    } else {
      summaryProvider = provider;
      summaryModel = model;
    }

    const oldContent = oldMessages.map((m) => `${m.role}: ${m.content}`).join('\n');

    const summaryResponse = await summaryProvider.chat(
      [
        {
          role: 'system',
          content:
            'Summarize the following conversation concisely, preserving key facts, decisions, and context needed for continuing the conversation.',
        },
        { role: 'user', content: oldContent },
      ],
      { model: summaryModel, maxTokens: 1024, signal: this.currentSignal },
    );

    this.summaryCache = summaryResponse.content;

    // Persist summary cache to session metadata so it survives across requests
    const sessionId = this.metadata?.sessionId as string | undefined;
    if (sessionId && this.stateStore) {
      await this.stateStore.saveSessionMeta(sessionId, 'summaryCache', this.summaryCache);
    }

    const summaryMsg: ChatMessage = {
      role: 'system',
      content: `Summary of earlier conversation:\n${summaryResponse.content}`,
    };

    return [summaryMsg, ...history.slice(splitIdx)];
  }

  // ── ctx.checkpoint() ────────────────────────────────────────────────

  /**
   * Execute a function with checkpoint-replay semantics.
   *
   * On first execution, runs `fn()`, saves the result under `name`, and
   * returns it. On replay (resume after restart), returns the saved result
   * without re-executing. This prevents duplicate side effects (double API
   * calls, double refunds, etc.).
   *
   * `name` must be a stable, caller-supplied identifier — the same call
   * site MUST pass the same name across runs of the same execution for
   * replay to work. Names are scoped to a single execution and must be
   * unique within it; reusing a name (e.g. inside a loop) gives
   * last-write-wins behavior. For loops, compose names from the iterator:
   * `ctx.checkpoint(`process-${id}`, fn)`.
   *
   * Names starting with `__auto/` are reserved for runtime-internal
   * auto-checkpointing of `ctx.ask` / spawn / race / parallel / map.
   */
  async checkpoint<T>(name: string, fn: () => Promise<T>): Promise<T> {
    // Defensive validation — checkpoint names are state-store keys, so
    // empty/whitespace-only names round-trip silently and create
    // hard-to-debug replay failures. The reserved-prefix check is
    // case-insensitive and trim-aware so accidentally constructed names
    // like '__AUTO/foo' or ' __auto/foo' don't sneak past.
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('ctx.checkpoint name must be a non-empty string.');
    }
    if (name !== name.trim()) {
      throw new Error(
        `ctx.checkpoint name "${name}" has leading/trailing whitespace — trim before passing.`,
      );
    }
    if (name.toLowerCase().startsWith('__auto/')) {
      throw new Error(
        `ctx.checkpoint name "${name}" is reserved — names starting with "__auto/" (case-insensitive) are used by the runtime for ask/spawn/race/parallel/map auto-checkpointing.`,
      );
    }
    return this._checkpoint(name, fn);
  }

  /**
   * Internal checkpoint implementation shared by both the public
   * `checkpoint(name, fn)` and the automatic checkpointing in
   * ask/spawn/race/parallel/map. Internal callers pass an `__auto/...`
   * name composed by `_autoCheckpointName`.
   *
   * `agent` is the originating agent for ask auto-checkpoints — passing
   * it explicitly stamps `event.agent` on the trace events even though
   * the emit fires before/after `fn()` (where the ask's ALS frame
   * either doesn't exist yet or has already torn down). Without this,
   * post-fn `checkpoint_save` rows show no agent in the trace UI.
   */
  private async _checkpoint<T>(
    name: string,
    fn: () => Promise<T>,
    options?: { agent?: string },
  ): Promise<T> {
    // If no state store, just execute without persistence
    if (!this.stateStore) {
      return fn();
    }

    const agentStamp = options?.agent ? { agent: options.agent } : {};

    // Check for a saved checkpoint from a previous execution
    const saved = await this.stateStore.getCheckpoint(this.executionId, name);
    if (saved !== null) {
      this.emitEvent({
        type: 'checkpoint_replay',
        ...agentStamp,
        data: { name },
      });
      this.spanManager?.addEventToActiveSpan('axl.checkpoint.hit', { 'axl.checkpoint.name': name });
      return saved as T;
    }

    // Execute and save the result
    const result = await fn();

    await this.stateStore.saveCheckpoint(this.executionId, name, result);

    this.emitEvent({
      type: 'checkpoint_save',
      ...agentStamp,
      data: { name },
    });
    this.spanManager?.addEventToActiveSpan('axl.checkpoint.miss', { 'axl.checkpoint.name': name });

    return result;
  }

  /** Generate a stable auto-checkpoint name for an internal primitive.
   *
   *  For `ctx.ask`, the originating agent is known and gets a per-agent
   *  counter — the resulting name reads as "orchestrator's first ask"
   *  (`__auto/orchestrator-agent/ask/0`) instead of a global ordinal.
   *  For `spawn` / `race` / `parallel` / `map`, no agent context is
   *  available (those wrap arbitrary fn callbacks), so the name uses
   *  the root counter: `__auto/spawn/0`, `__auto/race/3`, etc.
   *
   *  All counters live on a shared ref passed through `createChildContext`,
   *  so a tool handler's nested `ctx.ask()` (which runs in a child
   *  WorkflowContext) can never collide with the parent's auto-names in
   *  the state store. */
  private _autoCheckpointName(
    primitive: 'ask' | 'spawn' | 'race' | 'parallel' | 'map',
    agent?: string,
  ): string {
    const counters = this.autoCheckpointCounters;
    if (primitive === 'ask' && agent) {
      const n = counters.byAgent.get(agent) ?? 0;
      counters.byAgent.set(agent, n + 1);
      return `__auto/${agent}/ask/${n}`;
    }
    const n = counters.root++;
    return `__auto/${primitive}/${n}`;
  }

  // ── ctx.spawn() ───────────────────────────────────────────────────────

  async spawn<T>(
    n: number,
    fn: (index: number) => Promise<T>,
    options?: SpawnOptions,
  ): Promise<Result<T>[]> {
    return this._checkpoint(this._autoCheckpointName('spawn'), () => {
      if (this.spanManager) {
        return this.spanManager.withSpanAsync(
          'axl.ctx.spawn',
          {
            'axl.spawn.count': n,
            ...(options?.quorum != null ? { 'axl.spawn.quorum': options.quorum } : {}),
          },
          async (span) => {
            const results = await this._spawnImpl(n, fn, options);
            const completed = results.filter((r) => r !== undefined).length;
            const succeeded = results.filter((r) => r?.ok).length;
            span.setAttribute('axl.spawn.completed', completed);
            span.setAttribute('axl.spawn.succeeded', succeeded);
            span.setAttribute('axl.spawn.cancelled', n - completed);
            return results;
          },
        );
      }
      return this._spawnImpl(n, fn, options);
    });
  }

  private async _spawnImpl<T>(
    n: number,
    fn: (index: number) => Promise<T>,
    options?: SpawnOptions,
  ): Promise<Result<T>[]> {
    const results: Result<T>[] = [];
    let successCount = 0;
    const quorum = options?.quorum;

    if (quorum) {
      const controller = new AbortController();
      const parentSignal = this.currentSignal;
      const composedSignal = parentSignal
        ? AbortSignal.any([parentSignal, controller.signal])
        : controller.signal;

      return new Promise<Result<T>[]>((resolve, reject) => {
        let settled = false;
        let completedCount = 0;

        for (let i = 0; i < n; i++) {
          const index = i;
          // Run each branch in an AsyncLocalStorage context with the composed signal
          const p = signalStorage.run(composedSignal, () => fn(index));

          p.then((value) => {
            if (settled) return;
            results[index] = { ok: true, value };
            successCount++;
            completedCount++;
            if (successCount >= quorum) {
              settled = true;
              controller.abort(); // Cancel remaining branches
              resolve(results);
            } else if (completedCount === n && successCount < quorum) {
              settled = true;
              reject(new QuorumNotMet(quorum, successCount, results));
            }
          }).catch((err) => {
            if (settled) return;
            // AbortErrors from our cancellation don't count as failures
            const isAbort = err instanceof DOMException && err.name === 'AbortError';
            if (isAbort) {
              completedCount++;
              if (completedCount === n && !settled && successCount < quorum) {
                settled = true;
                reject(new QuorumNotMet(quorum, successCount, results));
              }
              return;
            }
            results[index] = { ok: false, error: err instanceof Error ? err.message : String(err) };
            completedCount++;
            if (completedCount === n && successCount < quorum) {
              settled = true;
              reject(new QuorumNotMet(quorum, successCount, results));
            }
          });
        }
      });
    }

    // Default: run all, return all results
    const parentSignal = this.currentSignal;
    const promises = Array.from({ length: n }, (_, i) => {
      const run = () =>
        fn(i)
          .then((value): Result<T> => ({ ok: true, value }))
          .catch(
            (err): Result<T> => ({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
      // Propagate parent signal so budget hard_stop can cancel non-quorum spawns
      return parentSignal ? signalStorage.run(parentSignal, run) : run();
    });

    return Promise.all(promises);
  }

  // ── ctx.vote() ────────────────────────────────────────────────────────

  vote<T>(results: Result<T>[], options: VoteOptions<T>): T | Promise<T> {
    if (this.spanManager) {
      return this.spanManager.withSpanAsync(
        'axl.ctx.vote',
        {
          'axl.vote.strategy': options.strategy,
          'axl.vote.candidates': results.filter((r) => r.ok).length,
        },
        async (span) => {
          const result = await this._voteImpl(results, options);
          span.setAttribute(
            'axl.vote.result',
            typeof result === 'object' ? JSON.stringify(result) : String(result),
          );
          return result;
        },
      );
    }
    return this._voteImpl(results, options);
  }

  private _voteImpl<T>(results: Result<T>[], options: VoteOptions<T>): T | Promise<T> {
    const successes = results
      .filter((r): r is Result<T> & { ok: true } => r.ok)
      .map((r) => r.value);

    if (successes.length === 0) {
      throw new NoConsensus('No successful results to vote on');
    }

    const { strategy, key, scorer, reducer } = options;

    if (scorer || (strategy === 'custom' && reducer)) {
      return this.asyncVote(successes, options);
    }

    switch (strategy) {
      case 'majority':
        return this.majorityVote(successes, key);
      case 'unanimous':
        return this.unanimousVote(successes, key);
      case 'highest':
        return this.numericVote(successes, key, 'highest');
      case 'lowest':
        return this.numericVote(successes, key, 'lowest');
      case 'mean':
        return this.meanVote(successes) as T;
      case 'median':
        return this.medianVote(successes) as T;
      case 'custom':
        if (reducer) return reducer(successes) as T;
        throw new NoConsensus('Custom strategy requires a reducer');
      default:
        throw new NoConsensus(`Unknown strategy: ${strategy}`);
    }
  }

  private async asyncVote<T>(successes: T[], options: VoteOptions<T>): Promise<T> {
    const { strategy, scorer, reducer } = options;

    if (strategy === 'custom' && reducer) {
      return reducer(successes);
    }

    if (scorer && (strategy === 'highest' || strategy === 'lowest')) {
      const scored = await Promise.all(
        successes.map(async (v) => ({ value: v, score: await scorer(v) })),
      );
      scored.sort((a, b) => (strategy === 'highest' ? b.score - a.score : a.score - b.score));
      return scored[0].value;
    }

    throw new NoConsensus(`Cannot use scorer with strategy "${strategy}"`);
  }

  private majorityVote<T>(values: T[], key?: string): T {
    const counts = new Map<string, { count: number; value: T }>();
    for (const v of values) {
      const k = key ? String((v as Record<string, unknown>)[key]) : JSON.stringify(v);
      const entry = counts.get(k);
      if (entry) entry.count++;
      else counts.set(k, { count: 1, value: v });
    }
    let best: { count: number; value: T } | undefined;
    for (const entry of counts.values()) {
      if (!best || entry.count > best.count) best = entry;
    }
    return best!.value;
  }

  private unanimousVote<T>(values: T[], key?: string): T {
    const first = key ? (values[0] as Record<string, unknown>)[key] : JSON.stringify(values[0]);
    for (let i = 1; i < values.length; i++) {
      const current = key ? (values[i] as Record<string, unknown>)[key] : JSON.stringify(values[i]);
      if (String(current) !== String(first)) {
        throw new NoConsensus('Unanimous vote failed: values differ');
      }
    }
    return values[0];
  }

  private numericVote<T>(values: T[], key: string | undefined, mode: 'highest' | 'lowest'): T {
    let best = values[0];
    let bestVal = key ? Number((values[0] as Record<string, unknown>)[key]) : Number(values[0]);
    for (let i = 1; i < values.length; i++) {
      const val = key ? Number((values[i] as Record<string, unknown>)[key]) : Number(values[i]);
      if (mode === 'highest' ? val > bestVal : val < bestVal) {
        best = values[i];
        bestVal = val;
      }
    }
    return best;
  }

  private meanVote(values: unknown[]): number {
    const nums = values.map(Number);
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  }

  private medianVote(values: unknown[]): number {
    const sorted = values.map(Number).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // ── ctx.verify() ──────────────────────────────────────────────────────

  async verify<T>(
    fn: (retry?: VerifyRetry<T>) => Promise<unknown>,
    schema: z.ZodType<T>,
    options?: VerifyOptions<T>,
  ): Promise<T> {
    const maxRetries = options?.retries ?? 3;
    let lastRetry: VerifyRetry<T> | undefined = undefined;

    // Emits exactly one `verify` trace event at each terminal point so consumers
    // can see the outcome (pass/fail) and the number of attempts used. Called
    // just before every return/throw below; no-op on `continue`.
    const emitVerifyOutcome = (passed: boolean, attempts: number, lastError?: string) => {
      this.emitEvent({
        type: 'verify',
        agent: undefined,
        data: {
          passed,
          attempts,
          ...(lastError ? { lastError } : {}),
        },
      });
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let rawOutput: unknown;
      try {
        const result = await fn(lastRetry);
        rawOutput = result;
        const parsed = schema.parse(result) as T;

        // Post-schema business rule validation
        if (options?.validate) {
          let validateResult: ValidateResult;
          try {
            validateResult = await options.validate(parsed, { metadata: this.metadata });
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            validateResult = { valid: false, reason: `Validator error: ${reason}` };
          }
          if (!validateResult.valid) {
            const errorMsg = validateResult.reason ?? 'Validation failed';
            lastRetry = { error: errorMsg, output: rawOutput, parsed };
            if (attempt === maxRetries) {
              emitVerifyOutcome(false, attempt + 1, errorMsg);
              if (options?.fallback !== undefined) return options.fallback;
              throw new ValidationError(parsed, errorMsg, maxRetries);
            }
            continue;
          }
        }

        emitVerifyOutcome(true, attempt + 1);
        return parsed;
      } catch (err) {
        if (err instanceof ValidationError) {
          // ValidationError from our own validate block or from fn (e.g., ctx.ask() validate
          // exhausted). Extract the parsed object so the next retry can repair it.
          // When fn() throws, rawOutput is undefined — fall back to the error's lastOutput.
          lastRetry = {
            error: err.reason,
            output: rawOutput ?? err.lastOutput,
            parsed: err.lastOutput as T,
          };
          if (attempt === maxRetries) {
            emitVerifyOutcome(false, attempt + 1, err.reason);
            if (options?.fallback !== undefined) return options.fallback;
            throw err;
          }
          continue;
        }

        // VerifyError from fn (e.g., ctx.ask() with schema exhausted retries, or nested
        // ctx.verify()). Extract lastOutput so fn can attempt repair — output is the raw
        // LLM response that failed parsing, parsed stays undefined.
        if (err instanceof VerifyError) {
          lastRetry = { error: err.message, output: rawOutput ?? err.lastOutput };
          if (attempt === maxRetries) {
            emitVerifyOutcome(false, attempt + 1, err.message);
            if (options?.fallback !== undefined) return options.fallback;
            throw err;
          }
          continue;
        }

        const errorMsg =
          err instanceof ZodError ? err.message : err instanceof Error ? err.message : String(err);
        lastRetry = { error: errorMsg, output: rawOutput };

        if (attempt === maxRetries) {
          emitVerifyOutcome(false, attempt + 1, errorMsg);
          if (options?.fallback !== undefined) return options.fallback;
          const zodErr =
            err instanceof ZodError
              ? err
              : new ZodError([{ code: 'custom', path: [], message: errorMsg }]);
          throw new VerifyError(rawOutput, zodErr, maxRetries);
        }
      }
    }

    emitVerifyOutcome(false, maxRetries + 1, lastRetry?.error ?? 'Verify failed');
    if (options?.fallback !== undefined) return options.fallback;
    throw new VerifyError(
      lastRetry?.output,
      new ZodError([{ code: 'custom', path: [], message: 'Verify failed' }]),
      maxRetries,
    );
  }

  // ── ctx.budget() ──────────────────────────────────────────────────────

  async budget<T>(options: BudgetOptions, fn: () => Promise<T>): Promise<BudgetResult<T>> {
    const limit = parseCost(options.cost);
    const policy = options.onExceed ?? 'finish_and_stop';

    const parentBudget = this.budgetContext;
    const controller = policy === 'hard_stop' ? new AbortController() : undefined;
    const parentSignal = this.currentSignal;

    const budgetSignal = controller
      ? parentSignal
        ? AbortSignal.any([parentSignal, controller.signal])
        : controller.signal
      : undefined;

    this.budgetContext = {
      totalCost: 0,
      limit,
      exceeded: false,
      policy,
      abortController: controller,
      unpriced: false,
      unpricedCount: 0,
      unpricedWarned: false,
    };

    const executeBudget = async (): Promise<BudgetResult<T>> => {
      try {
        // Run fn in an AsyncLocalStorage context with the budget signal
        const value = budgetSignal ? await signalStorage.run(budgetSignal, fn) : await fn();
        const totalCost = this.budgetContext!.totalCost;
        const exceeded = this.budgetContext!.exceeded;
        const unpriced = this.budgetContext!.unpriced;
        return { value, budgetExceeded: exceeded, totalCost, unpriced };
      } catch (err) {
        if (this.budgetContext!.exceeded) {
          return {
            value: null,
            budgetExceeded: true,
            totalCost: this.budgetContext!.totalCost,
            unpriced: this.budgetContext!.unpriced,
          };
        }
        // AbortError from hard_stop should count as budget exceeded
        if (err instanceof DOMException && err.name === 'AbortError' && controller) {
          return {
            value: null,
            budgetExceeded: true,
            totalCost: this.budgetContext!.totalCost,
            unpriced: this.budgetContext!.unpriced,
          };
        }
        throw err;
      } finally {
        // Roll nested spend AND the unpriced lower-bound flag up to the parent budget:
        // if an inner block spent unmeasured money, the parent's total is a lower bound too.
        if (parentBudget) {
          parentBudget.totalCost += this.budgetContext!.totalCost;
          if (this.budgetContext!.unpriced) {
            parentBudget.unpriced = true;
            parentBudget.unpricedCount += this.budgetContext!.unpricedCount;
          }
        }
        this.budgetContext = parentBudget;
      }
    };

    if (this.spanManager) {
      return this.spanManager.withSpanAsync(
        'axl.ctx.budget',
        {
          'axl.budget.limit': limit,
          'axl.budget.policy': policy,
        },
        async (span) => {
          const result = await executeBudget();
          span.setAttribute('axl.budget.totalCost', result.totalCost);
          span.setAttribute('axl.budget.exceeded', result.budgetExceeded);
          return result;
        },
      );
    }

    return executeBudget();
  }

  /**
   * Get the current budget status, or null if not inside a budget block. Inside
   * nested budgets this reflects the **innermost active** block (the nested block's
   * `finally` restores the parent before control returns to it).
   *
   * `unpriced` is true when this block ran a model with no usable cost (unpriced /
   * pricing-table miss): `spent` is then a LOWER BOUND and `remaining` an upper bound —
   * the limit cannot be enforced on the unmeasured spend. See {@link BudgetResult.unpriced}.
   */
  getBudgetStatus(): {
    spent: number;
    limit: number;
    remaining: number;
    unpriced: boolean;
  } | null {
    if (!this.budgetContext) return null;
    return {
      spent: this.budgetContext.totalCost,
      limit: this.budgetContext.limit,
      remaining: Math.max(0, this.budgetContext.limit - this.budgetContext.totalCost),
      unpriced: this.budgetContext.unpriced,
    };
  }

  // ── ctx.race() ────────────────────────────────────────────────────────

  async race<T>(fns: Array<() => Promise<T>>, options?: RaceOptions<T>): Promise<T> {
    return this._checkpoint(this._autoCheckpointName('race'), () => {
      if (this.spanManager) {
        return this.spanManager.withSpanAsync(
          'axl.ctx.race',
          {
            'axl.race.participants': fns.length,
          },
          async (span) => {
            let winnerIndex = -1;
            const wrappedFns = fns.map((fn, i) => async () => {
              const result = await fn();
              winnerIndex = i;
              return result;
            });
            const result = await this._raceImpl(wrappedFns, options);
            span.setAttribute('axl.race.resolved', true);
            span.setAttribute('axl.race.winner', winnerIndex);
            return result;
          },
        );
      }
      return this._raceImpl(fns, options);
    });
  }

  private async _raceImpl<T>(fns: Array<() => Promise<T>>, options?: RaceOptions<T>): Promise<T> {
    const controller = new AbortController();
    let lastError: Error | undefined;
    const schema = options?.schema as z.ZodType | undefined;

    const parentSignal = this.currentSignal;
    const composedSignal = parentSignal
      ? AbortSignal.any([parentSignal, controller.signal])
      : controller.signal;

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let remaining = fns.length;

      for (const fn of fns) {
        // Run each branch in an AsyncLocalStorage context with the composed signal.
        // This ensures the signal persists through all awaits in the branch.
        const p = signalStorage.run(composedSignal, fn);

        p.then(async (value) => {
          if (settled) return;
          // If a schema is provided, validate the result.
          // Invalid results are discarded and the race continues.
          if (schema) {
            const parsed = schema.safeParse(value);
            if (!parsed.success) {
              remaining--;
              lastError = new Error(`Schema validation failed: ${parsed.error.message}`);
              if (remaining === 0 && !settled) {
                settled = true;
                reject(lastError);
              }
              return;
            }
            // Post-schema business rule validation — invalid results discarded like schema failures
            if (options?.validate) {
              try {
                const validateResult = await options.validate(parsed.data as T, {
                  metadata: this.metadata,
                });
                if (!validateResult.valid) {
                  remaining--;
                  lastError = new Error(
                    `Validation failed: ${validateResult.reason ?? 'Validation failed'}`,
                  );
                  if (remaining === 0 && !settled) {
                    settled = true;
                    reject(lastError);
                  }
                  return;
                }
              } catch (err) {
                remaining--;
                lastError =
                  err instanceof Error ? err : new Error(`Validator error: ${String(err)}`);
                if (remaining === 0 && !settled) {
                  settled = true;
                  reject(lastError);
                }
                return;
              }
            }
            if (settled) return; // another branch may have won during async validate
            settled = true;
            controller.abort();
            resolve(parsed.data as T);
            return;
          }
          settled = true;
          controller.abort(); // Cancel losing branches
          resolve(value);
        }).catch((err) => {
          if (settled) return;
          // Ignore AbortErrors from our own cancellation
          if (err instanceof DOMException && err.name === 'AbortError') {
            remaining--;
            if (remaining === 0 && !settled) {
              settled = true;
              reject(lastError ?? new Error('All race branches were aborted'));
            }
            return;
          }
          remaining--;
          lastError = err instanceof Error ? err : new Error(String(err));
          if (remaining === 0 && !settled) {
            settled = true;
            reject(lastError);
          }
        });
      }
    });
  }

  // ── ctx.parallel() ────────────────────────────────────────────────────

  async parallel<T extends unknown[]>(fns: { [K in keyof T]: () => Promise<T[K]> }): Promise<T> {
    return this._checkpoint(
      this._autoCheckpointName('parallel'),
      () => Promise.all(fns.map((fn) => fn())) as Promise<T>,
    );
  }

  // ── ctx.map() ─────────────────────────────────────────────────────────

  async map<T, U>(
    items: T[],
    fn: (item: T, index: number) => Promise<U>,
    options?: MapOptions,
  ): Promise<Result<U>[]> {
    return this._checkpoint(this._autoCheckpointName('map'), () =>
      this._mapImpl(items, fn, options),
    );
  }

  private async _mapImpl<T, U>(
    items: T[],
    fn: (item: T, index: number) => Promise<U>,
    options?: MapOptions,
  ): Promise<Result<U>[]> {
    const concurrency = options?.concurrency ?? 5;
    const quorum = options?.quorum;
    const results: Result<U>[] = new Array(items.length);
    let nextIndex = 0;
    let successCount = 0;
    let completedCount = 0;
    let settled = false;

    const controller = quorum ? new AbortController() : undefined;
    const parentSignal = this.currentSignal;
    const mapSignal = controller
      ? parentSignal
        ? AbortSignal.any([parentSignal, controller.signal])
        : controller.signal
      : parentSignal;

    return new Promise<Result<U>[]>((resolve, reject) => {
      if (items.length === 0) {
        resolve([]);
        return;
      }

      const runNext = async () => {
        while (nextIndex < items.length && !settled) {
          const idx = nextIndex++;
          try {
            // Run each item in an AsyncLocalStorage context with the map signal
            const value = mapSignal
              ? await signalStorage.run(mapSignal, () => fn(items[idx], idx))
              : await fn(items[idx], idx);
            results[idx] = { ok: true, value };
            successCount++;
          } catch (err) {
            // Ignore AbortErrors from our own quorum cancellation
            if (
              err instanceof DOMException &&
              err.name === 'AbortError' &&
              controller?.signal.aborted
            ) {
              completedCount++;
              return;
            }
            results[idx] = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          completedCount++;

          if (quorum && successCount >= quorum) {
            settled = true;
            controller?.abort(); // Cancel remaining work
            resolve(results);
            return;
          }

          if (completedCount === items.length) {
            if (quorum && successCount < quorum) {
              reject(new QuorumNotMet(quorum, successCount, results));
            } else {
              resolve(results);
            }
            return;
          }
        }
      };

      const workers = Math.min(concurrency, items.length);
      for (let i = 0; i < workers; i++) {
        runNext().catch((err) => {
          if (!settled) reject(err);
        });
      }
    });
  }

  // ── ctx.awaitHuman() ──────────────────────────────────────────────────

  async awaitHuman(options: AwaitHumanOptions): Promise<HumanDecision> {
    if (this.spanManager) {
      return this.spanManager.withSpanAsync(
        'axl.ctx.awaitHuman',
        {
          'axl.awaitHuman.channel': options.channel,
        },
        async (span) => {
          const start = Date.now();
          const result = await this._awaitHumanImpl(options);
          span.setAttribute('axl.awaitHuman.wait_duration', Date.now() - start);
          span.setAttribute('axl.awaitHuman.approved', result.approved);
          return result;
        },
      );
    }
    return this._awaitHumanImpl(options);
  }

  private async _awaitHumanImpl(options: AwaitHumanOptions): Promise<HumanDecision> {
    if (this.awaitHumanHandler) {
      // Emit `await_human` BEFORE invoking the handler so consumers see the
      // start/end pair regardless of which approval path is taken
      // (synchronous handler vs runtime-mediated pendingDecisions).
      this.emitEvent({
        type: 'await_human',
        data: { channel: options.channel, prompt: options.prompt },
      });
      const decision = await this.awaitHumanHandler(options);
      this.emitEvent({
        type: 'await_human_resolved',
        data: { channel: options.channel, decision },
      });
      return decision;
    }

    if (!this.pendingDecisions) {
      throw new Error(
        'Tool requires approval but no approval handler is configured. ' +
          'Provide awaitHumanHandler to createContext() or use runtime.execute() with workflow infrastructure.',
      );
    }

    if (this.stateStore) {
      await this.stateStore.savePendingDecision(this.executionId, {
        executionId: this.executionId,
        channel: options.channel,
        prompt: options.prompt,
        metadata: options.metadata,
        createdAt: new Date().toISOString(),
      });

      // Persist execution state so we can resume after restart
      await this.stateStore.saveExecutionState(this.executionId, {
        workflow: this.workflowName ?? 'unknown',
        input: this.input,
        step: this.stepRefRoot.value,
        status: 'waiting',
        metadata: {
          ...this.metadata,
          awaitHumanChannel: options.channel,
          awaitHumanPrompt: options.prompt,
        },
      });
    }

    this.emitEvent({
      type: 'await_human',
      data: { channel: options.channel, prompt: options.prompt },
    });

    // Honor abort: without a signal listener, an `AbortError`-driven cancel
    // (e.g., `runtime.deleteExecution` on a mid-flight workflow) cleans up
    // the runtime's pendingDecisionResolvers map and the persisted decision
    // row but leaves the workflow Promise hanging forever — the
    // `pendingDecisions.set(id, resolve)` registration would just sit
    // there. Race the resolver Promise against the signal and clean up
    // either path's lingering registration in `finally`.
    const makeAbortError = (reason: unknown): Error => {
      // Match the existing AbortError shape used elsewhere in context.ts —
      // `instanceof DOMException && name === 'AbortError'` is the
      // detection used by `isAbortError` in runtime.ts and several catch
      // sites here. Fall back to a tagged Error in environments missing
      // the global DOMException constructor.
      if (typeof DOMException !== 'undefined') {
        return new DOMException(
          typeof reason === 'string' ? reason : 'awaitHuman aborted',
          'AbortError',
        );
      }
      const err = new Error(typeof reason === 'string' ? reason : 'awaitHuman aborted');
      err.name = 'AbortError';
      return err;
    };

    const decision = await new Promise<HumanDecision>((resolve, reject) => {
      // Fast path: already aborted before we even register.
      if (this.signal?.aborted) {
        reject(makeAbortError(this.signal.reason));
        return;
      }
      this.pendingDecisions!.set(this.executionId, resolve);
      const onAbort = () => {
        // Remove our registration ONLY if it's still ours — `resolveDecision`
        // could have overwritten/cleared between abort and listener firing.
        const current = this.pendingDecisions!.get(this.executionId);
        if (current === resolve) {
          this.pendingDecisions!.delete(this.executionId);
        }
        reject(makeAbortError(this.signal?.reason));
      };
      this.signal?.addEventListener('abort', onAbort, { once: true });
    });

    // Mirror the synchronous-handler path — emit `await_human_resolved` so
    // every `await_human` has a paired terminal event regardless of whether
    // the decision came in-process or via runtime.resolveDecision.
    this.emitEvent({
      type: 'await_human_resolved',
      data: { channel: options.channel, decision },
    });

    // Update execution state to running after decision is received
    if (this.stateStore) {
      await this.stateStore.saveExecutionState(this.executionId, {
        workflow: this.workflowName ?? 'unknown',
        input: this.input,
        step: this.stepRefRoot.value,
        status: 'running',
      });
    }

    return decision;
  }

  /**
   * Compose an `AbortSignal` for a memory operation's underlying embedder
   * fetch. Combines the parent context signal (user cancellation,
   * `runtime.execute({ signal })`) with the budget hard_stop abort so
   * that either cause correctly aborts an in-flight embed call.
   *
   * Returns `undefined` if there's nothing to cancel on — the embedder
   * runs without a signal in that case, matching its prior behavior.
   *
   * @internal
   */
  private _composeMemorySignal(): AbortSignal | undefined {
    const budgetSignal = this.budgetContext?.abortController?.signal;
    if (this.signal && budgetSignal) return AbortSignal.any([this.signal, budgetSignal]);
    return this.signal ?? budgetSignal;
  }

  /**
   * Accumulate a cost amount into the active `budgetContext` and trip the
   * `exceeded` flag if we've crossed the limit. On `hard_stop` policy,
   * also fires the abort controller so in-flight operations cancel.
   *
   * Called from every code path that spends money: the `agent_call` loop,
   * semantic memory operations (`ctx.remember({embed:true})`, `ctx.recall({query})`),
   * and any future cost-emitting primitive. Centralizing the logic here
   * means `ctx.budget({ limit, policy })` accurately enforces the limit
   * across ALL cost sources — not just agent calls.
   *
   * @internal
   */
  private _accumulateBudgetCost(amount: number): void {
    if (!this.budgetContext) return;
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.budgetContext.totalCost += amount;
    if (this.budgetContext.totalCost >= this.budgetContext.limit) {
      this.budgetContext.exceeded = true;
      // hard_stop: abort current in-flight operations immediately
      if (this.budgetContext.policy === 'hard_stop' && this.budgetContext.abortController) {
        this.budgetContext.abortController.abort();
      }
    }
  }

  // ── workflow lifecycle trace emission ──────────────────────────────────
  //
  // These are called by the runtime at execution boundaries. They emit
  // first-class `workflow_start` / `workflow_end` trace events instead of
  // the previous `ctx.log('workflow_start', ...)` indirection — so consumers
  // that narrow via `event.type === 'workflow_start'` actually see them.
  // Internal: the runtime is the only caller, user workflows never call these.

  /** @internal — idempotent; no-ops on second+ call within one ctx. */
  _emitWorkflowStart(input: unknown): void {
    if (this._workflowStartEmitted) return;
    this._workflowStartEmitted = true;
    this.emitEvent({
      type: 'workflow_start',
      workflow: this.workflowName,
      data: { input },
    });
  }

  /** @internal — idempotent; no-ops on second+ call within one ctx.
   *  Protects against the post-emit-side-effect double-fire (reviewer
   *  bug B1): `runtime.execute()` / `runtime.stream()` emit
   *  `workflow_end(completed)`, then call `deleteCheckpoints` /
   *  `persistExecution`. If either throws, the outer catch would
   *  otherwise fire a second `workflow_end(failed)` with conflicting
   *  status. First-wins semantics: the completed event stands, the
   *  inner side-effect failure propagates as a normal thrown error. */
  _emitWorkflowEnd(info: {
    status: 'completed' | 'failed';
    duration: number;
    result?: unknown;
    error?: string;
    aborted?: boolean;
  }): void {
    if (this._workflowEndEmitted) return;
    this._workflowEndEmitted = true;
    this.emitEvent({
      type: 'workflow_end',
      workflow: this.workflowName,
      duration: info.duration,
      data: {
        status: info.status,
        duration: info.duration,
        ...(info.result !== undefined ? { result: info.result } : {}),
        ...(info.error !== undefined ? { error: info.error } : {}),
        ...(info.aborted ? { aborted: true } : {}),
      },
    });
  }

  // ── ctx.log() ─────────────────────────────────────────────────────────

  log(event: string, data?: unknown): void {
    this.emitEvent({
      type: 'log',
      data: {
        event,
        ...(data && typeof data === 'object'
          ? (data as Record<string, unknown>)
          : data !== undefined
            ? { value: data }
            : {}),
      },
    });

    // Forward log events to the active OTel span
    if (this.spanManager) {
      const attrs: Record<string, string | number | boolean> = { 'axl.log.event': event };
      if (data !== undefined && typeof data === 'object' && data !== null) {
        for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            attrs[`axl.log.${k}`] = v;
          }
        }
      }
      this.spanManager.addEventToActiveSpan('axl.log', attrs);
    }
  }

  // -- ctx.remember() / ctx.recall() ----------------------------------------

  /**
   * Store a value in memory, scoped to the current session (default) or globally.
   * When a vector store is configured, the value is also embedded for semantic recall.
   */
  async remember(key: string, value: unknown, options?: RememberOptions): Promise<void> {
    if (!this.memoryManager) {
      throw new Error(
        'Memory is not configured. Provide a memoryManager in WorkflowContextInit or configure memory in AxlConfig.',
      );
    }
    if (!this.stateStore) {
      throw new Error('A state store is required for memory operations.');
    }
    // Budget gate: refuse to start a new memory op if the budget has
    // already been breached. Semantic remember hits a paid embedding API
    // and without this check a hard_stop budget only stopped the next
    // `ctx.ask()` call — memory writes could keep spending after the
    // limit. Mirrors the gate at the top of `ctx.ask()`.
    if (this.budgetContext?.exceeded) {
      const { limit, totalCost: spent, policy } = this.budgetContext;
      if (policy !== 'warn') {
        throw new BudgetExceededError(limit, spent, policy);
      }
    }
    const sessionId = this.metadata?.sessionId as string | undefined;
    const scope: 'session' | 'global' = options?.scope ?? (sessionId ? 'session' : 'global');
    // Operation-only audit trail — values are deliberately NOT traced because
    // they can be arbitrary user data. Emit on both success and failure so
    // compliance consumers can reconstruct the full audit history even when
    // the underlying store rejects the write.
    try {
      const memorySignal = this._composeMemorySignal();
      const { usage } = await this.memoryManager.remember(
        key,
        value,
        this.stateStore,
        sessionId,
        options,
        memorySignal,
      );
      // Budget attribution: embedder spend counts against `ctx.budget()`
      // the same way agent_call cost does. Without this, a RAG workload
      // with heavy semantic memory can silently breach a hard_stop
      // budget (memory cost was previously only flowing through the
      // trace-event rail for trackExecution, bypassing budgetContext).
      if (usage?.cost != null) {
        this._accumulateBudgetCost(usage.cost);
      }
      // Surface embedder cost at the AxlEvent top level so the
      // `trackExecution` listener picks it up automatically (it sums
      // `event.cost` across every event in scope, regardless of type).
      // Also mirror `usage.tokens` to top-level `tokens.input` so the
      // CostAggregator's early-return gate (`cost == null && !tokens`)
      // doesn't silently drop zero-cost-but-nonzero-token events from a
      // local embedder or an unknown-pricing model. Tokens live in
      // `tokens.input` because embedding APIs bill on input only.
      // `usage` is also nested into the event `data` for trace-explorer
      // visibility (debuggers see the full model/cost/tokens breakdown).
      this.emitEvent({
        type: 'memory_remember',
        ...(usage?.cost != null ? { cost: usage.cost } : {}),
        ...(usage?.tokens != null ? { tokens: { input: usage.tokens } } : {}),
        data: {
          key,
          scope,
          embed: options?.embed === true,
          ...(usage ? { usage } : {}),
        },
      });
    } catch (err) {
      // Recover cost attribution on the partial-failure path: if the
      // embedder call succeeded but a downstream step (vectorStore.upsert)
      // failed, `MemoryManager.remember` attaches the usage to the error
      // as a non-enumerable `axlEmbedUsage` property. The user has already
      // been billed for the embed — we owe them accurate cost tracking
      // even though the memory write ultimately failed (including budget
      // accounting, so a partial-failure RAG burst still counts against
      // a hard_stop budget).
      const partialUsage = (err as { axlEmbedUsage?: import('./memory/types.js').EmbedUsage })
        .axlEmbedUsage;
      if (partialUsage?.cost != null) {
        this._accumulateBudgetCost(partialUsage.cost);
      }
      this.emitEvent({
        type: 'memory_remember',
        ...(partialUsage?.cost != null ? { cost: partialUsage.cost } : {}),
        ...(partialUsage?.tokens != null ? { tokens: { input: partialUsage.tokens } } : {}),
        data: {
          key,
          scope,
          embed: options?.embed === true,
          ...(partialUsage ? { usage: partialUsage } : {}),
          error: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    }
  }

  /**
   * Recall a value from memory by key, or perform semantic search if query option is provided.
   */
  async recall(key: string, options?: RecallOptions): Promise<unknown | VectorResult[] | null> {
    if (!this.memoryManager) {
      throw new Error(
        'Memory is not configured. Provide a memoryManager in WorkflowContextInit or configure memory in AxlConfig.',
      );
    }
    if (!this.stateStore) {
      throw new Error('A state store is required for memory operations.');
    }
    // Budget gate: refuse to start a new semantic recall if the budget
    // has already been breached. See ctx.remember for rationale.
    if (this.budgetContext?.exceeded) {
      const { limit, totalCost: spent, policy } = this.budgetContext;
      if (policy !== 'warn') {
        throw new BudgetExceededError(limit, spent, policy);
      }
    }
    const sessionId = this.metadata?.sessionId as string | undefined;
    const scope: 'session' | 'global' = options?.scope ?? (sessionId ? 'session' : 'global');
    const semantic = options?.query !== undefined;
    // Operation-only audit trail. Emit on both success and failure.
    try {
      const memorySignal = this._composeMemorySignal();
      const { data, usage } = await this.memoryManager.recall(
        key,
        this.stateStore,
        sessionId,
        options,
        memorySignal,
      );
      let hit: boolean;
      let resultCount: number | undefined;
      if (semantic) {
        resultCount = Array.isArray(data) ? data.length : 0;
        hit = resultCount > 0;
      } else {
        hit = data !== null && data !== undefined;
      }
      // Budget attribution: semantic recall embedder cost counts against
      // `ctx.budget()`. Heavy RAG read workloads could previously breach
      // a hard_stop budget silently — memory cost flowed through the trace
      // rail for trackExecution but bypassed budgetContext.
      if (usage?.cost != null) {
        this._accumulateBudgetCost(usage.cost);
      }
      // Surface embedder cost + tokens at the AxlEvent top level so
      // the `trackExecution` listener picks cost up and the CostAggregator's
      // early-return gate (`cost == null && !tokens`) doesn't silently
      // drop zero-cost-but-nonzero-token events. `usage` is also nested
      // into `data.usage` for trace inspection.
      this.emitEvent({
        type: 'memory_recall',
        ...(usage?.cost != null ? { cost: usage.cost } : {}),
        ...(usage?.tokens != null ? { tokens: { input: usage.tokens } } : {}),
        data: {
          key,
          scope,
          semantic,
          hit,
          ...(resultCount !== undefined ? { resultCount, count: resultCount } : {}),
          ...(usage ? { usage } : {}),
        },
      });
      return data;
    } catch (err) {
      this.emitEvent({
        type: 'memory_recall',
        data: {
          key,
          scope,
          semantic,
          hit: false,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    }
  }

  /** Delete a memory entry by key. */
  async forget(key: string, options?: { scope?: 'session' | 'global' }): Promise<void> {
    if (!this.memoryManager) {
      throw new Error(
        'Memory is not configured. Provide a memoryManager in WorkflowContextInit or configure memory in AxlConfig.',
      );
    }
    if (!this.stateStore) {
      throw new Error('A state store is required for memory operations.');
    }
    const sessionId = this.metadata?.sessionId as string | undefined;
    const scope: 'session' | 'global' = options?.scope ?? (sessionId ? 'session' : 'global');
    try {
      await this.memoryManager.forget(key, this.stateStore, sessionId, options);
      this.emitEvent({
        type: 'memory_forget',
        data: { key, scope },
      });
    } catch (err) {
      this.emitEvent({
        type: 'memory_forget',
        data: {
          key,
          scope,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    }
  }

  // ── ctx.delegate() ──────────────────────────────────────────────────

  /**
   * Select the best agent from a list of candidates and invoke it.
   * Creates a temporary router agent that uses handoffs to pick the right specialist.
   *
   * This is convenience sugar over creating a router agent with dynamic handoffs.
   * For full control over the router's behavior, create the router agent explicitly.
   *
   * @param agents - Candidate agents to choose from (at least 1)
   * @param prompt - The prompt to send to the selected agent
   * @param options - Optional: schema, routerModel, metadata, retries
   */
  async delegate<T = string>(
    agents: Agent[],
    prompt: string,
    options?: DelegateOptions<T>,
  ): Promise<T> {
    if (agents.length === 0) {
      throw new Error('ctx.delegate() requires at least one candidate agent');
    }

    // Validate no duplicate agent names — duplicates produce duplicate tool names
    // which violates LLM API contracts and makes the second agent unreachable.
    const names = new Set<string>();
    for (const a of agents) {
      if (names.has(a._name)) {
        throw new Error(
          `ctx.delegate() received duplicate agent name '${a._name}'. All candidate agents must have unique names.`,
        );
      }
      names.add(a._name);
    }

    if (agents.length === 1) {
      this.emitEvent({
        type: 'delegate',
        agent: agents[0]._name,
        data: {
          candidates: [agents[0]._name],
          selected: agents[0]._name,
          reason: 'single_candidate',
        },
      });
      return this.ask(agents[0], prompt, {
        schema: options?.schema,
        schemaPrompt: options?.schemaPrompt,
        nativeStructuredOutput: options?.nativeStructuredOutput,
        retries: options?.retries,
        metadata: options?.metadata,
        validate: options?.validate,
        validateRetries: options?.validateRetries,
      });
    }

    // Resolve the router model: explicit option > first candidate's model
    const resolveCtx = options?.metadata
      ? { metadata: { ...this.metadata, ...options.metadata } }
      : { metadata: this.metadata };
    const routerModelUri = options?.routerModel ?? agents[0].resolveModel(resolveCtx);

    // Build handoff descriptors from candidates.
    // Use the agent's system prompt (truncated) as the handoff description
    // so the router LLM understands each candidate's capability.
    const handoffs = agents.map((a) => {
      let description: string;
      try {
        description = a.resolveSystem(resolveCtx).slice(0, 200);
      } catch {
        description = `Agent: ${a._name}`;
      }
      return { agent: a, description };
    });

    const routerSystem =
      'Route to the best agent for this task. Always hand off; never answer directly.';

    // Create a temporary router agent (inline to avoid circular import with agent.ts).
    // maxTurns: 2 allows one turn for the LLM to pick a handoff, plus one retry
    // if the first response is text instead of a tool call.
    const routerAgent: Agent = {
      _config: {
        model: routerModelUri,
        system: routerSystem,
        temperature: 0,
        handoffs,
        maxTurns: 2,
      },
      _name: '_delegate_router',
      ask: async () => {
        throw new Error('Direct invocation not supported on delegate router');
      },
      resolveModel: () => routerModelUri,
      resolveSystem: () => routerSystem,
    };

    this.emitEvent({
      type: 'delegate',
      agent: '_delegate_router',
      data: {
        candidates: agents.map((a) => a._name),
        routerModel: routerModelUri,
        reason: 'routed',
      },
    });

    return this.ask(routerAgent, prompt, {
      schema: options?.schema,
      schemaPrompt: options?.schemaPrompt,
      nativeStructuredOutput: options?.nativeStructuredOutput,
      retries: options?.retries,
      metadata: options?.metadata,
      validate: options?.validate,
      validateRetries: options?.validateRetries,
    });
  }

  // ── Private ───────────────────────────────────────────────────────────

  /**
   * Internal emitter input — intentionally loose so call sites don't need to
   * build a perfectly-narrowed discriminated-union member. The resulting
   * `AxlEvent` (exported type) remains strict, and TypeScript narrows it at
   * consumer sites via the `type` discriminator.
   */
  private emitEvent(partial: {
    type: AxlEvent['type'];
    workflow?: string;
    agent?: string;
    tool?: string;
    promptVersion?: string;
    model?: string;
    cost?: number;
    tokens?: { input?: number; output?: number; reasoning?: number };
    duration?: number;
    data?: unknown;
    // Variant-specific fields are accepted as `unknown`-typed extras so
    // call sites don't need to build a perfectly-narrowed discriminated
    // union member. The final `as unknown as AxlEvent` cast at the bottom
    // of the function is the runtime contract — emit sites are
    // responsible for pairing `type` with the matching variant fields.
    [key: string]: unknown;
  }): void {
    // Redaction is now table-driven: `REDACTION_RULES` in `redaction.ts`
    // owns every per-variant scrub, applied below to the constructed
    // event via `redactEvent(...)`. The legacy if/else ladder that used
    // to live here was duplicated by Studio's `redactStreamEvent`; both
    // sites now consult the same rules so adding a new event variant
    // can't drift between layers. Per-variant scrub contracts live at
    // the rule definitions in `redaction.ts`.
    const data: unknown = partial.data;
    // `as unknown as AxlEvent`: the loose internal `partial` type can't be
    // narrowed to a single discriminated union member at compile time, but the
    // runtime invariant is maintained by the gate/emission call sites that
    // always pair `type` with matching `data`/`tool`/etc.
    //
    // NOTE on redaction: we deliberately do NOT scrub top-level `cost`,
    // `tokens`, or `duration` under `config.trace.redact`. They are numeric
    // observability metrics (non-PII) and are load-bearing — `trackExecution`'s
    // cost-aggregation listener and Studio's CostAggregator both read
    // `event.cost` / `event.tokens` directly, so zeroing them would silently
    // break cost totals when redaction is enabled. In strict compliance
    // environments where even aggregate spend is sensitive, callers should
    // filter these events out entirely via `onTrace` rather than mutate them.
    //
    // NOTE on `workflow`: every trace event gets stamped with the owning
    // workflow name automatically (if set on the context). Previously each
    // caller had to explicitly pass `workflow` in the partial, and only
    // `_emitWorkflowStart` / `_emitWorkflowEnd` did so — which meant
    // `event.workflow` was undefined on every other event type in production.
    // Studio's `CostData.byWorkflow.cost` was effectively always $0 as a
    // result (workflows appeared with execution counts but zero spend).
    // Auto-stamping here is the single-source-of-truth fix: callers can
    // still override via `partial.workflow` if needed (e.g. a child context
    // emitting on behalf of its parent), but the common case "just works".
    // Read the ALS frame for ask correlation. The step counter prefers the
    // ALS frame's `stepRef` (which is `this.stepRefRoot` for top-level
    // asks, or the parent's counter for nested asks). Out-of-ask events
    // (workflow_start, workflow_end, ad-hoc log) also use `stepRefRoot` so
    // every event from this WorkflowContext shares one monotonic counter.
    const frame = askStorage.getStore();
    const step = (frame?.stepRef ?? this.stepRefRoot).value++;
    // Per-frame ask cost rollup. Only count cost-bearing leaf events
    // emitted directly within this frame — nested asks have their own
    // frame and their own counter, and their own `ask_end` event will
    // surface their rollup. This keeps `ask_end.cost` honest per spec
    // decision 10. Uses `COST_BEARING_LEAF_TYPES` so the rollup stays
    // in lockstep with `eventCostContribution` / `isCostBearingLeaf` —
    // previously this was hardcoded to `agent_call_end | tool_call_end`
    // which silently dropped embedder cost (`memory_remember` /
    // `memory_recall`) from the per-ask rollup when `ctx.recall()` ran
    // inside an ask.
    const cost = (partial as { cost?: number }).cost;
    if ((COST_BEARING_LEAF_TYPES as readonly string[]).includes(partial.type as string)) {
      // Classify the leaf ONCE, then feed two independent accumulators: the per-ask
      // frame rollup (ALS-scoped) AND the budget rail (instance-scoped). A
      // cost-bearing leaf that did measurable work (POSITIVE token count) but
      // produced no usable cost = an unpriced model / pricing-table miss. The
      // positive-token signal distinguishes this from a failed call (no tokens) AND
      // from a no-usage streamed call (zero tokens). Budget detection is NOT gated on
      // `frame`: a direct `ctx.budget(() => ctx.recall(...))` emits a cost-bearing
      // leaf with no ask frame, and the budget must still see it.
      // This is the canonical inline form of `isUnpricedLeaf` (event-utils):
      // it splits the two terms because the priced branch ALSO needs `usable`
      // to add to the rollup. The `isCostBearingLeaf` gate is the enclosing
      // `if`. Keep this in lockstep with `isUnpricedLeaf` — the runtime + Studio
      // aggregate via that helper, so a divergence here would desync the per-ask
      // flag from `ExecutionInfo.unpriced`.
      const usable = isUsableCost(cost);
      const unpriced =
        !usable &&
        hasPositiveTokens(
          partial as { tokens?: { input?: number; output?: number; reasoning?: number } },
        );
      if (frame) {
        if (usable) frame.askCost.value += cost;
        else if (unpriced) frame.askUnpriced = true;
      }
      if (unpriced && this.budgetContext) {
        // REPORT (not enforce): mark the budget's total as a lower bound. The
        // enforcement rail (`_accumulateBudgetCost`) never receives the unknown
        // component, so a cost limit / hard_stop still cannot trip on this spend.
        this.budgetContext.unpriced = true;
        this.budgetContext.unpricedCount += 1;
        // Warn only when there's an ENFORCEABLE (finite) cost limit the user might
        // wrongly trust — the runtime installs an ambient `Infinity` budget on every
        // execution, and warning "your cost limit is a lower bound" there is a lie
        // (no limit was set). The `unpriced` flag above is still recorded so
        // `ctx.totalCost` / `getBudgetStatus()` stay honest under the ambient budget.
        if (!this.budgetContext.unpricedWarned && Number.isFinite(this.budgetContext.limit)) {
          // Fail loud, once per block: a budget with a cost limit is silently
          // blind to unpriced spend. Synchronous check-and-set (no await) ⇒ no
          // interleaving under JS's cooperative single-threaded model.
          this.budgetContext.unpricedWarned = true;
          console.warn(
            "Budget honesty: unpriced work detected — this budget's cost limit is a " +
              'lower bound and is NOT enforced on unpriced models. ' +
              'See docs/observability.md#budget-honesty.',
          );
        }
      }
    }
    const event = {
      executionId: this.executionId,
      step,
      timestamp: Date.now(),
      ...(this.workflowName ? { workflow: this.workflowName } : {}),
      // Stamp ask correlation from ALS. Variants like `workflow_start` /
      // `workflow_end` and out-of-ask events (log/memory/checkpoint/await_human
      // when emitted at workflow scope) may legitimately have no frame —
      // they still get `depth: 0` so consumers can render them at root
      // level without having to guess. `askId`/`parentAskId`/`agent` stay
      // unset for non-ask-scoped events, matching the `Partial<AskScoped>`
      // shape on those union members.
      ...(frame
        ? {
            askId: frame.askId,
            ...(frame.parentAskId ? { parentAskId: frame.parentAskId } : {}),
            depth: frame.depth,
            ...(frame.agent ? { agent: frame.agent } : {}),
          }
        : { depth: 0 }),
      ...partial,
      data,
    } as unknown as AxlEvent;
    // Per-variant scrub via the shared `REDACTION_RULES` table — single
    // source of truth shared with Studio's `redactStreamEvent`. Applied
    // AFTER the event is constructed so cost-rail accumulation (above)
    // sees the unscrubbed numeric fields. Top-level numerics (`cost`,
    // `tokens`, `duration`) are preserved by every rule.
    const finalEvent = this.config.trace?.redact ? redactEvent(event) : event;
    // Isolate consumer bugs: a buggy onTrace handler must not crash the
    // workflow. Swallow and forward to console.error so the caller sees
    // the failure in ops but the workflow keeps running.
    //
    // Overflow handling: under `onOverflow: 'throw'`, both the wire
    // bus (AxlStream) and the ctx.events bus can throw
    // `EventStreamOverflowError`. We push to BOTH and DEFER the throw
    // until both have run, so a saturating wire-side bus doesn't deny
    // ctx.events consumers the same event (or vice versa). The
    // documented policy is "fail the workflow on overflow" — that
    // still happens, but consumers on the surviving channel see the
    // last event before the failure cascades. If both buses overflow
    // for the same event, the first one's error is kept (the second
    // is logged via console.error so it's still observable).
    let overflowErr: EventStreamOverflowError | undefined;
    if (this.onTrace) {
      try {
        this.onTrace(finalEvent);
      } catch (err) {
        if (err instanceof EventStreamOverflowError) {
          overflowErr = err;
        } else {
          console.error(
            '[axl] onTrace handler threw; trace event dropped:',
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
    // Fan out to the `ctx.events` bus if any consumer subscribed. Read
    // `_busRef.current` on every call so a late `ctx.events` access
    // (after this child context already exists) is picked up here.
    const bus = this._busRef.current;
    if (bus) {
      try {
        bus._push(finalEvent);
      } catch (err) {
        if (err instanceof EventStreamOverflowError) {
          if (!overflowErr) {
            overflowErr = err;
          } else {
            // Both buses overflowed on the same event. Keep the first
            // error (already preserves the failure-first semantic) but
            // log the second so operators investigating overflow see
            // both saturating sites.
            console.error(
              '[axl] ctx.events bus also overflowed for event "' +
                finalEvent.type +
                '"; first overflow already in flight:',
              err.message,
            );
          }
        } else {
          // _push catches listener exceptions internally (commit
          // bf17409). Anything reaching here is unexpected; log and
          // continue.
          console.error(
            '[axl] AxlEventBus._push threw unexpectedly:',
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
    // Auto-terminate the bus on workflow terminals so iterators resolve
    // with `done: true`, and remove the constructor's abort listener so
    // a long-lived signal reused across executions doesn't accumulate
    // listeners. Both run regardless of whether a bus was ever
    // allocated — the cleanup is for the listener on `this.signal`,
    // not the bus.
    if (finalEvent.type === 'workflow_end' || finalEvent.type === 'error') {
      bus?._finish();
      this.abortListenerCleanup?.();
    }
    if (overflowErr) throw overflowErr;
  }
}
