# Migration: State Store Durability & Lifecycle

> **Versions:** 0.17.6 → 0.17.7
> **Scope:** Anyone using `RedisStore`, custom `StateStore` implementations, `runtime.deleteExecution`, `ExecuteOptions.metadata`, `ctx.awaitHuman`, or `state.persist`. Operators sizing production deployments. Implementers writing their own `StateStore`.

## TL;DR

Most consumers: **nothing to do**. The release is additive — existing `runtime.execute()` / `runtime.stream()` calls work unchanged, the default `StateConfig` is unchanged, every API gets new behaviors without breaking old ones.

You should read further if you:

1. Run **`RedisStore` in production** — pick TTLs (`defaultTtl`, `ttls`), choose a `keyPrefix` for shared clusters, and (recommended) opt into `state.persist: 'streaming'` for crash survival.
2. Maintain a **custom `StateStore`** — `deleteExecution`'s contract widened; new optional streaming methods (`appendStreamingEvents` / `finalizeStreamingEvents` / `listStreamingExecutions` / `getStreamingEvents`).
3. Want **GDPR right-to-be-forgotten** — `runtime.deleteExecution(id)` and `DELETE /api/executions/:id` are the canonical sweeps; subscribe to `execution_deleted` for the audit trail.
4. Pass `metadata` to `runtime.execute()` — caller-supplied keys now persist to `ExecutionInfo.metadata` (queryable); `sessionHistory` / `sessionId` are stripped from the snapshot.

## What changed

### 1. `runtime.deleteExecution(id)`

New runtime method. Removes an execution from in-memory caches, the configured `StateStore`, and every per-execution side surface. Returns `true` if anything was removed.

```ts
// GDPR right-to-be-forgotten
await runtime.deleteExecution(executionId);

// Audit trail
runtime.on('execution_deleted', (e) => {
  auditLog.write({ event: 'execution.deleted', user: operator, ...e });
  // e: { executionId, workflow, wasActive, hadPendingDecision, removed }
});

// Symmetric audit signal for eval history deletion
runtime.on('eval_deleted', (e) => {
  auditLog.write({ event: 'eval.deleted', user: operator, ...e });
  // e: { id, eval, removed }
});
```

**Total sweep.** All built-in stores remove: data blob + indexes, checkpoints, suspended state + pending-set membership, streaming buffer + in-flight ids set, pending awaitHuman decision. The runtime additionally clears in-memory abort controllers, `pendingDecisionResolvers`, `streamableExecutionIds`, and (Studio) the WebSocket replay buffer for the deleted execution channel.

**In-flight handling.** If the execution is still running, `deleteExecution` aborts it via the registered abort controller AND marks the id in `pendingDeletedExecutions` so the workflow's eventual `workflow_end` does NOT resurrect the row. The workflow itself terminates normally (consumers see the abort flow through).

**Custom store implementers:** `StateStore.deleteExecution?` is the canonical total-sweep entry point. Implementations MUST drop every per-execution surface (checkpoints, execution_state, pending decisions, streaming buffer, any custom side tables). See the updated JSDoc on `StateStore.deleteExecution?` and `RedisStore.deleteExecution` as the reference implementation.

### 2. `state.persist: 'streaming'` for crash survival

Opt-in durability mode that batches events to the `StateStore` throughout the run. On the next process, `runtime.recoverIncompleteStreams()` reconstructs partial `ExecutionInfo`s from surviving buffers.

```ts
const runtime = new AxlRuntime({
  state: {
    store: await RedisStore.create(redisUrl),
    persist: 'streaming',
    streamingBatchSize: 100,     // events per flush (default 100)
    streamingBatchInterval: 1000, // ms (default 1000)
  },
});

// Boot sequence: lazy-load THEN recover THEN accept new work
await runtime.getExecutions(); // hydrate history cache
const recovered = await runtime.recoverIncompleteStreams();
console.log(`Recovered ${recovered.length} crashed executions`);
// Now safe to accept new requests
app.listen(3000);
```

**Scope.** Only `runtime.execute()` and `runtime.stream()` register an executionId as streamable. `runtime.createContext()` flows (ad-hoc Studio playground, tool tests, evals) are deliberately excluded — no terminal `persistExecution` path would finalize the buffer, leaving phantom orphans that recovery would mis-recover on every restart.

**Excluded event types.** `token`, `partial_object`, `string_delta` are never flushed — they're high-volume, stream-only, and reconstructable from the persisted `agent_call_end.data.response`. Other event types flow through.

**Synthesized executions.** Recovered v2 runs have `status: 'failed'`, `error: 'process terminated (recovered from streaming buffer)'`, and `observation: { complete: false, reason: 'process_interrupted' }`; `workflow` is `__axl/recovered` when the buffer didn't capture a `workflow_start`. The events array is bounded by `state.maxEventsPerExecution` (default 50k); pathological crashed runs don't resurrect as unbounded ExecutionInfos.

**Save-failure preserves the buffer.** If `saveExecution` throws during recovery, the streaming buffer is left in place for the next attempt. No data loss on intermittent Redis failures.

**Live-execution skip.** Recovery never touches ids that are actively running in the current process — prevents corrupting a live workflow by mistaking its in-flight buffer for an orphan.

**Store coverage:** `RedisStore` implements all four streaming methods (atomic via MULTI). `MemoryStore` implements them in-process (for tests). `SQLiteStore` does NOT — configure `persist: 'terminal'` (the default) for SQLite-backed installs. The runtime emits a one-shot warning if you configure streaming against an unsupported store.

### 3. `ExecutionInfo.metadata`

Caller-supplied metadata from `ExecuteOptions.metadata` (and `runtime.stream()`'s `options.metadata`) now round-trips through `runtime.getExecution(id)` / `getExecutions()` as a queryable field.

```ts
await runtime.execute('analyze', input, {
  metadata: { userId: 'u-42', tenantId: 't-7', correlationId: 'req-abc' },
});

const execs = await runtime.getExecutions();
const tenantRuns = execs.filter((e) => e.metadata?.tenantId === 't-7');
```

**Persistence:** All three built-in stores roundtrip the field. `SQLiteStore` schema v3 auto-adds an `execution_history.metadata` column on first open.

**Internal control-plane keys stripped.** `sessionHistory` and `sessionId` are filtered before lift. The runtime reads these directly from `options.metadata` for control purposes, but they don't bloat the persisted row. Callers using these as control channels see no behavior change; the persisted snapshot stays JSON-clean.

**Isolation.** The snapshot is `structuredClone`'d so caller mutations to `options.metadata` after `execute()` returns don't surface mid-run through `getExecution(id)`. Non-cloneable values (functions, etc.) fall back to a sanitized shallow copy at the persist boundary — uncloneable keys are silently dropped, workflow execution is unaffected.

**Redaction.** Studio's REST endpoints scrub `metadata` to `{ redacted: true }` when `config.trace.redact: true` — `userId`/`tenantId` are the PII surface compliance mode is meant to protect.

### 4. `RedisStore` production hardening

Multi-key writes are now atomic via `MULTI/EXEC`. `listExecutions` / `listEvalResults` are O(log N) via a sorted-set fast path (lazy backfilled from the legacy SET on first run). `RedisStore` now implements the optional memory methods (`saveMemory` / `getMemory` / `getAllMemory` / `deleteMemory`) — previously delegated to a sessionMeta fallback that lost the `metadata` option and skipped `session.fork()` memory migration.

#### `keyPrefix` for shared clusters

```ts
// Default — back-compat. Existing 0.17.x deployments need no change.
const store = await RedisStore.create('redis://localhost:6379');

// Custom prefix for multi-tenant / shared-cluster deployments
const store = await RedisStore.create({
  url: 'redis://localhost:6379',
  keyPrefix: 'axl:prod:tenant-a:',
});
```

Empty string is rejected. The prefix is concatenated as-given (no normalization) — include a trailing colon if you want one. Avoid Redis glob metacharacters (`*`, `?`, `[`, `]`) in the prefix; operators using `redis-cli SCAN MATCH '<prefix>*'` will have to escape them.

#### TTL config (strongly recommended for production)

```ts
const store = await RedisStore.create({
  url: redisUrl,
  defaultTtl: 60 * 60 * 24 * 30,         // 30 days for everything
  ttls: {
    checkpoint:       60 * 60 * 24 * 7,  // shorter — checkpoints belong to a run
    executionState:   60 * 60 * 24,      // legacy app-managed state
    streamingEvents:  60 * 60 * 24 * 7,  // OPT-IN safety net (see below)
    sessionMeta:      null,              // explicit opt-out, even with defaultTtl
  },
});
```

Without TTLs, every save accumulates forever and Redis eventually OOMs. Categories: `session`, `sessionMeta`, `checkpoint`, `executionState`, `executionHistory`, `evalHistory`, `memory`, `streamingEvents`.

**Window semantics:**
- **Sliding** (`memory`, `session`, `sessionMeta`): every write resets the TTL. Active users keep their data; inactive users forget. Reads do NOT refresh — pair with a no-op write per turn if you need read-as-activity.
- **Fixed-creation** (`checkpoint`, `streamingEvents`): TTL set on first write via `EXPIRE NX`. Subsequent writes don't extend the window — the hash ages out together with the run it belongs to.
- **Fixed-refresh** (`executionState`, `executionHistory`, `evalHistory`): TTL via `SET ... EX`, refreshes on overwrite. `executionState` is retained for application-managed state compatibility; Axl does not automatically resume it.

**`streamingEvents` is opt-in only.** It does NOT fall back to `defaultTtl`. The TTL is the safety net for operators who forget to wire `runtime.recoverIncompleteStreams()` into startup — auto-applying a generous default would silently TTL-evict crashed-run buffers before recovery had a chance to run. **Must be longer than your max process-restart-gap** or recovery misses.

**`pendingDecision` is intentionally NOT configurable.** Pending decisions share a `axl:decisions` hash; a TTL on that key would expire ALL pending decisions at once. Resolve decisions individually via `resolveDecision()` instead.

#### Sorted-set perf

`listExecutions(limit)` and `listEvalResults(limit)` now use `ZREVRANGEBYSCORE` + `MGET` — one indexed range lookup + one pipelined bulk fetch, regardless of total entry count. Over-fetches by 2× (with a +5 floor) when `limit` is set so TTL drift between the ZSET and data blobs doesn't silently under-deliver.

**Upgrade path is automatic.** On `RedisStore.create()`, a one-time lazy backfill populates the sorted-set from the legacy ID set. Cheap when there's nothing to do (two ZCARD calls); a few seconds for installs with sub-10k entries. For six-figure deployments, pass `skipMigration: true` and run `await store.backfillExecutionIndex()` / `backfillEvalIndex()` during a maintenance window. While the ZSET is behind, reads fall back to the legacy slow path — correct but slower.

### 5. `ctx.awaitHuman()` wakes on signal abort

A workflow paused at `ctx.awaitHuman()` previously had no abort listener — `runtime.deleteExecution(id)` on such a workflow would clean up the runtime's bookkeeping but the workflow Promise would hang forever. Now both persisted and handler-backed approval paths race the current branch signal: a fast-path check for already-aborted, then a listener that marks the request non-resolvable and rejects with the signal's exact reason (the default is `AbortError`). The cleanup record remains discoverable until compensation finishes. This also prevents a losing race branch from resuming workflow-side effects after terminal finalization.

Pending decisions still use `executionId` as their key. Concurrent `awaitHuman()` calls in one execution are therefore rejected with `CONCURRENT_HUMAN_DECISION_UNSUPPORTED`; both sibling waits are cancelled and any persisted row is compensated. Supporting them requires request-scoped decision IDs as part of the future durable replay protocol.

Custom stores must make `resolveDecision()` idempotent. A pending-request save
can commit and then reject when its acknowledgement is lost, so Axl attempts
compensation after any failed save attempt. Cancellation also waits for an
in-flight public resolution before compensating; the store never receives an
approval and cancellation denial concurrently from one runtime.
`runtime.deleteExecution()` joins the same cleanup barrier before its total
store sweep, preventing a late decision write from following a completed
operator/GDPR deletion.

No API change. Affects any caller that aborts a paused awaitHuman: `runtime.abort(id)`, `runtime.deleteExecution(id)`, an external `AbortController.abort()` passed via `options.signal`, or a budget hard-stop.

## Customer-store implementation guide

If you maintain a custom `StateStore`, the following methods are optional but increasingly relevant:

| Method | Why it matters | Behavior if omitted |
|---|---|---|
| `deleteExecution?(id)` | GDPR right-to-be-forgotten. **Total sweep contract** — drop checkpoints, execution_state, pending decisions, streaming buffer, AND the canonical row in one call. | `runtime.deleteExecution` still works for in-memory + Studio WS scrub, but persisted data leaks. |
| `appendStreamingEvents?(id, events)` | `state.persist: 'streaming'` durability. Should be idempotent w.r.t. first-vs-subsequent calls (the first call also registers the id for `listStreamingExecutions`). | Streaming mode degrades to terminal (no crash survival). |
| `finalizeStreamingEvents?(id)` | Release the per-execution streaming buffer once `executionHistory` is committed. | Buffers leak in proportion to executions. |
| `listStreamingExecutions?()` | Recovery entrypoint — what crashed last time? | `recoverIncompleteStreams()` returns `[]`. |
| `getStreamingEvents?(id)` | Recovery — read the events for a crashed run. | `recoverIncompleteStreams()` returns `[]`. |

Wrap multi-table deletes in a transaction (SQL) or `MULTI`/`EXEC` (Redis). Idempotency required — deleting an unknown id returns `false` without throwing.

## Studio: new `DELETE /api/executions/:id`

```http
DELETE /api/executions/exec-abc
→ 200 { ok: true, data: { id: "exec-abc", deleted: true } }
→ 404 { ok: false, error: { code: "NOT_FOUND", ... } }
→ 405 { ok: false, error: { code: "READ_ONLY", ... } } (readOnly mode)
```

Wraps `runtime.deleteExecution(id)`. Also calls `ConnectionManager.clearChannelBuffer('execution:{id}')` so late WebSocket subscribers can't replay events for the deleted execution (the buffer's natural TTL is 30 seconds after stream completion; the scrub closes that window). Blocked in `readOnly` mode.

## Fully back-compat

- All public APIs unchanged. Existing code compiles and runs.
- `StateStore` interface is additive. Stores without the new methods see them as optional.
- `RedisStore.create(urlString)` (single-arg URL form) unchanged. New options form coexists.
- `ExecuteOptions.metadata` semantics: previously unused, now lifted to `ExecutionInfo.metadata`. Existing callers passing metadata get queryable persistence as a free upgrade.
- `ctx.awaitHuman()` semantics: previously could hang on abort, now wakes. The fix is a strict improvement — no caller depending on the hang exists.

## See also

- [`docs/api-reference.md`](../api-reference.md) — full type tables
- [`docs/security.md`](../security.md) — GDPR right-to-be-forgotten section
- [`docs/observability.md`](../observability.md) — crash recovery, streaming trace persistence
- [`docs/integration.md`](../integration.md) — production deployment patterns (multi-tenant Redis, recovery wiring, shutdown drain)
