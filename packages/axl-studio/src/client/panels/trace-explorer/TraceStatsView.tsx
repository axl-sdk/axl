import { BarChart3 } from 'lucide-react';
import { StatCard } from '../../components/shared/StatCard';
import { EmptyState } from '../../components/shared/EmptyState';
import { WindowSelector } from '../../components/shared/WindowSelector';
import { BarChart, StackedBarChart } from '../../components/shared/charts/BarChart';
import { fetchTraceStats } from '../../lib/api';
import { useAggregate } from '../../hooks/use-aggregate';

/** Retry reason colors — amber for recoverable, red for guardrail blocks. */
const RETRY_COLORS = {
  schema: '#f59e0b', // amber
  validate: '#eab308', // yellow
  guardrail: '#ef4444', // red
};

/** Event-type color map — stable across renders so the pie-like bar
 *  doesn't shuffle colors as data changes. Hand-picked for readability. */
const EVENT_TYPE_COLORS: Record<string, string> = {
  agent_call: '#3b82f6', // blue
  tool_call: '#10b981', // emerald
  tool_approval: '#14b8a6', // teal
  tool_denied: '#ef4444', // red
  workflow_start: '#8b5cf6', // violet
  workflow_end: '#6366f1', // indigo
  log: '#64748b', // slate
  guardrail: '#dc2626', // red-600
  schema_check: '#f59e0b', // amber
  validate: '#eab308', // yellow
  delegate: '#ec4899', // pink
  handoff: '#f97316', // orange
  verify: '#06b6d4', // cyan
};
function eventTypeColor(type: string): string {
  return EVENT_TYPE_COLORS[type] ?? '#64748b';
}

export function TraceStatsView() {
  const { window, handleWindowChange, data: stats } = useAggregate('trace-stats', fetchTraceStats);

  if (!stats || stats.totalEvents === 0) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-sm font-medium">Trace Stats</h3>
          <WindowSelector value={window} onChange={handleWindowChange} />
        </div>
        <EmptyState
          icon={<BarChart3 size={32} />}
          title="No trace stats yet"
          description="Execute workflows to see trace statistics."
        />
      </div>
    );
  }

  const eventTypes = Object.entries(stats.eventTypeCounts).sort(([, a], [, b]) => b - a);
  const tools = Object.entries(stats.byTool).sort(([, a], [, b]) => b.calls - a.calls);
  const retries = Object.entries(stats.retryByAgent).filter(
    ([, r]) => r.schema + r.validate + r.guardrail > 0,
  );

  // Event-type distribution as a horizontal bar chart (functions as "pie/bar")
  const eventTypeBars = eventTypes.map(([type, count]) => ({
    label: type,
    value: count,
    color: eventTypeColor(type),
  }));

  // Top-N tool calls bar chart
  const toolBars = tools.map(([name, data]) => ({
    label: name,
    value: data.calls,
  }));

  // Retry-by-agent stacked bar
  const retryStacks = retries.map(([agent, r]) => ({
    label: agent,
    segments: [
      { name: 'schema', value: r.schema, color: RETRY_COLORS.schema },
      { name: 'validate', value: r.validate, color: RETRY_COLORS.validate },
      { name: 'guardrail', value: r.guardrail, color: RETRY_COLORS.guardrail },
    ].filter((s) => s.value > 0),
  }));

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Trace Stats</h3>
        <WindowSelector value={window} onChange={handleWindowChange} />
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard label="Total Events" value={String(stats.totalEvents)} subtitle={window} />
        <StatCard label="Event Types" value={String(eventTypes.length)} subtitle="distinct types" />
        <StatCard
          label="Tools Used"
          value={String(tools.length)}
          subtitle={tools.length === 1 ? 'tool' : 'tools'}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Event type distribution — each bar colored for quick identification */}
        <div className="rounded-xl border border-[hsl(var(--border))] p-4">
          <h4 className="text-sm font-medium mb-3">Event Type Distribution</h4>
          <BarChart data={eventTypeBars} formatValue={(v) => v.toString()} />
        </div>

        {/* Top tools */}
        <div className="rounded-xl border border-[hsl(var(--border))] p-4">
          <h4 className="text-sm font-medium mb-3">
            Tool Calls {tools.length > 10 && <span className="text-[10px] text-[hsl(var(--muted-foreground))]">(top 10)</span>}
          </h4>
          {tools.length === 0 ? (
            <p className="text-xs text-[hsl(var(--muted-foreground))]">No tool activity in window</p>
          ) : (
            <BarChart data={toolBars} maxBars={10} />
          )}
        </div>

        {/* Retry breakdown */}
        {retries.length > 0 && (
          <div className="lg:col-span-2 rounded-xl border border-[hsl(var(--border))] p-4">
            <h4 className="text-sm font-medium mb-3">Retries by Agent</h4>
            <StackedBarChart data={retryStacks} formatValue={(v) => v.toString()} />
          </div>
        )}

        {/* Approval/denial counts (if any tool has non-zero) */}
        {tools.some(([, d]) => d.approved + d.denied > 0) && (
          <div className="lg:col-span-2 rounded-xl border border-[hsl(var(--border))] p-4">
            <h4 className="text-sm font-medium mb-3">Tool Approvals / Denials</h4>
            <StackedBarChart
              data={tools
                .filter(([, d]) => d.approved + d.denied > 0)
                .map(([name, d]) => ({
                  label: name,
                  segments: [
                    { name: 'approved', value: d.approved, color: '#10b981' },
                    { name: 'denied', value: d.denied, color: '#ef4444' },
                  ].filter((s) => s.value > 0),
                }))}
              formatValue={(v) => v.toString()}
            />
          </div>
        )}
      </div>
    </div>
  );
}
