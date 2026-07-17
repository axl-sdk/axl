import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Send, ArrowRight, ShieldCheck, MessageSquarePlus, Activity } from 'lucide-react';
import { eventCostContribution } from '../../lib/event-utils';
import type { AxlEvent, ToolCallOutcome, ToolCallRejectedData } from '../../lib/types';
import { PanelHeader } from '../../components/layout/PanelHeader';
import { EmptyState } from '../../components/shared/EmptyState';
import { StreamingText } from '../../components/shared/StreamingText';
import { JsonViewer } from '../../components/shared/JsonViewer';
import { CommandPicker } from '../../components/shared/CommandPicker';
import { AskTree } from '../../components/shared/AskTree';
import { TraceEventList } from '../../components/shared/TraceEventList';
import { ResizableSplit } from '../../components/shared/ResizableSplit';
import { fetchAgents, playgroundChat } from '../../lib/api';
import { useWsStream } from '../../hooks/use-ws-stream';
import { cn, formatCost, formatTokens } from '../../lib/utils';

type ToolCallBase = {
  name: string;
  args: unknown;
  callId: string;
  executionId: string;
  askId: string;
  /** False when replay/transport loss delivered a terminal without its start. */
  startObserved: boolean;
};
type ToolCall =
  | (ToolCallBase & { status: 'running' | 'incomplete' })
  | (ToolCallBase & { status: 'succeeded'; result: unknown })
  | (ToolCallBase & {
      status: 'failed';
      failure: Extract<ToolCallOutcome, { status: 'failed' }>['failure'];
    })
  | (ToolCallBase & { status: 'denied'; reason?: string })
  | (ToolCallBase & {
      status: 'cancelled';
      cancellation: Extract<ToolCallOutcome, { status: 'cancelled' }>['cancellation'];
    })
  | {
      name: string;
      callId: string;
      executionId: string;
      askId: string;
      status: 'rejected';
      rejection: ToolCallRejectedData;
    };
type Handoff = { source: string; target: string; mode: string };

type Message = {
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ToolCall[];
  handoffs?: Handoff[];
  approvals?: Array<{ tool: string; approved: boolean }>;
};

function ToolCallStatusBadge({ status }: { status: ToolCall['status'] }) {
  const tone =
    status === 'succeeded'
      ? 'bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300'
      : status === 'running'
        ? 'bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300'
        : status === 'incomplete' || status === 'cancelled'
          ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
          : 'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300';
  return (
    <span className={cn('px-1.5 py-0.5 text-[9px] font-medium rounded-full', tone)}>{status}</span>
  );
}

// Stable Set hoisted out of render — re-creating per render means the
// auto-open effect's dependency identity churns and triggers an extra
// rescan on every render of the component.
const ACTIVITY_TRIGGERS: ReadonlySet<string> = new Set([
  'tool_call_start',
  'tool_call_rejected',
  'handoff_start',
  'tool_approval',
]);

/**
 * Derive the in-flight structured-output state from the running event
 * stream. Used to switch the chat bubble from raw-token rendering
 * (`{"summary":"H...` gibberish for schema responses) to a JSON-tree
 * snapshot + typewriter view of the currently-streaming string field.
 *
 * Mirrors the bus-side `stringStream` accumulator semantics:
 *   - On `string_delta`: append to per-(askId, path) text.
 *   - On `pipeline(failed)`: clear the failed ask's accumulator so a
 *     retry's first delta starts at `accumulated === delta`.
 *   - On `ask_end`: clear (frees memory, hides stale state from the
 *     UI once an ask completes).
 *   - `latestPartial`: most recent `partial_object` snapshot, regardless
 *     of askId. For the typical chat use case there's one schema'd ask
 *     in flight at a time; multi-ask workflows (planner → writer) get
 *     the most recently emitting one, which matches the chat-bubble's
 *     "what's the agent saying RIGHT NOW" UX.
 *   - `latestStringDelta`: most recently appended (askId, path) — the
 *     field the agent is actively writing. Becomes null when its ask
 *     ends or its attempt is discarded.
 */
function deriveStructuredOutputView(events: AxlEvent[]): {
  latestPartial: { askId: string; object: unknown } | null;
  latestStringDelta: { askId: string; path: string; accumulated: string } | null;
} {
  let latestPartial: { askId: string; object: unknown } | null = null;
  // key: `${askId}|${path}`
  const stringAcc = new Map<string, { askId: string; path: string; accumulated: string }>();
  let latestKey: string | null = null;

  const clearAsk = (askId: string) => {
    for (const k of [...stringAcc.keys()]) {
      if (k.startsWith(askId + '|')) {
        stringAcc.delete(k);
        if (latestKey === k) latestKey = null;
      }
    }
  };

  for (const e of events) {
    if (e.type === 'partial_object') {
      latestPartial = { askId: e.askId ?? '', object: e.data?.object };
    } else if (e.type === 'string_delta') {
      const askId = e.askId ?? '';
      const key = `${askId}|${e.data.path}`;
      const existing = stringAcc.get(key);
      stringAcc.set(key, {
        askId,
        path: e.data.path,
        accumulated: (existing?.accumulated ?? '') + e.data.delta,
      });
      latestKey = key;
    } else if (e.type === 'pipeline' && e.status === 'failed') {
      clearAsk(e.askId ?? '');
    } else if (e.type === 'ask_end') {
      clearAsk(e.askId ?? '');
    }
  }

  return {
    latestPartial,
    latestStringDelta: latestKey ? (stringAcc.get(latestKey) ?? null) : null,
  };
}

/**
 * Chat-bubble render for an in-flight schema response. Shows the latest
 * `partial_object` snapshot as a JSON tree + the field currently being
 * written as typewriter text below it.
 *
 * Why both: `partial_object` snapshots only fire at JSON structural
 * seams (after `,` / `}` / `]` outside strings) — they don't update
 * while a string is mid-flight. So a 4 KB summary field appears all at
 * once when the closing quote lands. The `streamingField` line shows
 * the in-progress text live (char-by-char) below the JSON, so the
 * operator never wonders "is the agent still running?" during a long
 * write.
 *
 * When the snapshot catches up (the field appears statically in the
 * tree with the same value), the live line is redundant but harmless —
 * it'll clear on `ask_end` regardless.
 */
function StructuredStreamingBubble({
  partial,
  streamingField,
}: {
  partial: unknown;
  streamingField: { askId: string; path: string; accumulated: string } | null;
}) {
  return (
    <div className="space-y-2">
      <div className="text-[10px] uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
        Streaming structured output
      </div>
      <JsonViewer data={partial} defaultExpandDepth={3} />
      {streamingField && streamingField.accumulated.length > 0 && (
        <div className="border-t border-[hsl(var(--border))] pt-2">
          <div className="text-[10px] uppercase tracking-wide text-[hsl(var(--muted-foreground))] mb-1">
            Writing <code className="font-mono">{streamingField.path}</code>
          </div>
          <div className="whitespace-pre-wrap font-mono text-xs">
            {streamingField.accumulated}
            <span className="inline-block w-1.5 h-3 ml-0.5 align-middle bg-[hsl(var(--foreground))] animate-pulse" />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Try to parse `text` as JSON. Used at chat-bubble render time for
 * post-completion messages: when the workflow returned a structured
 * object, the runtime stringifies it (in `useWsStream`'s `done`
 * fallback path) so it can fit the `Message.content: string` shape.
 * Render-time round-trip keeps the JSON tree view without changing
 * the persistence shape.
 *
 * Returns `undefined` for non-JSON strings (most common case — free-
 * text responses) so callers fall back to plain-text rendering.
 */
function tryParseJsonObject(text: string): unknown {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export function PlaygroundPanel() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [totalCost, setTotalCost] = useState(0);
  const [totalTokens, setTotalTokens] = useState({ input: 0, output: 0 });
  const [showActivity, setShowActivity] = useState(false);
  const userDismissedActivity = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const processedEventsCount = useRef(0);
  const activityScannedCount = useRef(0);

  const { data: agents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: fetchAgents,
  });

  const stream = useWsStream(executionId);

  // Accumulate streaming tokens into the current assistant message
  useEffect(() => {
    if (stream.tokens && isStreaming) {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant') {
          return [...prev.slice(0, -1), { ...last, content: stream.tokens }];
        }
        return [...prev, { role: 'assistant', content: stream.tokens }];
      });
    }
    // Gate the done/error append on `isStreaming` so it only runs ONCE
    // per stream. Without this guard, the effect re-fires on the
    // intermediate render between `setIsStreaming(false)` and useWsStream's
    // own `id → null` gate-clear effect — during that window stream.done
    // and stream.error are still set, so the error bubble would be
    // appended a second time. Reproducible regression: see
    // playground-panel-integration.test.tsx > "renders an Error: bubble".
    if (stream.done && isStreaming) {
      setIsStreaming(false);
      setExecutionId(null);
      // Show stream error as an assistant message
      if (stream.error) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          // If the last message is an empty assistant placeholder, replace it
          if (last?.role === 'assistant' && !last.content) {
            return [...prev.slice(0, -1), { role: 'assistant', content: `Error: ${stream.error}` }];
          }
          return [...prev, { role: 'assistant', content: `Error: ${stream.error}` }];
        });
      } else if (stream.result != null) {
        // Three scenarios end up here. In all of them we may want to
        // overwrite the token-accumulated `msg.content` with a canonical
        // form so the post-completion render path picks the right shape:
        //
        // 1. Late-subscribe race: tokens excluded from the WS replay
        //    buffer; a fast-completing execution finishes before
        //    `useWsStream` subscribes. `stream.tokens` is empty, so we
        //    must fall back to `stream.result` to render anything.
        //
        // 2. Structured (schema) response, server sent a stringified
        //    result: the playground endpoint serializes the parsed
        //    object via `JSON.stringify(result)` and emits it as
        //    `done.data.result: string`. The token stream is the raw
        //    LLM JSON (often pretty-printed with newlines that get
        //    stripped by the chunking regex on the way through —
        //    leading to subtly-malformed strings that `JSON.parse`
        //    rejects). We detect a JSON-shaped string result and
        //    re-canonicalize it: parse, re-stringify, store the clean
        //    form. The render path's `tryParseJsonObject` then has a
        //    reliable input and `JsonViewer` renders.
        //
        // 3. Structured (schema) response, server sent the raw object
        //    (typeof === 'object'): the parsed object goes straight
        //    into `JSON.stringify` for `msg.content`.
        //
        // Free-text (no schema): `stream.result` is a plain string
        // that doesn't parse as JSON. We keep the token-accumulated
        // content untouched.
        let canonical: string | null = null;
        if (typeof stream.result === 'string') {
          const trimmed = stream.result.trim();
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
              canonical = JSON.stringify(JSON.parse(trimmed));
            } catch {
              // Not parseable JSON despite the leading brace/bracket —
              // treat as plain text and keep tokens.
            }
          }
        } else if (typeof stream.result === 'object') {
          canonical = JSON.stringify(stream.result);
        }

        // Overwrite when:
        //   - we have nothing else to show (late-subscribe with no tokens), OR
        //   - we recognized a structured (JSON) result — the canonical
        //     form is more reliable than token accumulation, which can
        //     have artifacts from chunk-boundary effects.
        const shouldOverwriteContent = !stream.tokens || canonical !== null;
        if (!shouldOverwriteContent) return;
        const text =
          canonical ??
          (typeof stream.result === 'string' ? stream.result : JSON.stringify(stream.result));
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === 'assistant') {
            return [...prev.slice(0, -1), { ...last, content: text }];
          }
          return [...prev, { role: 'assistant', content: text }];
        });
      }
    }
  }, [stream.tokens, stream.done, stream.error, isStreaming]);

  // Collect tool calls, handoffs, and approvals from stream events
  useEffect(() => {
    const toolCalls = new Map<string, ToolCall>();
    const toolCallOrder: string[] = [];
    const handoffs: Handoff[] = [];
    const approvals: Array<{ tool: string; approved: boolean }> = [];

    // Post-spec/16 wire (no translation layer): tool activity flows as
    // `tool_call_start` (args at dispatch) and `tool_call_end` (args +
    // result at completion); handoff's `source/target/mode` live under
    // `data`; tool_approval carries `tool` + `data.approved`. Each branch
    // below narrows on `event.type` so `event.tool` / `event.data` /
    // `event.callId` are statically typed via the strict AxlEvent union.
    // Defense-in-depth: optional-chain through `data` since malformed wire
    // payloads (older runtimes, redaction edge cases) shouldn't crash the
    // SPA — degrade to undefined rendering instead.
    for (const event of stream.events) {
      if (event.type === 'tool_call_start') {
        const key = `${event.executionId}\u0000${event.askId}\u0000${event.callId}`;
        toolCalls.set(key, {
          name: event.tool,
          args: event.data?.args,
          callId: event.callId,
          executionId: event.executionId,
          askId: event.askId,
          startObserved: true,
          status: 'running',
        });
        toolCallOrder.push(key);
      } else if (event.type === 'tool_call_end') {
        // Live Playground events are v2: pair only by the full invocation
        // identity. Name-only matching can attach an end to the wrong nested ask.
        const key = `${event.executionId}\u0000${event.askId}\u0000${event.callId}`;
        const existing = toolCalls.get(key);
        if (!existing || existing.status !== 'rejected') {
          const base: ToolCallBase = {
            name: event.tool,
            args: event.data.args,
            callId: event.callId,
            executionId: event.executionId,
            askId: event.askId,
            startObserved: existing != null,
          };
          const outcome = event.data.outcome;
          switch (outcome.status) {
            case 'succeeded':
              toolCalls.set(key, { ...base, status: 'succeeded', result: outcome.result });
              break;
            case 'failed':
              toolCalls.set(key, { ...base, status: 'failed', failure: outcome.failure });
              break;
            case 'denied':
              toolCalls.set(key, { ...base, status: 'denied', reason: outcome.reason });
              break;
            case 'cancelled':
              toolCalls.set(key, {
                ...base,
                status: 'cancelled',
                cancellation: outcome.cancellation,
              });
              break;
          }
          if (!existing) toolCallOrder.push(key);
        }
      } else if (event.type === 'tool_call_rejected') {
        const key = `${event.executionId}\u0000${event.askId}\u0000${event.callId}`;
        toolCalls.set(key, {
          name: event.tool,
          callId: event.callId,
          executionId: event.executionId,
          askId: event.askId,
          status: 'rejected',
          rejection: event.data,
        });
        toolCallOrder.push(key);
      } else if (event.type === 'handoff_start') {
        // `handoff_start` carries the transition metadata (source, target,
        // mode). `handoff_return` (roundtrip only) is a structural marker —
        // the chat doesn't render a second row for it; the target's own
        // response already shows up in the normal flow.
        const data = event.data;
        if (data) {
          handoffs.push({ source: data.source, target: data.target, mode: data.mode });
        }
      } else if (event.type === 'tool_approval') {
        approvals.push({ tool: event.tool, approved: event.data?.approved === true });
      }
    }

    if (stream.done || stream.interrupted) {
      for (const [key, toolCall] of toolCalls) {
        if (toolCall.status === 'running')
          toolCalls.set(key, { ...toolCall, status: 'incomplete' });
      }
    }
    const orderedToolCalls = toolCallOrder.flatMap((key) => {
      const toolCall = toolCalls.get(key);
      return toolCall ? [toolCall] : [];
    });

    if (orderedToolCalls.length > 0 || handoffs.length > 0 || approvals.length > 0) {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant') {
          return [
            ...prev.slice(0, -1),
            {
              ...last,
              toolCalls: orderedToolCalls.length > 0 ? orderedToolCalls : last.toolCalls,
              handoffs: handoffs.length > 0 ? handoffs : last.handoffs,
              approvals: approvals.length > 0 ? approvals : last.approvals,
            },
          ];
        }
        return prev;
      });
    }
  }, [stream.events, stream.done, stream.interrupted]);

  // Track cost and tokens from stream events incrementally
  useEffect(() => {
    const newEvents = stream.events.slice(processedEventsCount.current);
    if (newEvents.length === 0) return;
    processedEventsCount.current = stream.events.length;

    let addedCost = 0;
    let addedInput = 0;
    let addedOutput = 0;
    // Cost rollup via shared helper (spec §10). Token counts are
    // explicitly scoped to `agent_call_end` because embedder events
    // (`memory_recall` / `memory_remember`) carry embedder-token
    // counts in a different category and shouldn't be conflated.
    for (const event of newEvents) {
      addedCost += eventCostContribution(event);
      if (event.type === 'agent_call_end' && event.tokens) {
        addedInput += event.tokens.input ?? 0;
        addedOutput += event.tokens.output ?? 0;
      }
    }
    if (addedCost > 0) setTotalCost((prev) => prev + addedCost);
    if (addedInput > 0 || addedOutput > 0) {
      setTotalTokens((prev) => ({
        input: prev.input + addedInput,
        output: prev.output + addedOutput,
      }));
    }
  }, [stream.events]);

  // Auto-open the Activity panel the first time we see multi-step
  // behavior: tool calls, handoffs, nested asks (depth >= 1), or
  // tool approvals. Simple single-agent chats stay clean.
  // Respects explicit user dismissal — once the user toggles it off,
  // auto-open won't fight them until a new chat starts.
  // Scan only the new tail to avoid O(n²) over a long execution; the
  // ref is reset to 0 alongside `userDismissedActivity` when a new
  // chat starts (see "New chat" handler below).
  useEffect(() => {
    if (showActivity || userDismissedActivity.current) {
      activityScannedCount.current = stream.events.length;
      return;
    }
    for (let i = activityScannedCount.current; i < stream.events.length; i++) {
      const event = stream.events[i];
      if (!event) continue;
      // `depth` lives on AskScoped variants only — narrow via `'depth' in
      // event` so the strict union admits the access without a cast.
      const depth = 'depth' in event && typeof event.depth === 'number' ? event.depth : 0;
      if (ACTIVITY_TRIGGERS.has(event.type) || depth >= 1) {
        setShowActivity(true);
        activityScannedCount.current = stream.events.length;
        return;
      }
    }
    activityScannedCount.current = stream.events.length;
  }, [stream.events, showActivity]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || isStreaming) return;

    const userMessage = input.trim();
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }]);
    setIsStreaming(true);

    try {
      const res = await playgroundChat(
        userMessage,
        sessionId ?? undefined,
        selectedAgent || undefined,
      );
      setSessionId(res.sessionId);
      setExecutionId(res.executionId);
    } catch (err) {
      setIsStreaming(false);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
    }
  }, [input, isStreaming, sessionId, selectedAgent]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const hasCostData = totalCost > 0 || totalTokens.input > 0;
  const messageCount = messages.length;

  // Derive the structured-output view from the running event stream.
  // When the in-flight ask has emitted `partial_object`, render the JSON
  // tree instead of raw token text (which for schema responses is just
  // JSON syntax char-by-char — gibberish to a human reader). When a
  // `string_delta` is currently streaming, render it as a typewriter line
  // below the snapshot so the user can see the actual text appear in
  // real-time, not just at structural seams.
  const structuredView = useMemo(() => deriveStructuredOutputView(stream.events), [stream.events]);

  // Filter out high-volume content events from the activity feed — they're
  // already rendered via the streaming chat bubble (`StreamingText`) and
  // would otherwise produce hundreds of useless rows for a long response.
  // `string_delta` joined this list in spec/17 alongside `token` and
  // `partial_object`. Customers wanting per-field char-by-char rendering
  // should subscribe to `AxlStream.stringStream({ path })` in their own
  // UI (see docs/observability.md).
  const activityEvents = stream.events.filter(
    (e) =>
      e.type !== 'token' &&
      e.type !== 'partial_object' &&
      e.type !== 'string_delta' &&
      e.type !== 'done' &&
      e.type !== 'error',
  );

  const chatPanel = (
    <>
      <div className="flex-1 overflow-auto p-3 sm:p-5 space-y-4">
        {messages.length === 0 && (
          <EmptyState
            title="Start a conversation"
            description="Type a message below to chat with an agent. Tool calls, handoffs, and streaming responses will be displayed in real-time."
          />
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm ${
                msg.role === 'user'
                  ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]'
                  : 'bg-[hsl(var(--secondary))] text-[hsl(var(--secondary-foreground))]'
              }`}
            >
              {(() => {
                const isInFlight =
                  msg.role === 'assistant' && isStreaming && i === messages.length - 1;
                // In-flight schema response — render the partial_object
                // snapshot as a JSON tree, plus the actively-streaming
                // string field as typewriter text. Switches automatically
                // when partial_object events fire; falls back to raw
                // tokens otherwise (free-text chat, no schema).
                if (isInFlight && structuredView.latestPartial) {
                  return (
                    <StructuredStreamingBubble
                      partial={structuredView.latestPartial.object}
                      streamingField={structuredView.latestStringDelta}
                    />
                  );
                }
                if (isInFlight) {
                  return <StreamingText text={msg.content} />;
                }
                // Post-completion. If the message content is JSON-shaped
                // (the workflow returned a structured object that
                // useWsStream's done-fallback path stringified into
                // `msg.content`), render it as a JSON tree instead of a
                // raw `{"summary":"..."}` blob. Free-text falls through
                // to the existing plain-text render.
                const parsed =
                  msg.role === 'assistant' ? tryParseJsonObject(msg.content) : undefined;
                if (parsed !== undefined) {
                  return <JsonViewer data={parsed} defaultExpandDepth={3} />;
                }
                return <div className="whitespace-pre-wrap">{msg.content}</div>;
              })()}

              {msg.handoffs && msg.handoffs.length > 0 && (
                <div className="mt-2 space-y-1 border-t border-[hsl(var(--border))] pt-2">
                  {msg.handoffs.map((h, j) => (
                    <div key={j} className="flex items-center gap-1.5 text-xs">
                      <ArrowRight size={12} className="text-amber-500" />
                      <span className="font-medium">{h.source}</span>
                      <ArrowRight size={10} />
                      <span className="font-medium">{h.target}</span>
                      <span className="text-[hsl(var(--muted-foreground))]">({h.mode})</span>
                    </div>
                  ))}
                </div>
              )}

              {msg.approvals && msg.approvals.length > 0 && (
                <div className="mt-2 space-y-1 border-t border-[hsl(var(--border))] pt-2">
                  {msg.approvals.map((a, j) => (
                    <div key={j} className="flex items-center gap-1.5 text-xs">
                      <ShieldCheck
                        size={12}
                        className={a.approved ? 'text-green-500' : 'text-red-500'}
                      />
                      <span>
                        Tool <span className="font-mono">{a.tool}</span>:{' '}
                        {a.approved ? 'approved' : 'denied'}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <div className="mt-2 space-y-2 border-t border-[hsl(var(--border))] pt-2">
                  {msg.toolCalls.map((tc, j) => (
                    <div key={j} className="text-xs">
                      <div className="flex items-center gap-2 font-medium mb-1">
                        <span>Tool: {tc.name}</span>
                        <ToolCallStatusBadge status={tc.status} />
                      </div>
                      <div className="space-y-1">
                        {tc.status !== 'rejected' && (
                          <>
                            <div className="text-[hsl(var(--muted-foreground))]">Input:</div>
                            <JsonViewer data={tc.args} collapsed />
                          </>
                        )}
                        {tc.status !== 'rejected' && !tc.startObserved && (
                          <div className="text-amber-600 dark:text-amber-400">
                            Terminal observed without its matching start; the trace is incomplete.
                          </div>
                        )}
                        {tc.status === 'succeeded' && (
                          <>
                            <div className="text-[hsl(var(--muted-foreground))]">Output:</div>
                            <JsonViewer data={tc.result} collapsed />
                          </>
                        )}
                        {tc.status === 'failed' && (
                          <>
                            <div className="text-red-600 dark:text-red-400">
                              Failed in {tc.failure.phase}: {tc.failure.error.name} —{' '}
                              {tc.failure.error.message}
                            </div>
                            {'result' in tc.failure && (
                              <>
                                <div className="text-[hsl(var(--muted-foreground))]">
                                  Output before failure:
                                </div>
                                <JsonViewer data={tc.failure.result} collapsed />
                              </>
                            )}
                          </>
                        )}
                        {tc.status === 'denied' && tc.reason && (
                          <div className="text-red-600 dark:text-red-400">Reason: {tc.reason}</div>
                        )}
                        {tc.status === 'cancelled' && (
                          <>
                            <div className="text-amber-600 dark:text-amber-400">
                              Cancelled in {tc.cancellation.phase}
                              {tc.cancellation.reason ? `: ${tc.cancellation.reason}` : ''}
                            </div>
                            {'result' in tc.cancellation && (
                              <>
                                <div className="text-[hsl(var(--muted-foreground))]">
                                  Output before cancellation:
                                </div>
                                <JsonViewer data={tc.cancellation.result} collapsed />
                              </>
                            )}
                          </>
                        )}
                        {tc.status === 'incomplete' && (
                          <div className="text-amber-600 dark:text-amber-400">
                            Trace ended before a matching tool terminal was observed.
                          </div>
                        )}
                        {tc.status === 'rejected' && (
                          <>
                            <div className="text-red-600 dark:text-red-400">
                              Rejected before execution: {tc.rejection.reason}
                            </div>
                            {tc.rejection.reason === 'invalid_arguments' && (
                              <JsonViewer
                                data={{ args: tc.rejection.args, issues: tc.rejection.issues }}
                                collapsed
                              />
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="border-t border-[hsl(var(--border))] p-4 shrink-0">
        <div className="flex items-end gap-2 max-w-3xl mx-auto">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            rows={1}
            className="flex-1 px-3 py-2.5 text-sm rounded-xl border border-[hsl(var(--input))] bg-[hsl(var(--background))] resize-none focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isStreaming}
            className="p-2.5 rounded-xl bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </>
  );

  return (
    <div className="flex flex-col h-screen">
      <PanelHeader
        title="Agent Playground"
        description={
          messageCount > 0 ? (
            <>
              <span>
                {messageCount} message{messageCount !== 1 ? 's' : ''}
              </span>
              {sessionId && (
                <>
                  <span className="opacity-40 mx-1.5">·</span>
                  <span className="font-mono">session {sessionId.slice(0, 8)}</span>
                </>
              )}
            </>
          ) : agents.length > 0 ? (
            <>
              <span>
                {agents.length} registered agent{agents.length !== 1 ? 's' : ''}
              </span>
              <span className="opacity-40 mx-1.5">·</span>
              <span>pick one or use the default</span>
            </>
          ) : (
            'Interactive chat with registered agents'
          )
        }
        actions={
          <>
            {hasCostData && (
              <div className="flex items-center gap-1.5">
                {totalCost > 0 && (
                  <span className="px-1.5 py-0.5 rounded text-xs font-mono bg-[hsl(var(--secondary))] text-[hsl(var(--secondary-foreground))]">
                    {formatCost(totalCost)}
                  </span>
                )}
                {totalTokens.input > 0 && (
                  <span className="px-1.5 py-0.5 rounded text-xs font-mono bg-[hsl(var(--secondary))] text-[hsl(var(--secondary-foreground))]">
                    {formatTokens(totalTokens.input + totalTokens.output)} tok
                  </span>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                setShowActivity((v) => {
                  if (v) userDismissedActivity.current = true;
                  return !v;
                });
              }}
              aria-pressed={showActivity}
              title="Show execution activity (tool calls, handoffs, agent calls)"
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs',
                'ring-1 ring-[hsl(var(--input))] hover:ring-[hsl(var(--ring))]',
                showActivity
                  ? 'bg-[hsl(var(--secondary))] text-[hsl(var(--secondary-foreground))]'
                  : 'bg-[hsl(var(--background))] text-[hsl(var(--muted-foreground))]',
              )}
            >
              <Activity size={12} />
              Activity
            </button>
            <div
              className={cn(
                'inline-flex items-stretch rounded-full bg-[hsl(var(--background))]',
                'ring-1 ring-[hsl(var(--input))] shadow-sm',
                'hover:ring-[hsl(var(--ring))] focus-within:ring-[hsl(var(--ring))]',
                'transition-shadow',
              )}
            >
              <CommandPicker
                items={agents}
                value={selectedAgent}
                onSelect={setSelectedAgent}
                getKey={(a) => a.name}
                getLabel={(a) => a.name}
                getDescription={(a) => (
                  <>
                    <span>{a.model}</span>
                    {a.tools.length > 0 && (
                      <>
                        <span className="opacity-40 mx-1">·</span>
                        <span>
                          {a.tools.length} tool{a.tools.length !== 1 ? 's' : ''}
                        </span>
                      </>
                    )}
                    {a.handoffs.length > 0 && (
                      <>
                        <span className="opacity-40 mx-1">·</span>
                        <span>
                          {a.handoffs.length} handoff{a.handoffs.length !== 1 ? 's' : ''}
                        </span>
                      </>
                    )}
                  </>
                )}
                searchMatch={(a, q) =>
                  a.name.toLowerCase().includes(q) ||
                  a.model.toLowerCase().includes(q) ||
                  a.tools.some((t) => t.toLowerCase().includes(q))
                }
                placeholder="Default agent"
                searchPlaceholder="Search agents…"
                emptyLabel="No agents registered"
                shortcut
                triggerClassName="rounded-l-full"
                ariaLabel="Select an agent"
              />
              <button
                onClick={() => {
                  setMessages([]);
                  setSessionId(null);
                  setExecutionId(null);
                  setTotalCost(0);
                  setTotalTokens({ input: 0, output: 0 });
                  setShowActivity(false);
                  userDismissedActivity.current = false;
                  processedEventsCount.current = 0;
                  activityScannedCount.current = 0;
                }}
                className={cn(
                  'inline-flex items-center gap-1.5 pl-3.5 pr-4 py-2 text-sm font-medium cursor-pointer',
                  'border-l border-[hsl(var(--input))] rounded-r-full',
                  'hover:bg-[hsl(var(--muted))] transition-colors',
                  'focus:outline-none focus-visible:bg-[hsl(var(--muted))]',
                )}
              >
                <MessageSquarePlus size={12} />
                New chat
              </button>
            </div>
          </>
        }
      />

      {showActivity ? (
        <ResizableSplit
          className="flex-1"
          left={chatPanel}
          right={
            <div className="flex-1 overflow-y-auto p-3 sm:p-5 space-y-4">
              <h3 className="text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                Activity
              </h3>
              <AskTree events={stream.events} />
              {activityEvents.length > 0 ? (
                <TraceEventList
                  events={activityEvents}
                  lifecycleEvents={stream.events}
                  traceComplete={stream.done || stream.interrupted}
                  showToolbar={false}
                />
              ) : (
                <p className="text-xs text-[hsl(var(--muted-foreground))]">
                  Events will appear here as the agent executes.
                </p>
              )}
            </div>
          }
        />
      ) : (
        <div className="flex-1 min-h-0 flex flex-col">{chatPanel}</div>
      )}
    </div>
  );
}
