#!/usr/bin/env node
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { createServer } from './server/index.js';
import { resolveRuntime } from './resolve-runtime.js';

// ── Parse CLI args ──────────────────────────────────────────────────

function parseArgs(argv: string[]): { port: number; config: string; open: boolean } {
  let port = 4400;
  let config = './axl.config.ts';
  let open = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) {
      port = parseInt(argv[i + 1], 10);
      i++;
    } else if (arg === '--config' && argv[i + 1]) {
      config = argv[i + 1];
      i++;
    } else if (arg === '--open') {
      open = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Axl Studio — Local development UI for Axl agents and workflows

Usage:
  axl-studio [options]

Options:
  --port <number>    Server port (default: 4400)
  --config <path>    Path to axl.config.ts (default: ./axl.config.ts)
  --open             Auto-open browser
  -h, --help         Show this help message
`);
      process.exit(0);
    }
  }

  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${port}. Must be between 1 and 65535.`);
    process.exit(1);
  }

  return { port, config, open };
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const configPath = resolve(process.cwd(), args.config);

  if (!existsSync(configPath)) {
    console.error(`Config file not found: ${configPath}`);
    console.error(`Create an axl.config.ts that exports a default AxlRuntime instance.`);
    process.exit(1);
  }

  // Register tsx as a TypeScript loader so .ts config files can be imported.
  // Both ESM and CJS hooks are needed: if the config's nearest package.json
  // lacks "type": "module", Node routes the import through CJS where the ESM
  // hook alone can't intercept .ts resolution.
  if (/\.[mc]?tsx?$/.test(configPath)) {
    let tsxLoaded = false;
    try {
      const tsxEsm = await import('tsx/esm/api');
      tsxEsm.register();
      tsxLoaded = true;
    } catch {
      // ESM hook not available
    }
    try {
      const tsxCjs = await import('tsx/cjs/api');
      tsxCjs.register();
      tsxLoaded = true;
    } catch {
      // CJS hook not available
    }
    if (!tsxLoaded) {
      console.warn(
        `[axl-studio] Warning: tsx is not installed. TypeScript config files require tsx as a dependency.\n` +
          `  Install it with: npm install -D tsx`,
      );
    }
  }

  console.log(`[axl-studio] Loading config from ${configPath}`);

  // Import the user's config
  let runtime: import('@axlsdk/axl').AxlRuntime;
  try {
    const mod = await import(configPath);
    runtime = resolveRuntime(mod) as typeof runtime;

    if (!runtime || typeof runtime.execute !== 'function') {
      console.error(`Config must export a default AxlRuntime instance.`);
      console.error(
        `Example:\n  import { AxlRuntime } from '@axlsdk/axl';\n  export default new AxlRuntime({ ... });`,
      );
      process.exit(1);
    }
  } catch (err) {
    console.error(`Failed to load config:`, err);
    process.exit(1);
  }

  // Determine static root for pre-built SPA
  const staticRoot = resolve(import.meta.dirname ?? __dirname, 'client');
  const hasStaticAssets = existsSync(resolve(staticRoot, 'index.html'));

  const { app, createWsHandlers } = createServer({
    runtime,
    staticRoot: hasStaticAssets ? staticRoot : undefined,
  });

  // Set up WebSocket
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: undefined as never });
  const wsHandlers = createWsHandlers();
  app.get(
    '/ws',
    upgradeWebSocket(() => wsHandlers),
  );

  const server = serve(
    {
      fetch: app.fetch,
      port: args.port,
    },
    (info) => {
      console.log(`[axl-studio] Server running at http://localhost:${info.port}`);
      console.log(`[axl-studio] Workflows: ${runtime.getWorkflowNames().join(', ') || '(none)'}`);
      console.log(
        `[axl-studio] Agents: ${
          runtime
            .getAgents()
            .map((a) => a._name)
            .join(', ') || '(none)'
        }`,
      );
      console.log(
        `[axl-studio] Tools: ${
          runtime
            .getTools()
            .map((t) => t.name)
            .join(', ') || '(none)'
        }`,
      );

      if (!hasStaticAssets) {
        console.log(
          `[axl-studio] No pre-built UI found. Run 'pnpm build:client' or use Vite dev server on port 4401.`,
        );
      }
    },
  );

  injectWebSocket(server);

  // Auto-open browser
  if (args.open) {
    const url = `http://localhost:${args.port}`;
    const { exec } = await import('node:child_process');
    const cmd =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${cmd} ${url}`);
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[axl-studio] Shutting down...');
    await runtime.shutdown().catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[axl-studio] Fatal error:', err);
  process.exit(1);
});
