import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Users, Trash2, ArrowRight, MessageSquare } from 'lucide-react';
import { PanelShell } from '../../components/layout/PanelShell';
import { EmptyState } from '../../components/shared/EmptyState';
import { JsonViewer } from '../../components/shared/JsonViewer';
import { fetchSessions, fetchSession, deleteSession } from '../../lib/api';
import type { SessionSummary, ChatMessage, HandoffRecord } from '../../lib/types';

function safeParseJson(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

function renderContent(content: string, role: string) {
  if (role === 'assistant') {
    const trimmed = content.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        return <JsonViewer data={parsed} collapsed />;
      } catch {
        // Not valid JSON, fall through to plain text
      }
    }
  }
  return <div className="whitespace-pre-wrap">{content}</div>;
}

export function SessionManagerPanel() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [replayIndex, setReplayIndex] = useState<number | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: sessions = [] } = useQuery({
    queryKey: ['sessions'],
    queryFn: fetchSessions,
    refetchInterval: 5000,
  });

  const { data: sessionDetail } = useQuery({
    queryKey: ['session', selectedSessionId],
    queryFn: () => fetchSession(selectedSessionId!),
    enabled: !!selectedSessionId,
  });

  const deleteMutation = useMutation({
    mutationFn: deleteSession,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setSelectedSessionId(null);
      setDeleteConfirmId(null);
    },
  });

  const displayMessages = sessionDetail?.history
    ? replayIndex !== null
      ? sessionDetail.history.slice(0, replayIndex + 1)
      : sessionDetail.history
    : [];

  return (
    <PanelShell
      title="Session Manager"
      description="Browse active sessions, replay conversations, and view handoff chains"
    >
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Session list */}
        <div className="space-y-2">
          <h3 className="text-sm font-medium mb-2">Sessions ({sessions.length})</h3>
          {sessions.length === 0 ? (
            <EmptyState
              icon={<Users size={24} />}
              title="No sessions"
              description="Sessions are created when using runtime.session()"
            />
          ) : (
            sessions.map((s: SessionSummary) => (
              <button
                key={s.id}
                onClick={() => {
                  setSelectedSessionId(s.id);
                  setReplayIndex(null);
                }}
                className={`w-full text-left px-3 py-2.5 text-xs rounded-xl border transition-colors ${
                  selectedSessionId === s.id
                    ? 'border-[hsl(var(--primary))] bg-[hsl(var(--accent))]'
                    : 'border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]'
                }`}
              >
                <div className="font-mono truncate text-[11px]" title={s.id}>
                  {s.id}
                </div>
                <div className="flex items-center gap-1.5 text-[hsl(var(--muted-foreground))] mt-1">
                  <MessageSquare size={11} />
                  <span>
                    {s.messageCount} message{s.messageCount !== 1 ? 's' : ''}
                  </span>
                </div>
              </button>
            ))
          )}
        </div>

        {/* Session detail */}
        <div className="lg:col-span-2">
          {!sessionDetail ? (
            <EmptyState
              title="Select a session"
              description="Click a session to view its history"
            />
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-medium font-mono">{sessionDetail.id}</h3>
                  <p className="text-xs text-[hsl(var(--muted-foreground))]">
                    {sessionDetail.history.length} messages
                  </p>
                </div>
                {deleteConfirmId === sessionDetail.id ? (
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => deleteMutation.mutate(sessionDetail.id)}
                      className="px-2 py-1 text-xs rounded-md bg-red-600 text-white hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-800"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setDeleteConfirmId(null)}
                      className="px-2 py-1 text-xs rounded-md border border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setDeleteConfirmId(sessionDetail.id)}
                    className="flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-red-300 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
                  >
                    <Trash2 size={12} />
                    Delete
                  </button>
                )}
              </div>

              {/* Handoff chain */}
              {sessionDetail.handoffHistory && sessionDetail.handoffHistory.length > 0 && (
                <div>
                  <h4 className="text-xs font-medium mb-2">Handoff Chain</h4>
                  <div className="flex items-center gap-1 flex-wrap">
                    {sessionDetail.handoffHistory.map((h: HandoffRecord, i: number) => (
                      <div key={i} className="flex items-center gap-1">
                        <span className="px-2 py-0.5 text-xs rounded bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300">
                          {h.source}
                        </span>
                        <ArrowRight size={12} className="text-[hsl(var(--muted-foreground))]" />
                        <span className="px-2 py-0.5 text-xs rounded bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300">
                          {h.target}
                        </span>
                        <span className="text-xs text-[hsl(var(--muted-foreground))]">
                          ({h.mode})
                        </span>
                        {i < sessionDetail.handoffHistory!.length - 1 && (
                          <span className="mx-1 text-[hsl(var(--muted-foreground))]">|</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Replay slider */}
              {sessionDetail.history.length > 1 && (
                <div className="rounded-xl border border-[hsl(var(--border))] p-3">
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-medium">Replay</label>
                    <span className="text-xs text-[hsl(var(--muted-foreground))] font-mono">
                      {replayIndex !== null
                        ? `${replayIndex + 1} / ${sessionDetail.history.length}`
                        : `${sessionDetail.history.length} / ${sessionDetail.history.length}`}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={sessionDetail.history.length - 1}
                    value={replayIndex ?? sessionDetail.history.length - 1}
                    onChange={(e) => setReplayIndex(Number(e.target.value))}
                    className="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-[hsl(var(--secondary))] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[hsl(var(--primary))] [&::-webkit-slider-thumb]:shadow-sm [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-[hsl(var(--primary))] [&::-moz-range-thumb]:border-0"
                  />
                  <div className="flex justify-between mt-1">
                    <span className="text-[10px] text-[hsl(var(--muted-foreground))]">Start</span>
                    <span className="text-[10px] text-[hsl(var(--muted-foreground))]">Latest</span>
                  </div>
                </div>
              )}

              {/* Messages */}
              <div className="space-y-3">
                {displayMessages.map((msg: ChatMessage, i: number) => (
                  <div
                    key={i}
                    className={`p-3 rounded-xl text-sm ${
                      msg.role === 'user'
                        ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] ml-8'
                        : msg.role === 'assistant'
                          ? 'bg-[hsl(var(--secondary))] mr-8'
                          : 'bg-[hsl(var(--muted))] text-xs font-mono'
                    }`}
                  >
                    <div className="text-xs font-medium mb-1 opacity-70">{msg.role}</div>
                    {renderContent(msg.content, msg.role)}
                    {msg.tool_calls && msg.tool_calls.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {msg.tool_calls.map((tc) => (
                          <details key={tc.id} className="text-xs">
                            <summary className="cursor-pointer font-mono">
                              {tc.function.name}
                            </summary>
                            <JsonViewer data={safeParseJson(tc.function.arguments)} collapsed />
                          </details>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </PanelShell>
  );
}
