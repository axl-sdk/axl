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
