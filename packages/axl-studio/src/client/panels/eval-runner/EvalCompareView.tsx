import { useState, useMemo } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { JsonViewer } from '../../components/shared/JsonViewer';
import { cn, formatCost, formatDuration, extractLabel } from '../../lib/utils';
import { EvalCompareItemTable } from './EvalCompareItemTable';
import type { ComparisonResult, EvalResultData } from './types';
import {
  scoreColorClass,
  scoreTextColor,
  getResultModels,
  getResultWorkflows,
  formatModelName,
  aggregateGroupTokens,
  aggregateGroupCost,
} from './types';

function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <span className="relative group/tip cursor-help">
      {children}
      <span className="invisible group-hover/tip:visible absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2.5 py-1.5 text-[10px] leading-snug rounded-md bg-[hsl(var(--foreground))] text-[hsl(var(--background))] whitespace-normal w-56 z-50 shadow-md pointer-events-none">
        {text}
      </span>
    </span>
  );
}

type Props = {
  compareResult: ComparisonResult;
  baseline: EvalResultData | null;
  candidate: EvalResultData | null;
  isGroupComparison?: boolean;
  baselineRuns?: EvalResultData[] | null;
  candidateRuns?: EvalResultData[] | null;
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

  const percentStr = `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%`;

  return (
    <td className={cn('px-3 py-2.5 text-right', colorClass)}>
      <div className="font-mono">
        {formatted} ({percentStr})
      </div>
    </td>
  );
}

function formatSigned(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(4);
}

type ExpandedItem = { type: 'regression' | 'improvement'; index: number };

type ScorerSortField = 'metric' | 'baseline' | 'candidate' | 'delta';

export function EvalCompareView({
  compareResult,
  baseline,
  candidate,
  isGroupComparison,
  baselineRuns,
  candidateRuns,
}: Props) {
  const [expanded, setExpanded] = useState<ExpandedItem | null>(null);
  const [scorerSort, setScorerSort] = useState<ScorerSortField>('delta');
  const [scorerSortDir, setScorerSortDir] = useState<'asc' | 'desc'>('desc');
  const [showNoise, setShowNoise] = useState<Record<string, boolean>>({});

  const toggleExpand = (type: 'regression' | 'improvement', index: number) => {
    if (expanded?.type === type && expanded?.index === index) {
      setExpanded(null);
    } else {
      setExpanded({ type, index });
    }
  };

  const scorerTypes = (baseline?.metadata?.scorerTypes ?? candidate?.metadata?.scorerTypes) as
    | Record<string, string>
    | undefined;
  const baselineRunCount = baselineRuns?.length ?? 1;
  const candidateRunCount = candidateRuns?.length ?? 1;
  const pooledLabel = isGroupComparison
    ? `averaged across ${baselineRunCount === candidateRunCount ? `${baselineRunCount} runs` : `${baselineRunCount} / ${candidateRunCount} runs`}`
    : null;

  // Sort scorer entries — derive from compareResult.scorers directly to keep stable deps
  const sortedScorerEntries = useMemo(() => {
    const entries = Object.entries(compareResult.scorers);
    entries.sort((a, b) => {
      // When sorting by delta, significant entries float to the top
      if (scorerSort === 'delta') {
        const aSig = a[1].significant === true ? 1 : 0;
        const bSig = b[1].significant === true ? 1 : 0;
        if (aSig !== bSig) return bSig - aSig;
      }

      let aVal: number, bVal: number;
      switch (scorerSort) {
        case 'metric':
          return scorerSortDir === 'asc' ? a[0].localeCompare(b[0]) : b[0].localeCompare(a[0]);
        case 'baseline':
          aVal = a[1].baselineMean;
          bVal = b[1].baselineMean;
          break;
        case 'candidate':
          aVal = a[1].candidateMean;
          bVal = b[1].candidateMean;
          break;
        case 'delta':
        default:
          aVal = Math.abs(a[1].delta);
          bVal = Math.abs(b[1].delta);
          break;
      }
      return scorerSortDir === 'desc' ? bVal - aVal : aVal - bVal;
    });
    return entries;
  }, [compareResult.scorers, scorerSort, scorerSortDir]);

  const hasCI = sortedScorerEntries.some(([, s]) => s.ci != null);

  const toggleScorerSort = (field: ScorerSortField) => {
    if (scorerSort === field) {
      setScorerSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setScorerSort(field);
      setScorerSortDir('desc');
    }
  };

  const sortIndicator = (field: ScorerSortField) =>
    scorerSort === field ? (scorerSortDir === 'desc' ? ' \u25BC' : ' \u25B2') : '';

  // Compute stat card values
  const significantCount = sortedScorerEntries.filter(([, s]) => s.significant === true).length;
  const regressionCount = compareResult.regressions.length;
  const improvementCount = compareResult.improvements.length;

  return (
    <div className="space-y-6">
      {/* Verdict banner */}
      {sortedScorerEntries.length > 0 &&
        (() => {
          const hasSignificantRegression = sortedScorerEntries.some(
            ([, s]) => s.significant === true && s.delta < 0,
          );
          const hasSignificantImprovement = sortedScorerEntries.some(
            ([, s]) => s.significant === true && s.delta > 0,
          );
          const hasRegressions = compareResult.regressions.length > 0;
          const allNotSignificant = sortedScorerEntries.every(([, s]) => s.significant === false);

          const formatScorerDetail = (name: string, s: (typeof sortedScorerEntries)[0][1]) => {
            const pct =
              s.delta < 0
                ? s.pRegression != null
                  ? `${Math.round(s.pRegression * 100)}%`
                  : null
                : s.pImprovement != null
                  ? `${Math.round(s.pImprovement * 100)}%`
                  : null;
            const delta = `${s.delta > 0 ? '+' : ''}${s.delta.toFixed(3)}`;
            return `${name} ${delta}${pct ? ` (${pct} probability)` : ''}`;
          };

          if (hasSignificantRegression) {
            const regressed = sortedScorerEntries.filter(
              ([, s]) => s.significant === true && s.delta < 0,
            );
            return (
              <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30">
                <div className="h-6 w-6 rounded-full bg-red-100 dark:bg-red-900/50 flex items-center justify-center shrink-0 mt-0.5">
                  <span className="text-red-600 dark:text-red-400 text-xs font-bold">
                    {'\u2715'}
                  </span>
                </div>
                <div>
                  <p className="text-sm font-medium text-red-800 dark:text-red-200">
                    Significant regression detected
                  </p>
                  <p className="text-xs text-red-600 dark:text-red-400 mt-0.5">
                    {regressed.map(([n, s]) => formatScorerDetail(n, s)).join('; ')}
                  </p>
                </div>
              </div>
            );
          }
          if (hasSignificantImprovement) {
            const improved = sortedScorerEntries.filter(
              ([, s]) => s.significant === true && s.delta > 0,
            );
            return (
              <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/30">
                <div className="h-6 w-6 rounded-full bg-emerald-100 dark:bg-emerald-900/50 flex items-center justify-center shrink-0 mt-0.5">
                  <span className="text-emerald-600 dark:text-emerald-400 text-xs font-bold">
                    {'\u2713'}
                  </span>
                </div>
                <div>
                  <p className="text-sm font-medium text-emerald-800 dark:text-emerald-200">
                    Significant improvement detected
                  </p>
                  <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-0.5">
                    {improved.map(([n, s]) => formatScorerDetail(n, s)).join('; ')}
                  </p>
                </div>
              </div>
            );
          }
          if (hasRegressions && allNotSignificant) {
            return (
              <div className="flex items-center gap-2.5 px-4 py-3 rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30">
                <div className="h-6 w-6 rounded-full bg-amber-100 dark:bg-amber-900/50 flex items-center justify-center shrink-0">
                  <span className="text-amber-600 dark:text-amber-400 text-xs font-bold">~</span>
                </div>
                <div>
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                    {compareResult.regressions.length} item regressions, but not statistically
                    significant
                  </p>
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    {isGroupComparison
                      ? 'Even with pooled multi-run data, the score differences are within normal variation.'
                      : 'Score differences are within normal LLM variation. Consider multi-run for stronger confidence.'}
                  </p>
                </div>
              </div>
            );
          }
          return (
            <div className="flex items-center gap-2.5 px-4 py-3 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted))]">
              <div className="h-6 w-6 rounded-full bg-emerald-100 dark:bg-emerald-900/50 flex items-center justify-center shrink-0">
                <span className="text-emerald-600 dark:text-emerald-400 text-xs font-bold">
                  {'\u2713'}
                </span>
              </div>
              <div>
                <p className="text-sm font-medium">No significant changes</p>
                <p className="text-xs text-[hsl(var(--muted-foreground))]">
                  Scores are stable between baseline and candidate
                </p>
              </div>
            </div>
          );
        })()}

      {/* Model + token + cost comparison */}
      {(() => {
        // Aggregate across all runs in a group (falls back to single result)
        const collectModels = (
          single: EvalResultData | null,
          runs?: EvalResultData[] | null,
        ): string[] => {
          const sources = runs && runs.length > 0 ? runs : single ? [single] : [];
          const set = new Set<string>();
          for (const r of sources) for (const m of getResultModels(r)) set.add(m);
          return [...set];
        };
        const bSources =
          baselineRuns && baselineRuns.length > 0 ? baselineRuns : baseline ? [baseline] : [];
        const cSources =
          candidateRuns && candidateRuns.length > 0 ? candidateRuns : candidate ? [candidate] : [];
        // Aggregate workflows across all runs in a group (parallel to models).
        // A group from `--runs N` usually has one workflow per side, but custom
        // callbacks could produce heterogeneous groups so we union.
        const collectWorkflows = (
          single: EvalResultData | null,
          runs?: EvalResultData[] | null,
        ): string[] => {
          const sources = runs && runs.length > 0 ? runs : single ? [single] : [];
          const seen = new Set<string>();
          const ordered: string[] = [];
          for (const r of sources) {
            for (const w of getResultWorkflows(r)) {
              if (!seen.has(w)) {
                seen.add(w);
                ordered.push(w);
              }
            }
          }
          return ordered;
        };

        const baselineModels = collectModels(baseline, baselineRuns);
        const candidateModels = collectModels(candidate, candidateRuns);
        const baselineWorkflows = collectWorkflows(baseline, baselineRuns);
        const candidateWorkflows = collectWorkflows(candidate, candidateRuns);
        const baselineTokens = aggregateGroupTokens(bSources);
        const candidateTokens = aggregateGroupTokens(cSources);
        const bTotal = baselineTokens.input + baselineTokens.output + baselineTokens.reasoning;
        const cTotal = candidateTokens.input + candidateTokens.output + candidateTokens.reasoning;
        const bCost = aggregateGroupCost(bSources);
        const cCost = aggregateGroupCost(cSources);

        const hasWorkflow = baselineWorkflows.length > 0 || candidateWorkflows.length > 0;
        // "changed" = the two sets of workflow names differ. Any diff — added,
        // removed, or replaced — counts as changed.
        const baselineWorkflowSet = new Set(baselineWorkflows);
        const candidateWorkflowSet = new Set(candidateWorkflows);
        const workflowChanged =
          baselineWorkflowSet.size !== candidateWorkflowSet.size ||
          baselineWorkflows.some((w) => !candidateWorkflowSet.has(w));

        const hasModels = baselineModels.length > 0 || candidateModels.length > 0;
        const hasTokens = bTotal > 0 && cTotal > 0;
        const hasCost = bCost > 0 || cCost > 0;
        if (!hasWorkflow && !hasModels && !hasTokens && !hasCost) return null;
        const baselineSet = new Set(baselineModels);
        const candidateSet = new Set(candidateModels);
        const modelsChanged =
          baselineSet.size !== candidateSet.size ||
          baselineModels.some((m) => !candidateSet.has(m));
        const tokenDeltaPct = bTotal > 0 ? ((cTotal - bTotal) / bTotal) * 100 : 0;
        return (
          <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-[hsl(var(--muted))]/50 text-xs flex-wrap">
            {hasWorkflow && (
              <>
                <span className="text-[hsl(var(--muted-foreground))] uppercase tracking-wider text-[10px] font-medium shrink-0">
                  {baselineWorkflows.length > 1 || candidateWorkflows.length > 1
                    ? 'Workflows'
                    : 'Workflow'}
                </span>
                <div className="flex items-center gap-1.5">
                  {baselineWorkflows.length > 0 ? (
                    baselineWorkflows.map((w) => (
                      <span
                        key={w}
                        className="px-1.5 py-0.5 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] font-mono"
                        title={w}
                      >
                        {w}
                      </span>
                    ))
                  ) : (
                    <span className="text-[hsl(var(--muted-foreground))] italic">unknown</span>
                  )}
                </div>
                <span className="text-[hsl(var(--muted-foreground))]">{'\u2192'}</span>
                <div className="flex items-center gap-1.5">
                  {candidateWorkflows.length > 0 ? (
                    candidateWorkflows.map((w) => (
                      <span
                        key={w}
                        className={cn(
                          'px-1.5 py-0.5 rounded font-mono',
                          workflowChanged
                            ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                            : 'border border-[hsl(var(--border))] bg-[hsl(var(--background))]',
                        )}
                        title={w}
                      >
                        {w}
                      </span>
                    ))
                  ) : (
                    <span className="text-[hsl(var(--muted-foreground))] italic">unknown</span>
                  )}
                </div>
                {workflowChanged && (
                  <span className="text-[10px] font-medium text-blue-600 dark:text-blue-400">
                    changed
                  </span>
                )}
              </>
            )}
            {hasModels && (
              <>
                {hasWorkflow && <span className="text-[hsl(var(--border))]">|</span>}
                <span className="text-[hsl(var(--muted-foreground))] uppercase tracking-wider text-[10px] font-medium shrink-0">
                  Models
                </span>
                <div className="flex items-center gap-1.5">
                  {baselineModels.length > 0 ? (
                    baselineModels.map((m) => (
                      <span
                        key={m}
                        className="px-1.5 py-0.5 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] font-mono"
                        title={m}
                      >
                        {formatModelName(m)}
                      </span>
                    ))
                  ) : (
                    <span className="text-[hsl(var(--muted-foreground))] italic">unknown</span>
                  )}
                </div>
                <span className="text-[hsl(var(--muted-foreground))]">{'\u2192'}</span>
                <div className="flex items-center gap-1.5">
                  {candidateModels.length > 0 ? (
                    candidateModels.map((m) => (
                      <span
                        key={m}
                        className={cn(
                          'px-1.5 py-0.5 rounded font-mono',
                          modelsChanged
                            ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                            : 'border border-[hsl(var(--border))] bg-[hsl(var(--background))]',
                        )}
                        title={m}
                      >
                        {formatModelName(m)}
                      </span>
                    ))
                  ) : (
                    <span className="text-[hsl(var(--muted-foreground))] italic">unknown</span>
                  )}
                </div>
                {modelsChanged && (
                  <span className="text-[10px] font-medium text-blue-600 dark:text-blue-400">
                    changed
                  </span>
                )}
              </>
            )}
            {hasTokens && (
              <>
                {hasModels && <span className="text-[hsl(var(--border))]">|</span>}
                <span className="text-[hsl(var(--muted-foreground))] uppercase tracking-wider text-[10px] font-medium shrink-0">
                  Tokens
                </span>
                <span className="font-mono">{bTotal.toLocaleString()}</span>
                <span className="text-[hsl(var(--muted-foreground))]">{'\u2192'}</span>
                <span className="font-mono">{cTotal.toLocaleString()}</span>
                {Math.abs(tokenDeltaPct) >= 1 && (
                  <span
                    className={cn(
                      'text-[10px] font-medium',
                      tokenDeltaPct > 0
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-emerald-600 dark:text-emerald-400',
                    )}
                  >
                    {tokenDeltaPct > 0 ? '+' : ''}
                    {tokenDeltaPct.toFixed(0)}%
                  </span>
                )}
              </>
            )}
            {hasCost && (
              <>
                {(hasModels || hasTokens) && <span className="text-[hsl(var(--border))]">|</span>}
                <span className="text-[hsl(var(--muted-foreground))] uppercase tracking-wider text-[10px] font-medium shrink-0">
                  Cost
                </span>
                <span className="font-mono">{formatCost(bCost)}</span>
                <span className="text-[hsl(var(--muted-foreground))]">{'\u2192'}</span>
                <span className="font-mono">{formatCost(cCost)}</span>
                {bCost > 0 &&
                  cCost > 0 &&
                  (() => {
                    const costDeltaPct = ((cCost - bCost) / bCost) * 100;
                    return Math.abs(costDeltaPct) >= 1 ? (
                      <span
                        className={cn(
                          'text-[10px] font-medium',
                          costDeltaPct > 0
                            ? 'text-red-600 dark:text-red-400'
                            : 'text-emerald-600 dark:text-emerald-400',
                        )}
                      >
                        {costDeltaPct > 0 ? '+' : ''}
                        {costDeltaPct.toFixed(0)}%
                      </span>
                    ) : null;
                  })()}
              </>
            )}
          </div>
        );
      })()}

      {/* Quick stat cards */}
      <div className="grid grid-cols-4 gap-3">
        <div className="px-3 py-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
          <div className="text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
            Significant
          </div>
          <div className="text-lg font-semibold mt-0.5">{significantCount}</div>
        </div>
        <div className="px-3 py-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
          <div className="text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
            Regressions
          </div>
          <div
            className={cn(
              'text-lg font-semibold mt-0.5',
              regressionCount > 0 ? 'text-red-600 dark:text-red-400' : '',
            )}
          >
            {regressionCount}
          </div>
        </div>
        <div className="px-3 py-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
          <div className="text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
            Improvements
          </div>
          <div
            className={cn(
              'text-lg font-semibold mt-0.5',
              improvementCount > 0 ? 'text-emerald-600 dark:text-emerald-400' : '',
            )}
          >
            {improvementCount}
          </div>
        </div>
        {compareResult.cost && (
          <div className="px-3 py-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
            <div className="text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
              Cost Delta
            </div>
            <div
              className={cn(
                'text-lg font-semibold mt-0.5',
                compareResult.cost.delta > 0
                  ? 'text-red-600 dark:text-red-400'
                  : compareResult.cost.delta < 0
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : '',
              )}
            >
              {compareResult.cost.delta > 0 ? '+' : ''}
              {formatCost(Math.abs(compareResult.cost.delta))}
            </div>
          </div>
        )}
      </div>

      {/* ── Scorer comparison table ──────────────────────── */}
      {sortedScorerEntries.length > 0 && (
        <div className="border border-[hsl(var(--border))] rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 bg-[hsl(var(--muted))] border-b border-[hsl(var(--border))]">
            <h3 className="text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
              Scorer Comparison
              {pooledLabel && (
                <span className="normal-case tracking-normal font-normal ml-1.5 opacity-70">
                  {'\u2014'} {pooledLabel}
                </span>
              )}
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[hsl(var(--border))]">
                  <th
                    className="text-left px-4 py-2 font-medium cursor-pointer select-none hover:text-[hsl(var(--foreground))]"
                    onClick={() => toggleScorerSort('metric')}
                  >
                    Metric{sortIndicator('metric')}
                  </th>
                  <th
                    className="text-right px-3 py-2 font-medium cursor-pointer select-none hover:text-[hsl(var(--foreground))]"
                    onClick={() => toggleScorerSort('baseline')}
                  >
                    Baseline
                    {isGroupComparison && baselineRunCount > 1 && (
                      <span className="font-normal opacity-60 ml-0.5">({baselineRunCount})</span>
                    )}
                    {sortIndicator('baseline')}
                  </th>
                  <th
                    className="text-right px-3 py-2 font-medium cursor-pointer select-none hover:text-[hsl(var(--foreground))]"
                    onClick={() => toggleScorerSort('candidate')}
                  >
                    Candidate
                    {isGroupComparison && candidateRunCount > 1 && (
                      <span className="font-normal opacity-60 ml-0.5">({candidateRunCount})</span>
                    )}
                    {sortIndicator('candidate')}
                  </th>
                  <th
                    className="text-right px-3 py-2 font-medium cursor-pointer select-none hover:text-[hsl(var(--foreground))]"
                    onClick={() => toggleScorerSort('delta')}
                  >
                    {hasCI ? (
                      <Tooltip text="Score delta with 95% confidence interval via paired bootstrap. If the CI excludes zero and the effect exceeds the practical threshold, the difference is significant (shown with a colored left border).">
                        Delta{sortIndicator('delta')}
                      </Tooltip>
                    ) : (
                      <>Delta{sortIndicator('delta')}</>
                    )}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedScorerEntries.map(([scorer, stats]) => {
                  const sign = stats.delta > 0 ? '+' : stats.delta < 0 ? '' : '';
                  const deltaColor =
                    stats.delta > 0
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : stats.delta < 0
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-[hsl(var(--muted-foreground))]';

                  return (
                    <tr
                      key={scorer}
                      className={cn(
                        'border-b border-[hsl(var(--border))] last:border-b-0',
                        stats.significant === true &&
                          stats.delta < 0 &&
                          'border-l-[3px] border-l-red-500',
                        stats.significant === true &&
                          stats.delta > 0 &&
                          'border-l-[3px] border-l-emerald-500',
                      )}
                    >
                      <td className="px-4 py-2.5 font-mono">
                        {scorer}
                        {scorerTypes?.[scorer] === 'llm' && (
                          <span
                            className="ml-1.5 px-1 py-0.5 text-[9px] font-medium rounded bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400 align-middle"
                            title="LLM scorer — scores may vary between runs"
                          >
                            LLM
                          </span>
                        )}
                      </td>
                      <td
                        className={cn(
                          'px-3 py-2.5 text-right font-mono',
                          scoreTextColor(stats.baselineMean),
                        )}
                      >
                        {stats.baselineMean.toFixed(3)}
                      </td>
                      <td
                        className={cn(
                          'px-3 py-2.5 text-right font-mono',
                          scoreTextColor(stats.candidateMean),
                        )}
                      >
                        {stats.candidateMean.toFixed(3)}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className={cn('font-mono', deltaColor)}>
                          {sign}
                          {Math.abs(stats.delta).toFixed(3)} ({sign}
                          {Math.abs(stats.deltaPercent).toFixed(1)}%)
                        </div>
                        {stats.ci && (
                          <div className="font-mono text-[10px] text-[hsl(var(--muted-foreground))] mt-0.5">
                            CI [{formatSigned(stats.ci.lower)}, {formatSigned(stats.ci.upper)}]
                          </div>
                        )}
                        {stats.pRegression != null &&
                          stats.pImprovement != null &&
                          (() => {
                            // Show the dominant direction's probability, or "no change" if both are near zero
                            const pReg = stats.pRegression ?? 0;
                            const pImp = stats.pImprovement ?? 0;
                            if (pReg === 0 && pImp === 0) return null;

                            let label: string;
                            let p: number;
                            let color: string;
                            if (pReg > pImp) {
                              p = pReg;
                              label = 'regression';
                              color =
                                Math.round(p * 100) >= 95
                                  ? 'text-red-600 dark:text-red-400'
                                  : 'text-[hsl(var(--muted-foreground))]';
                            } else if (pImp > pReg) {
                              p = pImp;
                              label = 'improvement';
                              color =
                                Math.round(p * 100) >= 95
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : 'text-[hsl(var(--muted-foreground))]';
                            } else {
                              return null; // exactly 50/50
                            }
                            const pct = Math.round(p * 100);
                            return (
                              <div className={cn('text-[10px] mt-0.5', color)}>
                                {pct}% probability of {label}
                                {stats.n != null && (
                                  <span className="opacity-60 ml-1">(n={stats.n})</span>
                                )}
                              </div>
                            );
                          })()}
                      </td>
                    </tr>
                  );
                })}

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
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Regressions & Improvements ──────────────────── */}
      {[
        {
          type: 'regression' as const,
          items: compareResult.regressions,
          borderColor: 'border-red-200 dark:border-red-900',
          bgColor: 'bg-red-50 dark:bg-red-950/30',
          textColor: 'text-red-700 dark:text-red-300',
          deltaColor: 'text-red-600 dark:text-red-400',
          label: 'Regressions',
          direction: -1,
        },
        {
          type: 'improvement' as const,
          items: compareResult.improvements,
          borderColor: 'border-emerald-200 dark:border-emerald-900',
          bgColor: 'bg-emerald-50 dark:bg-emerald-950/30',
          textColor: 'text-emerald-700 dark:text-emerald-300',
          deltaColor: 'text-emerald-600 dark:text-emerald-400',
          label: 'Improvements',
          direction: 1,
        },
      ]
        .filter((section) => section.items.length > 0)
        .map((section) => {
          const isPooled = baselineRuns && candidateRuns && baselineRuns.length > 1;
          const totalRuns = isPooled ? Math.min(baselineRuns!.length, candidateRuns!.length) : 0;

          // Compute consistency for each item and sort: highest consistency first, then by |delta|
          const enriched = section.items.map((r, originalIndex) => {
            let consistentCount = 0;
            if (isPooled) {
              for (let ri = 0; ri < totalRuns; ri++) {
                const bs = baselineRuns![ri]?.items[r.itemIndex]?.scores[r.scorer];
                const cs = candidateRuns![ri]?.items[r.itemIndex]?.scores[r.scorer];
                if (bs != null && cs != null && (section.direction < 0 ? cs < bs : cs > bs))
                  consistentCount++;
              }
            }
            return { ...r, originalIndex, consistentCount, totalRuns };
          });

          // Sort: consistency desc, then |delta| desc
          if (isPooled) {
            enriched.sort(
              (a, b) =>
                b.consistentCount - a.consistentCount || Math.abs(b.delta) - Math.abs(a.delta),
            );
          } else {
            enriched.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
          }

          // Check if all items share the same scorer
          const scorerNames = [...new Set(section.items.map((r) => r.scorer))];
          const singleScorer = scorerNames.length === 1 ? scorerNames[0] : null;

          // Group items by scorer for multi-scorer display
          const scorerGroups = new Map<string, typeof enriched>();
          for (const r of enriched) {
            if (!scorerGroups.has(r.scorer)) scorerGroups.set(r.scorer, []);
            scorerGroups.get(r.scorer)!.push(r);
          }

          const renderItem = (r: (typeof enriched)[0]) => {
            const isExpanded =
              expanded?.type === section.type && expanded.index === r.originalIndex;
            const baselineItem = baseline?.items[r.itemIndex];
            const candidateItem = candidate?.items[r.itemIndex];
            const inputLabel = r.input ? extractLabel(r.input, 40) : `Item #${r.itemIndex + 1}`;

            const opacity = isPooled
              ? r.consistentCount === totalRuns
                ? ''
                : r.consistentCount === 0
                  ? 'opacity-40'
                  : 'opacity-65'
              : '';

            return (
              <div key={r.originalIndex} className={opacity}>
                <button
                  onClick={() => toggleExpand(section.type, r.originalIndex)}
                  className="w-full text-left flex items-center gap-3 px-4 py-2.5 text-xs hover:bg-[hsl(var(--accent))] transition-colors cursor-pointer"
                >
                  {isPooled && (
                    <span
                      className={cn(
                        'shrink-0 text-[10px] font-mono font-medium px-1.5 py-0.5 rounded',
                        r.consistentCount === totalRuns
                          ? section.type === 'regression'
                            ? 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300'
                            : 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300'
                          : 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]',
                      )}
                    >
                      {r.consistentCount}/{totalRuns}
                    </span>
                  )}
                  <span className="min-w-0 truncate flex-1">
                    <span className="font-mono text-[hsl(var(--muted-foreground))]">
                      #{r.itemIndex + 1}
                    </span>{' '}
                    <span>{inputLabel}</span>
                  </span>
                  <span className={cn('font-mono shrink-0', section.deltaColor)}>
                    {r.baselineScore.toFixed(2)} {'\u2192'} {r.candidateScore.toFixed(2)}{' '}
                    <span className="text-[hsl(var(--muted-foreground))]">
                      ({r.delta > 0 ? '+' : ''}
                      {r.delta.toFixed(2)})
                    </span>
                  </span>
                </button>
                {isExpanded && baselineItem && candidateItem && (
                  <ItemComparison
                    baselineItem={baselineItem}
                    candidateItem={candidateItem}
                    scorer={r.scorer}
                    baselineRunItems={baselineRuns
                      ?.map((run) => run.items[r.itemIndex])
                      .filter(Boolean)}
                    candidateRunItems={candidateRuns
                      ?.map((run) => run.items[r.itemIndex])
                      .filter(Boolean)}
                  />
                )}
              </div>
            );
          };

          // Split into reliable (majority of runs agree) vs noise
          // In pooled mode: reliable = consistency > totalRuns/2, noise = rest
          // In single-run mode: show top 5 by default, rest behind toggle
          const SINGLE_RUN_LIMIT = 5;
          let reliableItems: typeof enriched;
          let noiseItems: typeof enriched;

          if (isPooled) {
            const majorityThreshold = Math.ceil(totalRuns / 2);
            reliableItems = enriched.filter((r) => r.consistentCount >= majorityThreshold);
            noiseItems = enriched.filter((r) => r.consistentCount < majorityThreshold);
          } else {
            reliableItems = enriched.slice(0, SINGLE_RUN_LIMIT);
            noiseItems = enriched.slice(SINGLE_RUN_LIMIT);
          }

          const isShowingNoise = showNoise[section.type] ?? false;
          const noiseLabel = isPooled
            ? `${noiseItems.length} likely noise (minority of runs)`
            : `${noiseItems.length} more`;

          // For multi-scorer, group both reliable and noise by scorer
          const groupByScorer = (items: typeof enriched) => {
            const groups = new Map<string, typeof enriched>();
            for (const r of items) {
              if (!groups.has(r.scorer)) groups.set(r.scorer, []);
              groups.get(r.scorer)!.push(r);
            }
            return groups;
          };

          const renderItemList = (items: typeof enriched) => {
            if (singleScorer) {
              return (
                <div className="divide-y divide-[hsl(var(--border))]">{items.map(renderItem)}</div>
              );
            }
            const groups = groupByScorer(items);
            return (
              <div>
                {[...groups.entries()].map(([scorerName, groupItems]) => (
                  <div key={scorerName}>
                    <div
                      className={cn(
                        'px-4 py-2 border-b border-t border-[hsl(var(--border))]',
                        section.type === 'regression'
                          ? 'bg-red-50/30 dark:bg-red-950/5'
                          : 'bg-emerald-50/30 dark:bg-emerald-950/5',
                      )}
                    >
                      <span className="text-[10px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                        {scorerName}
                      </span>
                      <span className="text-[10px] text-[hsl(var(--muted-foreground))] ml-1.5">
                        ({groupItems.length})
                      </span>
                    </div>
                    <div className="divide-y divide-[hsl(var(--border))]">
                      {groupItems.map(renderItem)}
                    </div>
                  </div>
                ))}
              </div>
            );
          };

          return (
            <div
              key={section.type}
              className={cn('border rounded-lg overflow-hidden', section.borderColor)}
            >
              <div className={cn('px-4 py-2.5 border-b', section.bgColor, section.borderColor)}>
                <h3 className={cn('text-xs font-medium', section.textColor)}>
                  {section.label} ({reliableItems.length}
                  {noiseItems.length > 0 ? ` + ${noiseItems.length} noise` : ''})
                  {pooledLabel && (
                    <span className="font-normal opacity-70 ml-1">
                      {' \u2014 '}scores {pooledLabel}
                    </span>
                  )}
                </h3>
              </div>

              {reliableItems.length > 0 ? (
                renderItemList(reliableItems)
              ) : (
                <div className="px-4 py-3 text-xs text-[hsl(var(--muted-foreground))]">
                  No reliable {section.label.toLowerCase()} detected (all within noise).
                </div>
              )}

              {noiseItems.length > 0 && (
                <>
                  <button
                    onClick={() =>
                      setShowNoise((prev) => ({ ...prev, [section.type]: !isShowingNoise }))
                    }
                    className="w-full flex items-center justify-center gap-1.5 px-4 py-2 text-[11px] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors border-t border-dashed border-[hsl(var(--border))] cursor-pointer"
                  >
                    {isShowingNoise ? (
                      <ChevronUp className="h-3 w-3" />
                    ) : (
                      <ChevronDown className="h-3 w-3" />
                    )}
                    {isShowingNoise ? 'Hide' : 'Show'} {noiseLabel}
                  </button>
                  {isShowingNoise && renderItemList(noiseItems)}
                </>
              )}
            </div>
          );
        })}

      {/* ── Item-level comparison ────────────────────────── */}
      {baseline && candidate && (
        <EvalCompareItemTable
          baseline={baseline}
          candidate={candidate}
          scorerNames={sortedScorerEntries.map(([name]) => name)}
          baselineRuns={baselineRuns ?? undefined}
          candidateRuns={candidateRuns ?? undefined}
          scorerTypes={scorerTypes}
        />
      )}
    </div>
  );
}

// ── Side-by-side item comparison ───────────────────────────────

type ItemLike = {
  output: unknown;
  scoreDetails?: Record<string, { score: number | null; metadata?: Record<string, unknown> }>;
};

function ItemSide({ label, item, scorer }: { label: string; item: ItemLike; scorer: string }) {
  const detail = item.scoreDetails?.[scorer];
  const reasoning =
    typeof detail?.metadata?.reasoning === 'string' ? detail.metadata.reasoning : null;

  return (
    <div className="p-4 space-y-3">
      <h5 className="font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider text-[10px]">
        {label}
      </h5>
      <JsonViewer data={item.output} collapsed />
      {detail?.score != null && (
        <div className="flex items-center gap-1.5">
          <span className="text-[hsl(var(--muted-foreground))]">Score:</span>
          <span
            className={cn(
              'px-2 py-0.5 rounded-full font-mono font-medium',
              scoreColorClass(detail.score),
            )}
          >
            {detail.score.toFixed(3)}
          </span>
        </div>
      )}
      {reasoning && (
        <div>
          <span className="font-medium text-[hsl(var(--muted-foreground))] text-[10px] uppercase tracking-wider block mb-1">
            Reasoning
          </span>
          <pre className="text-xs font-mono p-2 rounded-md bg-[hsl(var(--secondary))] overflow-auto max-h-48 whitespace-pre-wrap leading-relaxed">
            {reasoning}
          </pre>
        </div>
      )}
    </div>
  );
}

export function ItemComparison({
  baselineItem,
  candidateItem,
  scorer,
  baselineRunItems,
  candidateRunItems,
}: {
  baselineItem: ItemLike;
  candidateItem: ItemLike;
  scorer: string;
  baselineRunItems?: ItemLike[];
  candidateRunItems?: ItemLike[];
}) {
  const [runIndex, setRunIndex] = useState(0);
  const isPooled =
    (baselineRunItems && baselineRunItems.length > 1) ||
    (candidateRunItems && candidateRunItems.length > 1);
  const runCount = Math.max(baselineRunItems?.length ?? 1, candidateRunItems?.length ?? 1);

  // In pooled mode, show per-run items; in single mode, show the passed items
  const bItem =
    isPooled && baselineRunItems ? (baselineRunItems[runIndex] ?? baselineItem) : baselineItem;
  const cItem =
    isPooled && candidateRunItems ? (candidateRunItems[runIndex] ?? candidateItem) : candidateItem;

  // Averaged scores from the representative items (baselineItem/candidateItem have averaged scoreDetails)
  const bAvgScore = baselineItem.scoreDetails?.[scorer]?.score;
  const cAvgScore = candidateItem.scoreDetails?.[scorer]?.score;

  return (
    <div className="border-t border-[hsl(var(--border))] bg-[hsl(var(--card))] text-xs">
      {/* Averaged score summary for pooled mode */}
      {isPooled && (bAvgScore != null || cAvgScore != null) && (
        <div className="flex items-center gap-4 px-4 py-2 border-b border-[hsl(var(--border))] bg-[hsl(var(--card))]">
          <span className="text-[10px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
            Mean across {runCount} runs
          </span>
          <div className="flex items-center gap-3">
            {bAvgScore != null && (
              <span className="flex items-center gap-1">
                <span className="text-[hsl(var(--muted-foreground))]">Baseline:</span>
                <span className={cn('font-mono font-medium', scoreTextColor(bAvgScore))}>
                  {bAvgScore.toFixed(3)}
                </span>
              </span>
            )}
            {cAvgScore != null && (
              <span className="flex items-center gap-1">
                <span className="text-[hsl(var(--muted-foreground))]">Candidate:</span>
                <span className={cn('font-mono font-medium', scoreTextColor(cAvgScore))}>
                  {cAvgScore.toFixed(3)}
                </span>
              </span>
            )}
            {bAvgScore != null && cAvgScore != null && (
              <span
                className={cn(
                  'font-mono',
                  cAvgScore - bAvgScore > 0
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : cAvgScore - bAvgScore < 0
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-[hsl(var(--muted-foreground))]',
                )}
              >
                ({cAvgScore - bAvgScore > 0 ? '+' : ''}
                {(cAvgScore - bAvgScore).toFixed(3)})
              </span>
            )}
          </div>
        </div>
      )}

      {/* Run switcher for pooled mode */}
      {isPooled && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-[hsl(var(--border))] bg-[hsl(var(--muted))]">
          <span className="text-[10px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
            Run
          </span>
          <div className="flex items-center gap-0.5">
            {Array.from({ length: runCount }, (_, i) => (
              <button
                key={i}
                onClick={() => setRunIndex(i)}
                className={cn(
                  'px-2 py-0.5 rounded text-[10px] font-mono transition-colors cursor-pointer',
                  i === runIndex
                    ? 'bg-[hsl(var(--foreground))] text-[hsl(var(--background))]'
                    : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]',
                )}
              >
                {i + 1}
              </button>
            ))}
          </div>
          <span className="text-[10px] text-[hsl(var(--muted-foreground))] ml-auto">
            Showing output and reasoning from run {runIndex + 1} of {runCount}
          </span>
        </div>
      )}

      {/* Side-by-side comparison */}
      <div className="grid grid-cols-2 gap-0">
        <div className="border-r border-[hsl(var(--border))]">
          <ItemSide label="Baseline" item={bItem} scorer={scorer} />
        </div>
        <ItemSide label="Candidate" item={cItem} scorer={scorer} />
      </div>
    </div>
  );
}
