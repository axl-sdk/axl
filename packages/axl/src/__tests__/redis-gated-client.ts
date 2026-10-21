import { PRUNE_HISTORY_INDEX_SCRIPT } from '../state/redis.js';

/**
 * A wrapper around a Redis client (the shared mock, or a real node-redis
 * client) that can pause or fail RedisStore's history prune (and
 * `applyHistoryRetention`) at named steps, so tests can interleave a
 * competing save or delete deterministically, with no timers.
 *
 * Steps are recognized from the command and the key it touches, never from
 * store internals:
 *
 * | Step                 | Command                                              |
 * |----------------------|------------------------------------------------------|
 * | `zrange-expiry`      | ZRANGE on a `…-exp` sorted set (the prune's read)    |
 * | `eval-prune`         | EVAL of `PRUNE_HISTORY_INDEX_SCRIPT`                 |
 * | `retention-multi`    | a MULTI with a PEXPIREAT (`applyHistoryRetention`)   |
 * | `expiry-index-multi` | a MULTI that only adds to a `…-exp` sorted set       |
 *
 * A paused step waits before its command is sent; a failed step throws
 * instead of sending it, like a connection that dropped at that point (or a
 * server that rejected it).
 */
export type PruneStep = 'zrange-expiry' | 'eval-prune' | 'retention-multi' | 'expiry-index-multi';

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type Pause = { reached: Deferred; release: Deferred };

export type GatedClient<C> = {
  client: C;
  /** Every step reached, in order. */
  readonly steps: PruneStep[];
  /** Arm a pause; resolves once a command at `step` is waiting. */
  pauseAt(step: PruneStep): Promise<void>;
  /** Let the commands waiting at `step` through, and disarm the pause. */
  release(step: PruneStep): void;
  /** Make the next command at `step` throw instead of being sent. */
  failAt(step: PruneStep, error?: Error): void;
};

const isExpiry = (key: unknown) => typeof key === 'string' && key.endsWith('-history-exp');

export function gateRedisClient<C extends object>(client: C): GatedClient<C> {
  const steps: PruneStep[] = [];
  const pauses = new Map<PruneStep, Pause>();
  const failures = new Map<PruneStep, Error>();

  async function gate(step: PruneStep): Promise<void> {
    steps.push(step);
    const failure = failures.get(step);
    if (failure) {
      failures.delete(step);
      throw failure;
    }
    const pause = pauses.get(step);
    if (pause) {
      pause.reached.resolve();
      await pause.release.promise;
    }
  }

  function labelCommand(method: string, args: unknown[]): PruneStep | undefined {
    if (method === 'zRange' && isExpiry(args[0])) return 'zrange-expiry';
    if (method === 'eval' && args[0] === PRUNE_HISTORY_INDEX_SCRIPT) return 'eval-prune';
    return undefined;
  }

  function labelMulti(ops: Array<[string, unknown]>): PruneStep | undefined {
    if (ops.some(([m]) => m === 'pExpireAt')) return 'retention-multi';
    if (ops.length > 0 && ops.every(([m, key]) => m === 'zAdd' && isExpiry(key))) {
      return 'expiry-index-multi';
    }
    return undefined;
  }

  function wrapMulti(chain: object): object {
    const ops: Array<[string, unknown]> = [];
    const proxy: object = new Proxy(chain, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== 'function') return value;
        if (prop === 'exec') {
          return async () => {
            const step = labelMulti(ops);
            if (step) await gate(step);
            return (value as () => Promise<unknown>).call(target);
          };
        }
        return (...args: unknown[]) => {
          ops.push([String(prop), args[0]]);
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          return result === target ? proxy : result;
        };
      },
    });
    return proxy;
  }

  const gated = new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      if (prop === 'multi') {
        return (...args: unknown[]) =>
          wrapMulti((value as (...a: unknown[]) => object).apply(target, args));
      }
      return async (...args: unknown[]) => {
        const step = labelCommand(String(prop), args);
        if (step) await gate(step);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });

  return {
    client: gated,
    steps,
    pauseAt(step) {
      const pause = { reached: deferred(), release: deferred() };
      pauses.set(step, pause);
      return pause.reached.promise;
    },
    release(step) {
      const pause = pauses.get(step);
      if (!pause) throw new Error(`no pause armed at ${step}`);
      pauses.delete(step);
      pause.release.resolve();
    },
    failAt(step, error = new Error(`ECONNRESET at ${step}`)) {
      failures.set(step, error);
    },
  };
}
