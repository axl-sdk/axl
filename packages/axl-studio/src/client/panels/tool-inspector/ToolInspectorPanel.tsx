import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Wrench, ChevronRight, Loader2 } from 'lucide-react';
import { PanelShell } from '../../components/layout/PanelShell';
import { EmptyState } from '../../components/shared/EmptyState';
import { SchemaForm } from '../../components/shared/SchemaForm';
import { JsonViewer } from '../../components/shared/JsonViewer';
import { cn } from '../../lib/utils';
import { fetchTools, fetchTool, testTool } from '../../lib/api';
import type { ToolSummary } from '../../lib/types';

export function ToolInspectorPanel() {
  const [selectedToolName, setSelectedToolName] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [showRawSchema, setShowRawSchema] = useState(false);

  const { data: tools = [] } = useQuery({
    queryKey: ['tools'],
    queryFn: fetchTools,
  });

  // Fetch full tool detail when selected
  const { data: toolDetail } = useQuery({
    queryKey: ['tool', selectedToolName],
    queryFn: () => fetchTool(selectedToolName!),
    enabled: !!selectedToolName,
  });

  const handleTest = useCallback(
    async (input: Record<string, unknown>) => {
      if (!selectedToolName) return;
      setResult(null);
      setError(null);
      setRunning(true);

      try {
        const res = await testTool(selectedToolName, input);
        setResult(res.result);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRunning(false);
      }
    },
    [selectedToolName],
  );

  return (
    <PanelShell title="Tool Inspector" description="View tool schemas and test tools directly">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Tool list */}
        <div className="space-y-2">
          <h3 className="text-sm font-medium mb-2">Tools ({tools.length})</h3>
          {tools.length === 0 ? (
            <EmptyState
              icon={<Wrench size={24} />}
              title="No tools"
              description="Register tools with runtime.registerTool()"
            />
          ) : (
            tools.map((t: ToolSummary) => (
              <button
                key={t.name}
                onClick={() => {
                  setSelectedToolName(t.name);
                  setResult(undefined);
                  setError(null);
                  setShowRawSchema(false);
                }}
                className={`w-full text-left px-3 py-2 text-xs rounded-xl border ${
                  selectedToolName === t.name
                    ? 'border-[hsl(var(--primary))] bg-[hsl(var(--accent))]'
                    : 'border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]'
                }`}
              >
                <div className="font-medium">{t.name}</div>
                <div className="text-[hsl(var(--muted-foreground))] mt-0.5 truncate">
                  {t.description}
                </div>
                <div className="flex items-center gap-1.5 mt-1">
                  {t.sensitive && (
                    <span className="px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300 text-[10px]">
                      sensitive
                    </span>
                  )}
                  {t.requireApproval && (
                    <span className="px-1 py-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 text-[10px]">
                      approval
                    </span>
                  )}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Tool detail */}
        <div className="lg:col-span-2">
          {!selectedToolName ? (
            <EmptyState
              title="Select a tool"
              description="Click a tool to view its schema and test it"
            />
          ) : !toolDetail ? (
            <div className="flex items-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
              <Loader2 size={16} className="animate-spin" />
              Loading tool details...
            </div>
          ) : (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-medium">{toolDetail.name}</h3>
                <p className="text-sm text-[hsl(var(--muted-foreground))]">
                  {toolDetail.description}
                </p>
              </div>

              {/* Config badges */}
              <div className="flex flex-wrap items-center gap-2">
                {toolDetail.sensitive && (
                  <span className="px-2 py-1 text-xs rounded-md bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300">
                    Sensitive
                  </span>
                )}
                {toolDetail.requireApproval && (
                  <span className="px-2 py-1 text-xs rounded-md bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300">
                    Requires Approval
                  </span>
                )}
                {toolDetail.retry.attempts && toolDetail.retry.attempts > 1 && (
                  <span className="px-2 py-1 text-xs rounded-md bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300">
                    Retry: {toolDetail.retry.attempts}x {toolDetail.retry.backoff}
                  </span>
                )}
                {toolDetail.hasHooks && toolDetail.hooks && (
                  <span className="px-2 py-1 text-xs rounded-md bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300">
                    Hooks:{' '}
                    {[toolDetail.hooks.hasBefore && 'before', toolDetail.hooks.hasAfter && 'after']
                      .filter(Boolean)
                      .join(' + ')}
                  </span>
                )}
              </div>

              {/* Schema — collapsed by default */}
              <div>
                <button
                  onClick={() => setShowRawSchema(!showRawSchema)}
                  className="flex items-center gap-1.5 text-sm font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors"
                >
                  <ChevronRight
                    size={14}
                    className={cn('transition-transform', showRawSchema && 'rotate-90')}
                  />
                  View raw schema
                </button>
                {showRawSchema && (
                  <div className="mt-2">
                    <JsonViewer data={toolDetail.inputSchema} />
                  </div>
                )}
              </div>

              {/* Test form */}
              <div>
                <h4 className="text-sm font-medium mb-2">Test Tool</h4>
                <div className="rounded-xl border border-[hsl(var(--border))] p-4 bg-[hsl(var(--card))]">
                  <SchemaForm
                    schema={toolDetail.inputSchema as Record<string, unknown>}
                    onSubmit={handleTest}
                    submitLabel={running ? 'Running...' : 'Run Tool'}
                  />
                </div>
              </div>

              {/* Result */}
              {result !== undefined && (
                <div>
                  <h4 className="text-sm font-medium mb-2">Result</h4>
                  <div className="rounded-xl border border-[hsl(var(--border))] p-4 bg-[hsl(var(--card))]">
                    <JsonViewer data={result} />
                  </div>
                </div>
              )}

              {/* Error */}
              {error && (
                <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm">
                  {error}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </PanelShell>
  );
}
