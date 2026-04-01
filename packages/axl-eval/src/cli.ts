#!/usr/bin/env node

import { readdirSync, statSync } from 'node:fs';
import { readFile as readFileAsync, writeFile as writeFileAsync, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import type { AxlRuntime } from '@axlsdk/axl';
import { evalCompare } from './compare.js';
import { runEval } from './runner.js';
import type { EvalConfig, EvalResult } from './types.js';
import {
  findConfig,
  resolveRuntime,
  importModule,
  registerConditions,
  CONFIG_CANDIDATES,
} from './cli-utils.js';

const KNOWN_FLAGS = new Set(['--output', '--config', '--conditions', '--fail-on-regression']);

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
Usage:
  axl-eval <path>                         Run eval file(s)
  axl-eval <path> --output <file>         Save results to JSON
  axl-eval <path> --config <file>         Use config file for runtime
  axl-eval <path> --conditions <list>     Node.js import conditions (comma-separated)
  axl-eval compare <a> <b>                Compare two eval result files
  axl-eval compare <a> <b> --fail-on-regression  Exit 1 if regressions

Config auto-detection (when --config is not specified):
  ${CONFIG_CANDIDATES.join(' -> ')}

When a config is found, the exported AxlRuntime is passed to executeWorkflow
and cost is tracked automatically via runtime.trackCost().
When no config is found, a bare AxlRuntime is created (providers from env vars).
`);
    process.exit(0);
  }

  if (args[0] === 'compare') {
    await runCompare(args.slice(1));
    return;
  }

  await runEvalCommand(args);
}

async function runCompare(args: string[]) {
  const failOnRegression = args.includes('--fail-on-regression');
  const files = args.filter((a) => !a.startsWith('--'));

  if (files.length !== 2) {
    console.error('Usage: axl-eval compare <baseline.json> <candidate.json>');
    process.exit(1);
  }

  const baseline: EvalResult = JSON.parse(await readFileAsync(files[0], 'utf-8'));
  const candidate: EvalResult = JSON.parse(await readFileAsync(files[1], 'utf-8'));
  const comparison = evalCompare(baseline, candidate);

  console.log(
    `\nCompare: baseline (${comparison.baseline.id.slice(0, 8)}) -> candidate (${comparison.candidate.id.slice(0, 8)})\n`,
  );

  const scorerNames = Object.keys(comparison.scorers);
  const maxNameLen = Math.max(...scorerNames.map((n) => n.length), 6);

  console.log(`  ${'Scorer'.padEnd(maxNameLen)}  Baseline  Candidate  Delta     Change`);
  console.log(`  ${''.padEnd(maxNameLen, '-')}  --------  ---------  --------  ------`);

  for (const name of scorerNames) {
    const s = comparison.scorers[name];
    const sign = s.delta > 0 ? '+' : '';
    console.log(
      `  ${name.padEnd(maxNameLen)}  ${s.baselineMean.toFixed(3).padStart(8)}  ${s.candidateMean.toFixed(3).padStart(9)}  ${(sign + s.delta.toFixed(3)).padStart(8)}  ${(sign + s.deltaPercent.toFixed(1) + '%').padStart(6)}`,
    );
  }

  const stable = Math.max(
    0,
    baseline.items.length - comparison.regressions.length - comparison.improvements.length,
  );
  console.log(
    `\n  Regressions: ${comparison.regressions.length} | Improvements: ${comparison.improvements.length} | Stable: ${stable}\n`,
  );

  if (failOnRegression && comparison.regressions.length > 0) {
    process.exit(1);
  }
}

function collectEvalFiles(p: string): string[] {
  const resolved = path.resolve(p);
  try {
    const stat = statSync(resolved);
    if (stat.isDirectory()) {
      const entries = readdirSync(resolved);
      return entries
        .filter((e) => /\.eval\.[mc]?[jt]sx?$/.test(e))
        .map((e) => path.join(resolved, e));
    }
    return [resolved];
  } catch {
    return [resolved];
  }
}

function formatTable(result: EvalResult): string {
  const lines: string[] = [];
  const scorerNames = Object.keys(result.summary.scorers);
  const maxNameLen = Math.max(...scorerNames.map((n) => n.length), 'Scorer'.length);
  const colWidth = 8;

  lines.push(`Eval: ${result.workflow} x ${result.dataset} (${result.summary.count} items)`);
  lines.push(
    `  ${'Scorer'.padEnd(maxNameLen)}  ${'Mean'.padStart(colWidth)}  ${'Min'.padStart(colWidth)}  ${'Max'.padStart(colWidth)}  ${'p50'.padStart(colWidth)}  ${'p95'.padStart(colWidth)}`,
  );

  const ruleLen = maxNameLen + 2 + (colWidth + 2) * 5;
  lines.push('  ' + '\u2500'.repeat(ruleLen));

  for (const name of scorerNames) {
    const s = result.summary.scorers[name];
    // Detect scorers with no valid scores (all items errored → computeStats([]) → all zeros)
    const validScoreCount = result.items.filter((i) => !i.error && i.scores[name] != null).length;
    if (validScoreCount === 0) {
      lines.push(
        `  ${name.padEnd(maxNameLen)}  ${'--'.padStart(colWidth)}  ${'--'.padStart(colWidth)}  ${'--'.padStart(colWidth)}  ${'--'.padStart(colWidth)}  ${'--'.padStart(colWidth)}`,
      );
    } else {
      lines.push(
        `  ${name.padEnd(maxNameLen)}  ${s.mean.toFixed(2).padStart(colWidth)}  ${s.min.toFixed(2).padStart(colWidth)}  ${s.max.toFixed(2).padStart(colWidth)}  ${s.p50.toFixed(2).padStart(colWidth)}  ${s.p95.toFixed(2).padStart(colWidth)}`,
      );
    }
  }

  const durationSec = (result.duration / 1000).toFixed(1);
  const costStr = result.totalCost > 0 ? `$${result.totalCost.toFixed(2)}` : '$0.00';
  lines.push('');
  lines.push(
    `  Failures: ${result.summary.failures}/${result.summary.count} | Cost: ${costStr} | Duration: ${durationSec}s`,
  );

  const itemsWithErrors = result.items.filter((i) => i.scorerErrors?.length);
  if (itemsWithErrors.length > 0) {
    const uniqueErrors = [...new Set(itemsWithErrors.flatMap((i) => i.scorerErrors!))];
    lines.push('');
    lines.push(
      `  Scorer errors (${itemsWithErrors.length}/${result.summary.count} items affected):`,
    );
    for (const err of uniqueErrors.slice(0, 5)) {
      lines.push(`    - ${err}`);
    }
    if (uniqueErrors.length > 5) {
      lines.push(`    ... and ${uniqueErrors.length - 5} more`);
    }
  }

  return lines.join('\n');
}

// ── Runtime resolution ─────────────────────────────────────────────

async function resolveRuntimeFromConfig(configPath: string): Promise<AxlRuntime> {
  try {
    const mod = await importModule(configPath, import.meta.url);
    const runtime = resolveRuntime(mod) as AxlRuntime;

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

    return runtime;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      /Cannot use import statement|Unexpected reserved word|top-level await|exports is not defined/.test(
        msg,
      )
    ) {
      const ext = path.extname(configPath);
      console.error(`[axl-eval] Config failed to load due to a CJS/ESM compatibility issue.`);
      if (ext === '.ts' || ext === '.tsx') {
        console.error(
          `  Tip: try renaming to .mts to force ESM format, or ensure tsx is installed and up to date.`,
        );
      } else {
        console.error(`  Tip: add "type": "module" to your package.json.`);
      }
      console.error();
    }
    console.error(`Failed to load config:`, err);
    process.exit(1);
  }
}

async function getRuntime(configArg?: string, conditions?: string[]): Promise<AxlRuntime> {
  // Register import conditions before any config loading
  if (conditions && conditions.length > 0) {
    await registerConditions(conditions);
  }

  // 1. Explicit --config
  if (configArg) {
    const configPath = path.resolve(process.cwd(), configArg);
    const stat = statSync(configPath, { throwIfNoEntry: false });
    if (!stat?.isFile()) {
      console.error(`Config file not found: ${configPath}`);
      process.exit(1);
    }
    console.error(`[axl-eval] Loading config from ${configPath}`);
    return resolveRuntimeFromConfig(configPath);
  }

  // 2. Auto-detect
  const found = findConfig(process.cwd());
  if (found) {
    console.error(`[axl-eval] Auto-detected config: ${found}`);
    return resolveRuntimeFromConfig(found);
  }

  // 3. Bare runtime (providers from env vars)
  const { AxlRuntime } = await import('@axlsdk/axl');
  return new AxlRuntime();
}

// ── Arg parsing ────────────────────────────────────────────────────

function parseEvalArgs(args: string[]): {
  outputPath?: string;
  configArg?: string;
  conditions: string[];
  paths: string[];
} {
  let outputPath: string | undefined;
  let configArg: string | undefined;
  let conditions: string[] = [];
  const paths: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--output' || arg === '--config' || arg === '--conditions') {
      if (i + 1 >= args.length) {
        console.error(`Error: ${arg} requires a value`);
        process.exit(1);
      }
      const value = args[++i];
      if (arg === '--output') outputPath = value;
      else if (arg === '--config') configArg = value;
      else
        conditions = value
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean);
    } else if (arg.startsWith('--')) {
      if (!KNOWN_FLAGS.has(arg)) {
        console.error(`Unknown flag: ${arg}`);
        process.exit(1);
      }
    } else {
      paths.push(arg);
    }
  }

  return { outputPath, configArg, conditions, paths };
}

// ── Main eval command ──────────────────────────────────────────────

async function runEvalCommand(args: string[]) {
  const { outputPath, configArg, conditions, paths } = parseEvalArgs(args);

  if (paths.length === 0) {
    console.error('Error: No eval file path provided');
    process.exit(1);
  }

  const evalFiles: string[] = [];
  for (const p of paths) {
    evalFiles.push(...collectEvalFiles(p));
  }

  if (evalFiles.length === 0) {
    console.error('Error: No eval files found');
    process.exit(1);
  }

  const runtime = await getRuntime(configArg, conditions);
  const results: EvalResult[] = [];

  try {
    for (const filePath of evalFiles) {
      try {
        const mod = await importModule(path.resolve(filePath), import.meta.url);
        const evalConfig: EvalConfig = mod.default?.default ?? mod.default ?? mod.config ?? mod;

        if (!evalConfig.workflow || !evalConfig.dataset || !evalConfig.scorers) {
          console.error(
            `Error: ${filePath} does not export a valid eval config (missing workflow, dataset, or scorers)`,
          );
          continue;
        }

        // Resolve executeWorkflow: custom export > registered workflow > passthrough
        let executeWorkflow: (
          input: unknown,
          rt?: unknown,
        ) => Promise<{ output: unknown; cost?: number }>;

        if (mod.executeWorkflow) {
          // Wrap custom executeWorkflow with trackCost for automatic cost attribution
          executeWorkflow = async (input, rt) => {
            const { result, cost: trackedCost } = await runtime.trackCost(async () => {
              return mod.executeWorkflow(input, rt);
            });
            return { output: result.output, cost: result.cost ?? trackedCost };
          };
        } else if (runtime.getWorkflow(evalConfig.workflow)) {
          // No executeWorkflow exported but workflow is registered — use runtime.execute()
          executeWorkflow = async (input) => {
            const { result, cost } = await runtime.trackCost(async () => {
              return runtime.execute(evalConfig.workflow, input);
            });
            return { output: result, cost };
          };
        } else {
          console.warn(
            `[axl-eval] Warning: ${filePath} does not export executeWorkflow — using input passthrough`,
          );
          executeWorkflow = async (input) => ({ output: input });
        }

        const result = await runEval(evalConfig, executeWorkflow, runtime);
        results.push(result);

        console.log('\n' + formatTable(result) + '\n');
      } catch (err) {
        console.error(
          `Error running eval ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (outputPath && results.length > 0) {
      const output = results.length === 1 ? results[0] : results;
      const outputDir = path.dirname(path.resolve(outputPath));
      await mkdir(outputDir, { recursive: true });
      await writeFileAsync(outputPath, JSON.stringify(output, null, 2), 'utf-8');
      console.log(`Results saved to ${outputPath}`);
    }
  } finally {
    await runtime.shutdown().catch(() => {});
  }

  // Exit with non-zero code if no evals succeeded
  if (results.length === 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
