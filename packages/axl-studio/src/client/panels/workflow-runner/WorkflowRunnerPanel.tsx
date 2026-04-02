import { useState, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Play, FlaskConical } from 'lucide-react';
import { EmptyState } from '../../components/shared/EmptyState';
import { JsonEditor } from '../../components/shared/JsonEditor';
import { JsonViewer } from '../../components/shared/JsonViewer';
import { SchemaForm } from '../../components/shared/SchemaForm';
import { StatusBadge } from '../../components/shared/StatusBadge';
import { fetchWorkflows, fetchWorkflow, executeWorkflow } from '../../lib/api';
import { useWsStream } from '../../hooks/use-ws-stream';
import { cn, formatCost, formatDuration } from '../../lib/utils';
import type { WorkflowSummary, TraceEvent } from '../../lib/types';
import { StatCard } from '../../components/shared/StatCard';
import { getBarColor, getDepth } from '../../lib/trace-utils';

export function WorkflowRunnerPanel() {
  const [selectedWorkflow, setSelectedWorkflow] = useState('');
  const [inputJson, setInputJson] = useState('{}');
  const [useSchemaForm, setUseSchemaForm] = useState(true);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('idle');

  const { data: workflows = [] } = useQuery({
    queryKey: ['workflows'],
    queryFn: fetchWorkflows,
  });

  const { data: workflowDetail } = useQuery({
    queryKey: ['workflow', selectedWorkflow],
    queryFn: () => fetchWorkflow(selectedWorkflow),
    enabled: !!selectedWorkflow,
  });

  const stream = useWsStream(executionId);

  const doExecute = useCallback(
    async (input: unknown) => {
      if (!selectedWorkflow) return;
      setResult(undefined);
      setError(null);
      setStatus('running');

      try {
        const res = await executeWorkflow(selectedWorkflow, input, true);
        if (res.streaming && res.executionId) {
          setExecutionId(res.executionId);
        } else {
          setResult(res.result);
          setStatus('completed');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus('failed');
      }
    },
    [selectedWorkflow],
  );

  const handleExecuteJson = useCallback(() => {
    try {
      const input = JSON.parse(inputJson);
      doExecute(input);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('failed');
    }
  }, [inputJson, doExecute]);

  const handleSchemaSubmit = useCallback(
    (values: Record<string, unknown>) => {
      doExecute(values);
    },
    [doExecute],
  );

  useEffect(() => {
    if (stream.done && status === 'running') {
      setStatus(stream.error ? 'failed' : 'completed');
      if (stream.error) setError(stream.error);
      if (stream.result !== undefined) setResult(stream.result);
      setExecutionId(null);
    }
  }, [stream.done, stream.error, stream.result, status]);

  const timelineEvents = stream.events
    .filter((e): e is Extract<typeof e, { type: 'step' }> => e.type === 'step')
    .map((e) => e.data);

  const hasSchema = !!workflowDetail?.inputSchema;
  const maxDuration = Math.max(...timelineEvents.map((e) => e.duration ?? 0), 1);
  const totalDuration = timelineEvents.reduce((sum, e) => sum + (e.duration ?? 0), 0);
  const totalCost = timelineEvents.reduce((sum, e) => sum + (e.cost ?? 0), 0);

  return (
    <div className="flex flex-col h-screen">
      {/* ── Header ─────────────────────────────────────── */}
      <header className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-[hsl(var(--border))]">
        <h2 className="text-xl font-semibold">Workflows</h2>
        {workflows.length > 0 && (
          <div className="flex items-center gap-2">
            <select
              value={selectedWorkflow}
              onChange={(e) => {
                setSelectedWorkflow(e.target.value);
                setInputJson('{}');
                setResult(undefined);
                setError(null);
                setStatus('idle');
              }}
              className="px-3 py-1.5 text-sm rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))] min-w-[180px]"
            >
              <option value="">Select workflow…</option>
              {workflows.map((w: WorkflowSummary) => (
                <option key={w.name} value={w.name}>
                  {w.name}
                </option>
              ))}
            </select>
            <button
              onClick={handleExecuteJson}
              disabled={!selectedWorkflow || status === 'running'}
              className={cn(
                'inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded-lg transition-all',
                'bg-[hsl(var(--foreground))] text-[hsl(var(--background))]',
                'hover:opacity-90 disabled:opacity-40',
              )}
            >
              <Play size={12} className={status === 'running' ? 'animate-spin' : ''} />
              {status === 'running' ? 'Running…' : 'Run'}
            </button>
          </div>
        )}
      </header>

      {/* ── Body ───────────────────────────────────────── */}
      <div className="flex-1 min-h-0 flex border-t border-[hsl(var(--border))]">
        {/* Left: Input configuration */}
        <div className="w-[400px] xl:w-[480px] shrink-0 border-r border-[hsl(var(--border))] overflow-y-auto p-5 space-y-4">
          {/* Input mode toggle */}
          {hasSchema && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => setUseSchemaForm(true)}
                className={cn(
                  'px-3 py-1 text-xs rounded-lg transition-colors',
                  useSchemaForm
                    ? 'bg-[hsl(var(--foreground))] text-[hsl(var(--background))]'
                    : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]',
                )}
              >
                Form
              </button>
              <button
                onClick={() => setUseSchemaForm(false)}
                className={cn(
                  'px-3 py-1 text-xs rounded-lg transition-colors',
                  !useSchemaForm
                    ? 'bg-[hsl(var(--foreground))] text-[hsl(var(--background))]'
                    : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]',
                )}
              >
                JSON
              </button>
            </div>
          )}

          {/* Input form or editor */}
          {hasSchema && useSchemaForm ? (
            <SchemaForm
              schema={workflowDetail.inputSchema as Record<string, unknown>}
              onSubmit={handleSchemaSubmit}
              submitLabel={status === 'running' ? 'Running…' : 'Execute'}
            />
          ) : (
            <div>
              <label className="block text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))] mb-2">
                Input (JSON)
              </label>
              <JsonEditor value={inputJson} onChange={setInputJson} />
            </div>
          )}

          {/* Output schema (collapsed) */}
          {workflowDetail?.outputSchema != null && (
            <div>
              <label className="block text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))] mb-2">
                Output Schema
              </label>
              <JsonViewer data={workflowDetail.outputSchema} collapsed />
            </div>
          )}
        </div>

        {/* Right: Results */}
        <div className="flex-1 overflow-y-auto p-5">
          {status === 'idle' ? (
            <div className="flex items-center justify-center h-full">
              <EmptyState
                icon={<FlaskConical size={32} />}
                title="No execution"
                description="Select a workflow and click Run to see results."
              />
            </div>
          ) : (
            <div className="space-y-5">
              {/* Stat cards */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <StatCard label="Status" badge={<StatusBadge status={status} />} />
                <StatCard label="Steps" value={String(timelineEvents.length)} />
                <StatCard
                  label="Duration"
                  value={totalDuration > 0 ? formatDuration(totalDuration) : '\u2014'}
                />
                <StatCard label="Cost" value={totalCost > 0 ? formatCost(totalCost) : '\u2014'} />
              </div>

              {/* Error */}
              {error && (
                <div className="p-4 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm">
                  {error}
                </div>
              )}

              {/* Result */}
              {result !== undefined && (
                <div>
                  <h3 className="text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))] mb-2">
                    Result
                  </h3>
                  <JsonViewer data={result} />
                </div>
              )}

              {/* Timeline */}
              {timelineEvents.length > 0 && (
                <div>
                  <h3 className="text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))] mb-2">
                    Timeline
                  </h3>
                  <div className="space-y-1">
                    {timelineEvents.map((event: TraceEvent, i: number) => {
                      const depth = getDepth(event);
                      return (
                        <details key={i} className="group">
                          <summary
                            className="flex items-center gap-2 px-3 py-1.5 text-xs rounded-xl bg-[hsl(var(--secondary))] cursor-pointer hover:bg-[hsl(var(--accent))]"
                            style={{ marginLeft: `${depth * 16}px` }}
                          >
                            <span className="font-mono text-[hsl(var(--muted-foreground))] w-8">
                              #{event.step}
                            </span>
                            <span
                              className={`w-1.5 h-1.5 rounded-full shrink-0 ${getBarColor(event.type)}`}
                            />
                            <span className="font-medium w-24 truncate">{event.type}</span>
                            {event.agent && (
                              <span className="text-blue-600 dark:text-blue-400 w-24 truncate">
                                {event.agent}
                              </span>
                            )}
                            {event.tool && (
                              <span className="text-purple-600 dark:text-purple-400 w-24 truncate">
                                {event.tool}
                              </span>
                            )}
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
                            {event.duration != null && (
                              <span className="text-[10px] font-mono text-[hsl(var(--muted-foreground))]">
                                {formatDuration(event.duration)}
                              </span>
                            )}
                          </summary>
                          <div
                            className="mt-1 mb-2 p-3 rounded-xl bg-[hsl(var(--card))] border border-[hsl(var(--border))]"
                            style={{ marginLeft: `${depth * 16 + 32}px` }}
                          >
                            {event.model && (
                              <p className="text-xs mb-1">
                                <strong>Model:</strong> {event.model}
                              </p>
                            )}
                            {event.tokens && (
                              <p className="text-xs mb-1">
                                <strong>Tokens:</strong> in={event.tokens.input} out=
                                {event.tokens.output}
                                {event.tokens.reasoning
                                  ? ` reasoning=${event.tokens.reasoning}`
                                  : ''}
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
                </div>
              )}

              {/* Loading indicator */}
              {status === 'running' && timelineEvents.length === 0 && (
                <div className="flex items-center justify-center py-12 text-sm text-[hsl(var(--muted-foreground))]">
                  <FlaskConical size={16} className="animate-pulse mr-2" />
                  Executing workflow…
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
