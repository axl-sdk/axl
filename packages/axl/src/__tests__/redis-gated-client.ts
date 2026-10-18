/**
 * A wrapper around a Redis client (the shared mock, or a real node-redis
 * client) that can pause or fail RedisStore's history prune (and
 * `applyHistoryRetention`) at named steps, so tests can interleave a
 * competing save or delete deterministically, with no timers.
 *
 * Steps are recognized from the command and the key it touches, never from
 * store internals:
 *
 * | Step            | Command                                                 |
 * |-----------------|---------------------------------------------------------|
 * | `recheck-read`  | SMEMBERS on a `…-prune-recheck…` key (registry or batch) |
 * | `zrange-expiry` | ZRANGE on a `…-exp` sorted set                          |
 * | `mget-1`        | the MGET right after `zrange-expiry`                    |
 * | `remove-multi`  | a MULTI that adds to a `…-prune-recheck…` key            |
 * | `mget-2`        | the MGET right after `remove-multi` or `recheck-read`   |
 * | `pttl`          | a PTTL right after `mget-2`                             |
 * | `reindex-multi` | a MULTI that deletes or removes from a recheck key       |
 * | `rescore-multi` | a MULTI that only touches a `…-exp` sorted set          |
 * | `retention-multi` | a MULTI with a PEXPIREAT (`applyHistoryRetention`)    |
 *
 * A paused step waits before its command is sent; a failed step throws
 * instead of sending it, like a connection that dropped at that point.
 */
export type PruneStep =
  | 'recheck-read'
  | 'zrange-expiry'
  | 'mget-1'
  | 'remove-multi'
  | 'mget-2'
  | 'pttl'
  | 'reindex-multi'
  | 'rescore-multi'
  | 'retention-multi';

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
  /** Every MULTI sent (or attempted), with its step if it had one and its queued commands. */
  readonly multis: Array<{ step?: PruneStep; ops: Array<{ method: string; args: unknown[] }> }>;
  /** Arm a pause; resolves once a command at `step` is waiting. */
  pauseAt(step: PruneStep): Promise<void>;
  /** Let the commands waiting at `step` through, and disarm the pause. */
  release(step: PruneStep): void;
  /** Make the next command at `step` throw instead of being sent. */
  failAt(step: PruneStep, error?: Error): void;
};

const isRecheck = (key: unknown) => {
  const keys = Array.isArray(key) ? key : [key];
  return keys.some((k) => typeof k === 'string' && k.includes('-prune-recheck'));
};
const isExpiry = (key: unknown) => typeof key === 'string' && key.endsWith('-history-exp');

export function gateRedisClient<C extends object>(client: C): GatedClient<C> {
  const steps: PruneStep[] = [];
  const multis: GatedClient<C>['multis'] = [];
  const pauses = new Map<PruneStep, Pause>();
  const failures = new Map<PruneStep, Error>();
  let lastStep: PruneStep | undefined;

  async function gate(step: PruneStep): Promise<void> {
    steps.push(step);
    lastStep = step;
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
    if (method === 'sMembers' && isRecheck(args[0])) return 'recheck-read';
    if (method === 'zRange' && isExpiry(args[0])) return 'zrange-expiry';
    if (method === 'mGet') {
      if (lastStep === 'zrange-expiry') return 'mget-1';
      if (lastStep === 'remove-multi' || lastStep === 'recheck-read') return 'mget-2';
      return undefined;
    }
    if (method === 'pTTL' && (lastStep === 'mget-2' || lastStep === 'pttl')) return 'pttl';
    return undefined;
  }

  function labelMulti(ops: Array<[string, unknown]>): PruneStep | undefined {
    if (ops.some(([m]) => m === 'pExpireAt')) return 'retention-multi';
    if (ops.some(([m, key]) => m === 'sAdd' && isRecheck(key))) return 'remove-multi';
    if (ops.some(([m, key]) => (m === 'sRem' || m === 'del') && isRecheck(key))) {
      return 'reindex-multi';
    }
    if (
      ops.length > 0 &&
      ops.every(([m, key]) => (m === 'zAdd' || m === 'zRem') && isExpiry(key))
    ) {
      return 'rescore-multi';
    }
    return undefined;
  }

  function wrapMulti(chain: object): object {
    const ops: Array<[string, unknown]> = [];
    const log: Array<{ method: string; args: unknown[] }> = [];
    const proxy: object = new Proxy(chain, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== 'function') return value;
        if (prop === 'exec') {
          return async () => {
            const step = labelMulti(ops);
            multis.push({ step, ops: log });
            if (step) await gate(step);
            else lastStep = undefined;
            return (value as () => Promise<unknown>).call(target);
          };
        }
        return (...args: unknown[]) => {
          ops.push([String(prop), args[0]]);
          log.push({ method: String(prop), args });
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
        else lastStep = undefined;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });

  return {
    client: gated,
    steps,
    multis,
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
