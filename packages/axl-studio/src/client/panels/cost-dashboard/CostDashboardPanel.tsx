import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DollarSign } from 'lucide-react';
import { PanelShell } from '../../components/layout/PanelShell';
import { EmptyState } from '../../components/shared/EmptyState';
import { CostBadge } from '../../components/shared/CostBadge';
import { TokenBadge } from '../../components/shared/TokenBadge';
import { fetchCosts, resetCosts } from '../../lib/api';
import { useWs } from '../../hooks/use-ws';
import { cn, formatCost, formatTokens } from '../../lib/utils';
import type { CostData } from '../../lib/types';
import { StatCard } from '../../components/shared/StatCard';

export function CostDashboardPanel() {
  const [liveCosts, setLiveCosts] = useState<CostData | null>(null);

  const { data: fetchedCosts, refetch } = useQuery({
    queryKey: ['costs'],
    queryFn: fetchCosts,
  });

  // Live updates via WS
  useWs(
    'costs',
    useCallback((data: unknown) => {
      setLiveCosts(data as CostData);
    }, []),
  );

  const costs = liveCosts ?? fetchedCosts;

  const handleReset = async () => {
    await resetCosts();
    setLiveCosts(null);
    refetch();
  };

  if (!costs) {
    return (
      <PanelShell
        title="Cost Dashboard"
        description="Track spending across agents, models, and workflows"
      >
        <EmptyState
          icon={<DollarSign size={32} />}
          title="No cost data"
          description="Execute workflows to see cost data."
        />
      </PanelShell>
    );
  }

  const showReasoning = costs.totalTokens.reasoning > 0;

  return (
    <PanelShell
      title="Cost Dashboard"
      description="Track spending across agents, models, and workflows"
      actions={
        <button
          onClick={handleReset}
          className="px-3 py-1.5 text-sm rounded-md border border-[hsl(var(--input))] hover:bg-[hsl(var(--accent))]"
        >
          Reset
        </button>
      }
    >
      {/* Summary Cards */}
      <div
        className={cn(
          'grid grid-cols-1 sm:grid-cols-2 gap-3 mb-8',
          showReasoning ? 'lg:grid-cols-4' : 'lg:grid-cols-3',
        )}
      >
        <StatCard label="Total Cost" value={formatCost(costs.totalCost)} subtitle="all time" />
        <StatCard
          label="Input Tokens"
          value={formatTokens(costs.totalTokens.input)}
          subtitle="prompt"
        />
        <StatCard
          label="Output Tokens"
          value={formatTokens(costs.totalTokens.output)}
          subtitle="completion"
        />
        {showReasoning && (
          <StatCard
            label="Reasoning Tokens"
            value={formatTokens(costs.totalTokens.reasoning)}
            subtitle="thinking"
          />
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* By Agent */}
        <div>
          <h3 className="text-sm font-medium mb-3">Cost by Agent</h3>
          {Object.keys(costs.byAgent).length === 0 ? (
            <p className="text-xs text-[hsl(var(--muted-foreground))]">No agent data</p>
          ) : (
            <CostTable
              headers={['Agent', 'Calls', 'Cost']}
              rows={Object.entries(costs.byAgent)
                .sort(([, a], [, b]) => b.cost - a.cost)
                .map(([agent, data]) => ({
                  key: agent,
                  cells: [
                    <span className="font-mono">{agent}</span>,
                    <span>{data.calls}</span>,
                    <CostBadge cost={data.cost} />,
                  ],
                  cost: data.cost,
                }))}
              maxCost={Math.max(...Object.values(costs.byAgent).map((d) => d.cost))}
            />
          )}
        </div>

        {/* By Model */}
        <div>
          <h3 className="text-sm font-medium mb-3">Cost by Model</h3>
          {Object.keys(costs.byModel).length === 0 ? (
            <p className="text-xs text-[hsl(var(--muted-foreground))]">No model data</p>
          ) : (
            <CostTable
              headers={['Model', 'Calls', 'Tokens', 'Cost']}
              rows={Object.entries(costs.byModel)
                .sort(([, a], [, b]) => b.cost - a.cost)
                .map(([model, data]) => ({
                  key: model,
                  cells: [
                    <span className="font-mono">{model}</span>,
                    <span>{data.calls}</span>,
                    <TokenBadge tokens={data.tokens.input + data.tokens.output} />,
                    <CostBadge cost={data.cost} />,
                  ],
                  cost: data.cost,
                }))}
              maxCost={Math.max(...Object.values(costs.byModel).map((d) => d.cost))}
            />
          )}
        </div>

        {/* By Workflow */}
        <div className="lg:col-span-2">
          <h3 className="text-sm font-medium mb-3">Cost by Workflow</h3>
          {Object.keys(costs.byWorkflow).length === 0 ? (
            <p className="text-xs text-[hsl(var(--muted-foreground))]">No workflow data</p>
          ) : (
            <CostTable
              headers={['Workflow', 'Executions', 'Total Cost', 'Avg Cost']}
              rows={Object.entries(costs.byWorkflow)
                .sort(([, a], [, b]) => b.cost - a.cost)
                .map(([wf, data]) => ({
                  key: wf,
                  cells: [
                    <span className="font-mono">{wf}</span>,
                    <span>{data.executions}</span>,
                    <CostBadge cost={data.cost} />,
                    <CostBadge cost={data.executions > 0 ? data.cost / data.executions : 0} />,
                  ],
                  cost: data.cost,
                }))}
              maxCost={Math.max(...Object.values(costs.byWorkflow).map((d) => d.cost))}
            />
          )}
        </div>
      </div>
    </PanelShell>
  );
}

function CostTable({
  headers,
  rows,
  maxCost,
}: {
  headers: string[];
  rows: { key: string; cells: React.ReactNode[]; cost: number }[];
  maxCost: number;
}) {
  return (
    <div className="rounded-xl border border-[hsl(var(--border))] overflow-hidden">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-[hsl(var(--border))] bg-[hsl(var(--card))]">
            {headers.map((h, i) => (
              <th
                key={h}
                className={cn('py-2 px-3 font-medium', i === 0 ? 'text-left' : 'text-right')}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b last:border-b-0 border-[hsl(var(--border))]">
              {row.cells.map((cell, i) => (
                <td
                  key={i}
                  className={cn('py-2 px-3 relative', i === 0 ? 'text-left' : 'text-right')}
                >
                  {/* Proportion bar on cost column (last column) */}
                  {i === row.cells.length - 1 && maxCost > 0 && (
                    <div
                      className="absolute inset-y-0 right-0 bg-[hsl(var(--primary)/0.08)] rounded-sm"
                      style={{ width: `${(row.cost / maxCost) * 100}%` }}
                    />
                  )}
                  <span className="relative">{cell}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
