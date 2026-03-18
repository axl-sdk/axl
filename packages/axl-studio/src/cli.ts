#!/usr/bin/env node
import { resolve, extname } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { createServer } from './server/index.js';
import { resolveRuntime } from './resolve-runtime.js';
import {
  parseArgs,
  findConfig,
  needsEsmForcing,
  needsTsxLoader,
  CONFIG_CANDIDATES,
} from './cli-utils.js';

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  // Resolve config path: explicit --config or auto-detect
  let configPath: string;
  if (args.config) {
    configPath = resolve(process.cwd(), args.config);
    if (!existsSync(configPath)) {
      console.error(`Config file not found: ${configPath}`);
      process.exit(1);
    }
  } else {
    const found = findConfig(process.cwd());
    if (!found) {
      console.error(`No config file found. Searched for: ${CONFIG_CANDIDATES.join(', ')}`);
      console.error(`Create an axl.config.mts that exports a default AxlRuntime instance.`);
      process.exit(1);
    }
    configPath = found;
  }

  // Register tsx as a TypeScript loader so .ts config files can be imported.
  // Both ESM and CJS hooks are needed: if the config's nearest package.json
  // lacks "type": "module", Node routes the import through CJS where the ESM
  // hook alone can't intercept .ts resolution.
  if (needsTsxLoader(configPath)) {
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

  // Force ESM format for .ts/.tsx config files so top-level await works
  // regardless of the nearest package.json "type" field. Without this,
  // tsx decides CJS vs ESM based on package.json — CJS doesn't support
  // top-level await. We register a resolve hook after tsx that overrides
  // the format for the config file specifically.
  // .mts/.cts have explicit format built into their extension; .mjs/.cjs
  // are plain JS with explicit format. Only .ts/.tsx are ambiguous.
  if (needsEsmForcing(configPath)) {
    try {
      const nodeModule = await import('node:module');
      const configUrl = pathToFileURL(configPath).href;
      const hookCode = [
        `export async function resolve(specifier, context, nextResolve) {`,
        `  const result = await nextResolve(specifier, context);`,
        `  if (result.url === ${JSON.stringify(configUrl)}) result.format = 'module';`,
        `  return result;`,
        `}`,
      ].join('\n');
      nodeModule.register(`data:text/javascript,${encodeURIComponent(hookCode)}`);
    } catch {
      // module.register() not available (Node < 20.6) — fall through,
      // error handler below will suggest .mts if loading fails
    }
  }

  // Register custom import conditions (e.g., --conditions development).
  // In monorepos, package.json "exports" often use the "development" condition
  // to point at source (.ts) instead of built dist. Without this, Studio
  // configs that import workspace packages resolve to dist files, which may
  // not exist or be stale.
  if (args.conditions.length > 0) {
    try {
      const nodeModule = await import('node:module');
      const hookCode = [
        `const extra = ${JSON.stringify(args.conditions)};`,
        `export async function resolve(specifier, context, nextResolve) {`,
        `  return nextResolve(specifier, {`,
        `    ...context,`,
        `    conditions: [...new Set([...context.conditions, ...extra])],`,
        `  });`,
        `}`,
      ].join('\n');
      nodeModule.register(`data:text/javascript,${encodeURIComponent(hookCode)}`);
    } catch {
      console.warn(`[axl-studio] Warning: --conditions requires Node.js 20.6+`);
    }
  }

  console.log(`[axl-studio] Loading config from ${configPath}`);

  // Import the user's config
  let runtime: import('@axlsdk/axl').AxlRuntime;
  const ext = extname(configPath);
  try {
    const mod = await import(pathToFileURL(configPath).href);
    // resolveRuntime handles ESM default, CJS-to-ESM interop, and named exports
    runtime = resolveRuntime(mod) as typeof runtime;

    if (!runtime || typeof runtime.execute !== 'function') {
      console.error(`Config must export a default AxlRuntime instance.`);
      if (runtime) {
        const keys = Object.keys(runtime as object)
          .slice(0, 5)
          .join(', ');
        console.error(`  Got: ${typeof runtime}${keys ? ` with keys: { ${keys} }` : ''}`);
      }
      console.error(
        `Example:\n  import { AxlRuntime } from '@axlsdk/axl';\n  export default new AxlRuntime({ ... });`,
      );
      process.exit(1);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      /Cannot use import statement|Unexpected reserved word|top-level await|exports is not defined/.test(
        msg,
      )
    ) {
      console.error(`[axl-studio] Config failed to load due to a CJS/ESM compatibility issue.`);
      if (ext === '.ts' || ext === '.tsx') {
        const mtsPath = configPath.slice(0, -ext.length) + '.mts';
        console.error(
          `  Tip: rename to .mts to force ESM format:\n` + `    mv ${configPath} ${mtsPath}`,
        );
      } else {
        console.error(`  Tip: add "type": "module" to your package.json.`);
      }
      console.error();
    }
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
