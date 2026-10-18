/**
 * In-memory mock of the node-redis client surface `RedisStore` uses, shared by
 * the store unit tests. Moved unchanged from `state.test.ts`.
 */
import { vi } from 'vitest';
import { RedisStore } from '../state/redis.js';

type ZRangeOptions = {
  BY?: 'SCORE' | 'LEX';
  REV?: boolean;
  LIMIT?: { offset: number; count: number };
};

/** Redis orders members that share a score by their bytes. */
function compareMemberBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function scoreBound(bound: number | string, infinite: '+inf' | '-inf'): number {
  if (bound === infinite) return infinite === '+inf' ? Infinity : -Infinity;
  if (bound === '+inf') return Infinity;
  if (bound === '-inf') return -Infinity;
  if (typeof bound === 'string') {
    throw new Error(`redis mock: unsupported ZRANGE score bound ${bound}`);
  }
  return bound;
}

/**
 * ZRANGE over the mock's member → score map, in Redis order: score, then
 * member bytes (both reversed with REV). BY:'SCORE' takes inclusive numeric
 * bounds or '+inf' / '-inf'; with REV, start is the maximum.
 */
function rangeZset(
  zsetData: Map<string, Map<string, number>>,
  key: string,
  start: number | string,
  stop: number | string,
  options?: ZRangeOptions,
): Array<[string, number]> {
  const set = zsetData.get(key);
  if (!set) return [];
  let entries = [...set.entries()].sort((a, b) => a[1] - b[1] || compareMemberBytes(a[0], b[0]));
  if (options?.REV) entries.reverse();
  if (options?.BY === 'SCORE') {
    const max = scoreBound(options.REV ? start : stop, '+inf');
    const min = scoreBound(options.REV ? stop : start, '-inf');
    entries = entries.filter(([, score]) => score >= min && score <= max);
  } else if (options?.BY === 'LEX') {
    throw new Error('redis mock: ZRANGE BY LEX is not supported');
  }
  if (options?.LIMIT) {
    entries = entries.slice(options.LIMIT.offset, options.LIMIT.offset + options.LIMIT.count);
  }
  return entries;
}

/**
 * Build a chainable mock RedisMulti that queues commands and applies them
 * on `.exec()`. Mirrors node-redis v5's RedisMulti shape (set/del/sAdd/
 * sRem/hDel + exec) at the surface we use.
 *
 * Two callers reach this: the mock client's `multi()` builds one with
 * the shared backing Maps; tests that want to inspect the queue can
 * spy on the returned chain.
 */
export function createMockMulti(
  data: Map<string, string>,
  hashData: Map<string, Map<string, string>>,
  setData: Map<string, Set<string>>,
  zsetData: Map<string, Map<string, number>>,
  ttls: Map<string, number>,
  listData: Map<string, string[]>,
) {
  type QueuedOp = () => unknown;
  const queue: QueuedOp[] = [];
  const chain = {
    set(key: string, value: string, options?: { EX?: number; PX?: number }) {
      queue.push(() => {
        data.set(key, value);
        // The side map is in seconds; PX arrives in milliseconds.
        if (options?.EX !== undefined) ttls.set(key, options.EX);
        else if (options?.PX !== undefined) ttls.set(key, options.PX / 1000);
        else ttls.delete(key);
        return 'OK';
      });
      return chain;
    },
    hSet(key: string, field: string, value: string) {
      queue.push(() => {
        if (!hashData.has(key)) hashData.set(key, new Map());
        hashData.get(key)!.set(field, value);
        return 1;
      });
      return chain;
    },
    expire(key: string, seconds: number, mode?: 'NX' | 'XX' | 'GT' | 'LT') {
      queue.push(() => {
        const existing = ttls.get(key);
        if (mode === 'NX' && existing !== undefined) return 0;
        if (mode === 'XX' && existing === undefined) return 0;
        ttls.set(key, seconds);
        return 1;
      });
      return chain;
    },
    del(key: string | string[]) {
      queue.push(() => {
        const keys = Array.isArray(key) ? key : [key];
        let count = 0;
        for (const k of keys) {
          if (data.delete(k)) count++;
          if (hashData.delete(k)) count++;
          if (listData.delete(k)) count++;
          if (setData.delete(k)) count++;
          if (zsetData.delete(k)) count++;
        }
        return count;
      });
      return chain;
    },
    sAdd(key: string, member: string | string[]) {
      queue.push(() => {
        if (!setData.has(key)) setData.set(key, new Set());
        const members = Array.isArray(member) ? member : [member];
        let count = 0;
        for (const m of members) {
          if (!setData.get(key)!.has(m)) {
            setData.get(key)!.add(m);
            count++;
          }
        }
        return count;
      });
      return chain;
    },
    sRem(key: string, member: string | string[]) {
      queue.push(() => {
        const set = setData.get(key);
        if (!set) return 0;
        const members = Array.isArray(member) ? member : [member];
        let count = 0;
        for (const m of members) {
          if (set.delete(m)) count++;
        }
        return count;
      });
      return chain;
    },
    hDel(key: string, field: string | string[]) {
      queue.push(() => {
        const map = hashData.get(key);
        if (!map) return 0;
        const fields = Array.isArray(field) ? field : [field];
        let count = 0;
        for (const f of fields) {
          if (map.delete(f)) count++;
        }
        return count;
      });
      return chain;
    },
    zAdd(key: string, member: { score: number; value: string }) {
      queue.push(() => {
        if (!zsetData.has(key)) zsetData.set(key, new Map());
        const set = zsetData.get(key)!;
        const isNew = !set.has(member.value);
        set.set(member.value, member.score);
        return isNew ? 1 : 0;
      });
      return chain;
    },
    zRem(key: string, member: string | string[]) {
      queue.push(() => {
        const set = zsetData.get(key);
        if (!set) return 0;
        const members = Array.isArray(member) ? member : [member];
        let count = 0;
        for (const m of members) {
          if (set.delete(m)) count++;
        }
        return count;
      });
      return chain;
    },
    rPush(key: string, values: string | string[]) {
      queue.push(() => {
        if (!listData.has(key)) listData.set(key, []);
        const list = listData.get(key)!;
        const arr = Array.isArray(values) ? values : [values];
        for (const v of arr) list.push(v);
        return list.length;
      });
      return chain;
    },
    async exec(): Promise<unknown[]> {
      // Apply queued ops in order. A real Redis MULTI is atomic — we
      // don't simulate failure scenarios here, but the per-op results
      // match the node-redis return convention.
      return queue.map((op) => op());
    },
  };
  // Test-only inspection hook. Non-enumerable so it doesn't appear in
  // Object.keys/JSON.stringify and can't be mistaken for production API.
  Object.defineProperty(chain, '_queueLength', {
    enumerable: false,
    value: () => queue.length,
  });
  return chain as typeof chain & { _queueLength: () => number };
}

/**
 * Create a RedisStore with a mock in-memory client, bypassing the
 * private constructor via Object.create and injecting a mock client.
 *
 * @param keyPrefix - Override the default `'axl:'` prefix to exercise
 * the keyPrefix option without hitting a real Redis.
 */
export type MockTtlConfig = Partial<{
  session: number | null;
  sessionMeta: number | null;
  checkpoint: number | null;
  executionState: number | null;
  executionHistory: number | null;
  evalHistory: number | null;
  memory: number | null;
  streamingEvents: number | null;
}>;

/**
 * Build a RedisStore over an existing client (the mock's, or a wrapper around
 * it), bypassing the private constructor. Two stores built over one client
 * behave like two processes sharing one Redis.
 */
export function createRedisStoreOverClient(
  client: unknown,
  keyPrefix = 'axl:',
  ttlConfig?: MockTtlConfig,
): RedisStore {
  // Resolve TTLs the same way the factory does: per-category override
  // beats default beats null (no TTL).
  const store = Object.create(RedisStore.prototype) as RedisStore;
  (store as any).client = client;
  (store as any).keyPrefix = keyPrefix;
  (store as any).ttls = {
    session: ttlConfig?.session ?? null,
    sessionMeta: ttlConfig?.sessionMeta ?? null,
    checkpoint: ttlConfig?.checkpoint ?? null,
    executionState: ttlConfig?.executionState ?? null,
    executionHistory: ttlConfig?.executionHistory ?? null,
    evalHistory: ttlConfig?.evalHistory ?? null,
    memory: ttlConfig?.memory ?? null,
    streamingEvents: ttlConfig?.streamingEvents ?? null,
  };
  return store;
}

export function createRedisStoreWithMockClient(keyPrefix = 'axl:', ttlConfig?: MockTtlConfig) {
  const data = new Map<string, string>();
  const hashData = new Map<string, Map<string, string>>();

  const setData = new Map<string, Set<string>>();
  // Sorted set: member → score. We re-sort by score on read; production
  // Redis maintains a skiplist for O(log N), but the mock just sorts on demand.
  const zsetData = new Map<string, Map<string, number>>();
  // Tracks the TTL last applied to each key (seconds, not absolute time).
  // The mock doesn't simulate actual expiration — tests assert what was set.
  const ttls = new Map<string, number>();
  // Lists for streaming-event persistence (RPUSH / LRANGE).
  const listData = new Map<string, string[]>();
  // node-redis exposes an open socket as `isOpen` and rejects a QUIT on a
  // closed client; a real Redis run proved it, so the mock reproduces it.
  let clientOpen = true;

  const mockClient = {
    get isOpen() {
      return clientOpen;
    },
    hSet: vi.fn(async (key: string, field: string, value: string) => {
      if (!hashData.has(key)) hashData.set(key, new Map());
      hashData.get(key)!.set(field, value);
      return 1;
    }),
    // HSETNX semantics: set field only if it doesn't already exist.
    // Returns 1 (set) or 0 (already existed). Mirrors node-redis v5 behavior.
    hSetNX: vi.fn(async (key: string, field: string, value: string) => {
      if (!hashData.has(key)) hashData.set(key, new Map());
      const map = hashData.get(key)!;
      if (map.has(field)) return 0;
      map.set(field, value);
      return 1;
    }),
    // node-redis returns undefined (not null) for missing hash fields
    hGet: vi.fn(async (key: string, field: string): Promise<string | undefined> => {
      return hashData.get(key)?.get(field);
    }),
    hGetAll: vi.fn(async (key: string) => {
      const map = hashData.get(key);
      if (!map || map.size === 0) return {};
      return Object.fromEntries(map.entries());
    }),
    hDel: vi.fn(async (key: string, field: string | string[]) => {
      const map = hashData.get(key);
      if (!map) return 0;
      const fields = Array.isArray(field) ? field : [field];
      let count = 0;
      for (const f of fields) {
        if (map.delete(f)) count++;
      }
      return count;
    }),
    // SET with optional EX (TTL in seconds). The mock records the EX value
    // on a side-map so tests can assert "TTL was set with the right value"
    // without simulating real wall-clock expiration (which would make tests
    // flaky and slow).
    set: vi.fn(
      async (
        key: string,
        value: string,
        options?: { EX?: number; PX?: number; XX?: boolean; KEEPTTL?: boolean },
      ) => {
        // XX: only overwrite an existing key. Redis returns null and writes
        // nothing when the key is absent.
        if (options?.XX === true && !data.has(key)) return null;
        data.set(key, value);
        // KEEPTTL leaves whatever TTL the key already had.
        if (options?.KEEPTTL === true) return 'OK';
        if (options?.EX !== undefined) ttls.set(key, options.EX);
        else if (options?.PX !== undefined) ttls.set(key, options.PX / 1000);
        else ttls.delete(key); // SET without EX clears any existing TTL
        return 'OK';
      },
    ),
    // EXPIRE applies a TTL to an existing key. With `mode: 'NX'`, only
    // sets if no TTL exists (used for fixed-window hash-backed data).
    // Without mode, always (re)sets — used for sliding-window memory.
    expire: vi.fn(async (key: string, seconds: number, mode?: 'NX' | 'XX' | 'GT' | 'LT') => {
      const existing = ttls.get(key);
      if (mode === 'NX' && existing !== undefined) return 0;
      if (mode === 'XX' && existing === undefined) return 0;
      // GT/LT not used by RedisStore today — fall through to set
      ttls.set(key, seconds);
      return 1;
    }),
    get: vi.fn(async (key: string) => {
      return data.get(key) ?? null;
    }),
    del: vi.fn(async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      let count = 0;
      for (const k of keys) {
        if (data.delete(k)) count++;
        if (hashData.delete(k)) count++;
        if (listData.delete(k)) count++;
        if (setData.delete(k)) count++;
        if (zsetData.delete(k)) count++;
      }
      return count;
    }),
    sAdd: vi.fn(async (key: string, member: string | string[]) => {
      if (!setData.has(key)) setData.set(key, new Set());
      const members = Array.isArray(member) ? member : [member];
      let count = 0;
      for (const m of members) {
        if (!setData.get(key)!.has(m)) {
          setData.get(key)!.add(m);
          count++;
        }
      }
      return count;
    }),
    sRem: vi.fn(async (key: string, member: string | string[]) => {
      const set = setData.get(key);
      if (!set) return 0;
      const members = Array.isArray(member) ? member : [member];
      let count = 0;
      for (const m of members) {
        if (set.delete(m)) count++;
      }
      return count;
    }),
    sMembers: vi.fn(async (key: string) => {
      return [...(setData.get(key) ?? [])];
    }),
    sCard: vi.fn(async (key: string) => {
      return setData.get(key)?.size ?? 0;
    }),
    rPush: vi.fn(async (key: string, values: string | string[]) => {
      if (!listData.has(key)) listData.set(key, []);
      const list = listData.get(key)!;
      const arr = Array.isArray(values) ? values : [values];
      for (const v of arr) list.push(v);
      return list.length;
    }),
    lRange: vi.fn(async (key: string, start: number, stop: number) => {
      const list = listData.get(key);
      if (!list) return [];
      const end = stop < 0 ? list.length + stop : stop;
      return list.slice(start, end + 1);
    }),
    mGet: vi.fn(async (keys: string[]): Promise<Array<string | null>> => {
      return keys.map((k) => data.get(k) ?? null);
    }),
    // ZADD semantics: if member is new, add and return 1; if member
    // exists, update score and return 0. node-redis v5 returns the
    // count of NEW members.
    zAdd: vi.fn(async (key: string, member: { score: number; value: string }) => {
      if (!zsetData.has(key)) zsetData.set(key, new Map());
      const set = zsetData.get(key)!;
      const isNew = !set.has(member.value);
      set.set(member.value, member.score);
      return isNew ? 1 : 0;
    }),
    zCard: vi.fn(async (key: string) => {
      return zsetData.get(key)?.size ?? 0;
    }),
    zRem: vi.fn(async (key: string, member: string | string[]) => {
      const set = zsetData.get(key);
      if (!set) return 0;
      const members = Array.isArray(member) ? member : [member];
      let count = 0;
      for (const m of members) {
        if (set.delete(m)) count++;
      }
      return count;
    }),
    // ZRANGE: the node-redis v5 parameterized form. With
    // BY:'SCORE' + REV:true this is the "ZREVRANGEBYSCORE" semantic.
    // (The dedicated `zRevRangeByScore` method exists in node-redis v4
    // but was removed in v5 — caught by the REDIS_URL-gated integration
    // test suite.)
    zRange: vi.fn(
      async (key: string, start: number | string, stop: number | string, options?: ZRangeOptions) =>
        rangeZset(zsetData, key, start, stop, options).map(([value]) => value),
    ),
    // ZRANGE ... WITHSCORES, node-redis v5 `zRangeWithScores` reply shape.
    zRangeWithScores: vi.fn(
      async (key: string, start: number | string, stop: number | string, options?: ZRangeOptions) =>
        rangeZset(zsetData, key, start, stop, options).map(([value, score]) => ({
          value,
          score,
        })),
    ),
    // multi() returns a chain object. Queue commands; on .exec(), apply
    // them all atomically against the same backing Maps. Real Redis
    // MULTI/EXEC is all-or-nothing, but our mock isn't simulating that
    // — it just guarantees the queued ops run together without other
    // mock interleaving (which is what callers actually care about).
    // PTTL in milliseconds, with Redis's two sentinel values: -2 (no such
    // key) and -1 (key exists, no TTL). The mock stores TTLs in seconds on a
    // side map, so convert; `getEvalRetention` distinguishes all three.
    pTTL: vi.fn(async (key: string) => {
      const exists = data.has(key) || hashData.has(key) || listData.has(key);
      if (!exists) return -2;
      const seconds = ttls.get(key);
      return seconds === undefined ? -1 : seconds * 1000;
    }),
    multi: vi.fn(() => createMockMulti(data, hashData, setData, zsetData, ttls, listData)),
    quit: vi.fn(async () => {
      if (!clientOpen) throw new Error('The client is closed');
      clientOpen = false;
    }),
  };

  // Bypass the private constructor and inject the mock client.
  const store = createRedisStoreOverClient(mockClient, keyPrefix, ttlConfig);

  return { store, mockClient, data, hashData, setData, zsetData, ttls, listData };
}
