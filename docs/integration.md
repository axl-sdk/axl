# Integration Guide

## Express.js

Axl embeds directly in your Express app — no special adapter needed.

```typescript
import express from 'express';
import { AxlRuntime } from '@axlsdk/axl';
import config from './axl.config';
import { HandleSupport } from './workflows/support';

const app = express();
const runtime = new AxlRuntime(config);

// Register workflows
runtime.register(HandleSupport);

// Request-response
app.post('/api/support', async (req, res) => {
  const result = await runtime.execute('HandleSupport', {
    msg: req.body.msg,
  });
  res.json({ reply: result });
});

// Streaming
app.post('/api/support/stream', async (req, res) => {
  const stream = runtime.stream('HandleSupport', {
    msg: req.body.msg,
  });
  stream.pipe(res);
  // Defaults already protect against slow consumers — `maxQueued: 10_000`
  // events with `onOverflow: 'drop-oldest-non-terminal'`. Terminal events
  // (`done`, `error`, `workflow_end`) are never dropped, and the first
  // overflow per stream emits a one-shot `console.warn`. For most
  // production webserver embeds this is the right policy: a temporarily
  // slow client should degrade gracefully, not abort the workflow.
  //
  // To opt into strict-mode failure (rare — typically only test/CI envs):
  //
  //   const stream = runtime.stream('HandleSupport', input, {
  //     events: { onOverflow: 'throw' },
  //   });
  //   stream.promise.catch((err) => {
  //     if (err instanceof EventStreamOverflowError) { ... }
  //   });
});

// Multi-turn sessions
app.post('/api/chat/:sessionId', async (req, res) => {
  const session = runtime.session(req.params.sessionId);
  const result = await session.send('HandleSupport', {
    msg: req.body.msg,
  });
  res.json({ reply: result });
});

app.listen(3000);
```

The same pattern works with any Node.js framework (Hono, Fastify, NestJS, Next.js API routes, etc.). The runtime is a plain TypeScript object — no middleware or plugin system required.

> **⚠️ Multi-worker deployments need sticky sessions.** `Session.send` is serialized per id within ONE Node process. If you run multiple workers behind a load balancer, you must route requests with the same `sessionId` to the same worker (sticky routing) — otherwise two workers may concurrently `send` on the same session id and the later writer will clobber the earlier one's update. See [API Reference → Sessions → Concurrency](./api-reference.md#concurrency-and-races).

## Production State-Store Deployment

For production deployments — especially multi-process, multi-tenant, or compliance-sensitive — the `StateStore` configuration is load-bearing. The defaults are fine for dev; production needs TTLs, namespace isolation, and (usually) crash-survival.

### RedisStore: keyPrefix, TTLs, and crash recovery

```ts
import { RedisStore, AxlRuntime } from '@axlsdk/axl';

const store = await RedisStore.create({
  url: process.env.REDIS_URL!,
  keyPrefix: `axl:${process.env.TENANT_ID ?? 'prod'}:`,
  defaultTtl: 60 * 60 * 24 * 30,         // 30 days for everything
  ttls: {
    checkpoint:      60 * 60 * 24 * 7,   // 7 days — belongs to a run
    executionState:  60 * 60 * 24,       // 1 day for legacy app-managed state
    streamingEvents: 60 * 60 * 24 * 7,   // OPT-IN safety net; must exceed max restart-gap
  },
});

const runtime = new AxlRuntime({
  state: { store, persist: 'streaming' },
});
```

**Without TTLs, every save accumulates and Redis OOMs.** Pick `defaultTtl` based on your retention policy; override per category as needed. `streamingEvents` is opt-in only (does NOT fall back to `defaultTtl`) so a generous default doesn't TTL-evict crashed-run buffers before recovery runs. See [docs/migration/state-store-durability.md](./migration/state-store-durability.md#tldr) for the full TTL strategy + window semantics (sliding vs. fixed-creation vs. fixed-refresh).

`keyPrefix` is the storage-layer isolation primitive for shared Redis clusters. Avoid Redis glob metacharacters (`*`, `?`, `[`, `]`) in the prefix; operators running `redis-cli SCAN MATCH` would otherwise have to escape them.

### Boot wiring: recovery before accepting new work

```ts
// 1. Hydrate the historical cache so recovery's "canonical exists" branch can fire
await runtime.getExecutions();

// 2. Reconstruct partial ExecutionInfos for crashed runs (if persist: 'streaming')
const recovered = await runtime.recoverIncompleteStreams();
console.log(`[boot] recovered ${recovered.length} crashed executions`);

// 3. NOW accept new requests
app.listen(3000);
```

Recovery is **idempotent** — re-running it is safe; concurrent recovery on a shared Redis with multiple pods restarting at the same time converges via "canonical exists, drop orphan." But it MUST run BEFORE accepting new work that could share an executionId with a recovery-in-progress (cross-process recovery on a live workflow is not enforced; see [docs/migration/state-store-durability.md](./migration/state-store-durability.md#2-statepersist-streaming-for-crash-survival)).

### Graceful shutdown

```ts
const server = app.listen(3000);

const shutdown = async () => {
  server.close();                  // stop accepting new requests FIRST
  await runtime.shutdown();        // drain in-flight, flush streaming buffer, close store
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

`runtime.shutdown()` aborts in-flight executions, drains the streaming flusher, **awaits all in-flight `persistExecution` chains**, and closes the store connection. Skipping it causes workflows aborted by shutdown to lose their canonical rows (the detached save races the connection close).

### Persisting rich session history

Session history is normally text. An application may deliberately construct
JSON-compatible rich **user** turns — text, image, and audio parts — and persist
them; base64 and provider-file sources round-trip through the memory, SQLite,
and Redis stores unchanged. Two rules are enforced on the way in:

- Rich content on a non-user role is rejected.
- An inline `Uint8Array` source is rejected with `InvalidModelInputError`
  (`Uint8Array media input cannot be persisted in session history`). Owned bytes
  are per-call evidence and are never silently serialized into a store. The
  check is type-agnostic over every non-text part, so it covers image and audio
  identically. Encode to base64 yourself if you intend to persist the media.

Axl never auto-retains an attachment across `Session` turns; persisted rich
history is something your application chose to write.

### Per-tenant metadata and right-to-be-forgotten

```ts
app.post('/run', async (req, res) => {
  const result = await runtime.execute('analyze', req.body.input, {
    metadata: { userId: req.user.id, tenantId: req.user.tenantId },
  });
  res.json(result);
});

// GDPR delete handler
app.delete('/users/:id/data', async (req, res) => {
  const execs = await runtime.getExecutions();
  const userRuns = execs.filter((e) => e.metadata?.userId === req.params.id);
  for (const e of userRuns) {
    await runtime.deleteExecution(e.executionId);
  }
  res.json({ deleted: userRuns.length });
});

// Audit trail
runtime.on('execution_deleted', (e) => {
  auditLog.write({ event: 'execution.deleted', operator: req.user.id, ...e });
});

runtime.on('decision_cleanup_failed', (e) => {
  opsAlerts.write({ event: 'approval.cleanup_failed', ...e });
});
```

`runtime.deleteExecution(id)` sweeps every per-execution surface (data + indexes + checkpoints + state + streaming buffer + pending decisions) and emits `execution_deleted` for the audit pipeline. If the execution is still running, it aborts the workflow AND prevents the resulting `workflow_end` from resurrecting the row. It also waits for any in-process approval resolution or cancellation compensation before invoking the store's total sweep. Custom stores must make `resolveDecision` idempotent and implement all execution-scoped deletion in `deleteExecution`; a failed compensation leaves the request visible and emits `decision_cleanup_failed` for operator retry or deletion.

`ExecutionInfo.metadata` strips internal session control-plane keys (`sessionHistory`, `sessionId`) before persistence so a multi-tenant tag bag stays clean. The snapshot is `structuredClone`'d for isolation from caller mutation.

## Diagnostic artifact storage

[Captured requests](observability.md#captured-requests-opt-in) are far too large
to live inside an eval result, so they live beside it as an **artifact** and the
result carries a manifest pointing at one. That makes them a two-store problem:
the history row is in your `StateStore`, the bytes are in an artifact store, and
every interesting failure is a partial one.

```ts
const runtime = new AxlRuntime({
  state: { store: 'sqlite' },
  diagnostics: {
    artifacts: {
      root: '.axl/artifacts', // built-in FileDiagnosticArtifactStore
      sweepIntervalMs: 60_000, // reclamation cadence (default)
      leaseMs: 300_000,        // how long a writer's lease survives (default)
    },
  },
});
```

Supply `store` instead of `root` to plug in your own `DiagnosticArtifactStore`
(S3, a blob column, anything). `commit`, `markDeletePending` and `refreshExpiry`
return an `ArtifactWriteResult` (`{ ok: true, manifest } | { ok: false, reason:
'missing' }`) — both the interface and that type are exported from `@axlsdk/axl`
— so an artifact that has already gone is reported rather than silently
succeeding. `copy` returns a **staged** artifact (`renewLease` included) plus
the bytes it carried and the source's `redaction`, because a copy is the start
of the new owner's capture, not the end of it. Supplying neither while a run asks for capture
raises `AxlError('DIAGNOSTICS_UNAVAILABLE')` **before** the run starts, never
halfway through.

### Lifecycle

An artifact is only ever published behind its history row:

1. **stage** — a lease is taken and records stream in
2. **finalize** — the writer declares `complete` / `truncated` / `unavailable`
3. **save** — `runtime.saveEvalResult` writes the history row **first**
4. **commit** — only then does the artifact become owned, carrying the row's
   expiry

If step 3 throws, the artifact is rolled back rather than left as an orphan
pointing at a row that never existed. A result may only commit or delete an
artifact whose manifest names **that result** as its owner, so a rescore that
degraded while naming its source — or a hand-edited import — can never rewrite
or destroy another run's evidence. When step 4 finds nothing to commit, the
stored row is corrected to `diagnostics.status: 'unavailable'` rather than
published claiming evidence that is not there.

`runtime.deleteEvalResult(id)` runs the mirror image: the history row is removed
**first**, and only then is the artifact marked `delete_pending` and deleted. A
storage failure surfaces to the caller; a crash between the two steps is covered
by reclamation, which already reclaims a committed artifact whose owning row is
gone. (Recording the intent first would have the sweeper destroy, within a
minute, the evidence of a result the caller was just told had *not* been
deleted.)

### Reclamation

A pass runs at startup and then every `sweepIntervalMs` (unref'd, so it never
holds the process open; stopped by `runtime.shutdown()`). It removes:

- artifacts marked `delete_pending`
- committed artifacts whose owning row is gone or whose expiry has passed
- staged artifacts whose writer lease expired — a crashed run

The lease is held for the **writer's lifetime**, renewed on a timer the runtime
owns and stopped at finalize or rollback — not renewed by writing. It is also
bounded: past `maxHoldMs` (24 h by default) the runtime lets go, so a caller
that never finalizes degrades to an ordinary abandoned writer instead of pinning
the artifact forever. A run that
exhausts its capture byte bound early, or that waits on a tool or a human for
longer than a lease, therefore keeps its artifact.

A staged artifact whose lease is **live** is never touched, so a sweep cannot
race a running eval. A writer that died mid-run reads back as `interrupted`
with its records intact up to the truncation point.

### Retention and `getEvalRetention`

An artifact must not outlive the row that owns it, and with Redis that row can
expire server-side while this process is offline. Stores therefore expose:

```ts
getEvalRetention?(id: string): Promise<{ exists: boolean; expiresAt?: number }>;
```

`MemoryStore` and `SQLiteStore` report existence with no expiry; `RedisStore`
derives both from `PTTL`, so a configured `ttls.evalHistory` is mirrored onto
the artifact as an absolute `expiresAt`.

**Re-saving an existing eval result never extends its retention.** Only a
genuinely new row gets the configured `ttls.evalHistory` window; an existing one
keeps the time it had left, and a row deliberately left untimed (`PERSIST`, or
one predating the setting) stays untimed. A result is re-saved by corrections
that have nothing to do with your retention policy — the diagnostics sweep
rewriting a row whose artifact it just reclaimed, a commit failure downgrading
one — and renewing the window on each of those would keep item inputs, outputs
and scores alive indefinitely on a busy server.

Those corrections go through `StateStore.updateEvalResult`, an **update-only,
retention-neutral** write: it replaces a row that is already there and returns
`false` rather than creating one. That is not the same as checking first and
then saving — between the check and the write a row can be deleted (a
right-to-be-forgotten request) or expire, and the save would bring it back,
permanently on a store with no expiry. The condition therefore has to be inside
the store:

| Store | How | Note |
|---|---|---|
| `RedisStore` | `SET key value XX KEEPTTL` | **Requires Redis ≥ 6.0** for `KEEPTTL`. Nothing else in `RedisStore` does |
| `SQLiteStore` | `UPDATE … WHERE id = ?` | no expiry, so a resurrection here would be permanent |
| `MemoryStore` | presence check, then set | as above |
| a custom store | omit it | corrections are then **not persisted at all**; the in-process cache is still corrected |

On a Redis older than 6.0 the server rejects `KEEPTTL`, and the store raises an
`AxlError` with code `REDIS_VERSION_UNSUPPORTED` naming the floor. The runtime
warns once per process and then keeps correcting its own cache only: this
process stops serving a promise of bytes that are gone, and the stored row is
left exactly as it is — never rewritten with a fresh retention window. Upgrade
the server to persist corrections.

A same-process delete also beats a correction already in flight: the runtime
records the id before it asks the store, and a correction for a recorded id is
refused outright. Physical deletion is **eventual**: the
row disappears the instant Redis expires it, and the bytes are reclaimed by the
next sweep (or the next startup). Reads are gated on the logical expiry, so an
expired artifact stops being served immediately regardless.

A custom `StateStore` **without** `getEvalRetention` cannot host managed
capture: it is rejected at runtime construction, with the method named, rather
than being allowed to silently accumulate artifacts nothing will ever reclaim.

## Axl Studio

Axl Studio provides a browser-based development UI for any Axl project.

### Setup

Create an `axl.config.mts` that exports your runtime (`.mts` ensures ESM semantics, including top-level `await`, regardless of your project's package.json):

```typescript
// axl.config.mts
import { AxlRuntime } from '@axlsdk/axl';
import { HandleSupport } from './workflows/support';
import { researcher, writer } from './agents';
import { searchTool, calculatorTool } from './tools';

const runtime = new AxlRuntime({
  trace: { enabled: true, level: 'steps', output: 'console' },
});

runtime.register(HandleSupport);
runtime.registerAgent(researcher, writer);
runtime.registerTool(searchTool, calculatorTool);

export default runtime;
```

Then start Studio:

```bash
npx @axlsdk/studio --open
```

### Development Workflow

1. **Define** agents, tools, and workflows in your project
2. **Export** the runtime from `axl.config.mts`
3. **Start** Studio (`npx @axlsdk/studio --open`)
4. **Iterate** using the Agent Playground for quick prompt testing
5. **Debug** execution traces in the Trace Explorer with waterfall visualization
6. **Monitor** costs across agents and models in the Cost Dashboard
7. **Test** tools individually in the Tool Inspector
8. **Evaluate** with the Eval Runner for regression detection

### Studio Features

| Feature | Description |
|---------|-------------|
| **Agent Playground** | Chat directly with any registered agent (no workflow required). Tool calls rendered inline. Multi-turn sessions. |
| **Workflow Runner** | Execute workflows with custom input. Visual execution timeline. |
| **Trace Explorer** | Waterfall view of spans — nested workflow > agent > tool hierarchy. |
| **Cost Dashboard** | Per-agent and per-workflow cost tracking. Token usage breakdown. |
| **Memory Browser** | View stored memories. Test semantic recall queries. |
| **Session Manager** | Browse sessions with history. Replay step-by-step. View handoff chains. |
| **Tool Inspector** | Tool schemas rendered as forms. Test tools with custom input. |
| **Eval Runner** | Run evals, view per-item results, compare runs for regressions. |

See the [@axlsdk/studio README](../packages/axl-studio/README.md) for full documentation.

### Embedded Middleware

For applications where workflows depend on injected services (database repos, message queues, auth), Studio can be mounted as middleware inside your existing HTTP server instead of running as a separate CLI process. This gives Studio direct access to your `AxlRuntime` — single process, shared object references.

```typescript
import { createStudioMiddleware } from '@axlsdk/studio/middleware';

const studio = createStudioMiddleware({
  runtime,           // your existing AxlRuntime
  basePath: '/studio',
  verifyUpgrade: (req) => validateAuth(req),  // WS auth
});

// Express
app.use('/studio', studio.handler);
studio.upgradeWebSocket(server);

// NestJS (in onModuleInit)
const expressApp = httpAdapterHost.httpAdapter.getInstance();
expressApp.use('/studio', studio.handler);
studio.upgradeWebSocket(httpAdapterHost.httpAdapter.getHttpServer());

// Fastify (with @fastify/middie — npm i @fastify/middie)
await fastify.register(middie);
fastify.use('/studio', studio.handler);
studio.upgradeWebSocket(fastify.server);

// Raw Node.js
const server = createServer(studio.handler);
studio.upgradeWebSocket(server);
```

Key points:
- `basePath` must match the path where you mount the handler (e.g., `'/studio'` for `app.use('/studio', ...)`)
- `verifyUpgrade` is critical — WebSocket upgrade requests bypass Express/Fastify/Koa middleware, so auth must be explicitly checked
- Call `studio.close()` during shutdown to remove event listeners and close WebSocket connections
- Use `readOnly: true` for production monitoring (disables workflow execution, tool testing, and other mutating endpoints)
- Use `evals: 'path/to/evals/*.eval.ts'` to lazy-load eval files that would otherwise create circular dependencies (see [Studio README](../packages/axl-studio/README.md#lazy-eval-loading))

See the [@axlsdk/studio README](../packages/axl-studio/README.md) for the full API reference and framework-specific examples.

## Troubleshooting

### Type incompatibility across ESM and CJS packages (dual package hazard)

**Symptom:** TypeScript reports that types like `WorkflowContext` or `AxlRuntime` from `@axlsdk/axl` are incompatible between two packages in your monorepo, even though both import from the same version. Errors typically mention private or protected members not being assignable.

**Cause:** This is the [dual package hazard](https://nodejs.org/api/packages.html#dual-package-hazard) — a known Node.js/TypeScript limitation. When one package in your dependency graph resolves `@axlsdk/axl` via the `import` condition (because it has `"type": "module"`) and another resolves via the `require` condition (no `"type": "module"`), TypeScript loads two separate declaration files (`.d.ts` and `.d.cts`). Even though the files are identical, TypeScript conservatively treats classes from different declaration files as distinct types.

**Fixes (pick one):**

1. **Use consistent `"type"` fields across your monorepo** (recommended). Ensure all packages that share Axl types resolve through the same export condition. Either all have `"type": "module"` or none do.

2. **Use `moduleResolution: "bundler"` in your tsconfig.** This avoids the dual `import`/`require` condition split entirely — TypeScript always resolves through the `import` condition.

3. **Pin resolution with `paths` in your root tsconfig:**
   ```json
   {
     "compilerOptions": {
       "paths": {
         "@axlsdk/axl": ["./node_modules/@axlsdk/axl/dist/index.d.ts"]
       }
     }
   }
   ```
   This forces all packages to resolve the same declaration file regardless of their module type.

This is not specific to Axl — any package that ships separate ESM and CJS type declarations can trigger this when consumed through mixed resolution modes in a monorepo.
