# Axl Studio — API & Middleware Reference

The complete reference for Studio's REST API, WebSocket protocol, embeddable
middleware options, and internal architecture. For an overview, install steps,
and the panel tour, see the [Studio README](../packages/axl-studio/README.md).

## REST API

Studio exposes a REST API that the SPA consumes. You can also call these directly for scripting or testing.

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Server status, registered workflow/agent/tool counts, `readOnly: boolean` |
| `GET /api/workflows` | List all workflows with input/output schemas |
| `GET /api/workflows/:name` | Workflow detail |
| `POST /api/workflows/:name/execute` | Execute a workflow |
| `GET /api/agents` | List all agents |
| `GET /api/agents/:name` | Agent detail with config |
| `GET /api/tools` | List all tools with JSON Schema |
| `GET /api/tools/:name` | Tool detail |
| `POST /api/tools/:name/test` | Test a tool with `{ input: {...} }` |
| `GET /api/sessions` | List sessions |
| `GET /api/executions` | List executions |
| `GET /api/executions/:id` | Execution detail. `?since={step}` filters `events` to those with `step > since` (polling tail) |
| `POST /api/executions/:id/abort` | Abort a running execution (signal-driven; wakes paused `ctx.awaitHuman`) |
| `DELETE /api/executions/:id` | Delete an execution from history (GDPR scrub). Calls `runtime.deleteExecution` AND scrubs the WS replay buffer for `execution:{id}`. Returns `{ id, deleted: true }` or 404. Blocked in readOnly |
| `GET /api/costs?window=24h\|7d\|30d\|all` | Aggregated cost data for a time window (default `7d`). `?windows=all` returns all four windows at once for debugging |
| `GET /api/eval-trends?window=` | Per-eval score trends (latest, mean, std), cost totals, recent runs with `model`/`duration` |
| `GET /api/workflow-stats?window=` | Per-workflow totals, completed/failed counts, p50/p95/avg duration, failure rate |
| `GET /api/trace-stats?window=` | Event-type distribution, version-separated tool lifecycle counts, and retry breakdown by agent |
| `GET /api/memory/:scope/:key` | Read memory entry |
| `PUT /api/memory/:scope/:key` | Save memory entry |
| `DELETE /api/memory/:scope/:key` | Delete memory entry |
| `GET /api/evals` | List registered eval configs |
| `GET /api/evals/history` | List eval run history |
| `POST /api/evals/:name/run` | Run a registered eval by name. Body: `{ runs?: N, stream?: true, captureTraces?: true }` (`runs` capped at 25). When `stream: true`, returns `{ evalRunId }` immediately and broadcasts progress over the `eval:{evalRunId}` WS channel: `item_done` per item, `run_done` per successful run, `run_failed` on a provider error, `run_cancelled` on user-initiated abort, terminal `done` (carrying only `{ evalResultId, runGroupId? }` plus `partial: true / batchCompleted / batchAttempted` and either `cancelled: true` OR `batchFailure` — never both — when the batch is partial), or terminal `error` if no runs completed. Clients refetch the full result from history. `captureTraces: true` populates per-item `EvalItem.traces` on every item (success + failure); the Eval Runner panel renders these inline on item detail. Synchronous mode (default) returns the full `EvalResult` enriched with `_multiRun.partial` markers when applicable |
| `POST /api/evals/runs/:evalRunId/cancel` | Abort an active streaming eval run. The cancelled run appears in history with remaining items marked as cancelled |
| `POST /api/evals/:name/rescore` | Re-score a history entry with the eval's current scorers |
| `POST /api/evals/import` | Import a CLI eval artifact (parsed `EvalResult` JSON) into runtime history. Body: `{ result: EvalResult \| EvalResult[], eval? }`. The CLI's `--output` writes a JSON array when `--runs N > 1` (including for partial batches), so array form is supported — each entry imports as its own history entry with shared `runGroupId`, rendering as a coherent group in the History tab. Single-object response is `{ id, eval, timestamp }`; array response is `{ imported: [{ id, eval, timestamp }, ...] }`. Per-entry validation; import is all-or-nothing |
| `DELETE /api/evals/history/:id` | Delete a single history entry. Blocked in readOnly |
| `POST /api/evals/compare` | Compare two eval results by history ID. Body: `{ baselineId, candidateId, options? }` where each ID is `string` (single run) or `string[]` (pooled multi-run). Resolves IDs server-side from `runtime.getEvalHistory()` so the wire payload stays small |
| `POST /api/playground/chat` | Chat with an agent directly (no workflow required). Accepts `{ message, agent?, sessionId? }`. Streams results via WebSocket |
| `GET /api/decisions` | List pending decisions |
| `POST /api/decisions/:id/resolve` | Resolve a pending decision |

All endpoints return `{ ok: true, data: {...} }` on success or `{ ok: false, error: { code, message } }` on error.

### Versioned execution history and tool aggregates

`GET /api/executions/:id` returns historical execution data without rewriting
it. New rows carry `eventSchemaVersion: 2`, and every new event carries
`schemaVersion: 2`. A missing execution/event version identifies legacy v1
history. Studio renders that history with a legacy badge and preserves its
`tool_call_end.data.result` / `tool_denied` semantics; it never guesses a v2
terminal outcome. An unmatched v1 start is `legacy incomplete`, while an
unmatched v2 start after completion, truncation, or connection interruption is
`incomplete trace`.

Current live `execution:*` and `trace:*` channels carry the v2 lifecycle
directly. Pre-start rejection is `tool_call_rejected`. An accepted call closes
with `tool_call_end.data.outcome`, narrowed by `status` to `succeeded`,
`failed`, `denied`, or `cancelled`. Pair accepted calls only by the full
`(executionId, askId, callId)` identity.

Each `trace-stats.byTool[tool]` bucket has this shape:

```typescript
{
  accepted: number;       // v2 tool_call_start
  succeeded: number;      // v2 successful terminal
  failed: number;         // v2 failed terminal
  failedByPhase: Record<string, number>;
  denied: number;         // v2 denied terminal
  cancelled: number;      // v2 cancelled terminal
  rejected: number;       // v2 pre-start rejection
  approved: number;       // v2 approved tool_approval
  legacy: { calls: number; approved: number; denied: number };
}
```

The v1 bucket stays separate because a legacy end does not encode the v2
terminal status. Additional v2 starts, rejections, and terminal events change
trace counts only. Cost and billing still fold cost-bearing model/embedder
events, so the expanded tool lifecycle does not add spend.

## WebSocket

Single endpoint at `ws://localhost:4400/ws` with channel multiplexing:

```json
{ "type": "subscribe", "channel": "trace:*" }
{ "type": "event", "channel": "trace:abc-123", "data": { ... } }
```

Channels: `execution:{id}`, `trace:{id}`, `trace:*`, `eval:{id}`, `eval:{evalRunId}`, `eval:*`, `costs`, `eval-trends`, `workflow-stats`, `trace-stats`, `decisions`. Execution and eval channels have replay buffering — late subscribers receive the full event history (capped at 1000 events by default; tunable via `bufferCaps`, see below). Buffers are cleaned up 30s after the stream completes. Aggregate channels (`costs`, `eval-trends`, `workflow-stats`, `trace-stats`) broadcast `{ snapshots: Record<WindowId, State>, updatedAt }` on every fold or rebuild.

Replay caps and socket interruption can produce an incomplete view. The client
labels unmatched accepted starts as incomplete after a cap/truncation marker or
disconnect; it does not synthesize a terminal outcome.

**Outbound frame budget.** The WS broadcast layer enforces a 64KB soft cap via `truncateIfOversized`. Oversized verbose-mode `agent_call_start.data.messages` request snapshots are replaced with a `{ __truncated: true, originalBytes, maxBytes, hint }` placeholder that preserves the event's `type`/`step`/`agent`/`tool` so the Trace Explorer still renders the row. The 64KB threshold matches the inbound message reject limit in the WS protocol (shared constant).

### Migrating from 0.14

- **`POST /api/costs/reset` has been removed.** Any script hitting the old endpoint gets `404`. Use window selection (`?window=`) instead — snapshots evict automatically as their window slides.
- **`CostAggregator` class is no longer exported** from `@axlsdk/studio`. Replaced by `TraceAggregator<CostData>` configured with a pure `reduceCost` reducer. Behavior is preserved.
- **`costs` WS channel payload shape changed** from `CostData` to `{ snapshots: Record<WindowId, CostData>, updatedAt: number }`. Clients that read the old shape must select a window (typically `snapshots['7d']`).

## Embeddable Middleware

For applications using dependency injection (NestJS, etc.) or existing HTTP servers, Studio can be mounted as middleware instead of running as a standalone CLI.

```typescript
import express from 'express';
import { AxlRuntime } from '@axlsdk/axl';
import { createStudioMiddleware } from '@axlsdk/studio/middleware';

const runtime = new AxlRuntime({ providers: ['openai'] });
// ... register workflows, agents, tools ...

const studio = createStudioMiddleware({
  runtime,
  basePath: '/studio',
  // Your auth logic here — check a token, cookie, or header.
  // This runs on WebSocket upgrades, which bypass Express middleware.
  verifyUpgrade: (req) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    return url.searchParams.get('token') === process.env.MY_SECRET;
  },
});

const app = express();
app.use('/studio', studio.handler);

const server = app.listen(3000);
studio.upgradeWebSocket(server);
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `runtime` | `AxlRuntime` | required | The runtime instance to observe and control |
| `basePath` | `string` | `''` | URL path prefix (e.g., `'/studio'`) |
| `serveClient` | `boolean` | `true` | Serve the pre-built SPA |
| `verifyUpgrade` | `(req) => boolean \| { allowed: boolean, metadata?: unknown } \| Promise<...>` | — | Auth callback for WebSocket upgrades. The object form attaches `metadata` (tenant/user id / role) to the connection, available to `filterTraceEvent` on every outbound broadcast. Bare boolean still works (back-compat) |
| `filterTraceEvent` | `(event, metadata) => boolean` | — | Per-connection broadcast filter for multi-tenant deployments. Called on every outbound trace event (and on replay buffer events for late subscribers, so historical cross-tenant events can't leak on reconnect). Predicate errors are fail-closed — event is dropped |
| `readOnly` | `boolean` | `false` | Disable all mutating endpoints. `POST /api/evals/compare` is allowed (pure computation); `POST /api/evals/import`, `POST /api/evals/:name/run`, `POST /api/evals/:name/rescore`, `POST /api/evals/runs/:evalRunId/cancel`, `DELETE /api/evals/history/:id`, and `DELETE /api/executions/:id` are blocked (405 with `error.code: 'READ_ONLY'`) |
| `evals` | `string \| string[] \| { files, conditions? }` | — | Lazy-load eval files for the Eval Runner panel |
| `bufferCaps` | `{ maxEventsPerBuffer?, maxBytesPerBuffer?, maxActiveBuffers? }` | `{ 1000, 4 MiB, 256 }` | Override the default WebSocket replay-buffer resource caps for high-churn deployments. Worst-case memory is roughly `maxActiveBuffers × maxBytesPerBuffer` (≈1 GiB at defaults). Terminal `done`/`error` events are always buffered regardless of caps |

### Return value

| Property | Description |
|----------|-------------|
| `handler` | Node.js `(req, res)` handler for Express/Fastify/Koa/raw HTTP |
| `handleWebSocket(ws)` | Handle an individual WebSocket (framework-agnostic) |
| `upgradeWebSocket(server)` | Attach WS upgrade handling to an `http.Server` |
| `app` | Underlying Hono app (for Hono-in-Hono mounting) |
| `connectionManager` | WS connection/channel manager |
| `close()` | Shut down middleware (removes listeners, closes connections) |

**Note:** `upgradeWebSocket(server)` is required for real-time features (trace streaming, cost updates, execution events, decision resolution). Without it, the Studio SPA loads but panels relying on live data will show no updates. If your framework manages WebSocket connections itself (NestJS gateway, Fastify plugin), use `handleWebSocket()` instead.

### Host body limits

Studio's API uses small request bodies — the eval comparison flow sends history IDs (~100 bytes), not full result payloads — so the default body limits in Express, NestJS, Fastify, and Koa (typically 100KB) are sufficient for normal use.

The one exception is `POST /api/evals/import`, which accepts a full `EvalResult` JSON (typically a CLI artifact from `axl-eval --output result.json`). If you import sizeable eval files through Studio, raise your host framework's JSON body limit *on the Studio sub-mount only*.

**Express:**

```typescript
import express from 'express';
const app = express();
// Larger limit just for Studio; the rest of the app keeps its defaults.
app.use('/studio', express.json({ limit: '10mb' }), studio.handler);
```

**NestJS:** NestJS registers its own body-parser at bootstrap, so `app.use(express.json(...))` added after `NestFactory.create()` does *not* override it — the built-in parser runs first and still rejects with `PayloadTooLargeError`. Disable the built-in parser and register a conditional one:

```typescript
// main.ts
import { NestFactory, HttpAdapterHost } from '@nestjs/core';
import { json } from 'express';
import { AppModule } from './app.module';
import { createStudioMiddleware } from '@axlsdk/studio/middleware';

async function bootstrap() {
  // Disable Nest's built-in body parser so we control limits ourselves.
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // Apply 10 MB limit to the Studio sub-mount only; rest of the app keeps
  // the 100 KB default. This is the maintainer-endorsed pattern for
  // per-route body limits in NestJS (see nestjs/nest#14734).
  const studioJson = json({ limit: '10mb' });
  const defaultJson = json();
  app.use((req, res, next) =>
    req.url.startsWith('/studio') ? studioJson(req, res, next) : defaultJson(req, res, next),
  );

  const studio = createStudioMiddleware({ runtime });
  const expressApp = app.get(HttpAdapterHost).httpAdapter.getInstance();
  expressApp.use('/studio', studio.handler);
  studio.upgradeWebSocket(app.getHttpServer());

  await app.listen(3000);
}
bootstrap();
```

> `app.useBodyParser('json', { limit })` raises the limit **globally**, not per-route — avoid it if you want the larger limit scoped to Studio.

**Fastify:** set `bodyLimit` on the Fastify instance or pass it via `fastify({ bodyLimit: 10 * 1024 * 1024 })`. There's no per-route equivalent as clean as Express's; if Studio is the only route that needs a larger limit, either raise the global limit or mount Studio on a separate Fastify instance.

### Framework examples

#### NestJS

```typescript
import { Module, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { createStudioMiddleware, type StudioMiddleware } from '@axlsdk/studio/middleware';

@Module({ /* ... */ })
export class AppModule implements OnModuleInit, OnModuleDestroy {
  private studio!: StudioMiddleware;

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly runtime: AxlRuntime, // injected via custom provider
  ) {}

  onModuleInit() {
    this.studio = createStudioMiddleware({
      runtime: this.runtime,
      basePath: '/studio',
      verifyUpgrade: (req) => req.headers['authorization'] === `Bearer ${process.env.MY_SECRET}`,
    });

    // Mount on the underlying Express instance — this is the recommended
    // NestJS pattern for sub-application mounting (see NestJS HTTP adapter docs).
    const expressApp = this.httpAdapterHost.httpAdapter.getInstance();
    expressApp.use('/studio', this.studio.handler);
    this.studio.upgradeWebSocket(this.httpAdapterHost.httpAdapter.getHttpServer());
  }

  onModuleDestroy() {
    this.studio.close();
  }
}
```

#### Fastify

```typescript
import Fastify from 'fastify';
import middie from '@fastify/middie';
import { createStudioMiddleware } from '@axlsdk/studio/middleware';

const studio = createStudioMiddleware({ runtime, basePath: '/studio' });
const fastify = Fastify();

await fastify.register(middie);
fastify.use('/studio', studio.handler);

await fastify.listen({ port: 3000 });
studio.upgradeWebSocket(fastify.server);
```

#### Raw Node.js

```typescript
import { createServer } from 'node:http';
import { createStudioMiddleware } from '@axlsdk/studio/middleware';

const studio = createStudioMiddleware({ runtime });
const server = createServer(studio.handler);
studio.upgradeWebSocket(server);
server.listen(3000);
```

#### Hono-in-Hono

```typescript
import { Hono } from 'hono';
import { createStudioMiddleware, handleWsMessage } from '@axlsdk/studio/middleware';

const studio = createStudioMiddleware({ runtime, basePath: '/studio' });
const app = new Hono();
app.route('/studio', studio.app);
// Wire WebSocket via Hono's native WS support — see spec for full example
```

### Important: `basePath` must match your mount path

`basePath` tells the SPA where it's mounted in the browser URL. It must match the path in your framework's mount call:

```typescript
// These must match:
createStudioMiddleware({ basePath: '/studio' })  // tells the SPA
app.use('/studio', studio.handler)                // tells Express
```

If they don't match, the SPA will load but API calls will fail (the SPA sends requests to the wrong path).

### Lazy eval loading

In monorepos, eval files often import from domain modules (prompt builders, validators, fixture datasets) that would create circular dependencies if statically imported from the module that owns the runtime. The `evals` option solves this by dynamically importing eval files on first access to the Eval Runner panel — never during normal API operation.

```typescript
const studio = createStudioMiddleware({
  runtime,
  basePath: '/studio',
  evals: 'evals/**/*.eval.ts',
});
```

Eval files are standalone entry points (like `axl.config.ts`). They can import from any module without creating circular deps in the static module graph, and `@axlsdk/eval` can remain a `devDependency` since bundlers can't see dynamic `import()` calls.

**Multiple patterns or explicit paths:**

```typescript
evals: ['evals/*.eval.ts', 'tests/evals/*.eval.ts']
```

**Monorepo import conditions** (process-wide via `module.register()`):

```typescript
evals: {
  files: 'libs/api/evals/*.eval.ts',
  conditions: ['development'],
}
```

> **`conditions` / `--conditions` is ESM-only.** The custom import conditions are applied
> through an ESM resolve hook, so they only affect `import`/`await import()` chains.
> Transitive **CommonJS `require()`** chains bypass the hook — a `development` export that
> points at a `.ts` source file will silently resolve to the built `.js` instead. Keep the
> resolved module graph ESM end-to-end if you rely on source-export conditions.

Each file should `export default` a config with `{ workflow, dataset, scorers }` (the result of `defineEval()`). By default, the runtime executes the named workflow for each dataset item. For self-contained evals that don't depend on a registered workflow, export an `executeWorkflow` function — it will be called instead of `runtime.execute()`. See the [`@axlsdk/eval` README](../packages/axl-eval/README.md#defineevalconfig) for details.

Eval names are the file's path relative to the project root (`cwd`), minus the `.eval.*` suffix:

```
evals/suggestions.eval.ts        → "evals/suggestions"
evals/api/accuracy.eval.ts       → "evals/api/accuracy"
libs/search/accuracy.eval.ts     → "libs/search/accuracy"
```

This makes names completely stable — a file's name never changes regardless of what other files or patterns exist. You can look at a file path and know its eval name.

Lazy-loaded evals coexist with evals registered directly via `runtime.registerEval()`.

**Important notes:**

- **Caching**: Eval files are loaded once on first access and cached for the lifetime of the middleware. Changes to eval files require a server restart to take effect (both the loader and Node.js module cache are one-shot).
- **Running nested evals**: Names containing `/` must be URL-encoded in the run endpoint: `POST /api/evals/api%2Faccuracy/run`.
- **Name stability**: Names are project-relative paths, so they never change when other files or patterns are added/removed.
- **Supported glob patterns**: `dir/*.eval.ts` (single directory), `dir/**/*.eval.ts` (recursive), `**/*.eval.ts` (recursive from cwd). Multi-segment `**` (e.g., `a/**/b/**/*.ts`) is not supported.

### Multi-tenant deployments

Combine `verifyUpgrade` returning `{ allowed, metadata }` with `filterTraceEvent` to scope each WebSocket connection to a tenant/user:

```typescript
const studio = createStudioMiddleware({
  runtime,
  verifyUpgrade: (req) => {
    const userId = authenticate(req);
    if (!userId) return { allowed: false };
    return { allowed: true, metadata: { userId, tenantId: lookupTenant(userId) } };
  },
  filterTraceEvent: (event, metadata) => {
    // Scope the trace firehose: only let a connection see its own tenant's events.
    return event.metadata?.tenantId === metadata?.tenantId;
  },
});
```

The filter runs on live broadcasts **and** on replay buffer events delivered to late subscribers, so historical cross-tenant events can't leak on reconnect. Predicate errors are fail-closed (event dropped).

### Migrating from the standalone CLI

If you currently use `npx @axlsdk/studio` with a config file:

1. Move runtime creation from `axl.config.ts` into your app's initialization code
2. Register workflows, agents, and tools on the runtime where they have access to your services
3. Call `createStudioMiddleware({ runtime, basePath: '/studio' })` and mount the handler
4. Call `upgradeWebSocket(server)` for WebSocket support
5. Remove the `axl-studio` CLI from your dev scripts

The `axl.config.ts` file is no longer needed. The standalone CLI continues to work for projects that don't need embedded middleware.

## Observability-boundary redaction

When the runtime is constructed with `config.trace.redact: true`, Studio scrubs user/LLM content at three layers — trace events at emission, REST route responses at serialization, and WebSocket broadcasts at send time — while preserving structural metadata (IDs, keys, agent/tool/workflow names, roles, cost/token/duration metrics, timestamps).

```typescript
const runtime = new AxlRuntime({ trace: { redact: true } });
const studio = createStudioMiddleware({ runtime });
```

Under `redact: true`, the following Studio endpoints scrub user content server-side before responding: `GET /api/executions{,/:id}` (also scrubs `ExecutionInfo.metadata` to `{ redacted: true }` — caller-supplied `userId`/`tenantId`/correlation ids are PII surfaces), `GET /api/memory/:scope{,/:key}` (keys preserved so Memory Browser stays navigable), `GET /api/sessions/:id`, `GET /api/evals/history`, `POST /api/evals/:name/run` (sync), `POST /api/evals/:name/rescore`, `GET /api/decisions`, `POST /api/tools/:name/test`, `POST /api/workflows/:name/execute` (sync); streaming WS broadcasts on `/workflows/:name/execute` with `stream: true`, `/api/playground/chat`, AND the trace channel firehose (`trace:{executionId}`) all scrub `AxlEvent` content before send.

**`DELETE /api/executions/:id` is a second cleanup boundary** alongside redaction. Redaction scrubs *content* on read; the delete endpoint removes the *whole row + indexes + checkpoints + suspended state + streaming buffer + pending decisions* AND scrubs the WebSocket replay buffer for `execution:{id}` so late subscribers can't reconstruct events for a deleted run. Audit via `runtime.on('execution_deleted', ...)`.

Studio checks the flag via `runtime.isRedactEnabled(): boolean` — it does **not** reach into the config object directly, because `Readonly<AxlConfig>` is shallow and consumers could mutate the nested `trace.redact` field via sub-object access. `GET /api/health` also reports `readOnly: boolean` so clients can gate mutating UI affordances.

See [`docs/observability.md`](./observability.md#pii-and-redaction) for the complete scrubbed/preserved field table.

## Architecture

```
src/
  cli.ts                  CLI entry — loads config, starts server
  middleware.ts           Embeddable middleware: createStudioMiddleware()
  resolve-runtime.ts      Config module interop (ESM default, CJS wrapping, named exports)
  server/
    index.ts              createServer() — Hono app composition (basePath, readOnly, cors)
    types.ts              API types, WebSocket message types
    aggregates/
      aggregate-snapshots.ts  AggregateSnapshots<State> helper (per-window state, fold, replace, broadcastTransform)
      trace-aggregator.ts     TraceAggregator<State> — AxlEvent consumer (costs, trace-stats)
      execution-aggregator.ts ExecutionAggregator<State> — ExecutionInfo consumer (workflow-stats)
      eval-aggregator.ts      EvalAggregator<State> — EvalHistoryEntry consumer (eval-trends)
      reducers.ts             Pure reducers: reduceCost, reduceWorkflowStats, reduceTraceStats, reduceEvalTrends + enrichWorkflowStats
    middleware/
      error-handler.ts    Axl errors → JSON error envelope
    routes/               One file per resource (health, workflows, agents, tools, costs, eval-trends, workflow-stats, trace-stats, evals, etc.)
    ws/
      handler.ts          WebSocket message routing (Hono adapter)
      connection-manager.ts  Channel subscriptions + broadcast (BroadcastTarget) + replay buffer for execution channels
      protocol.ts         Shared WS protocol: handleWsMessage(), channel validation
  client/
    App.tsx               React SPA — sidebar + 8 panel routes
    lib/
      api.ts              Typed fetch wrappers (reads window.__AXL_STUDIO_BASE__)
      ws.ts               WebSocket client with channel subscriptions (reads base path)
    panels/               One directory per panel
```

**Server:** Hono HTTP server wrapping the user's `AxlRuntime`. REST endpoints for CRUD, WebSocket for live streaming. Supports standalone CLI and embeddable middleware modes.

**Client:** React 19 SPA with Tailwind CSS v4, TanStack Query, and react-router-dom. Pre-built at publish time and served as static assets. Reads `window.__AXL_STUDIO_BASE__` for runtime base path configuration.

**CLI:** Auto-detects and loads the user's config. TypeScript files activate tsx's loader hooks process-wide (registered once per process via both `tsx/esm/api`'s and `tsx/cjs/api`'s `register()`), so chained `import()` AND transitive `require('./x.ts')` calls from CJS workspace deps are transformed. Validates the runtime, starts the server, and optionally opens the browser.

**Middleware:** `createStudioMiddleware()` wraps the Hono app as a Node.js `(req, res)` handler via `@hono/node-server`. Adds `verifyUpgrade` for WS auth, `readOnly` mode, and `basePath` injection into the SPA.
