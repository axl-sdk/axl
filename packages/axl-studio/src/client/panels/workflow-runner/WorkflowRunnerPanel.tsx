import { useState, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { PanelShell } from '../../components/layout/PanelShell';
import { EmptyState } from '../../components/shared/EmptyState';
import { JsonEditor } from '../../components/shared/JsonEditor';
import { JsonViewer } from '../../components/shared/JsonViewer';
import { SchemaForm } from '../../components/shared/SchemaForm';
import { StatusBadge } from '../../components/shared/StatusBadge';
import { CostBadge } from '../../components/shared/CostBadge';
import { DurationBadge } from '../../components/shared/DurationBadge';
import { fetchWorkflows, fetchWorkflow, executeWorkflow } from '../../lib/api';
import { useWsStream } from '../../hooks/use-ws-stream';
import type { WorkflowSummary, TraceEvent } from '../../lib/types';

export function WorkflowRunnerPanel() {
  const [selectedWorkflow, setSelectedWorkflow] = useState('');
  const [inputJson, setInputJson] = useState('{}');
  const [useSchemaForm, setUseSchemaForm] = useState(true);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('idle');

  const { data: workflows = [] } = useQuery({
    queryKey: ['workflows'],
    queryFn: fetchWorkflows,
  });

  // Fetch workflow detail when selected (for input/output schemas)
  const { data: workflowDetail } = useQuery({
    queryKey: ['workflow', selectedWorkflow],
    queryFn: () => fetchWorkflow(selectedWorkflow),
    enabled: !!selectedWorkflow,
  });

  const stream = useWsStream(executionId);

  const doExecute = useCallback(
    async (input: unknown) => {
      if (!selectedWorkflow) return;

      setResult(null);
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

  // Handle stream completion
  useEffect(() => {
    if (stream.done && status === 'running') {
      setStatus(stream.error ? 'failed' : 'completed');
      if (stream.error) setError(stream.error);
      if (stream.result) setResult(stream.result);
      setExecutionId(null);
    }
  }, [stream.done, stream.error, stream.result, status]);

  // Extract timeline events from stream
  const timelineEvents = stream.events
    .filter((e): e is Extract<typeof e, { type: 'step' }> => e.type === 'step')
    .map((e) => e.data);

  const hasSchema = !!workflowDetail?.inputSchema;

  return (
    <PanelShell title="Workflow Runner" description="Execute and debug registered workflows">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Configuration */}
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Workflow</label>
            <select
              value={selectedWorkflow}
              onChange={(e) => {
                setSelectedWorkflow(e.target.value);
                setInputJson('{}');
                setResult(null);
                setError(null);
                setStatus('idle');
              }}
              className="w-full px-3 py-2 text-sm rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))]"
            >
              <option value="">Select a workflow...</option>
              {workflows.map((w: WorkflowSummary) => (
                <option key={w.name} value={w.name}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>

          {/* Output schema indicator */}
          {workflowDetail?.outputSchema != null && (
            <details className="text-xs">
              <summary className="cursor-pointer text-[hsl(var(--muted-foreground))]">
                Output Schema
              </summary>
              <div className="mt-1">
                <JsonViewer data={workflowDetail.outputSchema} collapsed />
              </div>
            </details>
          )}

          {/* Input: SchemaForm or raw JSON */}
          {hasSchema && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-[hsl(var(--muted-foreground))]">Input mode:</label>
              <button
                onClick={() => setUseSchemaForm(true)}
                className={`px-2 py-0.5 text-xs rounded ${useSchemaForm ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'border border-[hsl(var(--input))]'}`}
              >
                Form
              </button>
              <button
                onClick={() => setUseSchemaForm(false)}
                className={`px-2 py-0.5 text-xs rounded ${!useSchemaForm ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'border border-[hsl(var(--input))]'}`}
              >
                JSON
              </button>
            </div>
          )}

          {hasSchema && useSchemaForm ? (
            <SchemaForm
              schema={workflowDetail.inputSchema as Record<string, unknown>}
              onSubmit={handleSchemaSubmit}
              submitLabel={status === 'running' ? 'Running...' : 'Execute'}
            />
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium mb-1">Input (JSON)</label>
                <JsonEditor value={inputJson} onChange={setInputJson} />
              </div>
              <button
                onClick={handleExecuteJson}
                disabled={!selectedWorkflow || status === 'running'}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-50"
              >
                <Play size={14} />
                Execute
              </button>
            </>
          )}
        </div>

        {/* Right: Results */}
        <div className="space-y-4">
          {status !== 'idle' && (
            <div className="flex items-center gap-3">
              <StatusBadge status={status} />
              {stream.events.length > 0 && (
                <>
                  {timelineEvents.some((e) => e.cost) && (
                    <CostBadge cost={timelineEvents.reduce((sum, e) => sum + (e.cost ?? 0), 0)} />
                  )}
                  {timelineEvents.some((e) => e.duration) && (
                    <DurationBadge
                      ms={timelineEvents.reduce((sum, e) => sum + (e.duration ?? 0), 0)}
                    />
                  )}
                </>
              )}
            </div>
          )}

          {/* Timeline */}
          {timelineEvents.length > 0 && (
            <div>
              <h3 className="text-sm font-medium mb-2">Timeline</h3>
              <div className="space-y-1.5">
                {timelineEvents.map((event: TraceEvent, i: number) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 px-3 py-1.5 text-xs rounded bg-[hsl(var(--secondary))]"
                  >
                    <span className="font-mono text-[hsl(var(--muted-foreground))]">
                      #{event.step}
                    </span>
                    <span className="font-medium">{event.type}</span>
                    {event.agent && (
                      <span className="text-[hsl(var(--muted-foreground))]">{event.agent}</span>
                    )}
                    {event.tool && (
                      <span className="text-[hsl(var(--muted-foreground))]">{event.tool}</span>
                    )}
                    <span className="flex-1" />
                    {event.duration && <DurationBadge ms={event.duration} />}
                    {event.cost && <CostBadge cost={event.cost} />}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Result */}
          {result !== null && (
            <div>
              <h3 className="text-sm font-medium mb-2">Result</h3>
              <JsonViewer data={result} />
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="p-3 rounded-md bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm">
              {error}
            </div>
          )}

          {status === 'idle' && (
            <EmptyState
              title="No execution"
              description="Select a workflow and click Execute to see results."
            />
          )}
        </div>
      </div>
    </PanelShell>
  );
}
