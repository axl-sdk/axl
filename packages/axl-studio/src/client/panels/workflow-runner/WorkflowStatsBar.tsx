import { StatCard } from '../../components/shared/StatCard';
import { WindowSelector } from '../../components/shared/WindowSelector';
import { fetchWorkflowStats } from '../../lib/api';
import { useAggregate } from '../../hooks/use-aggregate';
import { cn, formatDuration } from '../../lib/utils';

export function WorkflowStatsBar({
  onWorkflowClick,
  selectedWorkflow,
}: {
  /** Fires when a row in the stats table is clicked — selects that workflow for the next run. */
  onWorkflowClick?: (name: string) => void;
  /** Highlights the currently-selected workflow row. */
  selectedWorkflow?: string;
} = {}) {
  const {
    window,
    handleWindowChange,
    data: stats,
  } = useAggregate('workflow-stats', fetchWorkflowStats);

  const isEmpty = !stats || stats.totalExecutions === 0;
  const workflows = stats
    ? Object.entries(stats.byWorkflow).sort(([, a], [, b]) => b.total - a.total)
    : [];

  // When no executions fall inside the current window, keep the header +
  // selector visible so the user can switch to a wider window. Previously
  // this returned null, which hid the selector entirely — a dead end if
  // 24h was empty but 7d had data.
  if (isEmpty) {
    return (
      <div className="space-y-3 mb-5">
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
            Workflow Stats
          </h3>
          <WindowSelector value={window} onChange={handleWindowChange} />
        </div>
        <p className="text-xs text-[hsl(var(--muted-foreground))] italic">
          No executions in the {window} window. Try a wider window.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 mb-5">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
          Workflow Stats
        </h3>
        <WindowSelector value={window} onChange={handleWindowChange} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Total Executions"
          value={String(stats.totalExecutions)}
          subtitle={window}
        />
        <StatCard
          label="Failure Rate"
          value={`${(stats.failureRate * 100).toFixed(1)}%`}
          subtitle={stats.failureRate > 0.1 ? 'high' : 'normal'}
          subtitleColor={stats.failureRate > 0.1 ? 'text-red-500' : undefined}
        />
      </div>

      {workflows.length > 0 && (
        <div className="rounded-xl border border-[hsl(var(--border))] overflow-x-auto">
          <table className="w-full text-xs min-w-[560px]">
            <thead>
              <tr className="border-b border-[hsl(var(--border))] bg-[hsl(var(--card))]">
                <th className="py-2 px-3 text-left font-medium">Workflow</th>
                <th className="py-2 px-3 text-right font-medium">Total</th>
                <th className="py-2 px-3 text-right font-medium">Failed</th>
                <th
                  className="py-2 px-3 text-right font-medium"
                  title="50th percentile duration (approximate for workflows with 200+ executions)"
                >
                  p50
                </th>
                <th
                  className="py-2 px-3 text-right font-medium"
                  title="95th percentile duration (approximate for workflows with 200+ executions)"
                >
                  p95
                </th>
                <th className="py-2 px-3 text-right font-medium">Avg</th>
              </tr>
            </thead>
            <tbody>
              {workflows.map(([name, wf]) => (
                <tr
                  key={name}
                  onClick={onWorkflowClick ? () => onWorkflowClick(name) : undefined}
                  className={cn(
                    'border-b last:border-b-0 border-[hsl(var(--border))]',
                    onWorkflowClick && 'cursor-pointer hover:bg-[hsl(var(--accent))]',
                    selectedWorkflow === name && 'bg-[hsl(var(--accent))]',
                  )}
                  title={onWorkflowClick ? 'Click to select this workflow' : undefined}
                >
                  <td className="py-2 px-3 font-mono">{name}</td>
                  <td className="py-2 px-3 text-right">{wf.total}</td>
                  <td className="py-2 px-3 text-right">
                    {wf.failed > 0 ? <span className="text-red-500">{wf.failed}</span> : '0'}
                  </td>
                  <td className="py-2 px-3 text-right font-mono">
                    {wf.durationP50 != null ? formatDuration(wf.durationP50) : '—'}
                  </td>
                  <td className="py-2 px-3 text-right font-mono">
                    {wf.durationP95 != null ? formatDuration(wf.durationP95) : '—'}
                  </td>
                  <td className="py-2 px-3 text-right font-mono">
                    {formatDuration(wf.avgDuration)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
