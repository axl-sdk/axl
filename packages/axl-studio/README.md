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
Run evaluations from the UI. View per-item results with scores. Compare two eval runs side-by-side with regression/improvement detection. Requires `@axlsdk/eval` as an optional peer dependency.

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

## Architecture

```
src/
  cli.ts                  CLI entry — loads config, starts server
  server/
    index.ts              createServer() — Hono app composition
    types.ts              API types, WebSocket message types
    cost-aggregator.ts    Accumulates cost from trace events
    middleware/
      error-handler.ts    Axl errors → JSON error envelope
    routes/               One file per resource (health, workflows, agents, tools, etc.)
    ws/
      handler.ts          WebSocket message routing
      connection-manager.ts  Channel subscriptions + broadcast
  client/
    App.tsx               React SPA — sidebar + 8 panel routes
    lib/
      api.ts              Typed fetch wrappers for all endpoints
      ws.ts               WebSocket client with channel subscriptions
    panels/               One directory per panel
```

**Server:** Hono HTTP server wrapping the user's `AxlRuntime`. REST endpoints for CRUD, WebSocket for live streaming.

**Client:** React 19 SPA with Tailwind CSS v4, TanStack Query, and react-router-dom. Pre-built at publish time and served as static assets.

**CLI:** Auto-detects and loads the user's config via `tsx` (with ESM-forcing resolve hook for `.ts` files), validates the runtime, starts the server, and optionally opens the browser.

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
