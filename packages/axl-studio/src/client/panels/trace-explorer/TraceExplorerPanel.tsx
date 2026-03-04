import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import { PanelShell } from '../../components/layout/PanelShell';
import { EmptyState } from '../../components/shared/EmptyState';
import { StatusBadge } from '../../components/shared/StatusBadge';
import { CostBadge } from '../../components/shared/CostBadge';
import { DurationBadge } from '../../components/shared/DurationBadge';
import { JsonViewer } from '../../components/shared/JsonViewer';
import { fetchExecutions } from '../../lib/api';
import { useWs } from '../../hooks/use-ws';
import type { ExecutionInfo, TraceEvent } from '../../lib/types';

const EVENT_COLORS: Record<string, string> = {
  agent_call: 'bg-blue-500',
  tool_call: 'bg-purple-500',
  tool_call_complete: 'bg-purple-400',
  workflow_start: 'bg-green-500',
  workflow_complete: 'bg-green-400',
  handoff: 'bg-amber-500',
  await_human: 'bg-red-500',
  vote_start: 'bg-cyan-500',
  spawn: 'bg-indigo-500',
};

function getBarColor(type: string): string {
  return EVENT_COLORS[type] ?? 'bg-slate-500';
}

// Infer nesting depth from event type
function getDepth(event: TraceEvent): number {
  const type = event.type;
  if (type === 'workflow_start' || type === 'workflow_complete') return 0;
  if (type === 'agent_call' || type === 'spawn' || type === 'vote_start') return 1;
  if (type === 'tool_call' || type === 'tool_call_complete' || type === 'handoff') return 2;
  return 1;
}

export function TraceExplorerPanel() {
  const [selectedExecution, setSelectedExecution] = useState<ExecutionInfo | null>(null);
  const [liveEvents, setLiveEvents] = useState<TraceEvent[]>([]);
  const [typeFilter, setTypeFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');

  const { data: executions = [], refetch } = useQuery({
    queryKey: ['executions'],
    queryFn: fetchExecutions,
    refetchInterval: 3000,
  });

  // Subscribe to all trace events for live updates
  useWs(
    'trace:*',
    useCallback((data: unknown) => {
      setLiveEvents((prev) => [...prev.slice(-200), data as TraceEvent]);
    }, []),
  );

  const allEvents = selectedExecution ? selectedExecution.steps : liveEvents;

  let filteredEvents = allEvents;
  if (typeFilter) filteredEvents = filteredEvents.filter((e) => e.type === typeFilter);
  if (agentFilter) filteredEvents = filteredEvents.filter((e) => e.agent === agentFilter);

  const eventTypes = [...new Set(allEvents.map((e) => e.type))];
  const agents = [...new Set(allEvents.map((e) => e.agent).filter(Boolean))];

  // Waterfall visualization: compute relative widths
  const maxDuration = Math.max(...filteredEvents.map((e) => e.duration ?? 0), 1);

  return (
    <PanelShell
      title="Trace Explorer"
      description="Inspect execution traces with waterfall visualization"
      actions={
        <button
          onClick={() => {
            refetch();
            setLiveEvents([]);
          }}
          className="px-3 py-1.5 text-sm rounded-md border border-[hsl(var(--input))] hover:bg-[hsl(var(--accent))]"
        >
          Refresh
        </button>
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Execution list (sidebar) */}
        <div className="lg:col-span-1 space-y-2">
          <h3 className="text-sm font-medium mb-2">Executions</h3>
          <button
            onClick={() => setSelectedExecution(null)}
            className={`w-full text-left px-3 py-2 text-xs rounded-md border ${
              !selectedExecution
                ? 'border-[hsl(var(--primary))] bg-[hsl(var(--accent))]'
                : 'border-[hsl(var(--border))]'
            }`}
          >
            Live Events ({liveEvents.length})
          </button>
          {executions.map((exec: ExecutionInfo) => (
            <button
              key={exec.executionId}
              onClick={() => setSelectedExecution(exec)}
              className={`w-full text-left px-3 py-2 text-xs rounded-md border ${
                selectedExecution?.executionId === exec.executionId
                  ? 'border-[hsl(var(--primary))] bg-[hsl(var(--accent))]'
                  : 'border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium truncate">{exec.workflow}</span>
                <StatusBadge status={exec.status} />
              </div>
              <div className="flex items-center justify-between mt-0.5">
                <span className="text-[hsl(var(--muted-foreground))] truncate">
                  {exec.executionId.slice(0, 8)}... | {exec.steps.length} steps
                </span>
                {exec.totalCost > 0 && <CostBadge cost={exec.totalCost} />}
              </div>
            </button>
          ))}
          {executions.length === 0 && (
            <p className="text-xs text-[hsl(var(--muted-foreground))]">No executions yet</p>
          )}
        </div>

        {/* Trace waterfall */}
        <div className="lg:col-span-3">
          {/* Filters */}
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="px-2 py-1 text-xs rounded border border-[hsl(var(--input))] bg-[hsl(var(--background))]"
            >
              <option value="">All types</option>
              {eventTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            {agents.length > 0 && (
              <select
                value={agentFilter}
                onChange={(e) => setAgentFilter(e.target.value)}
                className="px-2 py-1 text-xs rounded border border-[hsl(var(--input))] bg-[hsl(var(--background))]"
              >
                <option value="">All agents</option>
                {agents.map((a) => (
                  <option key={a} value={a!}>
                    {a}
                  </option>
                ))}
              </select>
            )}
            <span className="text-xs text-[hsl(var(--muted-foreground))]">
              {filteredEvents.length} events
            </span>
          </div>

          {filteredEvents.length === 0 ? (
            <EmptyState
              icon={<Activity size={32} />}
              title="No trace events"
              description="Execute a workflow to see trace events here."
            />
          ) : (
            <div className="space-y-1">
              {filteredEvents.map((event, i) => {
                const depth = getDepth(event);
                return (
                  <details key={i} className="group">
                    <summary
                      className="flex items-center gap-2 px-3 py-1.5 text-xs rounded bg-[hsl(var(--secondary))] cursor-pointer hover:bg-[hsl(var(--accent))]"
                      style={{ marginLeft: `${depth * 16}px` }}
                    >
                      <span className="font-mono text-[hsl(var(--muted-foreground))] w-8">
                        #{event.step}
                      </span>
                      <span className={`w-1.5 h-1.5 rounded-full ${getBarColor(event.type)}`} />
                      <span className="font-medium w-28 truncate">{event.type}</span>
                      {event.agent && (
                        <span className="text-blue-600 dark:text-blue-400 w-28 truncate">
                          {event.agent}
                        </span>
                      )}
                      {event.tool && (
                        <span className="text-purple-600 dark:text-purple-400 w-28 truncate">
                          {event.tool}
                        </span>
                      )}
                      {/* Waterfall bar */}
                      <div className="flex-1 h-3 bg-[hsl(var(--background))] rounded overflow-hidden">
                        {event.duration && (
                          <div
                            className={`h-full rounded ${getBarColor(event.type)}`}
                            style={{
                              width: `${Math.max((event.duration / maxDuration) * 100, 2)}%`,
                              opacity: 0.7,
                            }}
                          />
                        )}
                      </div>
                      {event.duration && <DurationBadge ms={event.duration} />}
                      {event.cost && <CostBadge cost={event.cost} />}
                    </summary>
                    <div
                      className="mt-1 mb-2 p-3 rounded bg-[hsl(var(--card))] border border-[hsl(var(--border))]"
                      style={{ marginLeft: `${depth * 16 + 32}px` }}
                    >
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
                      {event.tokens && (
                        <p className="text-xs mb-1">
                          <strong>Tokens:</strong> in={event.tokens.input} out={event.tokens.output}
                          {event.tokens.reasoning ? ` reasoning=${event.tokens.reasoning}` : ''}
                        </p>
                      )}
                      {event.data != null && (
                        <JsonViewer data={event.data as Record<string, unknown>} collapsed />
                      )}
                    </div>
                  </details>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </PanelShell>
  );
}
