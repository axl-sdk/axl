import { StatCard } from '../../components/shared/StatCard';
import { WindowSelector } from '../../components/shared/WindowSelector';
import { fetchWorkflowStats } from '../../lib/api';
import { useAggregate } from '../../hooks/use-aggregate';
import { formatDuration } from '../../lib/utils';

export function WorkflowStatsBar() {
  const {
    window,
    handleWindowChange,
    data: stats,
  } = useAggregate('workflow-stats', fetchWorkflowStats);
  if (!stats || stats.totalExecutions === 0) return null;

  const workflows = Object.entries(stats.byWorkflow).sort(([, a], [, b]) => b.total - a.total);

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
        <div className="rounded-xl border border-[hsl(var(--border))] overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[hsl(var(--border))] bg-[hsl(var(--card))]">
                <th className="py-2 px-3 text-left font-medium">Workflow</th>
                <th className="py-2 px-3 text-right font-medium">Total</th>
                <th className="py-2 px-3 text-right font-medium">Failed</th>
                <th className="py-2 px-3 text-right font-medium">p50</th>
                <th className="py-2 px-3 text-right font-medium">p95</th>
                <th className="py-2 px-3 text-right font-medium">Avg</th>
              </tr>
            </thead>
            <tbody>
              {workflows.map(([name, wf]) => (
                <tr key={name} className="border-b last:border-b-0 border-[hsl(var(--border))]">
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
