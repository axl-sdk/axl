/**
 * Default dev runtime for `pnpm --filter @axlsdk/studio dev`.
 *
 * Composes a feature-complete demo runtime — every workflow, agent,
 * tool, and AxlEvent variant the Studio UI needs to render is
 * exercised by at least one fixture here. Anyone reviewing a release
 * should be able to start the dev server with this config and walk
 * through the smoke checklist without missing UI surface area.
 *
 * Env toggles:
 *
 *   AXL_DEV_REDACT=1   turn on `trace.redact` (verify scrubbing in Trace
 *                      Explorer, REST envelopes, WS broadcasts)
 *
 *   AXL_DEV_VERBOSE=1  turn on `trace.level: 'full'` (verbose
 *                      agent_call_end.data.messages snapshots — required
 *                      for the >64KB truncation-placeholder smoke check
 *                      on the verbose-demo-workflow)
 *
 * Personal overrides: drop an `axl.config.{ts,mts,mjs,js}` next to this
 * directory; the CLI auto-detects it before falling back to this entry.
 */
import { AxlRuntime, InMemoryVectorStore } from '@axlsdk/axl';
import { MockEmbedder } from './embedder.mjs';
import {
  realisticEchoProvider,
  jsonProvider,
  schemaRetryProvider,
  mockTaggedProvider,
} from './providers.mjs';
import {
  lookupTool,
  calculatorTool,
  searchTool,
} from './tools.mjs';
import { allAgents, callSubResearcherTool } from './agents.mjs';
import { allWorkflows } from './workflows.mjs';
import { registerEvals } from './evals.mjs';
import { seedHistorical, seedLive } from './seed.mjs';

const redactEnabled = process.env.AXL_DEV_REDACT === '1';
const verboseEnabled = process.env.AXL_DEV_VERBOSE === '1';

if (redactEnabled) {
  // eslint-disable-next-line no-console
  console.log('[axl-studio dev] AXL_DEV_REDACT=1 → trace.redact is ON');
}
if (verboseEnabled) {
  // eslint-disable-next-line no-console
  console.log(
    '[axl-studio dev] AXL_DEV_VERBOSE=1 → trace.level=full (run verbose-demo-workflow to see >64KB truncation)',
  );
}

const runtime = new AxlRuntime({
  // Memory is configured so the embedder cost-attribution path
  // (`memory_remember`/`memory_recall` events with `usage`) flows end-to-
  // end. Without this, the Cost Dashboard's "Memory (Embedder)" section
  // would never render.
  memory: {
    vectorStore: new InMemoryVectorStore(),
    embedder: new MockEmbedder(),
  },
  trace: {
    enabled: true,
    redact: redactEnabled,
    level: verboseEnabled ? 'full' : 'steps',
  },
});

// Providers.
runtime.registerProvider('mock', realisticEchoProvider);
runtime.registerProvider('mock-json', jsonProvider);
runtime.registerProvider('mock-schema-retry', schemaRetryProvider);
runtime.registerProvider('mock-tagged', mockTaggedProvider);

// Workflows + agents + tools.
for (const wf of allWorkflows) runtime.register(wf);
runtime.registerAgent(...allAgents);
runtime.registerTool(lookupTool, calculatorTool, searchTool, callSubResearcherTool);

// Evals.
registerEvals(runtime);

// Seed historical executions at module load so the aggregator rebuild
// on createServer() sees them. Top-level await on a module that's
// imported via tsImport / the CLI's loader is fine; `type: "module"`
// is set on the package and TS `module: "ESNext"` allows it.
await seedHistorical(runtime);

// Seed live workflows + sessions + eval cohorts after a short delay so
// the server has come up and the WS aggregators are listening.
setTimeout(() => {
  void seedLive(runtime);
}, 1000);

export default runtime;
