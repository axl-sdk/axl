import { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Send, ArrowRight, ShieldCheck, MessageSquarePlus, Activity } from 'lucide-react';
import { eventCostContribution } from '../../lib/event-utils';
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

type ToolCall = { name: string; args: unknown; result?: unknown; callId?: string };
type Handoff = { source: string; target: string; mode: string };

type Message = {
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ToolCall[];
  handoffs?: Handoff[];
  approvals?: Array<{ tool: string; approved: boolean }>;
};

// Stable Set hoisted out of render — re-creating per render means the
// auto-open effect's dependency identity churns and triggers an extra
// rescan on every render of the component.
const ACTIVITY_TRIGGERS: ReadonlySet<string> = new Set([
  'tool_call_start',
  'handoff_start',
  'tool_approval',
]);

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
      } else if (!stream.tokens && stream.result != null) {
        // Late-subscribe race: tokens are excluded from the WS replay
        // buffer (connection-manager.ts treats them as reconstructable
        // from `done`/`agent_call_end`), so a fast-completing execution
        // can finish before useWsStream subscribes. We get `done` with
        // a populated `result` but no `tokens` to render. Fall back to
        // `stream.result` so the assistant message still appears.
        const text =
          typeof stream.result === 'string' ? stream.result : JSON.stringify(stream.result);
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === 'assistant' && !last.content) {
            return [...prev.slice(0, -1), { ...last, content: text }];
          }
          return [...prev, { role: 'assistant', content: text }];
        });
      }
    }
  }, [stream.tokens, stream.done, stream.error, isStreaming]);

  // Collect tool calls, handoffs, and approvals from stream events
  useEffect(() => {
    const toolCalls: ToolCall[] = [];
    const handoffs: Handoff[] = [];
    const approvals: Array<{ tool: string; approved: boolean }> = [];

    // Post-spec/16 wire (no translation layer): tool activity flows as
    // `tool_call_start` (args at dispatch) and `tool_call_end` (args +
    // result at completion); handoff's `source/target/mode` live under
    // `data`; tool_approval carries `tool` + `data.approved`.
    for (const event of stream.events) {
      if (event.type === 'tool_call_start') {
        const data = event.data as { args?: unknown } | undefined;
        toolCalls.push({
          name: event.tool ?? '',
          args: data?.args,
          callId: event.callId,
        });
      }
      if (event.type === 'tool_call_end') {
        // Prefer callId match; the top-level `tool` is the fallback
        // for legacy events that didn't stamp callId.
        const data = event.data as { result?: unknown } | undefined;
        const existing = event.callId
          ? toolCalls.find((tc) => tc.callId === event.callId)
          : toolCalls.find((tc) => tc.name === event.tool && !tc.result);
        if (existing) existing.result = data?.result;
      }
      // `handoff_start` carries the transition metadata (source, target,
      // mode). `handoff_return` (roundtrip only) is a structural marker —
      // the chat doesn't render a second row for it; the target's own
      // response already shows up in the normal flow.
      if (event.type === 'handoff_start') {
        const data = event.data as { source?: string; target?: string; mode?: string } | undefined;
        handoffs.push({
          source: data?.source ?? '',
          target: data?.target ?? '',
          mode: (data?.mode as 'oneway' | 'roundtrip') ?? 'oneway',
        });
      }
      if (event.type === 'tool_approval') {
        const data = event.data as { approved?: boolean } | undefined;
        approvals.push({ tool: event.tool ?? '', approved: data?.approved === true });
      }
    }

    if (toolCalls.length > 0 || handoffs.length > 0 || approvals.length > 0) {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant') {
          return [
            ...prev.slice(0, -1),
            {
              ...last,
              toolCalls: toolCalls.length > 0 ? toolCalls : last.toolCalls,
              handoffs: handoffs.length > 0 ? handoffs : last.handoffs,
              approvals: approvals.length > 0 ? approvals : last.approvals,
            },
          ];
        }
        return prev;
      });
    }
  }, [stream.events]);

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
      if (ACTIVITY_TRIGGERS.has(event.type) || ((event as { depth?: number }).depth ?? 0) >= 1) {
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

  const activityEvents = stream.events.filter(
    (e) =>
      e.type !== 'token' && e.type !== 'partial_object' && e.type !== 'done' && e.type !== 'error',
  );

  const chatPanel = (
    <>
      <div className="flex-1 overflow-auto p-5 space-y-4">
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
              {msg.role === 'assistant' && isStreaming && i === messages.length - 1 ? (
                <StreamingText text={msg.content} />
              ) : (
                <div className="whitespace-pre-wrap">{msg.content}</div>
              )}

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
                      <div className="font-medium mb-1">Tool: {tc.name}</div>
                      <div className="space-y-1">
                        <div className="text-[hsl(var(--muted-foreground))]">Input:</div>
                        <JsonViewer data={tc.args} collapsed />
                        {tc.result !== undefined && (
                          <>
                            <div className="text-[hsl(var(--muted-foreground))]">Output:</div>
                            <JsonViewer data={tc.result} collapsed />
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
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              <h3 className="text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                Activity
              </h3>
              <AskTree events={stream.events} />
              {activityEvents.length > 0 ? (
                <TraceEventList events={activityEvents} showToolbar={false} />
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
