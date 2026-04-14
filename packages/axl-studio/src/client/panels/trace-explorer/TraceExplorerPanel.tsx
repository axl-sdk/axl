import { useState, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  RefreshCw,
} from 'lucide-react';
import { PanelHeader } from '../../components/layout/PanelHeader';
import { EmptyState } from '../../components/shared/EmptyState';
import { StatusBadge } from '../../components/shared/StatusBadge';
import { CostBadge } from '../../components/shared/CostBadge';
import { DurationBadge } from '../../components/shared/DurationBadge';
import { JsonViewer } from '../../components/shared/JsonViewer';
import { CommandPicker } from '../../components/shared/CommandPicker';
import { fetchExecutions } from '../../lib/api';
import { useWs } from '../../hooks/use-ws';
import { cn, formatCost, formatDuration } from '../../lib/utils';
import type { ExecutionInfo, TraceEvent } from '../../lib/types';
import { StatCard } from '../../components/shared/StatCard';
import { getBarColor, getDepth } from '../../lib/trace-utils';

type FilterOption = { value: string; label: string };

const STATUS_TINT: Record<string, string> = {
  running: 'border-l-blue-500',
  completed: 'border-l-green-500',
  failed: 'border-l-red-500',
};

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isToday) {
    return d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function TraceExplorerPanel() {
  const [selectedExecution, setSelectedExecution] = useState<ExecutionInfo | null>(null);
  const [liveEvents, setLiveEvents] = useState<TraceEvent[]>([]);
  const [typeFilter, setTypeFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [expandedEvents, setExpandedEvents] = useState<Set<string | number>>(new Set());

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

  // Distinct type/agent sets for the filter dropdowns. Derive + sort so a
  // stable identity falls out of useMemo — downstream option arrays can then
  // depend on these directly without a hand-rolled serialization key.
  const eventTypes = useMemo(() => [...new Set(allEvents.map((e) => e.type))].sort(), [allEvents]);
  const agents = useMemo(
    () => [...new Set(allEvents.map((e) => e.agent).filter((a): a is string => !!a))].sort(),
    [allEvents],
  );

  // Prepend an "All …" pseudo-entry so users can clear the filter from the
  // picker popover itself (no separate clear button needed). The empty-string
  // value resets the filter state.
  const typeOptions: FilterOption[] = useMemo(
    () => [{ value: '', label: 'All types' }, ...eventTypes.map((t) => ({ value: t, label: t }))],
    [eventTypes],
  );
  const agentOptions: FilterOption[] = useMemo(
    () => [{ value: '', label: 'All agents' }, ...agents.map((a) => ({ value: a, label: a }))],
    [agents],
  );

  // Waterfall visualization: compute relative widths
  const maxDuration = Math.max(...filteredEvents.map((e) => e.duration ?? 0), 1);

  // Expand/collapse helpers
  const toggleEvent = (key: string | number) => {
    setExpandedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const expandAll = () => {
    const keys = filteredEvents.map((e, i) => e.step ?? i);
    setExpandedEvents(new Set(keys));
  };

  const collapseAll = () => {
    setExpandedEvents(new Set());
  };

  // Stat cards for selected execution
  const stats = useMemo(() => {
    if (!selectedExecution) return null;
    const models = [...new Set(selectedExecution.steps.map((s) => s.model).filter(Boolean))];
    return {
      duration: selectedExecution.duration,
      eventCount: selectedExecution.steps.length,
      cost: selectedExecution.totalCost,
      models,
    };
  }, [selectedExecution]);

  return (
    <div className="flex flex-col h-screen">
      <PanelHeader
        title="Trace Explorer"
        description={
          selectedExecution ? (
            <>
              <span>{selectedExecution.workflow}</span>
              <span className="opacity-40 mx-1.5">·</span>
              <span className="font-mono">{selectedExecution.executionId.slice(0, 8)}</span>
              <span className="opacity-40 mx-1.5">·</span>
              <span>
                {selectedExecution.steps.length} event
                {selectedExecution.steps.length !== 1 ? 's' : ''}
              </span>
            </>
          ) : (
            <>
              {executions.length} execution{executions.length !== 1 ? 's' : ''}
              <span className="opacity-40 mx-1.5">·</span>
              {liveEvents.length} live event{liveEvents.length !== 1 ? 's' : ''}
            </>
          )
        }
        actions={
          <>
            <CommandPicker
              items={typeOptions}
              value={typeFilter}
              onSelect={setTypeFilter}
              getKey={(o) => o.value}
              getLabel={(o) => o.label}
              placeholder="All types"
              searchPlaceholder="Filter types…"
              variant="filter"
              triggerClassName={cn(
                'rounded-full shadow-sm ring-1 transition-shadow',
                typeFilter
                  ? 'ring-[hsl(var(--foreground))] text-[hsl(var(--foreground))] font-medium'
                  : 'ring-[hsl(var(--input))]',
              )}
              ariaLabel="Filter by event type"
            />
            {agents.length > 0 && (
              <CommandPicker
                items={agentOptions}
                value={agentFilter}
                onSelect={setAgentFilter}
                getKey={(o) => o.value}
                getLabel={(o) => o.label}
                placeholder="All agents"
                searchPlaceholder="Filter agents…"
                variant="filter"
                triggerClassName={cn(
                  'rounded-full shadow-sm ring-1 transition-shadow',
                  agentFilter
                    ? 'ring-[hsl(var(--foreground))] text-[hsl(var(--foreground))] font-medium'
                    : 'ring-[hsl(var(--input))]',
                )}
                ariaLabel="Filter by agent"
              />
            )}
            <button
              onClick={() => {
                refetch();
                setLiveEvents([]);
              }}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full cursor-pointer',
                'ring-1 ring-[hsl(var(--input))] bg-[hsl(var(--background))] shadow-sm',
                'hover:bg-[hsl(var(--muted))] hover:ring-[hsl(var(--ring))]',
                'focus:outline-none focus-visible:ring-[hsl(var(--ring))] transition-all',
              )}
            >
              <RefreshCw size={12} />
              Refresh
            </button>
          </>
        }
      />

      {/* ── Body ─────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-auto p-6">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Execution list (sidebar) */}
          <div className="lg:col-span-1 space-y-2">
            <h3 className="text-sm font-medium mb-2">Executions</h3>
            <button
              onClick={() => {
                setSelectedExecution(null);
                setExpandedEvents(new Set());
              }}
              className={cn(
                'w-full text-left px-3 py-2 text-xs rounded-xl border',
                !selectedExecution
                  ? 'border-[hsl(var(--primary))] bg-[hsl(var(--accent))]'
                  : 'border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]',
              )}
            >
              Live Events ({liveEvents.length})
            </button>
            {executions.map((exec: ExecutionInfo) => (
              <button
                key={exec.executionId}
                onClick={() => {
                  setSelectedExecution(exec);
                  setExpandedEvents(new Set());
                }}
                className={cn(
                  'w-full text-left px-3 py-2.5 text-xs rounded-xl border border-l-[3px] transition-colors',
                  STATUS_TINT[exec.status] ?? 'border-l-slate-400',
                  selectedExecution?.executionId === exec.executionId
                    ? 'border-[hsl(var(--primary))] bg-[hsl(var(--accent))]'
                    : 'border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]',
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium truncate">{exec.workflow}</span>
                  <StatusBadge status={exec.status} />
                </div>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-[hsl(var(--muted-foreground))] truncate">
                    {exec.executionId.slice(0, 8)}… | {exec.steps.length} steps
                  </span>
                  {exec.totalCost > 0 && <CostBadge cost={exec.totalCost} />}
                </div>
                <div className="flex items-center gap-2 mt-1 text-[10px] text-[hsl(var(--muted-foreground))]">
                  <span>{formatTimestamp(exec.startedAt)}</span>
                  {exec.duration > 0 && (
                    <>
                      <span className="text-[hsl(var(--border))]">·</span>
                      <span>{formatDuration(exec.duration)}</span>
                    </>
                  )}
                </div>
              </button>
            ))}
            {executions.length === 0 && (
              <p className="text-xs text-[hsl(var(--muted-foreground))]">No executions yet</p>
            )}
          </div>

          {/* Trace waterfall */}
          <div className="lg:col-span-3">
            {/* Stat cards for selected execution */}
            {stats && (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
                <StatCard label="Duration" value={formatDuration(stats.duration)} />
                <StatCard label="Events" value={String(stats.eventCount)} />
                <StatCard label="Cost" value={stats.cost > 0 ? formatCost(stats.cost) : '\u2014'} />
                <StatCard
                  label="Model"
                  value={stats.models.length > 0 ? stats.models[0]! : '\u2014'}
                  subtitle={
                    stats.models.length > 1 ? `+${stats.models.length - 1} more` : undefined
                  }
                />
              </div>
            )}

            {/* Result for completed executions */}
            {selectedExecution?.status === 'completed' && selectedExecution.result != null && (
              <div className="mb-4">
                <h3 className="text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))] mb-2">
                  Result
                </h3>
                <JsonViewer data={selectedExecution.result as Record<string, unknown>} />
              </div>
            )}

            {/* Toolbar row */}
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs text-[hsl(var(--muted-foreground))]">
                {filteredEvents.length} events
              </span>
              {filteredEvents.length > 0 && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={expandAll}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]"
                    title="Expand all"
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
                  const eventKey = event.step ?? i;
                  const isExpanded = expandedEvents.has(eventKey);
                  return (
                    <div key={eventKey}>
                      <button
                        onClick={() => toggleEvent(eventKey)}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs rounded-xl bg-[hsl(var(--secondary))] cursor-pointer hover:bg-[hsl(var(--accent))] text-left"
                        style={{ marginLeft: `${depth * 16}px` }}
                      >
                        {isExpanded ? (
                          <ChevronDown
                            size={12}
                            className="shrink-0 text-[hsl(var(--muted-foreground))]"
                          />
                        ) : (
                          <ChevronRight
                            size={12}
                            className="shrink-0 text-[hsl(var(--muted-foreground))]"
                          />
                        )}
                        <span className="font-mono text-[hsl(var(--muted-foreground))] w-8">
                          #{event.step != null ? event.step : i}
                        </span>
                        <span
                          className={`w-1.5 h-1.5 rounded-full shrink-0 ${getBarColor(event.type)}`}
                        />
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
                          {event.duration != null && event.duration > 0 && (
                            <div
                              className={`h-full rounded ${getBarColor(event.type)}`}
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
                              <strong>Tokens:</strong> in={event.tokens.input} out=
                              {event.tokens.output}
                              {event.tokens.reasoning ? ` reasoning=${event.tokens.reasoning}` : ''}
                            </p>
                          )}
                          {event.data != null && (
                            <JsonViewer data={event.data as Record<string, unknown>} collapsed />
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
