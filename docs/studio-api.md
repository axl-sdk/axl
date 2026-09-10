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
| `GET /api/sessions/:id` | Read session history and handoff history. Rich user turns are projected to a bounded descriptor whose parts are `{ type: 'text', characters }`, `{ type: 'image', source, mediaType?, bytes? }`, or `{ type: 'audio', source, mediaType?, bytes? }`. The Studio payload deliberately carries **no** `locator` or `label` for either modality — it is a Studio-safe descriptor, not a replay payload — and never inline bytes or base64 |
| `POST /api/sessions/:id/send` | Send one session message. Body: `{ workflow: string, message: string }`. Returns the workflow result |
| `POST /api/sessions/:id/stream` | Start a session message. Body: `{ workflow: string, message: string }`. Broadcasts `AxlEvent`s on the returned `execution:{executionId}` channel |
| `GET /api/executions` | List executions |
| `GET /api/executions/:id` | Execution detail. `?since={step}` filters `events` to those with `step > since` (polling tail) |
| `POST /api/executions/:id/abort` | Abort a running execution (signal-driven; wakes paused `ctx.awaitHuman`) |
| `DELETE /api/executions/:id` | Delete an execution from history (GDPR scrub). Calls `runtime.deleteExecution` AND scrubs the WS replay buffer for `execution:{id}`. Returns `{ id, deleted: true }` or 404. Blocked in readOnly |
| `GET /api/costs?window=24h\|7d\|30d\|all` | Aggregated cost data for a time window (default `7d`). `?windows=all` returns all four windows at once for debugging |
| `GET /api/eval-trends?window=` | Per-eval score trends (latest, mean, std), known-spend totals with a conservative `completeness` flag, budget-stopped run counts, recent runs with `model`/`duration`. Payload shape: [Eval trend spend and completeness](#eval-trend-spend-and-completeness) |
| `GET /api/workflow-stats?window=` | Per-workflow totals, completed/failed counts, p50/p95/avg duration, failure rate |
| `GET /api/trace-stats?window=` | Event-type distribution, version-separated tool lifecycle counts, and retry breakdown by agent |
| `GET /api/memory/:scope/:key` | Read memory entry |
| `PUT /api/memory/:scope/:key` | Save memory entry |
| `DELETE /api/memory/:scope/:key` | Delete memory entry |
| `GET /api/evals` | List registered eval configs |
| `GET /api/evals/history` | List eval run history |
| `POST /api/evals/:name/run` | Run a registered eval by name. Body: `{ runs?: N, stream?: true, captureTraces?: true, captureRequests?: true }` (`runs` capped at 25). When `stream: true`, returns `{ evalRunId }` immediately and broadcasts progress over the `eval:{evalRunId}` WS channel: `item_done` per item, `run_done` per successful run, `run_failed` on a provider error, `run_cancelled` on user-initiated abort, terminal `done` (carrying only `{ evalResultId, runGroupId? }` plus `partial: true / batchCompleted / batchAttempted` and either `cancelled: true` OR `batchFailure` — never both — when the batch is partial), or terminal `error` if no runs completed. Clients refetch the full result from history. `captureTraces: true` populates per-item `EvalItem.traces` on every item (success + failure); the Eval Runner panel renders these inline on item detail. Synchronous mode (default) returns the full `EvalResult` enriched with `_multiRun.partial` markers when applicable |
| `POST /api/evals/runs/:evalRunId/cancel` | Abort an active streaming eval run. The cancelled run appears in history with remaining items marked as cancelled |
| `POST /api/evals/:name/rescore` | Re-score a history entry with the eval's current scorers. Body accepts `captureRequests?: true`, which captures the new judging calls and copies the source run's captured generation requests (bounded, original operation ids preserved) |
| `GET /api/evals/:id/diagnostics` | Manifest for a history entry's [captured requests](observability.md#captured-requests-opt-in): `{ artifactId, status, reason?, records, bytes, fidelity, redaction, expiresAt?, copiedFrom? }`. `redaction` describes the STORED bytes (what the writer applied, or for an imported bundle what its own records say) — not whether this deployment redacts on delivery, which it always does when `trace.redact` is on. 404 when the entry captured nothing or its artifact is gone. The artifact is resolved **through the history id** — a client can never name storage directly |
| `GET /api/evals/:id/diagnostics/records` | The captured records, streamed as `application/x-ndjson` (one `v: 1` JSON record per line) rather than buffered into an array. Re-redacted line by line when `trace.redact` is on |
| `POST /api/evals/import` | Import a CLI eval artifact (parsed `EvalResult` JSON) into runtime history. Body: `{ result: EvalResult \| EvalResult[], eval?, requests? }`. `requests` is an optional captured-request JSONL sidecar (`<name>.requests.jsonl` from `axl-eval --capture-requests --output`); it accompanies a **single** result only, is validated in full before anything is stored, and is re-staged under a new artifact id owned by the new history row. A result that claims captured requests but arrives without them is imported with `diagnostics.status: 'unavailable'` rather than rejected. The CLI's `--output` writes a JSON array when `--runs N > 1` (including for partial batches), so array form is supported — each entry imports as its own history entry with shared `runGroupId`, rendering as a coherent group in the History tab. Single-object response is `{ id, eval, timestamp }`; array response is `{ imported: [{ id, eval, timestamp }, ...] }`. Per-entry validation; import is all-or-nothing |
| `DELETE /api/evals/history/:id` | Delete a single history entry. Blocked in readOnly |
| `POST /api/evals/compare` | Compare two eval results by history ID. Body: `{ baselineId, candidateId, options? }` where each ID is `string` (single run) or `string[]` (pooled multi-run). Resolves IDs server-side from `runtime.getEvalHistory()` so the wire payload stays small |
| `POST /api/playground/chat` | Chat with an agent directly (no workflow required). Accepts `{ message, agent?, sessionId?, image? }`, where `image` is `{ mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', data: string }`: standard base64 only (no data URL), one image, up to 5 MiB decoded. Streams results via WebSocket. |
| `GET /api/decisions` | List pending decisions |
| `POST /api/decisions/:id/resolve` | Resolve a pending decision in its owning runtime. Returns 400 for an invalid exact decision union, 404 for an unknown/already-resolved ID, and 409 for a persisted request whose process-local owner is gone |

All endpoints return `{ ok: true, data: {...} }` on success or `{ ok: false, error: { code, message } }` on error.

**How the Studio client reads the two diagnostics routes.** A run whose result
carries a `diagnostics` block renders a "Captured requests" panel on the run
detail, beside the accounting footer, and a marker on its History row. The panel
shows the result's own manifest immediately and then confirms availability
against `GET /api/evals/:id/diagnostics` — that route is the only place a
rescore's `copiedFrom` provenance exists, and a 404 from it means the bytes were
swept since the result was loaded, which downgrades the panel to `unavailable`
and disables the download. A manifest reading `unavailable` (or carrying the
empty-string artifact id) never repeats its `records`/`bytes` figures, because
they describe evidence that has just been declared absent. "Download records
(.jsonl)" takes the whole `/diagnostics/records` body and saves it as
`<eval>-<id>.requests.jsonl`; the inline viewer parses the same stream line by
line and stops at 200 **operations** — not lines — says so, and points at the
download for the rest. The artifact is one line per phase (`start` carries the
request, `end` the response, error or termination), so the viewer reassembles
them by `operationId` and renders one row per operation: an absent half is only
ever reported when the line that would have carried it is absent, and a `start`
with no `end` reads as "no response recorded" rather than as a completed call.
Per-run only: the multi-run aggregate view renders no panel, because a group's
result carries run 1's `diagnostics`. A result with no `diagnostics` block —
every pre-0.24 artifact and every run that did not opt in — renders nothing.

Two honesty details worth knowing when reading the panel. Its `redaction` line
describes the **stored** bytes; when this deployment re-redacts on delivery
(`trace.redact`) the rendered records also carry `captured.redacted`, and the
viewer says so separately so scrubbed content under a "not redacted" header is
not mistaken for scrubbed bytes on disk. And the History-row marker reads only
the embedded manifest: a sweep downgrades the owning history row, so the marker
goes stale only between that sweep and the next history fetch — the panel's
route confirmation closes that window when the run is opened.

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

### Eval trend spend and completeness

`GET /api/eval-trends?window=` (and the `eval-trends` WS channel, which carries
the same state) reports spend alongside how complete that spend figure is.
A total on its own is not a fact: `$0.00` from a fully priced run and `$0.00`
from a run whose model had no price are opposite claims, and a window holding
one pre-accounting artifact cannot be summed into a certified number.

```typescript
type EvalTrendCompleteness = 'complete' | 'incomplete' | 'unverified';

{
  byEval: Record<string, {
    runs: Array<{
      timestamp: number; id: string; scores: Record<string, number>;
      cost: number;                        // EvalResult.accounting.knownCost
      completeness: EvalTrendCompleteness; // how to read `cost`
      budgetStopped?: boolean;             // budget closed AND refused work
      model?: string; duration?: number;
      runGroupId?: string; batchAttempted?: number;
    }>;
    latestScores: Record<string, number>;
    scoreMean: Record<string, number>;
    scoreStd: Record<string, number>;
    costTotal: number;
    costCompleteness: EvalTrendCompleteness; // worst of every run in the window
    budgetStoppedRuns: number;
    runCount: number;
  }>;
  totalRuns: number;
  totalCost: number;
  totalCostCompleteness: EvalTrendCompleteness; // worst across every eval
}
```

`budgetStopped` (and the per-eval `budgetStoppedRuns` count) follows
`@axlsdk/eval`'s `isBudgetStopped`: the run's budget must have closed **and**
refused work — cases never started or stopped mid-flight, or judges refused for
the same reason. A controller that closed on a final settlement landing exactly
on its limit refused nothing and is not reported as stopped; a run whose
artifact carries no `coverage` block (pre-0.24) is never reported as stopped
either, because nothing recorded that work was refused. Spend folded into a
window follows the same `usableCost` rule the eval package's
`aggregateAccounting` uses: a negative or non-finite figure contributes `0`
rather than dragging a window total. When an `accounting` block is present it
is authoritative — an unusable `knownCost` reads `$0.00`, never the legacy
`totalCost` beside it, so `cost` agrees with what `readAccounting` gives every
other consumer.

`completeness` mirrors core's `AccountingCompleteness`. A history entry with no
`accounting` block predates measured spend: its `totalCost` is repeated as
`cost` but reported `unverified`, and it is never upgraded to `complete`.
The two window-level flags take the **worst** completeness of every run folded
into their totals — including runs the 50-run window cap has already evicted
from `runs`, since `costTotal` still counts them. One legacy or unpriced run
therefore makes the whole window uncertifiable, which is what stops a trend
chart from implying a precision the data never had.

## WebSocket

The standalone CLI defaults to `ws://127.0.0.1:4400/ws`. Embedded Studio uses
the host application's origin and optional base path, for example
`wss://app.example.com/studio/ws`. Both forms use channel multiplexing:

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
  // Reuse your application auth. Browser WebSockets commonly authenticate
  // with the same secure session cookie as the HTTP mount.
  // This runs on WebSocket upgrades, which bypass Express middleware.
  verifyUpgrade: (req) => authenticateStudioRequest(req)?.isAdmin === true,
});

const app = express();
const authenticateStudioHttp: express.RequestHandler = (req, res, next) => {
  if (authenticateStudioRequest(req)?.isAdmin !== true) return res.sendStatus(403);
  next();
};
app.use('/studio', authenticateStudioHttp, studio.handler);

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
| `dangerouslyAllowUnauthenticatedWebSockets` | `boolean` | `false` | Permit `upgradeWebSocket()` to attach in production without `verifyUpgrade`. Use only when an outer upgrade gate is independently guaranteed; otherwise production attachment fails closed |
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

### Security boundary

Studio is an administrative/operator surface, not a public application API.
Its agent and tool routes intentionally expose resolved system prompts, tool
descriptions, schemas, and runtime configuration. `trace.redact` scrubs
user/model observability content; it is not authentication and does not hide
static agent configuration.

For embedded Studio, protect the HTTP mount with the host framework's
authentication and authorization middleware **and** provide `verifyUpgrade` for
WebSockets. Framework HTTP middleware does not run for upgrade requests. The
standalone CLI is for local development: it binds to `127.0.0.1`, omits CORS
headers, and rejects non-local Host and browser Origin values before REST or
WebSocket routing. CORS headers alone are not its security boundary.

Container and devcontainer users may bind only the published host port to
loopback while broadening the container listener explicitly:

```bash
docker run -p 127.0.0.1:4400:4400 ... axl-studio --dangerously-bind 0.0.0.0
```

`upgradeWebSocket()` fails closed in production when `verifyUpgrade` is absent.
The `dangerouslyAllowUnauthenticatedWebSockets: true` acknowledgement exists for
hosts that independently authenticate the raw upgrade before Axl receives it;
it must not replace an actual upgrade gate.

**Note:** `upgradeWebSocket(server)` is required for real-time features (trace streaming, cost updates, execution events, decision resolution). Without it, the Studio SPA loads but panels relying on live data will show no updates. If your framework manages WebSocket connections itself (NestJS gateway, Fastify plugin), use `handleWebSocket()` instead.

### Host body limits

In the examples below, `authenticateStudioHttp`, `authenticateStudioHono`, and
`authenticateStudioRequest` stand for application-owned admin authorization.
They are required security boundaries, not SDK helpers.

Studio's API uses small request bodies — the eval comparison flow sends history IDs (~100 bytes), not full result payloads — so the default body limits in Express, NestJS, Fastify, and Koa (typically 100KB) are sufficient for normal use.

Studio **renders** audio descriptors in the Session Manager and trace views and
labels them as audio; it offers no audio picker, upload, or attachment surface.
Studio media composition remains a deferred product surface.

The Playground's optional local image attachment is the small exception: Studio accepts one
PNG, JPEG, WebP, or GIF per run, capped at 5 MiB decoded. Base64 plus its JSON envelope is
about 6.7 MiB on the wire. Studio rejects requests above that route cap with HTTP 413 before
JSON parsing, but an embedded host parser runs first; configure at least an 8 MiB JSON limit
on the Studio mount for Playground image runs. Attachments are sent only with that run request
and are not persisted to the Playground session.

The other exception is `POST /api/evals/import`, which accepts a full `EvalResult` JSON (typically a CLI artifact from `axl-eval --output result.json`). If you import sizeable eval files through Studio, raise your host framework's JSON body limit *on the Studio sub-mount only*.

**Express:**

```typescript
import express from 'express';
const app = express();
// Larger limit just for Studio; the rest of the app keeps its defaults.
app.use('/studio', authenticateStudioHttp, express.json({ limit: '10mb' }), studio.handler);
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
  expressApp.use('/studio', authenticateStudioHttp, studio.handler);
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
    expressApp.use('/studio', authenticateStudioHttp, this.studio.handler);
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

const studio = createStudioMiddleware({
  runtime,
  basePath: '/studio',
  verifyUpgrade: (req) => authenticateStudioRequest(req)?.isAdmin === true,
});
const fastify = Fastify();

await fastify.register(middie);
fastify.use('/studio', authenticateStudioHttp, studio.handler);

await fastify.listen({ port: 3000 });
studio.upgradeWebSocket(fastify.server);
```

#### Raw Node.js

```typescript
import { createServer } from 'node:http';
import { createStudioMiddleware } from '@axlsdk/studio/middleware';

const studio = createStudioMiddleware({
  runtime,
  verifyUpgrade: (req) => authenticateStudioRequest(req)?.isAdmin === true,
});
const server = createServer((req, res) => {
  if (authenticateStudioRequest(req)?.isAdmin !== true) {
    res.writeHead(403).end();
    return;
  }
  studio.handler(req, res);
});
studio.upgradeWebSocket(server);
server.listen(3000);
```

#### Hono-in-Hono

```typescript
import { Hono } from 'hono';
import { createStudioMiddleware, handleWsMessage } from '@axlsdk/studio/middleware';

const studio = createStudioMiddleware({ runtime, basePath: '/studio' });
const app = new Hono();
app.use('/studio/*', authenticateStudioHono);
app.route('/studio', studio.app);
// Wire WebSocket via Hono's native WS support — see spec for full example
```

### Important: `basePath` must match your mount path

`basePath` tells the SPA where it's mounted in the browser URL. It must match the path in your framework's mount call:

```typescript
// These must match:
createStudioMiddleware({ basePath: '/studio' })  // tells the SPA
app.use('/studio', authenticateStudioHttp, studio.handler) // tells Express and enforces auth
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

### Imported accounting validation

An imported result is the one eval in history Studio did not measure, and
`compare` will certify a cost delta from an `accounting` block that says
`completeness: 'complete'`. So a **declared** record has to earn that trust:

| Check | Rule |
|---|---|
| Shape | `version === 1`, `currency === 'USD'`, finite non-negative `knownCost`, `completeness` in the enum, numeric `reasons` / `usage` |
| Operations | `operations.total === settled + unknown`, with `denied` and `byKind` numeric |
| Provenance | values sum to `knownCost` (float tolerance) |
| Breakdown | `generation + judging + external` sums to `knownCost` |
| Budget | when `accounting.budget` is present: finite non-negative `limit` / `knownSpend` / `knownOvershoot`, `status` in `open`/`closed`, `closedBy` in the enum, `knownOvershoot === max(0, knownSpend - limit)`, and `status === 'closed'` exactly when `knownSpend >= limit` (an `AdmissionController` closes on nothing else) |
| Coverage | when `summary.coverage` is present: every item-outcome key and every scorer-outcome key per scorer, each a non-negative integer |

The two sum identities are checked only for `'complete'` and `'incomplete'`. An
`'unverified'` record is by definition a synthesis with no operations,
provenance or breakdown behind it, so it is accepted as-is.

Item-level and scorer-level `accounting` are held to the same rules, and the
verdict is **all-or-nothing** across the result: a run total that adds up while
its items are forged is not half-trustworthy.

`accounting.budget` and `summary.coverage` are in the same verdict because
together they are the whole "this run was stopped by its budget" claim, which
three surfaces render (the CLI summary, the eval-trends aggregate and the run
panel's badge) and which a reader treats as "the numbers are short for a known
reason" rather than "the numbers are wrong". A failing record loses both along
with its accounting, so nothing downstream can badge it budget-stopped. A
coverage block that arrives without any accounting at all is validated on its
own; a malformed one is dropped AND recorded as `importedAccounting: 'invalid'`
— `EvalCoverage` promises every key including zeros, a partial block reads
downstream as zeros (turning refused work into a clean run), and a reader has to
be able to tell "never had coverage" from "its coverage was refused".

A failing record is replaced with the `unverified` synthesis an artifact with no
accounting receives — the numbers stay readable, the certification does not
survive. Import **never rejects** a result over its accounting; the outcome is
recorded on `metadata.importedAccounting` as `'declared'` or `'invalid'` so it
is visible rather than inferred.

## Observability-boundary redaction

When the runtime is constructed with `config.trace.redact: true`, Studio scrubs user/LLM content at three layers — trace events at emission, REST route responses at serialization, and WebSocket broadcasts at send time — while preserving structural metadata (IDs, keys, agent/tool/workflow names, roles, cost/token/duration metrics, timestamps).

```typescript
const runtime = new AxlRuntime({ trace: { redact: true } });
const studio = createStudioMiddleware({ runtime });
```

Under `redact: true`, the following Studio endpoints scrub user content server-side before responding: `GET /api/executions{,/:id}` (also scrubs `ExecutionInfo.metadata` to `{ redacted: true }` — caller-supplied `userId`/`tenantId`/correlation ids are PII surfaces), `GET /api/memory/:scope{,/:key}` (keys preserved so Memory Browser stays navigable), `GET /api/sessions/:id`, `GET /api/evals/history`, `POST /api/evals/:name/run` (sync), `POST /api/evals/:name/rescore`, `GET /api/evals/:id/diagnostics/records` (each record re-redacted on the way out), `GET /api/decisions`, `POST /api/tools/:name/test`, `POST /api/workflows/:name/execute` (sync); streaming WS broadcasts on `/workflows/:name/execute` with `stream: true`, `/api/playground/chat`, AND the trace channel firehose (`trace:{executionId}`) all scrub `AxlEvent` content before send.

Session execution has the same boundary: `POST /api/sessions/:id/send` scrubs
its result, and `POST /api/sessions/:id/stream` scrubs every `AxlEvent` before
broadcasting it on the returned `execution:{executionId}` channel.

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
