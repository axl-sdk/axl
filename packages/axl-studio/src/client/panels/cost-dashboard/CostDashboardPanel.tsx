import { useState, useMemo } from 'react';
import { DollarSign } from 'lucide-react';
import { PanelShell } from '../../components/layout/PanelShell';
import { EmptyState } from '../../components/shared/EmptyState';
import { CostBadge } from '../../components/shared/CostBadge';
import { TokenBadge } from '../../components/shared/TokenBadge';
import { WindowSelector } from '../../components/shared/WindowSelector';
import { fetchCosts } from '../../lib/api';
import { useAggregate } from '../../hooks/use-aggregate';
import { cn, formatCost, formatTokens } from '../../lib/utils';
import type { CostData } from '../../lib/types';
import { StatCard } from '../../components/shared/StatCard';

export function CostDashboardPanel() {
  const { window, handleWindowChange, data: costs } = useAggregate<CostData>('costs', fetchCosts);

  if (!costs) {
    return (
      <PanelShell
        title="Cost Dashboard"
        description="Spending across agents, models, and workflows"
        actions={<WindowSelector value={window} onChange={handleWindowChange} />}
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
  const agentCount = Object.keys(costs.byAgent).length;
  const modelCount = Object.keys(costs.byModel).length;
  // Retry overhead: cost spent re-asking the LLM because a gate failed.
  // Back-compat: the `retry` bucket was added after 0.14.x — degrade gracefully
  // if a client is connected to an older server that doesn't emit it.
  const retry = costs.retry ?? {
    primary: 0,
    primaryCalls: 0,
    schema: 0,
    schemaCalls: 0,
    validate: 0,
    validateCalls: 0,
    guardrail: 0,
    guardrailCalls: 0,
    retryCalls: 0,
  };
  const retryCost = retry.schema + retry.validate + retry.guardrail;
  const retryPercent = costs.totalCost > 0 ? (retryCost / costs.totalCost) * 100 : 0;

  // Embedder costs from semantic memory ops. Back-compat: older servers
  // don't emit this field; consumers degrade gracefully to an empty record.
  const byEmbedder = costs.byEmbedder ?? {};
  const embedderEntries = Object.entries(byEmbedder);
  const embedderTotalCost = embedderEntries.reduce((sum, [, d]) => sum + d.cost, 0);
  const embedderTotalCalls = embedderEntries.reduce((sum, [, d]) => sum + d.calls, 0);
  const embedderTotalTokens = embedderEntries.reduce((sum, [, d]) => sum + d.tokens, 0);
  const embedderPercent = costs.totalCost > 0 ? (embedderTotalCost / costs.totalCost) * 100 : 0;

  return (
    <PanelShell
      title="Cost Dashboard"
      description={
        costs.totalCost > 0 ? (
          <>
            <span>{formatCost(costs.totalCost)} total</span>
            <span className="opacity-40 mx-1.5">·</span>
            <span>
              {agentCount} agent{agentCount !== 1 ? 's' : ''}
            </span>
            <span className="opacity-40 mx-1.5">·</span>
            <span>
              {modelCount} model{modelCount !== 1 ? 's' : ''}
            </span>
          </>
        ) : (
          'Spending across agents, models, and workflows'
        )
      }
      actions={<WindowSelector value={window} onChange={handleWindowChange} />}
    >
      {/* Summary Cards */}
      <div
        className={cn(
          'grid grid-cols-1 sm:grid-cols-2 gap-3 mb-8',
          showReasoning ? 'lg:grid-cols-4' : 'lg:grid-cols-3',
        )}
      >
        <StatCard label="Total Cost" value={formatCost(costs.totalCost)} subtitle={window} />
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
            <CostTable<{ agent: string; cost: number; calls: number }>
              columns={[
                {
                  label: 'Agent',
                  sortKey: (row) => row.agent,
                  render: (row) => <span className="font-mono">{row.agent}</span>,
                },
                {
                  label: 'Calls',
                  sortKey: (row) => row.calls,
                  render: (row) => <span>{row.calls}</span>,
                },
                {
                  label: 'Cost',
                  sortKey: (row) => row.cost,
                  render: (row) => <CostBadge cost={row.cost} />,
                },
              ]}
              rows={Object.entries(costs.byAgent).map(([agent, data]) => ({
                agent,
                cost: data.cost,
                calls: data.calls,
              }))}
              rowKey={(row) => row.agent}
              defaultSort={{ index: 2, dir: 'desc' }}
              costValue={(row) => row.cost}
            />
          )}
        </div>

        {/* By Model */}
        <div>
          <h3 className="text-sm font-medium mb-3">Cost by Model</h3>
          {Object.keys(costs.byModel).length === 0 ? (
            <p className="text-xs text-[hsl(var(--muted-foreground))]">No model data</p>
          ) : (
            <CostTable<{ model: string; calls: number; tokens: number; cost: number }>
              columns={[
                {
                  label: 'Model',
                  sortKey: (row) => row.model,
                  render: (row) => <span className="font-mono">{row.model}</span>,
                },
                {
                  label: 'Calls',
                  sortKey: (row) => row.calls,
                  render: (row) => <span>{row.calls}</span>,
                },
                {
                  label: 'Tokens',
                  sortKey: (row) => row.tokens,
                  render: (row) => <TokenBadge tokens={row.tokens} />,
                },
                {
                  label: 'Cost',
                  sortKey: (row) => row.cost,
                  render: (row) => <CostBadge cost={row.cost} />,
                },
              ]}
              rows={Object.entries(costs.byModel).map(([model, data]) => ({
                model,
                calls: data.calls,
                tokens: data.tokens.input + data.tokens.output,
                cost: data.cost,
              }))}
              rowKey={(row) => row.model}
              defaultSort={{ index: 3, dir: 'desc' }}
              costValue={(row) => row.cost}
            />
          )}
        </div>

        {/* By Workflow */}
        <div className="lg:col-span-2">
          <h3 className="text-sm font-medium mb-3">Cost by Workflow</h3>
          {Object.keys(costs.byWorkflow).length === 0 ? (
            <p className="text-xs text-[hsl(var(--muted-foreground))]">No workflow data</p>
          ) : (
            <CostTable<{
              workflow: string;
              executions: number;
              cost: number;
              avgCost: number;
            }>
              columns={[
                {
                  label: 'Workflow',
                  sortKey: (row) => row.workflow,
                  render: (row) => <span className="font-mono">{row.workflow}</span>,
                },
                {
                  label: 'Executions',
                  sortKey: (row) => row.executions,
                  render: (row) => <span>{row.executions}</span>,
                },
                {
                  label: 'Total Cost',
                  sortKey: (row) => row.cost,
                  render: (row) => <CostBadge cost={row.cost} />,
                },
                {
                  label: 'Avg Cost',
                  sortKey: (row) => row.avgCost,
                  render: (row) => <CostBadge cost={row.avgCost} />,
                },
              ]}
              rows={Object.entries(costs.byWorkflow).map(([wf, data]) => ({
                workflow: wf,
                executions: data.executions,
                cost: data.cost,
                avgCost: data.executions > 0 ? data.cost / data.executions : 0,
              }))}
              rowKey={(row) => row.workflow}
              defaultSort={{ index: 2, dir: 'desc' }}
              costValue={(row) => row.cost}
            />
          )}
        </div>

        {/* Memory (embedder) cost breakdown: semantic `ctx.recall({query})`
             and `ctx.remember({embed:true})` hit a paid embedding API.
             Only render when there's at least one embedder call on record. */}
        {embedderEntries.length > 0 && (
          <div className="lg:col-span-2">
            <div className="flex items-baseline justify-between mb-3">
              <h3 className="text-sm font-medium">Memory (Embedder)</h3>
              <span className="text-xs text-[hsl(var(--muted-foreground))]">
                {formatCost(embedderTotalCost)} across {embedderTotalCalls} call
                {embedderTotalCalls !== 1 ? 's' : ''}
                <span className="opacity-40 mx-1.5">·</span>
                {formatTokens(embedderTotalTokens)} tokens
                {embedderPercent > 0 && (
                  <>
                    <span className="opacity-40 mx-1.5">·</span>
                    {embedderPercent.toFixed(1)}% of total
                  </>
                )}
              </span>
            </div>
            <CostTable<{ model: string; calls: number; tokens: number; cost: number }>
              columns={[
                {
                  label: 'Embedder Model',
                  sortKey: (row) => row.model,
                  render: (row) => <span className="font-mono">{row.model}</span>,
                },
                {
                  label: 'Calls',
                  sortKey: (row) => row.calls,
                  render: (row) => <span>{row.calls}</span>,
                },
                {
                  label: 'Tokens',
                  sortKey: (row) => row.tokens,
                  render: (row) => <TokenBadge tokens={row.tokens} />,
                },
                {
                  label: 'Cost',
                  sortKey: (row) => row.cost,
                  render: (row) => <CostBadge cost={row.cost} />,
                },
              ]}
              rows={embedderEntries.map(([model, data]) => ({
                model,
                calls: data.calls,
                tokens: data.tokens,
                cost: data.cost,
              }))}
              rowKey={(row) => row.model}
              defaultSort={{ index: 3, dir: 'desc' }}
              costValue={(row) => row.cost}
            />
          </div>
        )}

        {/* Retry overhead: how much money is being spent because agents have
             to be re-asked after a gate failure. Only render when retry cost
             is non-trivial or when there's at least one retry on record. */}
        {(retryCost > 0 || retry.retryCalls > 0) && (
          <div className="lg:col-span-2">
            <div className="flex items-baseline justify-between mb-3">
              <h3 className="text-sm font-medium">Retry Overhead</h3>
              <span className="text-xs text-[hsl(var(--muted-foreground))]">
                {formatCost(retryCost)} across {retry.retryCalls} retry call
                {retry.retryCalls !== 1 ? 's' : ''}
                {retryPercent > 0 && (
                  <>
                    <span className="opacity-40 mx-1.5">·</span>
                    {retryPercent.toFixed(1)}% of total
                  </>
                )}
              </span>
            </div>
            <CostTable<{
              reason: string;
              reasonLabel: React.ReactNode;
              calls: number;
              cost: number;
            }>
              columns={[
                {
                  label: 'Reason',
                  sortKey: (row) => row.reason,
                  render: (row) => row.reasonLabel,
                },
                {
                  label: 'Calls',
                  sortKey: (row) => row.calls,
                  render: (row) => <span>{row.calls}</span>,
                },
                {
                  label: 'Cost',
                  sortKey: (row) => row.cost,
                  render: (row) => <CostBadge cost={row.cost} />,
                },
              ]}
              rows={[
                {
                  reason: 'primary',
                  reasonLabel: (
                    <span className="text-[hsl(var(--muted-foreground))]">
                      primary (first attempt)
                    </span>
                  ),
                  calls: retry.primaryCalls,
                  cost: retry.primary,
                },
                {
                  reason: 'schema',
                  reasonLabel: (
                    <span className="font-mono text-teal-600 dark:text-teal-400">schema retry</span>
                  ),
                  calls: retry.schemaCalls,
                  cost: retry.schema,
                },
                {
                  reason: 'validate',
                  reasonLabel: (
                    <span className="font-mono text-teal-600 dark:text-teal-400">
                      validate retry
                    </span>
                  ),
                  calls: retry.validateCalls,
                  cost: retry.validate,
                },
                {
                  reason: 'guardrail',
                  reasonLabel: (
                    <span className="font-mono text-rose-600 dark:text-rose-400">
                      guardrail retry
                    </span>
                  ),
                  calls: retry.guardrailCalls,
                  cost: retry.guardrail,
                },
              ]}
              rowKey={(row) => row.reason}
              defaultSort={{ index: 2, dir: 'desc' }}
              costValue={(row) => row.cost}
            />
          </div>
        )}
      </div>
    </PanelShell>
  );
}

/**
 * Per-column descriptor for `CostTable`. `sortKey` returns the value used
 * for ordering (number or string); omit it to mark the column as not
 * sortable. `render` returns the React node shown in the cell. `align`
 * defaults to `'right'` for every column except the first.
 */
type CostColumn<T> = {
  label: string;
  align?: 'left' | 'right';
  sortKey?: (row: T) => number | string;
  render: (row: T) => React.ReactNode;
};

/**
 * Row-based cost table with client-side sort. Sorts default to the first
 * sortable column in the direction provided by `defaultSort`. Clicking a
 * sortable header cycles: active desc → active asc → switch column. The
 * proportion bar on the last column uses `costValue` when provided.
 */
function CostTable<T>({
  columns,
  rows,
  rowKey,
  defaultSort,
  costValue,
}: {
  columns: CostColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  defaultSort?: { index: number; dir: 'asc' | 'desc' };
  costValue?: (row: T) => number;
}) {
  const initialSortIndex = defaultSort?.index ?? columns.findIndex((c) => c.sortKey !== undefined);
  const initialSortDir = defaultSort?.dir ?? 'desc';
  const [sortIndex, setSortIndex] = useState<number>(initialSortIndex);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(initialSortDir);

  const sortedRows = useMemo(() => {
    const activeColumn = columns[sortIndex];
    if (!activeColumn?.sortKey) return rows;
    const sortKey = activeColumn.sortKey;
    const copy = [...rows];
    copy.sort((a, b) => {
      const va = sortKey(a);
      const vb = sortKey(b);
      if (typeof va === 'number' && typeof vb === 'number') {
        return sortDir === 'asc' ? va - vb : vb - va;
      }
      const sa = String(va);
      const sb = String(vb);
      return sortDir === 'asc' ? sa.localeCompare(sb) : sb.localeCompare(sa);
    });
    return copy;
  }, [rows, columns, sortIndex, sortDir]);

  const maxCost = useMemo(() => {
    if (!costValue) return 0;
    let max = 0;
    for (const row of rows) {
      const v = costValue(row);
      if (v > max) max = v;
    }
    return max;
  }, [rows, costValue]);

  const handleHeaderClick = (columnIndex: number) => {
    if (!columns[columnIndex].sortKey) return;
    if (sortIndex === columnIndex) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortIndex(columnIndex);
      setSortDir('desc');
    }
  };

  return (
    <div className="rounded-xl border border-[hsl(var(--border))] overflow-hidden">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-[hsl(var(--border))] bg-[hsl(var(--card))]">
            {columns.map((col, i) => {
              const align = col.align ?? (i === 0 ? 'left' : 'right');
              const sortable = col.sortKey !== undefined;
              const active = sortable && sortIndex === i;
              const arrow = active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
              return (
                <th
                  key={col.label}
                  aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={cn(
                    'py-2 px-3 font-medium',
                    align === 'left' ? 'text-left' : 'text-right',
                    sortable && 'cursor-pointer select-none hover:text-[hsl(var(--foreground))]',
                    sortable && !active && 'text-[hsl(var(--muted-foreground))]',
                  )}
                  onClick={sortable ? () => handleHeaderClick(i) : undefined}
                  title={sortable ? 'Click to sort' : undefined}
                >
                  {col.label}
                  {arrow}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => {
            const cost = costValue ? costValue(row) : 0;
            return (
              <tr
                key={rowKey(row)}
                className="border-b last:border-b-0 border-[hsl(var(--border))]"
              >
                {columns.map((col, i) => {
                  const align = col.align ?? (i === 0 ? 'left' : 'right');
                  return (
                    <td
                      key={col.label}
                      className={cn(
                        'py-2 px-3 relative',
                        align === 'left' ? 'text-left' : 'text-right',
                      )}
                    >
                      {i === columns.length - 1 && maxCost > 0 && (
                        <div
                          className="absolute inset-y-0 right-0 bg-[hsl(var(--primary)/0.08)] rounded-sm"
                          style={{ width: `${(cost / maxCost) * 100}%` }}
                        />
                      )}
                      <span className="relative">{col.render(row)}</span>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
