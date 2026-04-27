/**
 * Shared trace-event list renderer. Used by both the Trace Explorer
 * panel (for historical + live views) and the Workflow Runner panel
 * (for the per-run timeline). Centralizes:
 *
 * - Row rendering: chevron, type pill, agent/tool, waterfall bar, duration, cost
 * - Body rendering: per-type bodies (agent_call_start, agent_call_end, tool_approval, gate events)
 * - Expand/collapse state: local row state + trace-wide level via context
 * - Retry/gate failure amber tint
 * - Nested-depth indentation via `getDepth(event)`
 *
 * Both panels used to roll their own timelines with subtly different
 * renderers. This module is the single source of truth — any new
 * trace-event rendering added here is picked up by both.
 */
import { useState, useEffect, useMemo, createContext, useContext, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, RotateCw } from 'lucide-react';
import { cn, formatCost } from '../../lib/utils';
import { CostBadge } from './CostBadge';
import { DurationBadge } from './DurationBadge';
import { JsonViewer } from './JsonViewer';
import type { AxlEvent } from '../../lib/types';
import {
  getEventColor,
  getDepth,
  getAgentCallStartData,
  getAgentCallEndData,
  getGateData,
  getToolApprovalData,
  isRetryCall,
} from '../../lib/trace-utils';

// ── Trace-wide expand level ─────────────────────────────────────────

/**
 * Trace-wide expansion level. Lets the top-level Expand / Collapse buttons
 * reach into inner collapsible sections (system prompt, prompt, response,
 * messages) without each `TextBlock` holding independent state that drifts
 * out of sync with the user's intent.
 *
 * `version` increments on every Expand/Collapse click so that TextBlocks
 * re-sync even if the level itself didn't change.
 */
export type TraceExpandLevel = 0 | 1;
export const TraceExpandContext = createContext<{
  level: TraceExpandLevel;
  version: number;
}>({
  level: 0,
  version: 0,
});

// ── JsonViewer wrapper that respects TraceExpandContext ────────────

/**
 * Trace-aware JsonViewer. Reads `TraceExpandContext` and:
 *   - Expands fully (`defaultExpandDepth: Infinity`) when level === 1.
 *   - Uses a `key` that changes on every version bump so React remounts
 *     the viewer and overrides any manual expand/collapse the user did
 *     since the last Expand/Collapse button click.
 *
 * Used by ToolApprovalBody, GateCheckBody, and GenericBody so that the
 * trace-wide Expand button cascades into embedded JSON dumps (memory
 * usage, tool call args, arbitrary log data), not just TextBlocks.
 */
function TraceJsonViewer(props: Parameters<typeof JsonViewer>[0]) {
  const { level, version } = useContext(TraceExpandContext);
  const fullyExpanded = level === 1;
  return (
    <JsonViewer
      // Force remount on version bump so the tree picks up the new
      // expansion level even if the user manually toggled nodes since.
      key={`trace-expand-v${version}`}
      {...props}
      defaultExpandDepth={fullyExpanded ? Infinity : props.defaultExpandDepth}
      collapsed={fullyExpanded ? false : props.collapsed}
    />
  );
}

// ── Collapsible text block (system prompt, prompt, response) ────────

/** Collapsed-by-default text block for long strings (system prompts, feedback). */
export function TextBlock({
  label,
  content,
  tone = 'neutral',
  defaultOpen = false,
}: {
  label: string;
  content: string;
  tone?: 'neutral' | 'warning' | 'info';
  defaultOpen?: boolean;
}) {
  const { level, version } = useContext(TraceExpandContext);
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    if (version === 0) return;
    setOpen(level === 1);
  }, [version, level]);
  const toneClasses = {
    neutral: 'border-[hsl(var(--border))] bg-[hsl(var(--background))]',
    warning: 'border-amber-400/40 bg-amber-50 dark:bg-amber-950/20',
    info: 'border-blue-400/40 bg-blue-50 dark:bg-blue-950/20',
  }[tone];
  return (
    <div className={cn('rounded-lg border mb-2', toneClasses)}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-left hover:bg-[hsl(var(--muted))]/50"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span className="uppercase tracking-wider opacity-70">{label}</span>
        {!open && (
          <span className="text-[hsl(var(--muted-foreground))] font-normal truncate ml-1">
            {content.slice(0, 80)}
            {content.length > 80 ? '…' : ''}
          </span>
        )}
      </button>
      {open && (
        <pre className="px-3 pb-2.5 text-[11px] font-mono whitespace-pre-wrap break-words max-h-80 overflow-auto">
          {content}
        </pre>
      )}
    </div>
  );
}

// ── Per-type body renderers ─────────────────────────────────────────

/** Small pill for key/value params on agent_call_start. */
function ParamPill({ label, value }: { label: string; value: unknown }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-full bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
      <span className="opacity-60">{label}</span>
      <span className="font-mono text-[hsl(var(--foreground))]">
        {typeof value === 'object' ? JSON.stringify(value) : String(value)}
      </span>
    </span>
  );
}

/** Rendered body for an expanded agent_call_start event (request side). */
export function AgentCallStartBody({ event }: { event: AxlEvent }) {
  const d = getAgentCallStartData(event);
  if (!d) return null;
  return (
    <>
      {event.model && (
        <p className="text-xs mb-1">
          <strong>Model:</strong> {event.model}
          {d.turn != null && (
            <span className="ml-2 text-[hsl(var(--muted-foreground))]">· turn {d.turn}</span>
          )}
        </p>
      )}
      {d.params && Object.keys(d.params).length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {Object.entries(d.params).map(([k, v]) => (
            <ParamPill key={k} label={k} value={v} />
          ))}
        </div>
      )}
      {d.toolNames && d.toolNames.length > 0 && (
        <p className="text-xs mb-1">
          <strong>Tools:</strong>{' '}
          <span className="font-mono text-[hsl(var(--muted-foreground))]">
            {d.toolNames.join(', ')}
          </span>
        </p>
      )}
      {d.system && <TextBlock label="System prompt" content={d.system} tone="info" />}
      {d.prompt && <TextBlock label="Prompt" content={d.prompt} defaultOpen />}
      {d.messages && (
        <TextBlock
          label={`Messages (verbose) — ${d.messages.length}`}
          content={d.messages.map((m) => `[${m.role}]\n${m.content ?? ''}`).join('\n\n───\n\n')}
        />
      )}
    </>
  );
}

/** Rendered body for an expanded agent_call_end event (response side). */
export function AgentCallEndBody({ event }: { event: AxlEvent }) {
  const d = getAgentCallEndData(event);
  if (!d) return null;
  return (
    <>
      {event.model && (
        <p className="text-xs mb-1">
          <strong>Model:</strong> {event.model}
          {d.turn != null && (
            <span className="ml-2 text-[hsl(var(--muted-foreground))]">· turn {d.turn}</span>
          )}
        </p>
      )}
      {event.promptVersion && (
        <p className="text-xs mb-1">
          <strong>Version:</strong> {event.promptVersion}
        </p>
      )}
      {event.tokens && (event.tokens.input != null || event.tokens.output != null) && (
        <p className="text-xs mb-1">
          <strong>Tokens:</strong>
          {event.tokens.input != null ? ` in=${event.tokens.input}` : ''}
          {event.tokens.output != null ? ` out=${event.tokens.output}` : ''}
          {event.tokens.reasoning ? ` reasoning=${event.tokens.reasoning}` : ''}
        </p>
      )}
      {d.thinking && <TextBlock label="Thinking" content={d.thinking} tone="info" />}
      {d.response && <TextBlock label="Response" content={d.response} defaultOpen />}
      {d.error && <TextBlock label="Provider error" content={d.error} tone="warning" defaultOpen />}
    </>
  );
}

/** Rendered body for an expanded tool_approval event. */
export function ToolApprovalBody({ event }: { event: AxlEvent }) {
  const d = getToolApprovalData(event);
  if (!d) return null;
  return (
    <>
      <div className="flex items-center gap-2 mb-2 text-xs">
        <span
          className={cn(
            'px-2 py-0.5 rounded-full text-[10px] font-medium',
            d.approved
              ? 'bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300'
              : 'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300',
          )}
        >
          {d.approved ? 'APPROVED' : 'DENIED'}
        </span>
      </div>
      {d.reason && (
        <p className="text-xs mb-2">
          <strong>Reason:</strong> {d.reason}
        </p>
      )}
      {d.args !== undefined && (
        <>
          <p className="text-[11px] font-medium uppercase tracking-wider opacity-70 mb-1">
            Arguments
          </p>
          <TraceJsonViewer data={d.args as Record<string, unknown>} />
        </>
      )}
    </>
  );
}

/** Rendered body for an expanded gate event (guardrail / schema_check / validate). */
export function GateCheckBody({ event }: { event: AxlEvent }) {
  const d = getGateData(event);
  if (!d) return null;
  const failed = d.valid === false || d.blocked === true;
  return (
    <>
      <div className="flex items-center gap-2 mb-2 text-xs">
        <span
          className={cn(
            'px-2 py-0.5 rounded-full text-[10px] font-medium',
            failed
              ? 'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300'
              : 'bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300',
          )}
        >
          {failed ? 'FAILED' : 'PASSED'}
        </span>
        {d.attempt != null && d.maxAttempts != null && (
          <span className="text-[hsl(var(--muted-foreground))]">
            attempt {d.attempt} of {d.maxAttempts}
          </span>
        )}
        {d.guardrailType && (
          <span className="text-[hsl(var(--muted-foreground))]">· {d.guardrailType}</span>
        )}
      </div>
      {d.reason && (
        <p className="text-xs mb-2">
          <strong>Reason:</strong> {d.reason}
        </p>
      )}
      {d.feedbackMessage && (
        <TextBlock
          label="Retry feedback sent to LLM"
          content={d.feedbackMessage}
          tone="warning"
          defaultOpen
        />
      )}
    </>
  );
}

/** `ask_start` body — renders the user prompt at the top level of the
 *  event (not inside `event.data`, which is absent on this variant). */
function AskStartBody({ event }: { event: AxlEvent }) {
  const prompt = (event as { prompt?: unknown }).prompt;
  return (
    <>
      {typeof prompt === 'string' && prompt.length > 0 ? (
        <TextBlock label="Prompt" content={prompt} defaultOpen />
      ) : (
        <p className="text-xs text-[hsl(var(--muted-foreground))]">(no prompt)</p>
      )}
    </>
  );
}

/** `ask_end` body — renders outcome (narrowed on outcome.ok), plus the
 *  per-ask cost and duration from the top level of the event. */
function AskEndBody({ event }: { event: AxlEvent }) {
  const outcome = (event as { outcome?: { ok: boolean; result?: unknown; error?: string } })
    .outcome;
  const cost = (event as { cost?: number }).cost;
  const duration = (event as { duration?: number }).duration;
  return (
    <>
      {outcome && (
        <p className="text-xs mb-1">
          <strong>Outcome:</strong>{' '}
          <span
            className={
              outcome.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
            }
          >
            {outcome.ok ? 'ok' : 'error'}
          </span>
        </p>
      )}
      {typeof cost === 'number' && (
        <p className="text-xs mb-1">
          <strong>Ask cost:</strong> {formatCost(cost)}
        </p>
      )}
      {typeof duration === 'number' && (
        <p className="text-xs mb-1">
          <strong>Duration:</strong> {duration}ms
        </p>
      )}
      {outcome?.ok && outcome.result !== undefined && (
        <TextBlock
          label="Result"
          content={
            typeof outcome.result === 'string'
              ? outcome.result
              : JSON.stringify(outcome.result, null, 2)
          }
          defaultOpen
        />
      )}
      {outcome && !outcome.ok && outcome.error && (
        <TextBlock label="Error" content={outcome.error} tone="warning" defaultOpen />
      )}
    </>
  );
}

/** `pipeline` body — renders status/stage/attempt progression and the
 *  failure reason (only populated on `status: 'failed'`). */
function PipelineBody({ event }: { event: AxlEvent }) {
  const e = event as {
    status?: string;
    stage?: string;
    attempt?: number;
    maxAttempts?: number;
    reason?: string;
  };
  return (
    <>
      <p className="text-xs mb-1">
        <strong>Pipeline:</strong> {e.stage ?? '(unknown stage)'} · {e.status ?? '(unknown status)'}
        {e.attempt != null && e.maxAttempts != null
          ? ` · attempt ${e.attempt}/${e.maxAttempts}`
          : ''}
      </p>
      {e.reason && (
        <TextBlock label="Failure reason" content={e.reason} tone="warning" defaultOpen />
      )}
    </>
  );
}

/** `handoff_start` / `handoff_return` body — shows source→target and
 *  (for roundtrip start) the message passed to the target. */
function HandoffBody({ event }: { event: AxlEvent }) {
  const data = event.data as
    | { source?: string; target?: string; mode?: string; message?: string; duration?: number }
    | undefined;
  const isStart = event.type === 'handoff_start';
  return (
    <>
      <p className="text-xs mb-1">
        <strong>{isStart ? 'Handoff starts:' : 'Handoff returns:'}</strong> {data?.source ?? '?'} →{' '}
        {data?.target ?? '?'}
        {isStart && data?.mode ? ` · ${data.mode}` : ''}
      </p>
      {!isStart && typeof data?.duration === 'number' && (
        <p className="text-xs mb-1">
          <strong>Round-trip duration:</strong> {data.duration}ms
        </p>
      )}
      {isStart && data?.message && (
        <TextBlock label="Prompt to target" content={data.message} defaultOpen />
      )}
    </>
  );
}

/** Generic fallback body for event types without a dedicated renderer. */
function GenericBody({ event }: { event: AxlEvent }) {
  return (
    <>
      {event.model && (
        <p className="text-xs mb-1">
          <strong>Model:</strong> {event.model}
        </p>
      )}
      {event.promptVersion && (
        <p className="text-xs mb-1">
          <strong>Version:</strong> {event.promptVersion}
        </p>
      )}
      {event.tokens && (event.tokens.input != null || event.tokens.output != null) && (
        <p className="text-xs mb-1">
          <strong>Tokens:</strong>
          {event.tokens.input != null ? ` in=${event.tokens.input}` : ''}
          {event.tokens.output != null ? ` out=${event.tokens.output}` : ''}
          {event.tokens.reasoning ? ` reasoning=${event.tokens.reasoning}` : ''}
        </p>
      )}
      {event.data != null && (
        <TraceJsonViewer data={event.data as Record<string, unknown>} collapsed />
      )}
    </>
  );
}

// ── Event row + body ────────────────────────────────────────────────

function TraceEventRow({
  event,
  index,
  isExpanded,
  onToggle,
  maxDuration,
  baseDepth,
}: {
  event: AxlEvent;
  index: number;
  isExpanded: boolean;
  onToggle: () => void;
  maxDuration: number;
  baseDepth: number;
}) {
  const depth = Math.max(0, getDepth(event) - baseDepth);
  const isRetry = isRetryCall(event);
  const gate = getGateData(event);
  const isGateEvent =
    event.type === 'guardrail' || event.type === 'schema_check' || event.type === 'validate';
  const gateFailed = isGateEvent && (gate?.valid === false || gate?.blocked === true);
  // `done` and `error` synthesize `step: Number.MAX_SAFE_INTEGER` as a
  // "sort last" sentinel. Rendering the literal value blows past the
  // step column and collides with the label. Treat it as "no step".
  const stepDisplay =
    event.step != null && event.step !== Number.MAX_SAFE_INTEGER ? `#${event.step}` : '';

  return (
    <div>
      <button
        onClick={onToggle}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-1.5 text-xs rounded-xl cursor-pointer hover:bg-[hsl(var(--accent))] text-left',
          isRetry || gateFailed
            ? 'bg-amber-100/60 dark:bg-amber-950/30 ring-1 ring-amber-400/40'
            : 'bg-[hsl(var(--secondary))]',
        )}
        style={{ marginLeft: `${depth * 16}px` }}
      >
        {isExpanded ? (
          <ChevronDown size={12} className="shrink-0 text-[hsl(var(--muted-foreground))]" />
        ) : (
          <ChevronRight size={12} className="shrink-0 text-[hsl(var(--muted-foreground))]" />
        )}
        <span className="font-mono text-[hsl(var(--muted-foreground))] w-8 truncate">
          {stepDisplay || `#${index}`}
        </span>
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${getEventColor(event)}`} />
        <span className="font-medium w-28 truncate">{event.type}</span>
        {isRetry && (
          <span
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-medium rounded-full bg-amber-200 text-amber-900 dark:bg-amber-800 dark:text-amber-100"
            title={`Retry after ${getAgentCallStartData(event)?.retryReason ?? getAgentCallEndData(event)?.retryReason} failure`}
          >
            <RotateCw size={9} />
            retry
          </span>
        )}
        {gate?.attempt != null && gate.maxAttempts != null && (
          <span
            className="px-1.5 py-0.5 text-[9px] font-medium rounded-full bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]"
            title={`Attempt ${gate.attempt} of ${gate.maxAttempts}`}
          >
            {gate.attempt}/{gate.maxAttempts}
          </span>
        )}
        {event.agent && (
          <span className="text-blue-600 dark:text-blue-400 w-28 truncate">{event.agent}</span>
        )}
        {event.tool && (
          <span className="text-purple-600 dark:text-purple-400 w-28 truncate">{event.tool}</span>
        )}
        <div className="flex-1 h-3 bg-[hsl(var(--background))] rounded overflow-hidden">
          {event.duration != null && event.duration > 0 && (
            <div
              className={`h-full rounded ${getEventColor(event)}`}
              style={{
                width: `${Math.max((event.duration / maxDuration) * 100, 2)}%`,
                opacity: 0.7,
              }}
            />
          )}
        </div>
        {event.duration != null && <DurationBadge ms={event.duration} />}
        {event.cost != null && event.cost > 0 && <CostBadge cost={event.cost} />}
      </button>
      {isExpanded && (
        <div
          className="mt-1 mb-2 p-3 rounded-xl bg-[hsl(var(--card))] border border-[hsl(var(--border))]"
          style={{ marginLeft: `${depth * 16 + 32}px` }}
        >
          {event.type === 'agent_call_start' ? (
            <AgentCallStartBody event={event} />
          ) : event.type === 'agent_call_end' ? (
            <AgentCallEndBody event={event} />
          ) : isGateEvent ? (
            <GateCheckBody event={event} />
          ) : event.type === 'tool_approval' ? (
            <ToolApprovalBody event={event} />
          ) : event.type === 'ask_start' ? (
            <AskStartBody event={event} />
          ) : event.type === 'ask_end' ? (
            <AskEndBody event={event} />
          ) : event.type === 'pipeline' ? (
            <PipelineBody event={event} />
          ) : event.type === 'handoff_start' || event.type === 'handoff_return' ? (
            <HandoffBody event={event} />
          ) : (
            <GenericBody event={event} />
          )}
        </div>
      )}
    </div>
  );
}

// ── Shared event list with expand/collapse toolbar ──────────────────

/**
 * Full shared trace-event list. Handles:
 *   - Row + body rendering (via TraceEventRow)
 *   - Local expand/collapse state (per event)
 *   - Trace-wide expand level (via TraceExpandContext)
 *   - Optional Expand/Collapse toolbar (hidden if `showToolbar: false`)
 *   - Waterfall scaling (auto-computed from events if `maxDuration` omitted)
 *
 * Props:
 *   events            — the list of AxlEvent to render
 *   maxDuration?      — for the waterfall bar. Auto-computed from events if omitted.
 *   showToolbar       — default true; render the Expand/Collapse buttons + count row
 *   header?           — optional extra content rendered next to the event count
 */
export function TraceEventList({
  events,
  maxDuration: maxDurationOverride,
  showToolbar = true,
  header,
}: {
  events: AxlEvent[];
  maxDuration?: number;
  showToolbar?: boolean;
  header?: ReactNode;
}) {
  const [expandedEvents, setExpandedEvents] = useState<Set<string | number>>(new Set());
  const [expandLevel, setExpandLevel] = useState<TraceExpandLevel>(0);
  const [expandVersion, setExpandVersion] = useState(0);

  const maxDuration = useMemo(() => {
    if (maxDurationOverride != null) return maxDurationOverride;
    return Math.max(...events.map((e) => e.duration ?? 0), 1);
  }, [events, maxDurationOverride]);

  // Base depth for indent rendering. When drilled into a single ask, all
  // rows share a depth (e.g. 2 for a grandchild), which would push every
  // row right by 32px — the drill-down looks misaligned. Subtracting the
  // min depth re-grounds indentation so the drill-down reads as a normal
  // tree starting at 0. For the flat full-trace view, minDepth is 0 and
  // this becomes a no-op.
  const baseDepth = useMemo(() => {
    let min = Infinity;
    for (const e of events) {
      const d = getDepth(e);
      if (d < min) min = d;
    }
    return Number.isFinite(min) ? min : 0;
  }, [events]);

  const toggleEvent = (key: string | number) => {
    setExpandedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const expandAll = () => {
    const keys = events.map((e, i) => e.step ?? i);
    setExpandedEvents(new Set(keys));
    setExpandLevel(1);
    setExpandVersion((v) => v + 1);
  };

  const collapseAll = () => {
    setExpandedEvents(new Set());
    setExpandLevel(0);
    setExpandVersion((v) => v + 1);
  };

  return (
    <>
      {showToolbar && (
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-[hsl(var(--muted-foreground))]">
            {events.length} event{events.length !== 1 ? 's' : ''}
            {header && <span className="ml-2">{header}</span>}
          </span>
          {events.length > 0 && (
            <div className="flex items-center gap-1">
              <button
                onClick={expandAll}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]"
                title="Expand all — including inner sections"
              >
                <ChevronsUpDown size={12} />
                Expand
              </button>
              <button
                onClick={collapseAll}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]"
                title="Collapse all"
              >
                <ChevronsDownUp size={12} />
                Collapse
              </button>
            </div>
          )}
        </div>
      )}

      <TraceExpandContext.Provider value={{ level: expandLevel, version: expandVersion }}>
        <div className="space-y-1">
          {events.map((event, i) => {
            const eventKey = event.step ?? i;
            return (
              <TraceEventRow
                key={eventKey}
                event={event}
                index={i}
                isExpanded={expandedEvents.has(eventKey)}
                onToggle={() => toggleEvent(eventKey)}
                maxDuration={maxDuration}
                baseDepth={baseDepth}
              />
            );
          })}
        </div>
      </TraceExpandContext.Provider>
    </>
  );
}
