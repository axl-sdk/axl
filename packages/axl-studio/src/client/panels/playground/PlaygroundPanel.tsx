import { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Send, ArrowRight, ShieldCheck, MessageSquarePlus } from 'lucide-react';
import { PanelShell } from '../../components/layout/PanelShell';
import { EmptyState } from '../../components/shared/EmptyState';
import { StreamingText } from '../../components/shared/StreamingText';
import { JsonViewer } from '../../components/shared/JsonViewer';
import { CommandPicker } from '../../components/shared/CommandPicker';
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

export function PlaygroundPanel() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [totalCost, setTotalCost] = useState(0);
  const [totalTokens, setTotalTokens] = useState({ input: 0, output: 0 });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const processedEventsCount = useRef(0);

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
    if (stream.done) {
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
      }
    }
  }, [stream.tokens, stream.done, stream.error, isStreaming]);

  // Collect tool calls, handoffs, and approvals from stream events
  useEffect(() => {
    const toolCalls: ToolCall[] = [];
    const handoffs: Handoff[] = [];
    const approvals: Array<{ tool: string; approved: boolean }> = [];

    for (const event of stream.events) {
      if (event.type === 'tool_call') {
        toolCalls.push({ name: event.name, args: event.args, callId: event.callId });
      }
      if (event.type === 'tool_result') {
        // Match by callId when available (reliable), fall back to name (legacy)
        const existing = event.callId
          ? toolCalls.find((tc) => tc.callId === event.callId)
          : toolCalls.find((tc) => tc.name === event.name && !tc.result);
        if (existing) existing.result = event.result;
      }
      // Handle handoff and approval events
      if (event.type === 'handoff') {
        handoffs.push({ source: event.source, target: event.target, mode: event.mode ?? 'oneway' });
      }
      if (event.type === 'tool_approval') {
        approvals.push({ tool: event.name, approved: event.approved });
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
    for (const event of newEvents) {
      if (event.type === 'agent_end' && event.cost) {
        addedCost += event.cost;
      }
      if (event.type === 'step' && event.data.tokens) {
        addedInput += event.data.tokens.input ?? 0;
        addedOutput += event.data.tokens.output ?? 0;
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

  return (
    <PanelShell
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
    >
      <div className="flex flex-col h-full max-w-3xl mx-auto">
        {/* Messages */}
        <div className="flex-1 overflow-auto space-y-4 pb-4">
          {messages.length === 0 && (
            <EmptyState
              title="Start a conversation"
              description="Type a message below to chat with an agent. Tool calls, handoffs, and streaming responses will be displayed in real-time."
            />
          )}
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
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

                {/* Handoffs */}
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

                {/* Tool approvals */}
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

                {/* Tool calls — shown expanded by default */}
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

        {/* Input */}
        <div className="border-t border-[hsl(var(--border))] pt-4">
          <div className="flex items-end gap-2">
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
      </div>
    </PanelShell>
  );
}
