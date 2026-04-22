/**
 * Side panel showing a single ask's full event timeline. Filters the
 * event stream to the given `askId` and reuses `TraceEventList` for
 * row rendering so the presentation matches the rest of Studio.
 *
 * Spec/16 §5.9. Pure component — the hosting panel decides when to
 * show/hide via state (e.g., selection from an `AskTree`).
 */
import { useMemo, type ReactElement } from 'react';
import { X } from 'lucide-react';
import { TraceEventList } from './TraceEventList';
import { CostBadge } from './CostBadge';
import { DurationBadge } from './DurationBadge';
import { cn } from '../../lib/utils';
import type { AxlEvent } from '../../lib/types';

export type AskDetailsProps = {
  events: AxlEvent[];
  askId: string;
  onClose?: () => void;
  className?: string;
};

export function AskDetails(props: AskDetailsProps): ReactElement {
  const { events, askId, onClose, className } = props;

  const { filtered, summary } = useMemo(() => {
    const filtered = events.filter(
      (e) =>
        e.askId === askId ||
        // handoff_start/return span source→target and aren't AskScoped
        // themselves; surface them on the drill-down for either end.
        ((e.type === 'handoff_start' || e.type === 'handoff_return') &&
          (e.fromAskId === askId || e.toAskId === askId)),
    );
    // Derive a one-line summary from the events we have.
    const start = filtered.find((e) => e.type === 'ask_start');
    const end = filtered.find((e) => e.type === 'ask_end');
    // Fallback for asks that don't emit ask_start (e.g., legacy handoff
    // targets from before the target-wrap fix): walk filtered events for
    // one with an `agent` field. Ensures the drill-down header never
    // renders "unknown agent" just because the first event isn't ask_start.
    const agent = start?.agent ?? filtered.find((e) => 'agent' in e && e.agent)?.agent;
    const prompt = start?.prompt;
    const cost = end?.cost;
    const duration =
      start && end && typeof start.timestamp === 'number' && typeof end.timestamp === 'number'
        ? end.timestamp - start.timestamp
        : undefined;
    const outcome = end?.outcome;
    return { filtered, summary: { agent, prompt, cost, duration, outcome } };
  }, [events, askId]);

  return (
    <div
      data-testid="ask-details"
      data-ask-id={askId}
      className={cn(
        'flex flex-col h-full bg-white border-l border-slate-200 dark:bg-slate-900 dark:border-slate-700',
        className,
      )}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{summary.agent ?? '<unknown agent>'}</span>
          <span className="text-xs font-mono text-slate-400" title={askId}>
            {askId.slice(0, 8)}
          </span>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close ask details"
            className="rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="px-4 py-2 border-b border-slate-200 dark:border-slate-700 flex items-center gap-3 text-xs">
        {summary.duration !== undefined && <DurationBadge ms={summary.duration} />}
        {typeof summary.cost === 'number' && <CostBadge cost={summary.cost} />}
        {summary.outcome && (
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
              summary.outcome.ok
                ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200'
                : 'bg-red-100 text-red-900 dark:bg-red-900/30 dark:text-red-200',
            )}
          >
            {summary.outcome.ok ? 'ok' : 'failed'}
          </span>
        )}
      </div>
      {summary.prompt && (
        <div className="px-4 py-2 border-b border-slate-200 text-sm dark:border-slate-700">
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Prompt</div>
          <div className="font-mono whitespace-pre-wrap break-words">{summary.prompt}</div>
        </div>
      )}
      <div className="flex-1 overflow-auto px-2 py-2">
        {filtered.length === 0 ? (
          <div className="text-sm text-slate-500 py-4 text-center">No events for this ask.</div>
        ) : (
          <TraceEventList events={filtered} />
        )}
      </div>
    </div>
  );
}
