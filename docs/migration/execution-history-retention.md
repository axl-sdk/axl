# Execution history retention

> **Version:** 0.27.0
> **Read this if you:** run Axl for more than a few days, use `SQLiteStore` or `RedisStore`, upgrade with history you already have, or list executions for dashboards, tenants or deletion requests.

Every run Axl finishes is saved to your state store as execution history. This guide covers how long that history is kept, how to apply a retention to history you already have, and how to read large histories a page at a time.

## Choose a retention

Every built-in store takes the same option, in seconds:

| Value | Meaning |
|---|---|
| positive number | A run is deleted that many seconds after it was saved (normally when it finished) |
| `null` | Keep forever |
| unset | Keep forever. On `SQLiteStore` and `RedisStore`, Axl also warns once until you choose (see [below](#silencing-the-retention-warning)) |

`evalHistory` works the same way for eval results, counted from when the result was first written. Eval results are kept forever unless you set it.

```ts
import { AxlRuntime, MemoryStore, SQLiteStore, RedisStore } from '@axlsdk/axl';

const thirtyDays = 30 * 24 * 60 * 60;

// SQLite, built by the runtime
new AxlRuntime({
  state: { store: 'sqlite', sqlite: { path: './data/axl.db', ttls: { executionHistory: thirtyDays } } },
});

// SQLite or memory, built yourself
const sqlite = new SQLiteStore('./data/axl.db', { ttls: { executionHistory: thirtyDays } });
const memory = new MemoryStore({ ttls: { executionHistory: 24 * 60 * 60 } });

// Redis: you always build it yourself
const redis = await RedisStore.create({
  url: process.env.REDIS_URL,
  ttls: { executionHistory: thirtyDays, evalHistory: null },
});
new AxlRuntime({ state: { store: redis } });
```

An expired run disappears from `getExecutions()` and `getExecution()` right away. Its storage is reclaimed a batch at a time as new history is saved; on `MemoryStore` and `SQLiteStore` its leftover checkpoints and saved state go with it. On Redis, the listing indexes shrink along with the records.

Exact windows, defaults and per-store options: [History retention](../api-reference.md#history-retention-historyttls). Redis's other key categories and `defaultTtl`: [RedisStore options](../api-reference.md#redisstore-options).

## The in-memory store keeps the newest 1 000 runs

`MemoryStore`, the default when you don't configure a store, keeps the newest 1 000 runs and removes the oldest when a new run is saved. Its contents are lost on restart anyway, so a count is what keeps a long-running process from growing.

Change the limit, or remove it, with `maxExecutions`:

```ts
new AxlRuntime({ state: { store: 'memory', memory: { maxExecutions: 10_000 } } });
new AxlRuntime({ state: { store: 'memory', memory: { maxExecutions: Infinity } } }); // no limit
new MemoryStore({ maxExecutions: 10_000 });
```

## Silencing the retention warning

`SQLiteStore` and `RedisStore` never delete history on their own. If no retention is set for execution history, the store prints one warning per process suggesting that you choose one. Any of these silences it:

| Do this | Effect |
|---|---|
| Set `ttls.executionHistory` to a number of seconds | History expires after that long |
| Set `ttls.executionHistory: null` | You chose to keep history forever |
| Set `defaultTtl` (Redis only) | History expires with your other Redis keys |
| Set `AXL_DIAGNOSTICS_SILENT=true` | Silences every Axl diagnostic warning in the process |

The runtime's `diagnostics.silent` option silences the SQLite store the runtime creates for `state.store: 'sqlite'`. It does not reach a store you construct yourself, because that store is created, and warns, before the runtime exists; use one of the options above for those.

## Apply retention to records you already have

Setting a retention only affects runs saved from then on. History you already had keeps no expiry, and an upgrade never deletes or changes it. When you want the retention to apply to it as well, run `applyHistoryRetention()` once. Axl never runs it for you.

```ts
import type { HistoryRetentionCursor } from '@axlsdk/axl';

const store = runtime.getStateStore(); // or the store you constructed

let cursor: HistoryRetentionCursor | null = null;
do {
  const result = await store.applyHistoryRetention!({ kind: 'executions', cursor });
  console.log(result); // { expired, armed, indexed, deadIndexEntries, cursor }
  cursor = result.cursor;
} while (cursor !== null);
```

Each call handles one batch (500 records by default; set `batchSize` to change it) and returns the `cursor` for the next call. For each record that has no expiry:

- If its window has already passed, counted from when it was last saved, it is deleted now (`expired`).
- Otherwise it gets the expiry it would have had if the retention had been set when it was saved (`armed`).

Records that already have an expiry keep it. With no retention set for that kind, nothing is deleted or given an expiry. Run it again with `kind: 'evals'` for eval history.

On `RedisStore`, the same call also cleans up the listing indexes, even with no retention set:

| Counter | What it means |
|---|---|
| `indexed` | Runs saved with a TTL before 0.27.0, now tracked so they are cleaned up from the listing once they expire |
| `deadIndexEntries` | Listing entries whose run no longer exists, now removed |

`MemoryStore` and `SQLiteStore` have no separate index, so both counters are always `0` there.

You can run it while your app is serving traffic:

- **Stop and resume.** The cursor is plain JSON. Store it, and pass it back later to continue where you stopped. Records removed meanwhile do not cause any to be skipped.
- **Concurrent saves and deletes are safe.** A run saved again while maintenance runs keeps the expiry that save gave it, and a run deleted meanwhile stays deleted.
- **Running it twice is harmless.** A second full run reports all zeros and changes nothing.

Full contract: [`applyHistoryRetention`](../api-reference.md#applying-retention-to-existing-history). Custom stores own their retention and may implement the same method.

## Page through large histories

`runtime.getExecutions()` with no options returns every run the store holds. That is fine for small histories, but on a large one each call reads everything. Ask for a page with `limit`, and continue from the last run with a cursor:

```ts
import type { ExecutionCursor } from '@axlsdk/axl';

let cursor: ExecutionCursor | undefined;
do {
  const page = await runtime.getExecutions({ limit: 500, cursor });
  for (const exec of page) handle(exec);
  const last = page.at(-1);
  cursor = last && { startedAt: last.startedAt, executionId: last.executionId };
} while (cursor);
```

Every run appears on exactly one page, even when many started in the same millisecond, and a cursor keeps working if the run it names is deleted.

A call without `limit` that returns more than 1 000 runs prints one warning per process suggesting `limit` and `cursor`. It still returns every run. Pass `limit: Infinity` when you do want everything, or set the runtime's `diagnostics.silent` (or `AXL_DIAGNOSTICS_SILENT=true`) to silence it.

The same loop filters by tenant or user without holding the whole history in memory. For example, deleting a user's runs for a right-to-be-forgotten request:

```ts
async function deleteUserRuns(userId: string): Promise<number> {
  let deleted = 0;
  let cursor: ExecutionCursor | undefined;
  do {
    const page = await runtime.getExecutions({ limit: 500, cursor });
    for (const exec of page) {
      if (exec.metadata?.userId !== userId) continue;
      await runtime.deleteExecution(exec.executionId);
      deleted++;
    }
    const last = page.at(-1);
    cursor = last && { startedAt: last.startedAt, executionId: last.executionId };
  } while (cursor);
  return deleted;
}
```

Deleting runs from a page you have already read does not affect the next page.

## Studio

Studio's execution list reads history one page at a time. If you call its REST API directly, `GET /api/executions` returns `{ data, nextCursor }` with summaries instead of every execution with its events. See [Paging executions](../studio-api.md#paging-executions).
