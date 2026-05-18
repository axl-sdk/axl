# AXL Review — Response to Veery's `RedisStore` and Trace Persistence Asks

Companion to [`axl-team-asks.md`](./axl-team-asks.md). The customer report is technically accurate — every claim was verified against the source on `main` (0.17.x). What follows is an AXL-owner take: which asks we should address, in what order, and which we should decline. Grounded in code references rather than the customer's framing.

## Summary

| #   | Veery priority | AXL call | Shape |
|-----|----------------|----------|-------|
| 2   | P0             | **Ship now (patch)**                     | RedisStore memory methods — finish what the interface already promises |
| 6   | P1             | **Ship soon (patch)**                    | `MULTI/EXEC` on multi-key writes |
| 8   | P2             | **Ship soon (patch)**                    | `keyPrefix` constructor option |
| 3   | P0             | **Ship (minor)** — smaller design        | `defaultTtl` + per-key-class overrides; drop the glob layer |
| 10  | P2             | **Ship `deleteExecution` (minor)**       | Skip `pruneBefore` — TTLs cover it |
| 4   | P1             | **Ship perf fix; defer interface change**| Sorted-set + `MGET`, no API change; defer cursor pagination |
| 1   | P0             | **Ship a smaller version (minor)**       | `state.persist: 'terminal' \| 'streaming'`; no new interface methods |
| 5   | P1             | **Lift `metadata`; decline indexes**     | Top-level `ExecutionInfo.metadata` only |
| 7   | P2             | **Decline**                              | Studio is a dev tool; prod observability is `runtime.on('trace', …)` |
| 9   | P2             | **Decline hook; consider compression**   | Encryption is the storage layer's job; compression is an internal optimization |

## Framing notes before the per-ask detail

**1. The "P0" labels are Veery-priority, not AXL-priority.** From AXL's perspective only one ask (#2) describes behavior that is genuinely *wrong*. Everything else is a documented contract Veery wants extended.

**2. Several asks push `StateStore` toward being a query engine.** Asks #4 (cursor pagination), #5 (per-attribute indexes), and the `appendTraceEvents`/Streams shape of #1 all drift the interface in that direction. `StateStore` is a state-persistence boundary, not a database. The fact that Veery's own workaround for #5 is "duplicate writes into our own Postgres table" is the **correct** architecture, not the gap. We should resist taking on that scope.

**3. Veery is one customer; design for the others too.** The asks that benefit the most users are the small ones: #2 (silent-failure bug — anyone on `RedisStore` is exposed), #3 (Redis OOM is universal in prod), #6 (atomicity is universal), #8 (namespace collisions in shared clusters). Those are also the cheapest to ship. The bigger asks (#5 index engine, #7 pub/sub, #9 encryption hook) are Veery-shaped — most users either don't need them or have already routed around them via `runtime.on('trace', …)`.

---

## Ship in order

### Patch — corrections (no interface change)

#### 2. RedisStore memory methods

This is a silent-failure bug, not a feature ask. `StateStore.saveMemory?` is optional, so `ctx.remember(...)` on a `RedisStore` silently no-ops. `MemoryStore` and `SQLiteStore` implement all four methods (`packages/axl/src/state/memory.ts:133-158`, `packages/axl/src/state/sqlite.ts:444-468`); `RedisStore` does not (`packages/axl/src/state/redis.ts` — confirmed absent).

Worst possible failure mode. Probably 30 lines of code.

**Key layout**: `axl:memory:{scope}` as a hash, fields = keys, values = JSON-serialized entries. `getAllMemory(scope)` → `hGetAll`. `saveMemory(scope, key, value)` → `hSet`. Match the structuredClone semantics that `MemoryStore` already enforces (JSON round-trip provides this naturally on Redis).

**Rationale for hash-per-scope over key-per-entry**: the dominant user journey for `ctx.remember()` is per-user memory that you want to expire as a unit when the user goes inactive — not random keys aging out at different times. A "scope" is meaningful precisely because the entries belong together. Hash also keeps the keyspace small (one Redis key per scope vs. one per entry × scope, which compounds at scale).

**While we're there**, also emit a single `console.warn` the first time `ctx.remember()` runs against a store that doesn't implement the memory methods — so future custom-`StateStore` authors get a loud signal instead of silent loss.

#### 6. `MULTI/EXEC` on multi-key writes

Trivial. The current `saveExecution` (`packages/axl/src/state/redis.ts:176-181`) writes the index-set membership and the data blob as two independent commands. Same pattern in `saveEvalResult` (203-206) and `saveSession` (112-115). Wrap each in `this.client.multi()...exec()`.

Becomes load-bearing the moment ask #4 lands (adds a third write — `ZADD`). Better to fix now than to ship a partial-write hazard during a perf optimization.

#### 8. `keyPrefix` constructor option

5-line change. Universal value (anyone sharing a Redis cluster across environments or services), not Veery-specific.

```ts
RedisStore.create({ url, keyPrefix: 'axl:veery:prod:' });
```

All key helpers (`packages/axl/src/state/redis.ts:59-97`) compose against `this.keyPrefix` instead of the literal `'axl:'`. Default stays `'axl:'` for backward compatibility.

**No normalization.** Concatenate the prefix as given. Reject empty string. Don't enforce trailing colons or any convention — users have different naming preferences and the prefix is a leaf-level string concat. If someone wants `'myapp_axl_'` without colons, that's their call.

### Minor — small additive features

#### 3. TTL config — but smaller than proposed

Real production problem. Without TTLs, every `set`/`hSet`/`sAdd` accumulates forever (`packages/axl/src/state/redis.ts:99-237` — `grep -n 'EX\|expire\|TTL'` finds one match, in a comment). Every Redis-backed install will eventually OOM Redis without operator action.

Ship it — but **not** with Veery's full per-category nested config and `memory.perScope` globs. Start with:

```ts
RedisStore.create({
  url,
  defaultTtl: 60 * 60 * 24 * 30, // 30 days, in seconds
  ttls: {
    checkpoint: 60 * 60 * 24 * 7,
    executionState: 60 * 60 * 24,
    pendingDecision: 60 * 60 * 24,
    // omitted categories use defaultTtl; null = no TTL
  },
});
```

Categories: `session`, `sessionMeta`, `checkpoint`, `executionState`, `pendingDecision`, `executionHistory`, `evalHistory`, `memory`. No per-scope globs in v1 — if users need them, we'll see the request.

**Sliding vs fixed window**: memory AND sessions get sliding semantics — they're the two user-activity-driven categories. Memory uses `hSet + expire` (hash storage); session uses `SET ... EX` (string storage) but refreshes the TTL on every `saveSession`. Everything else is fixed-window because those categories have natural lifecycles tied to events, not user activity. (Checkpoints belong to a specific execution. Execution history is, by definition, historical. Execution state refreshes on status transition so a long-suspended workflow doesn't disappear mid-flight.) The "sessions expire on a schedule from creation" framing from the original proposal turned out to be wrong for live-chat use cases — an active conversation should not time out mid-turn, so sliding is the right behavior.

When `executionHistory` has a TTL, the index set (`axl:exec-history-ids`) needs matching eviction. Cleanest fix: pair the TTL change with ask #4 so the sorted set lets us `ZREMRANGEBYSCORE` instead of trying to garbage-collect a `SREM`.

#### 10. `deleteExecution` (single method, not the prune helper)

GDPR right-to-be-forgotten is real and won't be covered by TTLs (those expire on a schedule, not on demand). Add one optional method symmetric to the existing `deleteEvalResult`:

```ts
interface StateStore {
  deleteExecution?(executionId: string): Promise<boolean>;
}
```

Implementation on `RedisStore`: `MULTI` over `del(execHistoryKey(id))` + `sRem(execHistorySetKey, id)` (+ `zRem` on the sorted set once #4 lands). Skip the `pruneExecutionsBefore` helper — that's what TTLs are for.

#### 4. `listExecutions` perf fix (no API change)

The current implementation is genuinely bad (`packages/axl/src/state/redis.ts:188-199` — `SMEMBERS` + N `GET`s + JS-side sort). Fix in place without changing the signature:

- On every `saveExecution`, also `ZADD axl:exec-history-z <startedAt> <executionId>` (inside the `MULTI` from #6).
- `listExecutions(limit?)` → `ZREVRANGEBYSCORE axl:exec-history-z +inf -inf LIMIT 0 <limit>` → `MGET` for the JSON blobs.
- Same pattern for `listEvalResults` (`redis.ts:208-219`).

10–100× speedup, no consumer impact.

**Migration**: lazy backfill inside `RedisStore.create()`. After `connect()`, compare `SCARD axl:exec-history-ids` to `ZCARD axl:exec-history-z`. If they diverge, batch-`MGET` the data (chunks of 500) and `ZADD` from `startedAt`. Synchronous, one-time, logged. Typical install with <10k executions: under 5 seconds.

For users at six-figure execution counts (where the startup hit would actually hurt), pass `skipMigration: true` to skip the backfill and call `backfillExecutionIndex()` manually during a maintenance window. `listExecutions` falls back to the legacy SET-based read path if the ZSET is empty.

We don't dual-write across releases — that's two releases of cognitive overhead to avoid a one-time 5-second wait for the median user.

**Defer the cursor pagination** (`{ limit, before } → { items, nextBefore }`). That's a breaking change to the `StateStore` interface — wait until we have evidence someone is hitting >10k executions and feeling it. The in-place fix buys most of the win for free.

### Minor — slightly bigger

#### 1. In-flight trace durability — smaller shape than proposed

The durability problem is real (`packages/axl/src/runtime.ts:437-451` confirms `persistExecution` is only called from terminal `finally` blocks). The proposed API — `appendTraceEvents` / `getTraceEvents` / `finalizeTraceEvents` as new interface methods, backed by Redis Streams — is bigger than needed and conflates durability with cross-pod fan-out (#7). Those are separate problems.

Smaller shape: add to `state` config (no interface change):

```ts
state: {
  store: redis,
  persist: 'terminal' | 'streaming',     // default 'terminal' (back-compat)
  streamingBatchSize: 100,               // flush every N events
  streamingBatchInterval: 1_000,         // ...or every ms, whichever first
}
```

**Default for streaming mode: batched (100 / 1s).** Per-event flush would add a Redis round-trip per `emit()` — at 5ms RTT and 500 events per workflow, that's 2.5s of added latency on every workflow to solve a problem most users don't have. The use case is "what happened when this run died at 03:12," not "every event durably committed before continuing." Losing the last 1 second of events on a crash is almost always fine.

Users who actually need per-event flush set `streamingBatchSize: 1`. Power-user knob, not the default.

**Storage layout — coexist during run, terminal blob wins.** During the run, events flush to `axl:exec-events:{id}` (Redis list, `RPUSH` per batch). On terminal (success or error — the runtime's `finally` block runs in both cases), we write the canonical `axl:exec-history:{id}` blob with events embedded as today, then `DEL` the streaming list. On crash recovery, the streaming list is the source of truth; we synthesize an `ExecutionInfo` with `status: 'failed'` and `error: 'process terminated'`.

Public surface for completed runs is identical to today. The streaming list is purely a recovery aid for runs where the process died — not where the run errored out gracefully (those still write the terminal blob via the `finally` path).

Excluded from streaming flush: `token`, `partial_object`, `string_delta` (already excluded from `ExecutionInfo.events` via `pushEventBounded` at `packages/axl/src/runtime.ts:90-122` and from the Studio WS replay buffer via `UNBUFFERED_EVENT_TYPES`).

This solves Veery's "what did the model do in the run that failed at 03:12 UTC" use case without requiring a new interface contract.

#### 5. Lift `ExecutionInfo.metadata` (decline secondary indexes)

The customer's option (1) is right: lift `metadata?: Record<string, unknown>` onto `ExecutionInfo` (`packages/axl/src/types.ts:824-839` currently lacks it). Additive type change. The runtime already accepts `ExecuteOptions.metadata` — just thread it through to `ExecutionInfo` and persist it.

This gives users a stable, queryable surface for tags like `userId` without parsing events.

**Decline option (2)** — declaring indexes on the store config. That's the rabbit hole. Once we have "indexes," next is JOIN-shaped queries, transactions across stores, and we're now competing with Postgres. The architecturally correct answer for "give me all runs for user X" is either (a) `listExecutions()` + filter, fine up to ~10k entries, or (b) the customer mirrors execution metadata into their own datastore. The duplicate-write cost Veery is worried about is the right price for keeping `StateStore` focused.

---

## Decline

### 7. Pub/sub for multi-instance Studio

Veery itself rates this P2 with a workaround ("pin Studio to one pod"). Two reasons to decline outright rather than defer:

1. **Studio is positioned as a dev tool.** The README, `docs/`, and the CLI all frame it that way. Making it a production-multi-pod observability layer is a meaningful scope expansion.
2. **We already give users the prod-observability primitive.** `runtime.on('trace', event => …)` fires on every emitted event in every pod. The right answer for cross-pod live observability is "pipe to your existing stack" (Honeycomb, Datadog, OpenTelemetry — we already have `SpanManager` for OTel), not "make Studio cluster-aware."

Documentation gap: we should say this explicitly somewhere in `docs/observability.md` so customers don't pattern-match Studio onto production observability tooling and then file this ask.

### 9. Encryption-at-rest hooks

Slippery slope. Once we add a `transformer: { encode, decode }` hook, every future code path has to be transformer-aware (streaming reads, partial-key access, schema migrations). The interface ossifies.

The architecturally correct answer is one of:
- Use Redis with at-rest encryption (ElastiCache, Redis Enterprise) — this is the bulk threat model Veery already acknowledges.
- Implement a custom `StateStore` that wraps the `RedisStore` and applies encryption. The interface is small (`packages/axl/src/state/types.ts:27-88`); this is exactly the extension point.

`docs/security.md` already calls out the observability-vs-data-at-rest distinction. We should not add a hook that makes us responsible for both.

**Adjacent — possibly worth doing separately**: compression of `agent_call_end.data.messages` snapshots inside `RedisStore`. These can be hundreds of KB in verbose mode (`trace.level === 'full'`). Internal gzip on write, no hook, no API change. Worth measuring before shipping.

---

## Release plan

Patch releases first, since they're all corrections:

```
0.17.x   #2 (memory methods)
0.17.x   #6 (MULTI/EXEC) + #8 (keyPrefix)
```

Minor for the additive features:

```
0.18.0   #3 (TTLs) + #10 (deleteExecution) + #4 (sorted-set perf, no API change)
0.19.0   #1 (state.persist: 'streaming') + lift ExecutionInfo.metadata from #5
```

Decline #7, #9, and the index-engine half of #5. Document the prod-observability story (`runtime.on('trace', …)` → customer's stack) in `docs/observability.md` so the framing question doesn't keep coming back.

## Resolved design decisions

Calls we made (rather than asked Veery to validate), recorded here so the implementation team doesn't have to re-derive them:

| Decision | Call | Rationale (one line) |
|---|---|---|
| Memory key layout (#2) | Hash-per-scope (`axl:memory:{scope}` as hash) | Cohesion — entries in a scope belong together and want to expire together |
| Memory + session TTL semantics (#3) | Sliding window — every write refreshes TTL | Both are user-activity-driven; active users / chats should keep their state, inactive ones forget. Memory uses `EXPIRE`; session uses `SET ... EX` due to its underlying string storage |
| All other categories' TTL (#3) | Fixed window | Their lifecycles are runtime-controlled, not user-controlled |
| ZSET migration (#4) | Lazy backfill in `RedisStore.create()`, `skipMigration: true` escape hatch | One-time ~5s hit on typical installs; opt out for six-figure execution counts |
| Streaming default (#1) | Batched (100 events / 1s); `streamingBatchSize: 1` for per-event | Per-event default would add seconds of latency to every workflow for a corner case |
| Storage layout (#1) | Streaming list coexists during run; terminal blob wins; `DEL` list on graceful exit | Public surface for completed runs stays identical; list is purely recovery aid |
| `keyPrefix` normalization (#8) | None — concatenate as given; reject empty string | Users have different naming preferences; don't enforce a convention |

## References

- `packages/axl/src/state/redis.ts` — `RedisStore` (every claim in this doc verified against this file)
- `packages/axl/src/state/types.ts:27-88` — `StateStore` interface
- `packages/axl/src/state/sqlite.ts:444-468` — memory methods (parity reference)
- `packages/axl/src/state/memory.ts:133-158` — same
- `packages/axl/src/runtime.ts:437-451` — `persistExecution` (terminal-only)
- `packages/axl/src/runtime.ts:90-122` — `pushEventBounded` and the unbuffered-event exclusions
- `packages/axl/src/types.ts:824-839` — `ExecutionInfo` shape (no `metadata` field today)
- `packages/axl-studio/src/server/ws/connection-manager.ts:92` — `UNBUFFERED_EVENT_TYPES`
