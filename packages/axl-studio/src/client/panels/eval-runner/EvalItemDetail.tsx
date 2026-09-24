import { useState } from 'react';
import { JsonViewer } from '../../components/shared/JsonViewer';
import { TraceEventList } from '../../components/shared/TraceEventList';
import { cn, formatDuration } from '../../lib/utils';
import type { AxlEvent } from '../../lib/types';
import type { EvalItem, EvalItemFailure } from './types';
import {
  scoreColorClass,
  scoreTextColor,
  scoreBarColor,
  getItemModels,
  formatModelName,
  getItemTokens,
  getItemAgentCalls,
} from './types';
import {
  itemOutcome,
  readItemAccounting,
  readScorerAccounting,
  scorerDidNotRun,
  scorerOutcome,
} from './accounting';
import { ItemOutcomeBadge, ScorerOutcomeBadge } from './OutcomeBadge';
import { SpendBadge } from './SpendBadge';

type Props = {
  item: EvalItem;
  itemIndex: number;
  scorerNames: string[];
  onBack: () => void;
};

const REASONING_TRUNCATE_LENGTH = 300;

function ReasoningBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const needsTruncation = text.length > REASONING_TRUNCATE_LENGTH;

  return (
    <div>
      <pre className="text-xs font-mono p-3 rounded-lg bg-[hsl(var(--secondary))] overflow-auto max-h-96 whitespace-pre-wrap leading-relaxed">
        {needsTruncation && !expanded ? text.slice(0, REASONING_TRUNCATE_LENGTH) + '\u2026' : text}
      </pre>
      {needsTruncation && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-[hsl(var(--primary))] hover:underline mt-1.5 cursor-pointer"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

function DataCard({ label, data }: { label: string; data: unknown }) {
  return (
    <div className="rounded-xl border border-[hsl(var(--border))] overflow-hidden">
      <div className="px-4 py-2.5 bg-[hsl(var(--muted))]/50 border-b border-[hsl(var(--border))]">
        <span className="text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
          {label}
        </span>
      </div>
      <div className="p-4">
        <JsonViewer data={data} collapsed />
      </div>
    </div>
  );
}

/** Collapsible per-item trace viewer. Wraps the shared TraceEventList (the
 *  same renderer used by Trace Explorer and Workflow Runner) in a card with
 *  an outer collapse toggle, so users get retry pills, attempt counters,
 *  agent_call body renderers, failure-red dots, and the full set of
 *  affordances consistent with the rest of the app. */
function ItemTraces({ traces }: { traces: AxlEvent[] }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="rounded-xl border border-[hsl(var(--border))] overflow-hidden">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-2.5 bg-[hsl(var(--muted))]/50 border-b border-[hsl(var(--border))] hover:bg-[hsl(var(--muted))] text-left cursor-pointer"
      >
        <span className={cn('text-[11px]', collapsed ? 'rotate-0' : 'rotate-90')}>▶</span>
        <span className="text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
          Trace
        </span>
        <span className="text-[11px] text-[hsl(var(--muted-foreground))] ml-1">
          {traces.length} event{traces.length !== 1 ? 's' : ''}
        </span>
      </button>
      {!collapsed && (
        <div className="p-2">
          <TraceEventList events={traces} />
        </div>
      )}
    </div>
  );
}

/**
 * One line naming why a failed item failed: `Cause: ProviderError · openai ·
 * HTTP 429 · retryable · request req_…`, or just the thrown name when no
 * provider error was found. Status `0` is a network-level failure. The record
 * never carries the provider's response body, so there is nothing to scrub.
 */
function FailureCause({ failure }: { failure: EvalItemFailure }) {
  const parts: string[] = [];
  if (failure.provider) parts.push(failure.provider);
  if (failure.status !== undefined) {
    parts.push(failure.status === 0 ? 'network' : `HTTP ${failure.status}`);
  }
  if (failure.retryable !== undefined) {
    parts.push(failure.retryable ? 'retryable' : 'not retryable');
  }
  if (failure.requestId) parts.push(`request ${failure.requestId}`);
  return (
    <div
      data-testid="item-failure-cause"
      className="text-xs font-mono text-red-700 dark:text-red-300"
    >
      <span className="font-sans font-medium">Cause: </span>
      {[failure.name, ...parts].join(' · ')}
    </div>
  );
}

export function EvalItemDetail({ item, itemIndex, scorerNames, onBack }: Props) {
  const scorerErrors = item.scorerErrors ?? [];
  const models = getItemModels(item);
  const tokens = getItemTokens(item);
  const agentCalls = getItemAgentCalls(item);

  // Measured spend for this item. `breakdown` splits generation from judging;
  // the whole record travels with its completeness so neither half can be read
  // as exact when it isn't.
  const accounting = readItemAccounting(item);
  const generationAccounting = { ...accounting, knownCost: accounting.breakdown.generation };
  const judgingAccounting = { ...accounting, knownCost: accounting.breakdown.judging };
  const outcome = itemOutcome(item);

  return (
    <div className="space-y-5">
      {/* ── Breadcrumb + badges ────────────────────────── */}
      <div className="flex items-center justify-between">
        <nav className="flex items-center gap-1.5 text-sm">
          <button
            onClick={onBack}
            className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors cursor-pointer"
          >
            Overview
          </button>
          <span className="text-[hsl(var(--muted-foreground))]">/</span>
          <span className="font-medium">Item #{itemIndex + 1}</span>
          <ItemOutcomeBadge outcome={outcome} className="ml-1" />
          {outcome == null && item.error && (
            <span className="ml-1 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30">
              Error
            </span>
          )}
        </nav>
        <div className="flex items-center gap-2 text-xs text-[hsl(var(--muted-foreground))] font-mono">
          {models.length > 0 &&
            models.map((m) => (
              <span
                key={m}
                className="px-1.5 py-0.5 rounded bg-[hsl(var(--secondary))] text-[hsl(var(--foreground))] text-[10px] font-medium"
                title={m}
              >
                {formatModelName(m)}
              </span>
            ))}
          {tokens && (
            <span
              title={`Input: ${tokens.input.toLocaleString()}  Output: ${tokens.output.toLocaleString()}${tokens.reasoning ? `  Reasoning: ${tokens.reasoning.toLocaleString()}` : ''}`}
            >
              {(tokens.input + tokens.output + tokens.reasoning).toLocaleString()} tok
            </span>
          )}
          {agentCalls > 1 && (
            <span title={`${agentCalls} agent calls for this item`}>{agentCalls} calls</span>
          )}
          {item.duration != null && <span>{formatDuration(item.duration)}</span>}
          <SpendBadge accounting={accounting} label={`Item ${itemIndex + 1} known spend`} />
        </div>
      </div>

      {/* ── Score overview strip ───────────────────────── */}
      {scorerNames.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 px-4 rounded-xl bg-[hsl(var(--muted))]/50">
          {scorerNames.map((name) => {
            const score = item.scores[name];
            const skipped = item.scoreDetails?.[name]?.skipped === true;
            return (
              <div key={name} className="flex items-center gap-2">
                <span className="text-xs text-[hsl(var(--muted-foreground))]">{name}</span>
                {score != null ? (
                  <div className="flex items-center gap-1.5">
                    {/* Mini bar */}
                    <div className="w-12 h-1.5 bg-[hsl(var(--secondary))] rounded-full overflow-hidden">
                      <div
                        className={cn('h-full rounded-full', scoreBarColor(score))}
                        style={{ width: `${score * 100}%` }}
                      />
                    </div>
                    <span
                      className={cn(
                        'text-xs font-mono font-medium tabular-nums',
                        scoreTextColor(score),
                      )}
                    >
                      {score.toFixed(2)}
                    </span>
                  </div>
                ) : scorerDidNotRun(item.scoreDetails?.[name]) ? (
                  <ScorerOutcomeBadge outcome={scorerOutcome(item.scoreDetails?.[name])} />
                ) : skipped ? (
                  <span
                    className="text-xs text-[hsl(var(--muted-foreground))] font-mono"
                    title="Not applicable (N/A)"
                  >
                    N/A
                  </span>
                ) : (
                  <span className="text-xs text-[hsl(var(--muted-foreground))] font-mono">—</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Error ─────────────────────────────────────── */}
      {(item.error || item.failure) && (
        <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-xs font-mono space-y-1.5">
          {item.failure && <FailureCause failure={item.failure} />}
          {item.error && <div>{item.error}</div>}
        </div>
      )}

      {/* ── Input / Output / Expected ─────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <DataCard label="Input" data={item.input} />
        <DataCard label="Output" data={item.output} />
      </div>
      {item.annotations != null && (
        <DataCard label="Expected (Annotations)" data={item.annotations} />
      )}

      {/* ── Spend breakdown ───────────────────────────── */}
      <div className="flex items-center gap-3 text-xs text-[hsl(var(--muted-foreground))] flex-wrap">
        <span className="flex items-center gap-1.5">
          Generation:
          <SpendBadge accounting={generationAccounting} label="Generation spend" />
        </span>
        <span>+</span>
        <span className="flex items-center gap-1.5">
          Judging:
          <SpendBadge accounting={judgingAccounting} label="Judging spend" />
        </span>
        <span>=</span>
        <span className="flex items-center gap-1.5 font-medium text-[hsl(var(--foreground))]">
          <SpendBadge accounting={accounting} label="Item known spend" />
        </span>
      </div>

      {/* Caller-reported values are shown, and shown as NOT part of the total.
          A workflow callback that returns its own `cost` is making a claim Axl
          did not observe; folding it in would overwrite a measurement with an
          assertion, and dropping it silently would lose the user's own data. */}
      {item.callerReport?.cost != null && (
        <div
          className="text-xs text-[hsl(var(--muted-foreground))] font-mono"
          title="Returned by the executeWorkflow callback. Kept for inspection; never summed into known spend."
        >
          ${item.callerReport.cost.toFixed(2)} — caller-reported (not counted)
        </div>
      )}

      {/* ── Per-item traces (captureTraces mode only) ─── */}
      {/* `EvalItem.traces` is typed `unknown[]` on the wire (the eval payload
          is shaped server-side and forwarded verbatim); cast to AxlEvent[]
          at the render boundary so the strict union types reach the row
          renderer. The runtime always emits AxlEvent on this field — the
          type narrowing is purely a wire-layer formality. */}
      {item.traces && item.traces.length > 0 && <ItemTraces traces={item.traces as AxlEvent[]} />}

      {/* ── Scorer details ────────────────────────────── */}
      {scorerNames.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
            Scorer Results
          </h4>
          {scorerNames.map((name) => {
            const score = item.scores[name];
            const detail = item.scoreDetails?.[name];
            const scorerError = scorerErrors.find((err) => err.includes(`"${name}"`));
            const skipped = detail?.skipped === true;

            return (
              <div
                key={name}
                className="rounded-xl border border-[hsl(var(--border))] overflow-hidden"
              >
                {/* Scorer header */}
                <div className="flex items-center gap-2 px-4 py-2.5 bg-[hsl(var(--muted))]/50">
                  <span className="font-mono text-xs font-medium">{name}</span>
                  {score != null && (
                    <span
                      className={cn(
                        'px-2 py-0.5 rounded-full text-xs font-mono font-medium',
                        scoreColorClass(score),
                      )}
                    >
                      {score.toFixed(3)}
                    </span>
                  )}
                  {/* The judge's own outcome, when recorded. It is what
                      separates "scored 0" from "never ran", and the six values
                      each read differently. */}
                  <ScorerOutcomeBadge outcome={scorerOutcome(detail)} />
                  {score == null && skipped && scorerOutcome(detail) == null && (
                    <span
                      className="px-2 py-0.5 rounded-full text-xs font-mono bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]"
                      title="Skipped — the scorer's `applies` predicate returned false for this item (excluded from the mean and failure rate)"
                    >
                      N/A
                    </span>
                  )}
                  {score == null && !skipped && !scorerError && scorerOutcome(detail) == null && (
                    <span className="px-2 py-0.5 rounded-full text-xs font-mono bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))]">
                      null
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-2">
                    {detail?.duration != null && (
                      <span className="text-xs font-mono text-[hsl(var(--muted-foreground))]">
                        {formatDuration(detail.duration)}
                      </span>
                    )}
                    {(detail?.accounting || detail?.cost != null) && (
                      <SpendBadge
                        accounting={readScorerAccounting(detail)}
                        label={`${name} judging spend`}
                        className="text-xs text-[hsl(var(--muted-foreground))]"
                      />
                    )}
                  </div>
                </div>

                {/* Scorer body */}
                {(detail?.metadata || scorerError || skipped) && (
                  <div className="px-4 py-3 space-y-2">
                    {/* Skipped explanation */}
                    {skipped && (
                      <p className="text-xs text-[hsl(var(--muted-foreground))]">
                        Not applicable — the scorer&rsquo;s <code>applies</code> predicate returned
                        false for this item, so it was skipped (excluded from the mean and the
                        failure rate).
                      </p>
                    )}
                    {/* Reasoning */}
                    {detail?.metadata &&
                      typeof detail.metadata.reasoning === 'string' &&
                      detail.metadata.reasoning.length > 0 && (
                        <div>
                          <span className="text-[11px] font-medium text-[hsl(var(--muted-foreground))] block mb-1.5 uppercase tracking-wider">
                            Reasoning
                          </span>
                          <ReasoningBlock text={detail.metadata.reasoning} />
                        </div>
                      )}

                    {/* Other metadata (excluding reasoning) */}
                    {detail?.metadata &&
                      (() => {
                        const otherKeys = Object.keys(detail.metadata!).filter(
                          (k) => k !== 'reasoning',
                        );
                        if (otherKeys.length === 0) return null;
                        const otherMeta: Record<string, unknown> = {};
                        for (const k of otherKeys) {
                          otherMeta[k] = detail.metadata![k];
                        }
                        return (
                          <div>
                            <span className="text-[11px] font-medium text-[hsl(var(--muted-foreground))] block mb-1.5 uppercase tracking-wider">
                              Metadata
                            </span>
                            <JsonViewer data={otherMeta} collapsed />
                          </div>
                        );
                      })()}

                    {/* Scorer error */}
                    {scorerError && (
                      <div className="text-xs text-amber-600 dark:text-amber-400 font-mono p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/30">
                        {scorerError}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
