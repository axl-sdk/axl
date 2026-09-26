import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Graceful ask budgets active in the current async branch.
 *
 * Every `ctx.ask` pushes one tracker for its lifetime, so a nested ask sees
 * its own tracker plus every enclosing one, while sibling asks each see their
 * own copy of the stack and never share credit. A pause (an `awaitHuman` gate
 * or an SDK self-imposed governor wait in `fetchWithRetry`) is recorded on
 * every tracker in the branch: waiting on the SDK's own gates is never the
 * workflow's work, whichever ask is enclosing. Overlapping pauses on one
 * tracker count once, via an active-pause counter, so parallel tools cannot
 * mint more credit than wall time.
 *
 * Dependency-free so the provider transport can import it without a cycle.
 */
export type AskClockTracker = {
  pausedMs: number;
  activePauses: number;
  pauseStartedAt?: number;
};

const askClockStorage = new AsyncLocalStorage<AskClockTracker[]>();

/** Run `fn` with a fresh tracker pushed onto the branch's ask-clock stack. */
export function runWithAskClock<T>(fn: () => T): T {
  const tracker: AskClockTracker = { pausedMs: 0, activePauses: 0 };
  const enclosing = askClockStorage.getStore() ?? [];
  return askClockStorage.run([...enclosing, tracker], fn);
}

/** The innermost ask's tracker, or `undefined` outside any ask. */
export function currentAskClock(): AskClockTracker | undefined {
  return askClockStorage.getStore()?.at(-1);
}

/** Total paused time on a tracker, including a pause still in progress. */
export function pausedAskClockMs(tracker: AskClockTracker, now = Date.now()): number {
  return (
    tracker.pausedMs +
    (tracker.activePauses > 0 && tracker.pauseStartedAt !== undefined
      ? now - tracker.pauseStartedAt
      : 0)
  );
}

/**
 * Pause every enclosing ask clock for the duration of `wait`. Outside an ask
 * this is a plain passthrough. Rejections propagate unchanged after the
 * pause is closed.
 */
export async function pauseAskClocks<T>(wait: () => Promise<T>): Promise<T> {
  const trackers = askClockStorage.getStore();
  if (!trackers || trackers.length === 0) return wait();
  const startedAt = Date.now();
  for (const tracker of trackers) {
    if (tracker.activePauses++ === 0) tracker.pauseStartedAt = startedAt;
  }
  try {
    return await wait();
  } finally {
    const finishedAt = Date.now();
    for (const tracker of trackers) {
      tracker.activePauses--;
      if (tracker.activePauses === 0 && tracker.pauseStartedAt !== undefined) {
        tracker.pausedMs += finishedAt - tracker.pauseStartedAt;
        tracker.pauseStartedAt = undefined;
      }
    }
  }
}
