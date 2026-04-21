/**
 * Progressive JSON view for `partial_object` events.
 *
 * Spec/16 §5.9. Filters the event stream to the given `askId`, finds the
 * latest `partial_object` snapshot, and renders it via `JsonViewer`. On
 * `pipeline(status: 'failed')` for the same ask, resets the view so the
 * failed attempt's progress doesn't linger.
 *
 * Pure component — takes events, returns JSX. No internal subscription,
 * no data fetching. The calling panel wires up the event stream.
 */
import { useMemo, type ReactElement } from 'react';
import { JsonViewer } from './JsonViewer';
import { EmptyState } from './EmptyState';
import type { AxlEvent } from '../../lib/types';

export type PartialObjectRendererProps = {
  events: AxlEvent[];
  /** Ask to render. If omitted, shows the most recent partial from ANY ask. */
  askId?: string;
  /**
   * How to react to `pipeline(status: 'failed')`:
   *   - 'on_pipeline_failed' (default): clear the view when the latest
   *     pipeline event for this ask is `failed`. The next `partial_object`
   *     will repopulate as the retry streams in.
   *   - 'never': keep the most recent snapshot regardless. Useful for
   *     debug panels that want to see what the losing attempt produced.
   */
  reset?: 'on_pipeline_failed' | 'never';
};

export function PartialObjectRenderer(props: PartialObjectRendererProps): ReactElement {
  const { events, askId, reset = 'on_pipeline_failed' } = props;

  const rendered = useMemo(() => {
    // Filter to the requested ask. Without `askId`, the component tracks
    // whichever ask produced the latest partial_object event.
    let currentAskId = askId;
    let latestPartial: AxlEvent | undefined;
    let latestFailed = false;

    for (const ev of events) {
      // Track the most recent ask if no filter was supplied.
      if (!askId && ev.type === 'partial_object') {
        currentAskId = ev.askId;
      }
      if (ev.askId !== currentAskId) continue;

      if (ev.type === 'partial_object') {
        latestPartial = ev;
        latestFailed = false; // a successful partial supersedes any prior failed
      } else if (
        reset === 'on_pipeline_failed' &&
        ev.type === 'pipeline' &&
        ev.status === 'failed'
      ) {
        latestFailed = true;
      } else if (ev.type === 'pipeline' && ev.status === 'committed') {
        // Committed: latest partial holds its final form (the commit
        // itself doesn't carry a new object).
        latestFailed = false;
      }
    }

    if (!latestPartial || latestFailed) return null;
    const data = latestPartial.data as { object?: unknown } | undefined;
    return data?.object;
  }, [events, askId, reset]);

  if (rendered === null || rendered === undefined) {
    return (
      <EmptyState
        title="Waiting for partial object"
        description="Progressive structured output will appear here as the agent streams."
      />
    );
  }

  return (
    <div
      data-testid="partial-object-renderer"
      className="rounded border border-slate-200 p-3 dark:border-slate-700"
    >
      <JsonViewer data={rendered} defaultExpandDepth={Infinity} />
    </div>
  );
}
