import { useState } from 'react';
import { JsonViewer } from '../../components/shared/JsonViewer';
import { formatCost, formatDuration } from '../../lib/utils';
import type { ComparisonResult, EvalResultData } from './types';
import { scoreColorClass } from './types';

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
  // For timing and cost, positive delta means worse (invert=true flips the color)
  const isPositive = invert ? value < 0 : value > 0;
  const isNegative = invert ? value > 0 : value < 0;

  const colorClass = isPositive
    ? 'text-green-600 dark:text-green-400'
    : isNegative
      ? 'text-red-600 dark:text-red-400'
      : '';

  const formatted = format
    ? `${value > 0 ? '+' : value < 0 ? '-' : ''}${format(Math.abs(value))}`
    : `${value > 0 ? '+' : ''}${Math.abs(value) < 100 ? value.toFixed(3) : value.toFixed(0)}`;

  return (
    <>
      <td className={`py-2 text-right font-mono ${colorClass}`}>{formatted}</td>
      <td className={`py-2 text-right font-mono ${colorClass}`}>
        {percent > 0 ? '+' : ''}
        {percent.toFixed(1)}%
      </td>
    </>
  );
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

  return (
    <div className="space-y-4">
      {compareResult.summary && <p className="text-sm">{compareResult.summary}</p>}

      {/* Scorer comparison table */}
      {compareResult.scorers && Object.keys(compareResult.scorers).length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-2">Scorer Comparison</h3>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[hsl(var(--border))]">
                <th className="text-left py-2 font-medium">Metric</th>
                <th className="text-right py-2 font-medium">Baseline</th>
                <th className="text-right py-2 font-medium">Candidate</th>
                <th className="text-right py-2 font-medium">Delta</th>
                <th className="text-right py-2 font-medium">%</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(compareResult.scorers).map(([scorer, stats]) => (
                <tr key={scorer} className="border-b border-[hsl(var(--border))]">
                  <td className="py-2 font-mono">{scorer}</td>
                  <td className="py-2 text-right font-mono">{stats.baselineMean.toFixed(3)}</td>
                  <td className="py-2 text-right font-mono">{stats.candidateMean.toFixed(3)}</td>
                  <DeltaCell value={stats.delta} percent={stats.deltaPercent} />
                </tr>
              ))}

              {/* Timing comparison */}
              {compareResult.timing && (
                <tr className="border-b border-[hsl(var(--border))]">
                  <td className="py-2 font-mono text-[hsl(var(--muted-foreground))]">
                    Timing (mean)
                  </td>
                  <td className="py-2 text-right font-mono">
                    {formatDuration(compareResult.timing.baselineMean)}
                  </td>
                  <td className="py-2 text-right font-mono">
                    {formatDuration(compareResult.timing.candidateMean)}
                  </td>
                  <DeltaCell
                    value={compareResult.timing.delta}
                    percent={compareResult.timing.deltaPercent}
                    invert
                    format={formatDuration}
                  />
                </tr>
              )}

              {/* Cost comparison */}
              {compareResult.cost && (
                <tr className="border-b border-[hsl(var(--border))]">
                  <td className="py-2 font-mono text-[hsl(var(--muted-foreground))]">
                    Cost (total)
                  </td>
                  <td className="py-2 text-right font-mono">
                    {formatCost(compareResult.cost.baselineTotal)}
                  </td>
                  <td className="py-2 text-right font-mono">
                    {formatCost(compareResult.cost.candidateTotal)}
                  </td>
                  <DeltaCell
                    value={compareResult.cost.delta}
                    percent={compareResult.cost.deltaPercent}
                    invert
                    format={formatCost}
                  />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Regressions */}
      {compareResult.regressions && compareResult.regressions.length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-2 text-red-600 dark:text-red-400">
            Regressions ({compareResult.regressions.length})
          </h3>
          <div className="space-y-1">
            {compareResult.regressions.map((r, i) => {
              const isExpanded = expanded?.type === 'regression' && expanded.index === i;
              const baselineItem = baseline?.items[r.itemIndex];
              const candidateItem = candidate?.items[r.itemIndex];

              return (
                <div key={i}>
                  <button
                    onClick={() => toggleExpand('regression', i)}
                    className="w-full text-left flex items-center justify-between px-3 py-1.5 text-xs border border-[hsl(var(--border))] rounded hover:bg-[hsl(var(--accent))] cursor-pointer"
                  >
                    <span className="font-mono">
                      Item #{r.itemIndex + 1} - {r.scorer}
                    </span>
                    <span className="font-mono text-red-600 dark:text-red-400">
                      {r.baselineScore.toFixed(2)} {'\u2192'} {r.candidateScore.toFixed(2)} (
                      {r.delta.toFixed(2)})
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

      {/* Improvements */}
      {compareResult.improvements && compareResult.improvements.length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-2 text-green-600 dark:text-green-400">
            Improvements ({compareResult.improvements.length})
          </h3>
          <div className="space-y-1">
            {compareResult.improvements.map((r, i) => {
              const isExpanded = expanded?.type === 'improvement' && expanded.index === i;
              const baselineItem = baseline?.items[r.itemIndex];
              const candidateItem = candidate?.items[r.itemIndex];

              return (
                <div key={i}>
                  <button
                    onClick={() => toggleExpand('improvement', i)}
                    className="w-full text-left flex items-center justify-between px-3 py-1.5 text-xs border border-[hsl(var(--border))] rounded hover:bg-[hsl(var(--accent))] cursor-pointer"
                  >
                    <span className="font-mono">
                      Item #{r.itemIndex + 1} - {r.scorer}
                    </span>
                    <span className="font-mono text-green-600 dark:text-green-400">
                      {r.baselineScore.toFixed(2)} {'\u2192'} {r.candidateScore.toFixed(2)} (+
                      {r.delta.toFixed(2)})
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
    <div className="mt-1 mb-2 p-3 rounded bg-[hsl(var(--card))] border border-[hsl(var(--border))] grid grid-cols-2 gap-4 text-xs">
      {/* Baseline side */}
      <div className="space-y-2">
        <h5 className="font-medium text-[hsl(var(--muted-foreground))]">Baseline Output</h5>
        <JsonViewer data={baselineItem.output} collapsed />
        {baselineDetail && (
          <div className="flex items-center gap-1">
            <span className="text-[hsl(var(--muted-foreground))]">Score:</span>
            {baselineDetail.score != null && (
              <span
                className={`px-1.5 py-0.5 rounded font-mono ${scoreColorClass(baselineDetail.score)}`}
              >
                {baselineDetail.score.toFixed(3)}
              </span>
            )}
          </div>
        )}
        {baselineReasoning && (
          <div>
            <span className="font-medium text-[hsl(var(--muted-foreground))]">Reasoning:</span>
            <pre className="text-xs font-mono p-2 rounded-md bg-[hsl(var(--secondary))] overflow-auto max-h-48 whitespace-pre-wrap mt-1">
              {baselineReasoning}
            </pre>
          </div>
        )}
      </div>

      {/* Candidate side */}
      <div className="space-y-2">
        <h5 className="font-medium text-[hsl(var(--muted-foreground))]">Candidate Output</h5>
        <JsonViewer data={candidateItem.output} collapsed />
        {candidateDetail && (
          <div className="flex items-center gap-1">
            <span className="text-[hsl(var(--muted-foreground))]">Score:</span>
            {candidateDetail.score != null && (
              <span
                className={`px-1.5 py-0.5 rounded font-mono ${scoreColorClass(candidateDetail.score)}`}
              >
                {candidateDetail.score.toFixed(3)}
              </span>
            )}
          </div>
        )}
        {candidateReasoning && (
          <div>
            <span className="font-medium text-[hsl(var(--muted-foreground))]">Reasoning:</span>
            <pre className="text-xs font-mono p-2 rounded-md bg-[hsl(var(--secondary))] overflow-auto max-h-48 whitespace-pre-wrap mt-1">
              {candidateReasoning}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
