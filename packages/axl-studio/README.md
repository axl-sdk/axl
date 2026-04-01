# @axlsdk/studio

[![npm version](https://img.shields.io/npm/v/@axlsdk/studio)](https://www.npmjs.com/package/@axlsdk/studio)

Local development UI for debugging, testing, and iterating on [Axl](https://github.com/axl-sdk/axl) agents and workflows.

## Installation

```bash
npm install -D @axlsdk/studio
```

Or run directly with npx (no install needed):

```bash
npx @axlsdk/studio
```

**Requirements:** Node.js 20+, an existing Axl project with `@axlsdk/axl` installed.

## Quick Start

### 1. Create a config file

Studio needs a config file at your project root that default-exports an `AxlRuntime`. It auto-detects in this order: `axl.config.mts` → `axl.config.ts` → `axl.config.mjs` → `axl.config.js`. Use `.mts` for configs with top-level `await` or in projects without `"type": "module"` in package.json.

The recommended pattern is to keep your tools, agents, workflows, and runtime in your application code, then re-export the runtime for Studio to discover:

```
src/
  config.ts              — defineConfig (providers, state, trace)
  runtime.ts             — creates AxlRuntime, registers everything
  tools/                 — tool definitions (wrap your services)
  agents/                — agent definitions (import their tools)
  workflows/             — workflow definitions (orchestrate agents)
axl.config.mts           — re-exports runtime for Studio
```

```typescript
// src/runtime.ts
import { AxlRuntime } from '@axlsdk/axl';
import { config } from './config.js';
import { handleTicket } from './workflows/handle-ticket.js';
import { supportAgent } from './agents/support.js';
import { lookupOrder } from './tools/db.js';

export const runtime = new AxlRuntime(config);
runtime.register(handleTicket);
runtime.registerAgent(supportAgent);
runtime.registerTool(lookupOrder);
```

```typescript
// axl.config.mts — thin entry point for Studio
import { runtime } from './src/runtime.js';
export default runtime;
```

Your application imports from `src/runtime.ts` directly. Studio discovers everything via `axl.config.mts`. See the [`@axlsdk/axl` README](../axl/README.md#project-structure) for the full recommended project structure.

### 2. Start Studio

```bash
npx @axlsdk/studio --open
```

This loads your config, starts the server on `http://localhost:4400`, and opens the browser.

## CLI Options

```
axl-studio [options]

Options:
  --port <number>          Server port (default: 4400)
  --config <path>          Path to config file (default: auto-detect)
  --conditions <list>      Comma-separated Node.js import conditions (e.g., development)
  --open                   Auto-open browser
  -h, --help               Show help
```

The `--conditions` flag is useful in monorepos where workspace packages use the `"development"` export condition to point at source instead of built dist files. Pass `--conditions development` to resolve imports through source paths.

**Note:** `--conditions` only applies to ESM `import()` resolution. Transitive `require()` calls from packages without `"type": "module"` bypass the hook and use default conditions. If a dependency loads via CJS, it will still resolve from `dist/` regardless of the flag.

## Panels

### Agent Playground
Chat with any registered agent in real-time. See streaming tokens, tool calls with expandable input/output, and multi-turn conversation history.

### Workflow Runner
Execute workflows with custom JSON input. View execution timelines showing each agent call, tool invocation, and cost.

### Trace Explorer
Waterfall visualization of execution traces. Filter by type, agent, or tool. View token counts, cost per step, and duration.

### Cost Dashboard
Track spending across agents, models, and workflows. Live cost updates via WebSocket. Per-agent and per-model breakdowns.

### Memory Browser
View and manage agent memory (session and global scope). Create, edit, and delete entries. Test semantic recall queries.

### Session Manager
Browse active sessions with conversation history. Replay sessions step by step. View handoff chains between agents.

### Tool Inspector
Browse all registered tools with their schemas rendered as forms. Test any tool directly with custom input and see the result.

### Eval Runner
Run evaluations from the UI. View per-item results with scores, timing, and cost. Drill into individual items to see LLM scorer reasoning, per-scorer timing/cost, and annotations. Filter items by error state or score threshold, sort by score/duration/cost. Score distribution chart shows how scores are spread across bins. Compare two runs with timing/cost tradeoff analysis and expandable regression detail showing side-by-side outputs and reasoning. History tab tracks mean scores across runs with an eval name filter. Requires `@axlsdk/eval` as an optional peer dependency.

## What gets registered

Studio discovers your project through the `AxlRuntime` instance. Use these methods to make things visible:

| Method | What it exposes |
|--------|----------------|
| `runtime.register(workflow)` | Workflows (Workflow Runner, Playground) |
| `runtime.registerAgent(agent)` | Agents (Playground agent picker) |
| `runtime.registerTool(tool)` | Tools (Tool Inspector) |
| `runtime.registerEval(name, config)` | Evals (Eval Runner) |

Workflows are required for execution. Agents and tools are optional but recommended — they power the Playground agent picker and Tool Inspector panels. Evals require `@axlsdk/eval` as a peer dependency.

## API Endpoints

Studio exposes a REST API that the SPA consumes. You can also call these directly for scripting or testing.

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Server status, registered workflow/agent/tool counts |
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
| `GET /api/costs` | Aggregated cost data |
| `POST /api/costs/reset` | Reset cost counters |
| `GET /api/memory/:scope/:key` | Read memory entry |
| `PUT /api/memory/:scope/:key` | Save memory entry |
| `DELETE /api/memory/:scope/:key` | Delete memory entry |
| `GET /api/evals` | List registered eval configs |
| `GET /api/evals/history` | List eval run history |
| `POST /api/evals/:name/run` | Run a registered eval by name |
| `POST /api/evals/compare` | Compare two eval results |
| `GET /api/decisions` | List pending decisions |
| `POST /api/decisions/:id/resolve` | Resolve a pending decision |

All endpoints return `{ ok: true, data: {...} }` on success or `{ ok: false, error: { code, message } }` on error.

### WebSocket

Single endpoint at `ws://localhost:4400/ws` with channel multiplexing:

```json
{ "type": "subscribe", "channel": "trace:*" }
{ "type": "event", "channel": "trace:abc-123", "data": { ... } }
```

Channels: `execution:{id}`, `trace:{id}`, `trace:*`, `costs`, `decisions`.

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
| `verifyUpgrade` | `(req) => boolean \| Promise<boolean>` | — | Auth callback for WebSocket upgrades |
| `readOnly` | `boolean` | `false` | Disable all mutating endpoints |
| `evals` | `string \| string[] \| { files, conditions? }` | — | Lazy-load eval files for the Eval Runner panel |

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

Each file should `export default` a config with `{ workflow, dataset, scorers }` (the result of `defineEval()`). By default, the runtime executes the named workflow for each dataset item. For self-contained evals that don't depend on a registered workflow, export an `executeWorkflow` function — it will be called instead of `runtime.execute()`. See the [`@axlsdk/eval` README](../axl-eval/README.md#defineevalconfig) for details.

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

### Security

- **Always** provide `verifyUpgrade` — WebSocket upgrades bypass Express/Fastify/Koa middleware, so your auth middleware does NOT protect WebSocket connections
- Consider `readOnly: true` for production monitoring — view traces, costs, and schemas without execution capability
- CORS is not applied in embedded mode — the host framework owns CORS policy
- `basePath` is validated against unsafe characters and path traversal

### Migrating from the standalone CLI

If you currently use `npx @axlsdk/studio` with a config file:

1. Move runtime creation from `axl.config.ts` into your app's initialization code
2. Register workflows, agents, and tools on the runtime where they have access to your services
3. Call `createStudioMiddleware({ runtime, basePath: '/studio' })` and mount the handler
4. Call `upgradeWebSocket(server)` for WebSocket support
5. Remove the `axl-studio` CLI from your dev scripts

The `axl.config.ts` file is no longer needed. The standalone CLI continues to work for projects that don't need embedded middleware.

## Architecture

```
src/
  cli.ts                  CLI entry — loads config, starts server
  middleware.ts           Embeddable middleware: createStudioMiddleware()
  resolve-runtime.ts      Config module interop (ESM default, CJS wrapping, named exports)
  server/
    index.ts              createServer() — Hono app composition (basePath, readOnly, cors)
    types.ts              API types, WebSocket message types
    cost-aggregator.ts    Accumulates cost from trace events
    middleware/
      error-handler.ts    Axl errors → JSON error envelope
    routes/               One file per resource (health, workflows, agents, tools, etc.)
    ws/
      handler.ts          WebSocket message routing (Hono adapter)
      connection-manager.ts  Channel subscriptions + broadcast (BroadcastTarget)
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

**CLI:** Auto-detects and loads the user's config via tsx's `tsImport()` API (handles ESM/CJS correctly for TypeScript files without process-wide side effects), validates the runtime, starts the server, and optionally opens the browser.

**Middleware:** `createStudioMiddleware()` wraps the Hono app as a Node.js `(req, res)` handler via `@hono/node-server`. Adds `verifyUpgrade` for WS auth, `readOnly` mode, and `basePath` injection into the SPA.

## Development

```bash
# Install dependencies
pnpm install

# Build everything (client then server)
pnpm --filter @axlsdk/studio build

# Dev mode (Vite HMR + server watch)
pnpm --filter @axlsdk/studio dev

# Type check
pnpm --filter @axlsdk/studio typecheck
```

## License

Apache-2.0
