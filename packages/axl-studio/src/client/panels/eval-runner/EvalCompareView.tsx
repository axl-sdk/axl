import { useState } from 'react';
import { JsonViewer } from '../../components/shared/JsonViewer';
import { cn, formatCost, formatDuration } from '../../lib/utils';
import type { ComparisonResult, EvalResultData } from './types';
import { scoreColorClass, scoreTextColor } from './types';

type Props = {
  compareResult: ComparisonResult;
  baseline: EvalResultData | null;
  candidate: EvalResultData | null;
};

function DeltaCell({
  value,
  percent,
  invert,
  format,
}: {
  value: number;
  percent: number;
  invert?: boolean;
  format?: (v: number) => string;
}) {
  const isPositive = invert ? value < 0 : value > 0;
  const isNegative = invert ? value > 0 : value < 0;

  const colorClass = isPositive
    ? 'text-emerald-600 dark:text-emerald-400'
    : isNegative
      ? 'text-red-600 dark:text-red-400'
      : 'text-[hsl(var(--muted-foreground))]';

  const formatted = format
    ? `${value > 0 ? '+' : value < 0 ? '-' : ''}${format(Math.abs(value))}`
    : `${value > 0 ? '+' : ''}${Math.abs(value) < 100 ? value.toFixed(3) : value.toFixed(0)}`;

  return (
    <>
      <td className={cn('py-2.5 text-right font-mono', colorClass)}>{formatted}</td>
      <td className={cn('py-2.5 text-right font-mono', colorClass)}>
        {percent > 0 ? '+' : ''}
        {percent.toFixed(1)}%
      </td>
    </>
  );
}

function formatCI(ci: { lower: number; upper: number }): string {
  const lo = (ci.lower >= 0 ? '+' : '') + ci.lower.toFixed(4);
  const hi = (ci.upper >= 0 ? '+' : '') + ci.upper.toFixed(4);
  return `[${lo}, ${hi}]`;
}

type ExpandedItem = { type: 'regression' | 'improvement'; index: number };

export function EvalCompareView({ compareResult, baseline, candidate }: Props) {
  const [expanded, setExpanded] = useState<ExpandedItem | null>(null);

  const toggleExpand = (type: 'regression' | 'improvement', index: number) => {
    if (expanded?.type === type && expanded?.index === index) {
      setExpanded(null);
    } else {
      setExpanded({ type, index });
    }
  };

  const scorerEntries = compareResult.scorers ? Object.entries(compareResult.scorers) : [];
  const hasCI = scorerEntries.some(([, s]) => s.ci != null);

  return (
    <div className="space-y-6">
      {compareResult.summary && (
        <p className="text-sm text-[hsl(var(--muted-foreground))]">{compareResult.summary}</p>
      )}

      {/* ── Scorer comparison table ──────────────────────── */}
      {scorerEntries.length > 0 && (
        <div className="border border-[hsl(var(--border))] rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 bg-[hsl(var(--muted))] border-b border-[hsl(var(--border))]">
            <h3 className="text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
              Scorer Comparison
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[hsl(var(--border))]">
                  <th className="text-left px-4 py-2 font-medium">Metric</th>
                  <th className="text-right px-3 py-2 font-medium">Baseline</th>
                  <th className="text-right px-3 py-2 font-medium">Candidate</th>
                  <th className="text-right px-3 py-2 font-medium">Delta</th>
                  <th className="text-right px-3 py-2 font-medium">%</th>
                  {hasCI && (
                    <>
                      <th className="text-right px-3 py-2 font-medium">CI 95%</th>
                      <th className="text-center px-2 py-2 font-medium">Sig</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {scorerEntries.map(([scorer, stats]) => (
                  <tr key={scorer} className="border-b border-[hsl(var(--border))] last:border-b-0">
                    <td className="px-4 py-2.5 font-mono">{scorer}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-[hsl(var(--muted-foreground))]">
                      {stats.baselineMean.toFixed(3)}
                    </td>
                    <td
                      className={cn(
                        'px-3 py-2.5 text-right font-mono',
                        stats.significant === false
                          ? 'text-[hsl(var(--muted-foreground))]'
                          : scoreTextColor(stats.candidateMean),
                      )}
                    >
                      {stats.candidateMean.toFixed(3)}
                    </td>
                    <DeltaCell value={stats.delta} percent={stats.deltaPercent} />
                    {hasCI && (
                      <>
                        <td className="px-3 py-2.5 text-right font-mono text-[hsl(var(--muted-foreground))] text-[10px]">
                          {stats.ci ? formatCI(stats.ci) : '\u2014'}
                        </td>
                        <td className="px-2 py-2.5 text-center font-mono">
                          {stats.significant === true ? (
                            <span
                              className={
                                stats.delta >= 0
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : 'text-red-600 dark:text-red-400'
                              }
                            >
                              *
                            </span>
                          ) : stats.significant === false ? (
                            <span className="text-[hsl(var(--muted-foreground))]">\u2014</span>
                          ) : null}
                        </td>
                      </>
                    )}
                  </tr>
                ))}

                {/* Timing comparison */}
                {compareResult.timing && (
                  <tr className="border-t-2 border-[hsl(var(--border))]">
                    <td className="px-4 py-2.5 font-mono text-[hsl(var(--muted-foreground))]">
                      Timing (mean)
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-[hsl(var(--muted-foreground))]">
                      {formatDuration(compareResult.timing.baselineMean)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-[hsl(var(--muted-foreground))]">
                      {formatDuration(compareResult.timing.candidateMean)}
                    </td>
                    <DeltaCell
                      value={compareResult.timing.delta}
                      percent={compareResult.timing.deltaPercent}
                      invert
                      format={formatDuration}
                    />
                    {hasCI && <td colSpan={2} />}
                  </tr>
                )}

                {/* Cost comparison */}
                {compareResult.cost != null && (
                  <tr className="border-t border-[hsl(var(--border))]">
                    <td className="px-4 py-2.5 font-mono text-[hsl(var(--muted-foreground))]">
                      Cost (total)
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-[hsl(var(--muted-foreground))]">
                      {formatCost(compareResult.cost.baselineTotal)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-[hsl(var(--muted-foreground))]">
                      {formatCost(compareResult.cost.candidateTotal)}
                    </td>
                    <DeltaCell
                      value={compareResult.cost.delta}
                      percent={compareResult.cost.deltaPercent}
                      invert
                      format={formatCost}
                    />
                    {hasCI && <td colSpan={2} />}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Regressions ──────────────────────────────────── */}
      {compareResult.regressions && compareResult.regressions.length > 0 && (
        <div className="border border-red-200 dark:border-red-900 rounded-lg overflow-hidden">
          <div className="px-4 py-2.5 bg-red-50 dark:bg-red-950/30 border-b border-red-200 dark:border-red-900">
            <h3 className="text-xs font-medium text-red-700 dark:text-red-300">
              Regressions ({compareResult.regressions.length})
            </h3>
          </div>
          <div className="divide-y divide-[hsl(var(--border))]">
            {compareResult.regressions.map((r, i) => {
              const isExpanded = expanded?.type === 'regression' && expanded.index === i;
              const baselineItem = baseline?.items[r.itemIndex];
              const candidateItem = candidate?.items[r.itemIndex];

              return (
                <div key={i}>
                  <button
                    onClick={() => toggleExpand('regression', i)}
                    className="w-full text-left flex items-center justify-between px-4 py-2.5 text-xs hover:bg-[hsl(var(--accent))] transition-colors"
                  >
                    <span className="font-mono">
                      Item #{r.itemIndex + 1}{' '}
                      <span className="text-[hsl(var(--muted-foreground))]">{r.scorer}</span>
                    </span>
                    <span className="font-mono text-red-600 dark:text-red-400">
                      {r.baselineScore.toFixed(2)} {'\u2192'} {r.candidateScore.toFixed(2)}{' '}
                      <span className="text-[hsl(var(--muted-foreground))]">
                        ({r.delta.toFixed(2)})
                      </span>
                    </span>
                  </button>
                  {isExpanded && baselineItem && candidateItem && (
                    <ItemComparison
                      baselineItem={baselineItem}
                      candidateItem={candidateItem}
                      scorer={r.scorer}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Improvements ─────────────────────────────────── */}
      {compareResult.improvements && compareResult.improvements.length > 0 && (
        <div className="border border-emerald-200 dark:border-emerald-900 rounded-lg overflow-hidden">
          <div className="px-4 py-2.5 bg-emerald-50 dark:bg-emerald-950/30 border-b border-emerald-200 dark:border-emerald-900">
            <h3 className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
              Improvements ({compareResult.improvements.length})
            </h3>
          </div>
          <div className="divide-y divide-[hsl(var(--border))]">
            {compareResult.improvements.map((r, i) => {
              const isExpanded = expanded?.type === 'improvement' && expanded.index === i;
              const baselineItem = baseline?.items[r.itemIndex];
              const candidateItem = candidate?.items[r.itemIndex];

              return (
                <div key={i}>
                  <button
                    onClick={() => toggleExpand('improvement', i)}
                    className="w-full text-left flex items-center justify-between px-4 py-2.5 text-xs hover:bg-[hsl(var(--accent))] transition-colors"
                  >
                    <span className="font-mono">
                      Item #{r.itemIndex + 1}{' '}
                      <span className="text-[hsl(var(--muted-foreground))]">{r.scorer}</span>
                    </span>
                    <span className="font-mono text-emerald-600 dark:text-emerald-400">
                      {r.baselineScore.toFixed(2)} {'\u2192'} {r.candidateScore.toFixed(2)}{' '}
                      <span className="text-[hsl(var(--muted-foreground))]">
                        (+{r.delta.toFixed(2)})
                      </span>
                    </span>
                  </button>
                  {isExpanded && baselineItem && candidateItem && (
                    <ItemComparison
                      baselineItem={baselineItem}
                      candidateItem={candidateItem}
                      scorer={r.scorer}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Side-by-side item comparison ───────────────────────────────

function ItemComparison({
  baselineItem,
  candidateItem,
  scorer,
}: {
  baselineItem: {
    output: unknown;
    scoreDetails?: Record<string, { score: number | null; metadata?: Record<string, unknown> }>;
  };
  candidateItem: {
    output: unknown;
    scoreDetails?: Record<string, { score: number | null; metadata?: Record<string, unknown> }>;
  };
  scorer: string;
}) {
  const baselineDetail = baselineItem.scoreDetails?.[scorer];
  const candidateDetail = candidateItem.scoreDetails?.[scorer];
  const baselineReasoning =
    typeof baselineDetail?.metadata?.reasoning === 'string'
      ? baselineDetail.metadata.reasoning
      : null;
  const candidateReasoning =
    typeof candidateDetail?.metadata?.reasoning === 'string'
      ? candidateDetail.metadata.reasoning
      : null;

  return (
    <div className="border-t border-[hsl(var(--border))] bg-[hsl(var(--card))] grid grid-cols-2 gap-0 text-xs">
      {/* Baseline side */}
      <div className="p-4 space-y-3 border-r border-[hsl(var(--border))]">
        <h5 className="font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider text-[10px]">
          Baseline
        </h5>
        <JsonViewer data={baselineItem.output} collapsed />
        {baselineDetail?.score != null && (
          <div className="flex items-center gap-1.5">
            <span className="text-[hsl(var(--muted-foreground))]">Score:</span>
            <span
              className={cn(
                'px-2 py-0.5 rounded-full font-mono font-medium',
                scoreColorClass(baselineDetail.score),
              )}
            >
              {baselineDetail.score.toFixed(3)}
            </span>
          </div>
        )}
        {baselineReasoning && (
          <div>
            <span className="font-medium text-[hsl(var(--muted-foreground))] text-[10px] uppercase tracking-wider block mb-1">
              Reasoning
            </span>
            <pre className="text-xs font-mono p-2 rounded-md bg-[hsl(var(--secondary))] overflow-auto max-h-48 whitespace-pre-wrap leading-relaxed">
              {baselineReasoning}
            </pre>
          </div>
        )}
      </div>

      {/* Candidate side */}
      <div className="p-4 space-y-3">
        <h5 className="font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider text-[10px]">
          Candidate
        </h5>
        <JsonViewer data={candidateItem.output} collapsed />
        {candidateDetail?.score != null && (
          <div className="flex items-center gap-1.5">
            <span className="text-[hsl(var(--muted-foreground))]">Score:</span>
            <span
              className={cn(
                'px-2 py-0.5 rounded-full font-mono font-medium',
                scoreColorClass(candidateDetail.score),
              )}
            >
              {candidateDetail.score.toFixed(3)}
            </span>
          </div>
        )}
        {candidateReasoning && (
          <div>
            <span className="font-medium text-[hsl(var(--muted-foreground))] text-[10px] uppercase tracking-wider block mb-1">
              Reasoning
            </span>
            <pre className="text-xs font-mono p-2 rounded-md bg-[hsl(var(--secondary))] overflow-auto max-h-48 whitespace-pre-wrap leading-relaxed">
              {candidateReasoning}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
