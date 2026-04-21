import { useState, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Play, FlaskConical } from 'lucide-react';
import { PanelHeader } from '../../components/layout/PanelHeader';
import { EmptyState } from '../../components/shared/EmptyState';
import { JsonEditor } from '../../components/shared/JsonEditor';
import { JsonViewer } from '../../components/shared/JsonViewer';
import { SchemaForm } from '../../components/shared/SchemaForm';
import { StatusBadge } from '../../components/shared/StatusBadge';
import { CommandPicker } from '../../components/shared/CommandPicker';
import { fetchWorkflows, fetchWorkflow, executeWorkflow } from '../../lib/api';
import { useWsStream } from '../../hooks/use-ws-stream';
import { cn, formatCost, formatDuration } from '../../lib/utils';
import { StatCard } from '../../components/shared/StatCard';
import { TraceEventList } from '../../components/shared/TraceEventList';
import { AskTree } from '../../components/shared/AskTree';
import { AskDetails } from '../../components/shared/AskDetails';
import { WorkflowStatsBar } from './WorkflowStatsBar';

export function WorkflowRunnerPanel() {
  const [selectedWorkflow, setSelectedWorkflow] = useState('');
  const [inputJson, setInputJson] = useState('{}');
  const [useSchemaForm, setUseSchemaForm] = useState(true);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('idle');
  // "run" holds the form + live/last execution result; "stats" shows the
  // aggregate WorkflowStatsBar. Split into tabs (following Trace Explorer's
  // Events|Stats pattern) because cohabiting form + results + stats in one
  // body made the form cramped and turned the stats into a "dead top strip".
  const [wfTab, setWfTab] = useState<'run' | 'stats'>('run');
  // Spec/16 §5.10.2: workflows now produce ask trees, not flat event
  // lists. AskTree is the default timeline view; the flat TraceEventList
  // stays available via a toggle for users who prefer the chronological
  // list or need to scan for specific event types.
  const [timelineView, setTimelineView] = useState<'tree' | 'flat'>('tree');
  // Selected ask surfaces as an AskDetails drawer alongside the tree.
  const [selectedAskId, setSelectedAskId] = useState<string | undefined>(undefined);

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

  // Reset run state when the user picks a different workflow so leftover
  // results/errors from the previous run don't leak into the new view.
  const handleSelectWorkflow = useCallback((name: string) => {
    setSelectedWorkflow(name);
    setInputJson('{}');
    setResult(undefined);
    setError(null);
    setStatus('idle');
  }, []);

  const selectedWorkflowMeta = workflows.find((w) => w.name === selectedWorkflow);

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

  // Post-spec/16: the wire carries AxlEvent directly. No more `step`
  // wrapper to unwrap — events flow verbatim from the runtime.
  const timelineEvents = stream.events;

  const hasSchema = !!workflowDetail?.inputSchema;
  const maxDuration = Math.max(...timelineEvents.map((e) => e.duration ?? 0), 1);
  // ask_end carries a per-ask cost rollup; skip it here to avoid
  // double-counting against the agent_call_end leaf events (spec §10).
  const totalDuration = timelineEvents.reduce((sum, e) => sum + (e.duration ?? 0), 0);
  const totalCost = timelineEvents.reduce(
    (sum, e) => (e.type === 'ask_end' ? sum : sum + (e.cost ?? 0)),
    0,
  );

  return (
    <div className="flex flex-col h-screen">
      <PanelHeader
        title="Workflow Runner"
        description={
          selectedWorkflowMeta ? (
            <>
              <span>{selectedWorkflowMeta.name}</span>
              {(selectedWorkflowMeta.hasInputSchema || selectedWorkflowMeta.hasOutputSchema) && (
                <>
                  <span className="opacity-40 mx-1.5">·</span>
                  <span>
                    {selectedWorkflowMeta.hasInputSchema && 'input schema'}
                    {selectedWorkflowMeta.hasInputSchema &&
                      selectedWorkflowMeta.hasOutputSchema &&
                      ' · '}
                    {selectedWorkflowMeta.hasOutputSchema && 'output schema'}
                  </span>
                </>
              )}
            </>
          ) : workflows.length > 0 ? (
            `${workflows.length} registered workflow${workflows.length !== 1 ? 's' : ''} · select one to run`
          ) : (
            'No workflows registered'
          )
        }
        actions={
          workflows.length > 0 && (
            <div
              className={cn(
                'inline-flex items-stretch rounded-full bg-[hsl(var(--background))] shrink-0',
                'ring-1 ring-[hsl(var(--input))] shadow-sm',
                'hover:ring-[hsl(var(--ring))] focus-within:ring-[hsl(var(--ring))]',
                'transition-shadow',
              )}
            >
              <CommandPicker
                items={workflows}
                value={selectedWorkflow}
                onSelect={handleSelectWorkflow}
                getKey={(w) => w.name}
                getLabel={(w) => w.name}
                getDescription={(w) => {
                  const parts = [];
                  if (w.hasInputSchema) parts.push('input schema');
                  if (w.hasOutputSchema) parts.push('output schema');
                  return parts.length > 0 ? parts.join(' · ') : 'no schema';
                }}
                placeholder="Select workflow"
                searchPlaceholder="Search workflows…"
                emptyLabel="No workflows registered"
                shortcut
                triggerClassName="rounded-l-full"
                ariaLabel="Select a workflow"
              />
              <button
                onClick={handleExecuteJson}
                disabled={!selectedWorkflow || status === 'running'}
                className={cn(
                  'inline-flex items-center gap-1.5 pl-3.5 pr-4 py-2 text-sm font-medium cursor-pointer',
                  'bg-[hsl(var(--foreground))] text-[hsl(var(--background))] rounded-r-full',
                  'hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-[hsl(var(--foreground))]',
                  'disabled:opacity-40 disabled:cursor-not-allowed transition-opacity',
                )}
              >
                <Play
                  size={12}
                  className={cn('fill-current', status === 'running' && 'animate-spin fill-none')}
                />
                {status === 'running' ? 'Running\u2026' : 'Run'}
              </button>
            </div>
          )
        }
      />

      {/* ── Tabs ─────────────────────────────────────── */}
      <div
        role="tablist"
        aria-label="Workflow Runner views"
        className="shrink-0 flex items-center gap-1 px-6 border-b border-[hsl(var(--border))]"
      >
        {(['run', 'stats'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={wfTab === t}
            onClick={() => setWfTab(t)}
            className={cn(
              'px-3 py-2.5 text-sm -mb-px border-b-2 transition-colors cursor-pointer',
              wfTab === t
                ? 'border-[hsl(var(--foreground))] text-[hsl(var(--foreground))] font-medium'
                : 'border-transparent text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]',
            )}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* ── Stats Tab ─────────────────────────────────── */}
      {wfTab === 'stats' && (
        <div className="flex-1 min-h-0 overflow-auto p-5">
          <WorkflowStatsBar
            onWorkflowClick={(name) => {
              handleSelectWorkflow(name);
              setWfTab('run');
            }}
            selectedWorkflow={selectedWorkflow}
          />
        </div>
      )}

      {/* ── Run Tab ───────────────────────────────────── */}
      {wfTab === 'run' && (
        <div className="flex-1 min-h-0 flex">
          {/* Left: Input configuration — narrower than before so Result +
            Timeline get more horizontal room. */}
          <div className="w-[320px] xl:w-[360px] shrink-0 border-r border-[hsl(var(--border))] overflow-y-auto p-5 space-y-4">
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

                {/* Timeline — the new default is the AskTree (spec/16
                  §5.10.2) so users see the ask graph first; a toggle
                  falls back to the flat TraceEventList that historical
                  screenshots showed. Clicking an ask opens AskDetails
                  alongside (when tree view is active). */}
                {timelineEvents.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                        Timeline
                      </h3>
                      <div className="flex gap-1 text-xs">
                        <button
                          type="button"
                          onClick={() => setTimelineView('tree')}
                          className={cn(
                            'px-2 py-0.5 rounded',
                            timelineView === 'tree'
                              ? 'bg-[hsl(var(--secondary))] text-[hsl(var(--secondary-foreground))]'
                              : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--secondary))]/50',
                          )}
                        >
                          Tree
                        </button>
                        <button
                          type="button"
                          onClick={() => setTimelineView('flat')}
                          className={cn(
                            'px-2 py-0.5 rounded',
                            timelineView === 'flat'
                              ? 'bg-[hsl(var(--secondary))] text-[hsl(var(--secondary-foreground))]'
                              : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--secondary))]/50',
                          )}
                        >
                          Flat
                        </button>
                      </div>
                    </div>
                    {timelineView === 'tree' ? (
                      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-3">
                        <AskTree
                          events={timelineEvents}
                          selectedAskId={selectedAskId}
                          onSelectAsk={setSelectedAskId}
                        />
                        {selectedAskId && (
                          <AskDetails
                            events={timelineEvents}
                            askId={selectedAskId}
                            onClose={() => setSelectedAskId(undefined)}
                            className="max-h-[600px] rounded border border-slate-200 dark:border-slate-700"
                          />
                        )}
                      </div>
                    ) : (
                      <TraceEventList events={timelineEvents} maxDuration={maxDuration} />
                    )}
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
      )}
    </div>
  );
}
