import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DollarSign } from 'lucide-react';
import { PanelShell } from '../../components/layout/PanelShell';
import { EmptyState } from '../../components/shared/EmptyState';
import { CostBadge } from '../../components/shared/CostBadge';
import { TokenBadge } from '../../components/shared/TokenBadge';
import { fetchCosts, resetCosts } from '../../lib/api';
import { useWs } from '../../hooks/use-ws';
import { formatCost, formatTokens } from '../../lib/utils';
import type { CostData } from '../../lib/types';

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
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <SummaryCard label="Total Cost" value={formatCost(costs.totalCost)} />
        <SummaryCard label="Input Tokens" value={formatTokens(costs.totalTokens.input)} />
        <SummaryCard label="Output Tokens" value={formatTokens(costs.totalTokens.output)} />
        <SummaryCard label="Reasoning Tokens" value={formatTokens(costs.totalTokens.reasoning)} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* By Agent */}
        <div>
          <h3 className="text-sm font-medium mb-3">Cost by Agent</h3>
          {Object.keys(costs.byAgent).length === 0 ? (
            <p className="text-xs text-[hsl(var(--muted-foreground))]">No agent data</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[hsl(var(--border))]">
                  <th className="text-left py-2 font-medium">Agent</th>
                  <th className="text-right py-2 font-medium">Calls</th>
                  <th className="text-right py-2 font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(costs.byAgent)
                  .sort(([, a], [, b]) => b.cost - a.cost)
                  .map(([agent, data]) => (
                    <tr key={agent} className="border-b border-[hsl(var(--border))]">
                      <td className="py-2 font-mono">{agent}</td>
                      <td className="py-2 text-right">{data.calls}</td>
                      <td className="py-2 text-right">
                        <CostBadge cost={data.cost} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </div>

        {/* By Model */}
        <div>
          <h3 className="text-sm font-medium mb-3">Cost by Model</h3>
          {Object.keys(costs.byModel).length === 0 ? (
            <p className="text-xs text-[hsl(var(--muted-foreground))]">No model data</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[hsl(var(--border))]">
                  <th className="text-left py-2 font-medium">Model</th>
                  <th className="text-right py-2 font-medium">Calls</th>
                  <th className="text-right py-2 font-medium">Tokens</th>
                  <th className="text-right py-2 font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(costs.byModel)
                  .sort(([, a], [, b]) => b.cost - a.cost)
                  .map(([model, data]) => (
                    <tr key={model} className="border-b border-[hsl(var(--border))]">
                      <td className="py-2 font-mono">{model}</td>
                      <td className="py-2 text-right">{data.calls}</td>
                      <td className="py-2 text-right">
                        <TokenBadge tokens={data.tokens.input + data.tokens.output} />
                      </td>
                      <td className="py-2 text-right">
                        <CostBadge cost={data.cost} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </div>

        {/* By Workflow */}
        <div className="lg:col-span-2">
          <h3 className="text-sm font-medium mb-3">Cost by Workflow</h3>
          {Object.keys(costs.byWorkflow).length === 0 ? (
            <p className="text-xs text-[hsl(var(--muted-foreground))]">No workflow data</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[hsl(var(--border))]">
                  <th className="text-left py-2 font-medium">Workflow</th>
                  <th className="text-right py-2 font-medium">Executions</th>
                  <th className="text-right py-2 font-medium">Total Cost</th>
                  <th className="text-right py-2 font-medium">Avg Cost</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(costs.byWorkflow)
                  .sort(([, a], [, b]) => b.cost - a.cost)
                  .map(([wf, data]) => (
                    <tr key={wf} className="border-b border-[hsl(var(--border))]">
                      <td className="py-2 font-mono">{wf}</td>
                      <td className="py-2 text-right">{data.executions}</td>
                      <td className="py-2 text-right">
                        <CostBadge cost={data.cost} />
                      </td>
                      <td className="py-2 text-right">
                        <CostBadge cost={data.executions > 0 ? data.cost / data.executions : 0} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </PanelShell>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-4 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      <p className="text-xs text-[hsl(var(--muted-foreground))]">{label}</p>
      <p className="text-2xl font-semibold mt-1">{value}</p>
    </div>
  );
}
