/**
 * Inline badge that surfaces pipeline retry state alongside an agent turn.
 *
 * Consumers pass the stage/attempt/status from a `pipeline` AxlEvent:
 *   - `status === 'start'` + `stage !== 'initial'`: amber "Retrying — {stage}"
 *   - `status === 'failed'`: red "{stage} failed (n/m)"
 *   - `status === 'committed'`: green "Committed (n/m)" — usually collapsed
 *
 * Spec/16 §5.9. One pure component — no internal state, no data fetching.
 * The calling panel decides which events to render indicators for.
 */
import type { ReactElement } from 'react';
import { cn } from '../../lib/utils';

export type RetryIndicatorProps = {
  stage: 'initial' | 'schema' | 'validate' | 'guardrail';
  attempt: number;
  maxAttempts: number;
  status: 'start' | 'failed' | 'committed';
  /** Optional extra className(s) for the wrapping badge. */
  className?: string;
};

/** Short human-facing label for a pipeline stage. */
function stageLabel(stage: RetryIndicatorProps['stage']): string {
  switch (stage) {
    case 'schema':
      return 'Schema';
    case 'validate':
      return 'Validate';
    case 'guardrail':
      return 'Guardrail';
    case 'initial':
      return 'Initial';
  }
}

export function RetryIndicator(props: RetryIndicatorProps): ReactElement {
  const { stage, attempt, maxAttempts, status, className } = props;

  // Color / label policy per status. Spec §5.9 describes three states:
  //   - in-flight retry (amber), failed-retry-scheduled (red),
  //     committed (green).
  let tone: string;
  let label: string;
  if (status === 'committed') {
    tone = 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200';
    label = `Committed ${attempt}/${maxAttempts}`;
  } else if (status === 'failed') {
    tone = 'bg-red-100 text-red-900 dark:bg-red-900/30 dark:text-red-200';
    label = `${stageLabel(stage)} failed (${attempt}/${maxAttempts})`;
  } else {
    // start — color by whether this is the first attempt (neutral) or
    // an actual retry (amber).
    const isRetry = stage !== 'initial';
    tone = isRetry
      ? 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200'
      : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200';
    label = isRetry
      ? `Retrying — ${stageLabel(stage)} ${attempt}/${maxAttempts}`
      : `${stageLabel(stage)} ${attempt}/${maxAttempts}`;
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        tone,
        className,
      )}
      data-testid="retry-indicator"
      data-status={status}
      data-stage={stage}
    >
      {label}
    </span>
  );
}
