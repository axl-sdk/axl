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
```

`runtime.deleteExecution(id)` sweeps every per-execution surface (data + indexes + checkpoints + state + streaming buffer + pending decisions) and emits `execution_deleted` for the audit pipeline. If the execution is still running, it aborts the workflow AND prevents the resulting `workflow_end` from resurrecting the row.

`ExecutionInfo.metadata` strips internal session control-plane keys (`sessionHistory`, `sessionId`) before persistence so a multi-tenant tag bag stays clean. The snapshot is `structuredClone`'d for isolation from caller mutation.

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
