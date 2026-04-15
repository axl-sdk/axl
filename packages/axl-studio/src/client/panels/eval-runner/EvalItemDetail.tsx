import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { JsonViewer } from '../../components/shared/JsonViewer';
import { cn, formatCost, formatDuration } from '../../lib/utils';
import { getBarColor } from '../../lib/trace-utils';
import type { TraceEvent } from '../../lib/types';
import type { EvalItem } from './types';
import {
  scoreColorClass,
  scoreTextColor,
  scoreBarColor,
  getItemModels,
  formatModelName,
  getItemTokens,
  getItemAgentCalls,
} from './types';

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

/** Collapsible per-item trace viewer. Shows each captured event as a row with
 *  type + agent/tool + cost/duration, and expands to a JsonViewer on click. */
function ItemTraces({ traces }: { traces: TraceEvent[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggle = (i: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };
  return (
    <div className="rounded-xl border border-[hsl(var(--border))] overflow-hidden">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-2.5 bg-[hsl(var(--muted))]/50 border-b border-[hsl(var(--border))] hover:bg-[hsl(var(--muted))] text-left cursor-pointer"
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <span className="text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
          Trace
        </span>
        <span className="text-[11px] text-[hsl(var(--muted-foreground))] ml-1">
          {traces.length} event{traces.length !== 1 ? 's' : ''}
        </span>
      </button>
      {!collapsed && (
        <div className="divide-y divide-[hsl(var(--border))]">
          {traces.map((event, i) => {
            const isExpanded = expanded.has(i);
            return (
              <div key={i}>
                <button
                  onClick={() => toggle(i)}
                  className="w-full flex items-center gap-2 px-4 py-1.5 text-xs hover:bg-[hsl(var(--accent))] text-left cursor-pointer"
                >
                  {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  <span className="font-mono text-[hsl(var(--muted-foreground))] w-6">{i + 1}</span>
                  <span
                    className={cn('w-1.5 h-1.5 rounded-full shrink-0', getBarColor(event.type))}
                  />
                  <span className="font-medium w-28 truncate">{event.type}</span>
                  {event.agent && (
                    <span className="text-blue-600 dark:text-blue-400 w-24 truncate">
                      {event.agent}
                    </span>
                  )}
                  {event.tool && (
                    <span className="text-purple-600 dark:text-purple-400 w-24 truncate">
                      {event.tool}
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-2 font-mono text-[10px] text-[hsl(var(--muted-foreground))]">
                    {event.duration != null && event.duration > 0 && (
                      <span>{formatDuration(event.duration)}</span>
                    )}
                    {event.cost != null && event.cost > 0 && <span>{formatCost(event.cost)}</span>}
                  </div>
                </button>
                {isExpanded && (
                  <div className="px-4 py-3 bg-[hsl(var(--card))]">
                    <JsonViewer data={event as unknown as Record<string, unknown>} collapsed />
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

export function EvalItemDetail({ item, itemIndex, scorerNames, onBack }: Props) {
  const scorerErrors = item.scorerErrors ?? [];
  const models = getItemModels(item);
  const tokens = getItemTokens(item);
  const agentCalls = getItemAgentCalls(item);

  // Compute total cost line
  const workflowCost = item.cost ?? 0;
  const scorerCost = item.scorerCost ?? 0;
  const totalItemCost = workflowCost + scorerCost;

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
          {item.error && (
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
          {totalItemCost > 0 && <span>{formatCost(totalItemCost)}</span>}
        </div>
      </div>

      {/* ── Score overview strip ───────────────────────── */}
      {scorerNames.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 px-4 rounded-xl bg-[hsl(var(--muted))]/50">
          {scorerNames.map((name) => {
            const score = item.scores[name];
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
                ) : (
                  <span className="text-xs text-[hsl(var(--muted-foreground))] font-mono">—</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Error ─────────────────────────────────────── */}
      {item.error && (
        <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-xs font-mono">
          {item.error}
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

      {/* ── Cost breakdown ────────────────────────────── */}
      {totalItemCost > 0 && workflowCost > 0 && scorerCost > 0 && (
        <div className="flex items-center gap-3 text-xs text-[hsl(var(--muted-foreground))] font-mono">
          <span>Workflow: {formatCost(workflowCost)}</span>
          <span>+</span>
          <span>Scoring: {formatCost(scorerCost)}</span>
          <span>=</span>
          <span className="font-medium text-[hsl(var(--foreground))]">
            {formatCost(totalItemCost)}
          </span>
        </div>
      )}

      {/* ── Per-item traces (captureTraces mode only) ─── */}
      {item.traces && item.traces.length > 0 && (
        <ItemTraces traces={item.traces as unknown as TraceEvent[]} />
      )}

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
                  {score == null && !scorerError && (
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
                    {detail?.cost != null && detail.cost > 0 && (
                      <span className="text-xs font-mono text-[hsl(var(--muted-foreground))]">
                        {formatCost(detail.cost)}
                      </span>
                    )}
                  </div>
                </div>

                {/* Scorer body */}
                {(detail?.metadata || scorerError) && (
                  <div className="px-4 py-3 space-y-2">
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
