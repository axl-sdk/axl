import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart3 } from 'lucide-react';
import { StatCard } from '../../components/shared/StatCard';
import { EmptyState } from '../../components/shared/EmptyState';
import {
  WindowSelector,
  getStoredWindow,
  setStoredWindow,
} from '../../components/shared/WindowSelector';
import { fetchTraceStats } from '../../lib/api';
import { useWs } from '../../hooks/use-ws';
import { cn } from '../../lib/utils';
import type { WindowId, TraceStatsData, AggregateBroadcast } from '../../lib/types';

export function TraceStatsView() {
  const [window, setWindow] = useState<WindowId>(getStoredWindow);
  const [liveSnapshots, setLiveSnapshots] = useState<Record<WindowId, TraceStatsData> | null>(null);

  const { data: fetchedData } = useQuery({
    queryKey: ['trace-stats', window],
    queryFn: () => fetchTraceStats(window),
  });

  useWs(
    'trace-stats',
    useCallback((data: unknown) => {
      const broadcast = data as AggregateBroadcast<TraceStatsData>;
      if (broadcast.snapshots) setLiveSnapshots(broadcast.snapshots);
    }, []),
  );

  const handleWindowChange = (w: WindowId) => {
    setWindow(w);
    setStoredWindow(w);
  };

  const stats = liveSnapshots?.[window] ?? fetchedData;

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
  const maxEventCount = eventTypes[0]?.[1] ?? 0;

  const tools = Object.entries(stats.byTool).sort(([, a], [, b]) => b.calls - a.calls);

  const retries = Object.entries(stats.retryByAgent)
    .filter(([, r]) => r.schema + r.validate + r.guardrail > 0)
    .sort(
      ([, a], [, b]) => b.schema + b.validate + b.guardrail - (a.schema + a.validate + a.guardrail),
    );

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
        {/* Event type distribution */}
        <div>
          <h4 className="text-sm font-medium mb-3">Event Distribution</h4>
          <div className="rounded-xl border border-[hsl(var(--border))] overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[hsl(var(--border))] bg-[hsl(var(--card))]">
                  <th className="py-2 px-3 text-left font-medium">Type</th>
                  <th className="py-2 px-3 text-right font-medium">Count</th>
                  <th className="py-2 px-3 text-right font-medium w-24"></th>
                </tr>
              </thead>
              <tbody>
                {eventTypes.map(([type, count]) => (
                  <tr key={type} className="border-b last:border-b-0 border-[hsl(var(--border))]">
                    <td className="py-2 px-3 font-mono">{type}</td>
                    <td className="py-2 px-3 text-right">{count}</td>
                    <td className="py-2 px-3 text-right">
                      <div className="w-full bg-[hsl(var(--muted))] rounded-full h-1.5">
                        <div
                          className="bg-[hsl(var(--primary))] h-1.5 rounded-full"
                          style={{ width: `${(count / maxEventCount) * 100}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Tool calls */}
        {tools.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-3">Tool Calls</h4>
            <div className="rounded-xl border border-[hsl(var(--border))] overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[hsl(var(--border))] bg-[hsl(var(--card))]">
                    <th className="py-2 px-3 text-left font-medium">Tool</th>
                    <th className="py-2 px-3 text-right font-medium">Calls</th>
                    <th className="py-2 px-3 text-right font-medium">Approved</th>
                    <th className="py-2 px-3 text-right font-medium">Denied</th>
                  </tr>
                </thead>
                <tbody>
                  {tools.map(([tool, data]) => (
                    <tr key={tool} className="border-b last:border-b-0 border-[hsl(var(--border))]">
                      <td className="py-2 px-3 font-mono">{tool}</td>
                      <td className="py-2 px-3 text-right">{data.calls}</td>
                      <td className="py-2 px-3 text-right">
                        {data.approved > 0 ? (
                          <span className="text-green-600 dark:text-green-400">
                            {data.approved}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-2 px-3 text-right">
                        {data.denied > 0 ? (
                          <span className="text-red-500">{data.denied}</span>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Retry breakdown */}
        {retries.length > 0 && (
          <div className="lg:col-span-2">
            <h4 className="text-sm font-medium mb-3">Retries by Agent</h4>
            <div className="rounded-xl border border-[hsl(var(--border))] overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[hsl(var(--border))] bg-[hsl(var(--card))]">
                    <th className="py-2 px-3 text-left font-medium">Agent</th>
                    <th className="py-2 px-3 text-right font-medium">Schema</th>
                    <th className="py-2 px-3 text-right font-medium">Validate</th>
                    <th className="py-2 px-3 text-right font-medium">Guardrail</th>
                    <th className="py-2 px-3 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {retries.map(([agent, data]) => (
                    <tr
                      key={agent}
                      className="border-b last:border-b-0 border-[hsl(var(--border))]"
                    >
                      <td className="py-2 px-3 font-mono">{agent}</td>
                      <td
                        className={cn('py-2 px-3 text-right', data.schema > 0 && 'text-amber-500')}
                      >
                        {data.schema}
                      </td>
                      <td
                        className={cn(
                          'py-2 px-3 text-right',
                          data.validate > 0 && 'text-amber-500',
                        )}
                      >
                        {data.validate}
                      </td>
                      <td
                        className={cn('py-2 px-3 text-right', data.guardrail > 0 && 'text-red-500')}
                      >
                        {data.guardrail}
                      </td>
                      <td className="py-2 px-3 text-right font-medium">
                        {data.schema + data.validate + data.guardrail}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
