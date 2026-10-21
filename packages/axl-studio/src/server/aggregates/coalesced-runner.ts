/**
 * Runs `task` one at a time. A request made while a run is in flight does not
 * start a second run; all such requests share one trailing run that starts when
 * the current one finishes. A burst of N requests therefore costs at most two
 * runs, and the trailing run begins after every request in the burst, so it
 * observes their effects.
 *
 * A failed run rejects the callers it served and does not block later runs.
 */
export class CoalescedRunner {
  private current?: Promise<void>;
  private trailing?: Promise<void>;

  constructor(private readonly task: () => Promise<void>) {}

  run(): Promise<void> {
    if (!this.current) {
      const started = this.task().finally(() => {
        this.current = undefined;
      });
      this.current = started;
      return started;
    }
    this.trailing ??= this.current
      .catch(() => undefined)
      .then(() => {
        this.trailing = undefined;
        return this.run();
      });
    return this.trailing;
  }
}
