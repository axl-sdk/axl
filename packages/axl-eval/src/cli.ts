#!/usr/bin/env node

import { readdirSync, statSync } from 'node:fs';
import { readFile as readFileAsync, writeFile as writeFileAsync, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import type { AxlRuntime, EvalExecuteWorkflow } from '@axlsdk/axl';
import { evalCompare } from './compare.js';
import { runEval } from './runner.js';
import { rescore } from './rescore.js';
import { aggregateRuns } from './multi-run.js';
import type { MultiRunSummary } from './multi-run.js';
import type { EvalConfig, EvalResult } from './types.js';
import {
  findConfig,
  resolveRuntime,
  importModule,
  registerConditions,
  pickDefault,
  pickExport,
  expandGlob,
  CONFIG_CANDIDATES,
} from './cli-utils.js';

/**
 * Validate an eval config's required fields and produce a diagnostic string
 * if invalid. Returns `undefined` when the config passes.
 *
 * Returns a single-line message tail (caller prepends the file path) so the
 * full error reads like: `Error: <file> <message>`.
 *
 * Goes beyond a falsy check to catch (a) `scorers: []` which previously
 * silently ran with no scorers and (b) provide a `Got: { keys: [...] }`
 * hint so users can spot a typo like `scorerS` vs `scorers` immediately.
 */
function validateEvalConfig(cfg: unknown): string | undefined {
  if (!cfg || typeof cfg !== 'object') {
    return `does not export a valid eval config — got ${cfg === null ? 'null' : typeof cfg}.`;
  }
  const c = cfg as Partial<EvalConfig>;
  const missing: string[] = [];
  if (!c.workflow) missing.push('workflow');
  if (!c.dataset) missing.push('dataset');
  if (!c.scorers) missing.push('scorers');
  else if (!Array.isArray(c.scorers) || c.scorers.length === 0) {
    return `exports an empty scorers array — at least one scorer is required.`;
  }
  if (missing.length > 0) {
    const keys = Object.keys(c as object).slice(0, 10);
    const got = keys.length > 0 ? ` Got: { ${keys.join(', ')} }.` : '';
    return `does not export a valid eval config (missing ${missing.join(', ')}).${got}`;
  }
  return undefined;
}

const KNOWN_FLAGS = new Set([
  '--output',
  '--config',
  '--conditions',
  '--fail-on-regression',
  '--threshold',
  '--runs',
  '--capture-traces',
]);

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
Usage:
  axl-eval <path>                         Run eval file(s)
  axl-eval <path> --runs <n>              Run eval N times (multi-run)
  axl-eval <path> --output <file>         Save results to JSON
  axl-eval <path> --config <file>         Use config file for runtime
  axl-eval <path> --conditions <list>     Node.js import conditions (comma-separated)
  axl-eval <path> --capture-traces        Populate EvalItem.traces on every item
                                          (success + failure). Adds memory
                                          overhead proportional to dataset size
                                          x turns x agents; off by default.
  axl-eval rescore <results> <eval-file>  Re-run scorers on saved outputs
  axl-eval compare <a> <b>                Compare two eval result files
  axl-eval compare <a> <b> --threshold <v>  Set regression threshold (global or per-scorer)
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

  if (args[0] === 'rescore') {
    await runRescore(args.slice(1));
    return;
  }

  await runEvalCommand(args);
}

function parseThresholdArg(args: string[]): Record<string, number> | number | undefined {
  const idx = args.indexOf('--threshold');
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const value = args[idx + 1];

  // Global numeric threshold: --threshold 0.05
  if (/^[\d.]+$/.test(value)) return parseFloat(value);

  // Per-scorer map: --threshold accuracy=0,tone=0.1
  const map: Record<string, number> = {};
  for (const pair of value.split(',')) {
    const [key, val] = pair.split('=');
    if (key && val != null) map[key.trim()] = parseFloat(val.trim());
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

async function runCompare(args: string[]) {
  const failOnRegression = args.includes('--fail-on-regression');
  const thresholds = parseThresholdArg(args);
  const files = args.filter(
    (a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--threshold'),
  );

  if (files.length !== 2) {
    console.error('Usage: axl-eval compare <baseline.json> <candidate.json> [--threshold <value>]');
    process.exit(1);
  }

  const baselineRaw = JSON.parse(await readFileAsync(files[0], 'utf-8'));
  const candidateRaw = JSON.parse(await readFileAsync(files[1], 'utf-8'));
  const baseline: EvalResult | EvalResult[] = baselineRaw;
  const candidate: EvalResult | EvalResult[] = candidateRaw;
  const compareOptions = thresholds != null ? { thresholds } : undefined;
  const comparison = evalCompare(baseline, candidate, compareOptions);

  console.log(
    `\nCompare: baseline (${comparison.baseline.id.slice(0, 8)}) -> candidate (${comparison.candidate.id.slice(0, 8)})\n`,
  );

  const scorerNames = Object.keys(comparison.scorers);
  const maxNameLen = Math.max(...scorerNames.map((n) => n.length), 6);
  const hasCI = scorerNames.some((n) => comparison.scorers[n].ci != null);

  const ciHeader = hasCI ? '  CI 95%            Sig' : '';
  const ciRule = hasCI ? '  ----------------  ---' : '';
  console.log(`  ${'Scorer'.padEnd(maxNameLen)}  Baseline  Candidate  Delta     Change${ciHeader}`);
  console.log(`  ${''.padEnd(maxNameLen, '-')}  --------  ---------  --------  ------${ciRule}`);

  for (const name of scorerNames) {
    const s = comparison.scorers[name];
    const sign = s.delta > 0 ? '+' : '';
    let line = `  ${name.padEnd(maxNameLen)}  ${s.baselineMean.toFixed(3).padStart(8)}  ${s.candidateMean.toFixed(3).padStart(9)}  ${(sign + s.delta.toFixed(3)).padStart(8)}  ${(sign + s.deltaPercent.toFixed(1) + '%').padStart(6)}`;
    if (hasCI) {
      if (s.ci) {
        const lo = (s.ci.lower >= 0 ? '+' : '') + s.ci.lower.toFixed(4);
        const hi = (s.ci.upper >= 0 ? '+' : '') + s.ci.upper.toFixed(4);
        const sig = s.significant ? '  *' : '   ';
        line += `  [${lo}, ${hi}]${sig}`;
      } else {
        line += '  —'.padEnd(22);
      }
    }
    console.log(line);
  }

  if (comparison.timing) {
    const t = comparison.timing;
    const sign = t.delta > 0 ? '+' : '';
    console.log(
      `\n  Timing: baseline ${(t.baselineMean / 1000).toFixed(2)}s -> candidate ${(t.candidateMean / 1000).toFixed(2)}s (${sign}${t.deltaPercent.toFixed(1)}%)`,
    );
  }
  if (comparison.cost) {
    const c = comparison.cost;
    const sign = c.delta > 0 ? '+' : '';
    console.log(
      `  Cost: baseline $${c.baselineTotal.toFixed(2)} -> candidate $${c.candidateTotal.toFixed(2)} (${sign}${c.deltaPercent.toFixed(1)}%)`,
    );
  }

  const baselineRef = Array.isArray(baseline) ? baseline[0] : baseline;
  const stable = Math.max(
    0,
    baselineRef.items.length - comparison.regressions.length - comparison.improvements.length,
  );
  console.log(
    `\n  Regressions: ${comparison.regressions.length} | Improvements: ${comparison.improvements.length} | Stable: ${stable}\n`,
  );

  if (failOnRegression && comparison.regressions.length > 0) {
    // When CI is available, only fail on significant regressions
    const hasSignificance = scorerNames.some((n) => comparison.scorers[n].significant != null);
    if (hasSignificance) {
      const hasSignificantRegression = scorerNames.some(
        (n) => comparison.scorers[n].significant === true && comparison.scorers[n].delta < 0,
      );
      if (hasSignificantRegression) process.exit(1);
    } else {
      process.exit(1);
    }
  }
}

async function runRescore(args: string[]) {
  const { outputPath, configArg, conditions, paths } = parseEvalArgs(args);

  if (paths.length < 2) {
    console.error('Usage: axl-eval rescore <results.json> <eval-file> [--output <file>]');
    process.exit(1);
  }

  const [resultsPath, evalFilePath] = paths;
  const raw = JSON.parse(await readFileAsync(resultsPath, 'utf-8'));
  const results: EvalResult[] = Array.isArray(raw) ? raw : [raw];

  const runtime = await getRuntime(configArg, conditions);
  try {
    const mod = await importModule(path.resolve(evalFilePath), import.meta.url);
    const evalConfig = pickDefault<EvalConfig>(mod);

    if (!evalConfig || typeof evalConfig !== 'object') {
      console.error(
        `Error: ${evalFilePath} does not export an eval config object — got ${evalConfig === null ? 'null' : typeof evalConfig}.`,
      );
      process.exit(1);
    }
    if (!Array.isArray(evalConfig.scorers) || evalConfig.scorers.length === 0) {
      console.error(`Error: ${evalFilePath} does not export a non-empty scorers array.`);
      process.exit(1);
    }

    const rescored: EvalResult[] = [];
    for (const resultData of results) {
      rescored.push(await rescore(resultData, evalConfig.scorers, runtime));
    }

    for (const r of rescored) {
      console.log('\n' + formatTable(r) + '\n');
    }

    if (outputPath) {
      const output = Array.isArray(raw) ? rescored : rescored[0];
      const outputDir = path.dirname(path.resolve(outputPath));
      await mkdir(outputDir, { recursive: true });
      await writeFileAsync(outputPath, JSON.stringify(output, null, 2), 'utf-8');
      console.log(`Rescored results saved to ${outputPath}`);
    }
  } finally {
    await runtime.shutdown().catch(() => {});
  }
}

/**
 * Resolve a CLI path argument into a list of eval files.
 *
 * Accepts:
 * - An explicit file path (`path/to/foo.eval.ts`)
 * - A directory (lists `*.eval.[mc]?[jt]sx?` inside, non-recursive)
 * - A glob pattern: `evals/*.eval.ts`, `evals/**\/*.eval.ts`, `**\/*.eval.ts`
 *
 * Glob expansion mirrors the studio eval-loader's so users get the same
 * behavior in both places. Without it, users running on Windows or with
 * quoted patterns hit confusing "file not found" errors when the shell
 * couldn't expand the glob.
 */
function collectEvalFiles(p: string): string[] {
  if (p.includes('*')) return expandGlob(p, process.cwd());
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

/** Render observed workflows for a terse header line. Multiple → comma-separated. */
function formatWorkflows(workflows: unknown): string {
  if (!Array.isArray(workflows) || workflows.length === 0) return '(unknown)';
  return (workflows as unknown[]).filter((w): w is string => typeof w === 'string').join(', ');
}

function formatTable(result: EvalResult): string {
  const lines: string[] = [];
  const scorerNames = Object.keys(result.summary.scorers);
  const maxNameLen = Math.max(...scorerNames.map((n) => n.length), 'Scorer'.length);
  const colWidth = 8;

  lines.push(
    `Eval: ${formatWorkflows(result.metadata.workflows)} x ${result.dataset} (${result.summary.count} items)`,
  );
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

  if (result.summary.timing) {
    const t = result.summary.timing;
    lines.push(
      `  ${'Timing'.padEnd(maxNameLen)}  ${(t.mean / 1000).toFixed(2).padStart(colWidth)}s ${(t.p50 / 1000).toFixed(2).padStart(colWidth)}s ${(t.p95 / 1000).toFixed(2).padStart(colWidth)}s`,
    );
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

function formatMultiRunTable(summary: MultiRunSummary): string {
  const lines: string[] = [];
  const scorerNames = Object.keys(summary.scorers);
  const maxNameLen = Math.max(...scorerNames.map((n) => n.length), 'Scorer'.length);
  const colWidth = 16;

  lines.push(
    `Eval: ${formatWorkflows(summary.workflows)} x ${summary.dataset} \u2014 ${summary.runCount} runs`,
  );
  lines.push(
    `  ${'Scorer'.padEnd(maxNameLen)}  ${'Mean \u00b1 Std'.padStart(colWidth)}  ${'Min'.padStart(8)}  ${'Max'.padStart(8)}`,
  );
  const ruleLen = maxNameLen + 2 + colWidth + 2 + 8 + 2 + 8;
  lines.push('  ' + '\u2500'.repeat(ruleLen));

  for (const name of scorerNames) {
    const s = summary.scorers[name];
    const meanStd = `${s.mean.toFixed(3)} \u00b1 ${s.std.toFixed(3)}`;
    lines.push(
      `  ${name.padEnd(maxNameLen)}  ${meanStd.padStart(colWidth)}  ${s.min.toFixed(3).padStart(8)}  ${s.max.toFixed(3).padStart(8)}`,
    );
  }

  if (summary.timing) {
    lines.push(
      `  ${'Timing'.padEnd(maxNameLen)}  ${((summary.timing.mean / 1000).toFixed(2) + ' \u00b1 ' + (summary.timing.std / 1000).toFixed(2) + 's').padStart(colWidth)}`,
    );
  }

  const costStr = summary.totalCost > 0 ? `$${summary.totalCost.toFixed(2)}` : '$0.00';
  const durationStr = (summary.totalDuration / 1000).toFixed(1);
  lines.push('');
  lines.push(`  Total Cost: ${costStr} | Total Duration: ${durationStr}s`);

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
  runs: number;
  captureTraces: boolean;
  paths: string[];
} {
  let outputPath: string | undefined;
  let configArg: string | undefined;
  let conditions: string[] = [];
  let runs = 1;
  let captureTraces = false;
  const paths: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--output' || arg === '--config' || arg === '--conditions' || arg === '--runs') {
      if (i + 1 >= args.length) {
        console.error(`Error: ${arg} requires a value`);
        process.exit(1);
      }
      const value = args[++i];
      if (arg === '--output') outputPath = value;
      else if (arg === '--config') configArg = value;
      else if (arg === '--runs') runs = Math.max(1, parseInt(value, 10) || 1);
      else
        conditions = value
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean);
    } else if (arg === '--capture-traces') {
      // Boolean flag — no value consumed.
      captureTraces = true;
    } else if (arg.startsWith('--')) {
      if (!KNOWN_FLAGS.has(arg)) {
        console.error(`Unknown flag: ${arg}`);
        process.exit(1);
      }
    } else {
      paths.push(arg);
    }
  }

  return { outputPath, configArg, conditions, runs, captureTraces, paths };
}

// ── Main eval command ──────────────────────────────────────────────

async function runEvalCommand(args: string[]) {
  const { outputPath, configArg, conditions, runs, captureTraces, paths } = parseEvalArgs(args);

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
  let failedFiles = 0;

  try {
    for (const filePath of evalFiles) {
      try {
        const mod = await importModule(path.resolve(filePath), import.meta.url);
        const evalConfig = pickDefault<EvalConfig>(mod);

        const validationError = validateEvalConfig(evalConfig);
        if (validationError) {
          console.error(`Error: ${filePath} ${validationError}`);
          failedFiles++;
          continue;
        }

        // Resolve executeWorkflow: custom export > registered workflow > error
        // Walk the ESM/CJS interop chain symmetrically with the default export
        // so named exports stay visible when tsx loads the eval module as CJS.
        const exported = pickExport<unknown>(mod, 'executeWorkflow');

        // Validate that the export, if present, is callable. Catches the
        // `export const executeWorkflow = 'foo'` typo at the boundary instead
        // of crashing deep inside trackExecution with a confusing stack.
        let customExecute: EvalExecuteWorkflow | undefined;
        if (typeof exported === 'function') {
          customExecute = exported as EvalExecuteWorkflow;
        } else if (exported !== undefined) {
          console.error(
            `[axl-eval] Error: ${filePath} exports executeWorkflow but it is ${typeof exported}, not a function.`,
          );
          failedFiles++;
          continue;
        }

        let executeWorkflow: EvalExecuteWorkflow;

        if (customExecute) {
          // Wrap custom executeWorkflow with trackExecution for cost + metadata attribution
          executeWorkflow = async (input, rt) => {
            const {
              result,
              cost: trackedCost,
              metadata,
            } = await runtime.trackExecution(async () => {
              return customExecute(input, rt);
            });
            return {
              output: result.output,
              cost: result.cost ?? trackedCost,
              metadata: result.metadata ?? metadata,
            };
          };
        } else if (runtime.getWorkflow(evalConfig.workflow)) {
          // No executeWorkflow exported but workflow is registered — use runtime.execute()
          executeWorkflow = async (input) => {
            const { result, cost, metadata } = await runtime.trackExecution(async () => {
              return runtime.execute(evalConfig.workflow, input);
            });
            return { output: result, cost, metadata };
          };
        } else {
          // Fail loudly. The previous identity-passthrough fallback silently
          // produced all-zero scores in CI — exactly the kind of footgun the
          // "fail loudly, not silently" rule is meant to prevent. If you
          // genuinely want identity, export it explicitly:
          //   export const executeWorkflow = async (input) => ({ output: input });
          console.error(
            `[axl-eval] Error: ${filePath} does not export an executeWorkflow function ` +
              `and no workflow named "${evalConfig.workflow}" is registered on the runtime.\n` +
              `  Add either:\n` +
              `    export async function executeWorkflow(input, runtime) { ... }\n` +
              `  or register the workflow on your runtime via runtime.registerWorkflow(workflow).`,
          );
          failedFiles++;
          continue;
        }

        // When --capture-traces is set, forward it to runEval so the runner
        // wraps each item's execution in a nested trackExecution({ captureTraces: true }).
        // This populates EvalItem.traces on both success (via tracked.traces)
        // and failure (via the axlCapturedTraces side-channel on the thrown
        // error). Nested trackExecution scopes walk the AsyncLocalStorage
        // parent chain, so the outer trackExecution above still observes
        // cost/metadata correctly.
        const runOptions = captureTraces ? { captureTraces: true } : undefined;

        if (runs > 1) {
          // Multi-run mode. Buffer per-run results locally so we can mark the
          // batch correctly before committing to outer `results[]`. The
          // original bug was the opposite: results pushed eagerly per-run, a
          // throw mid-batch left partial results posing as a complete run
          // (no `partialBatch` marker, aggregate never ran). The fix ISN'T
          // to throw the partials away — those runs cost money and have
          // statistical signal. Instead we preserve them with explicit
          // partial-batch metadata, aggregate over what completed, and exit
          // non-zero so CI knows the batch wasn't clean.
          const { randomUUID } = await import('node:crypto');
          const runGroupId = randomUUID();
          const runResults: EvalResult[] = [];
          let runFailure: Error | undefined;

          for (let r = 0; r < runs; r++) {
            console.error(`[axl-eval] Run ${r + 1}/${runs}...`);
            try {
              const result = await runEval(evalConfig, executeWorkflow, runtime, runOptions);
              result.metadata.runGroupId = runGroupId;
              result.metadata.runIndex = r;
              runResults.push(result);
            } catch (err) {
              runFailure = err instanceof Error ? err : new Error(String(err));
              console.error(`[axl-eval] Run ${r + 1}/${runs} failed: ${runFailure.message}`);
              // Stop attempting further runs — we don't know whether this is
              // transient (rate limit) or permanent (auth failure), and
              // burning more API calls speculatively is hostile. Preserve
              // what completed.
              break;
            }
          }

          if (runResults.length === 0) {
            // Nothing completed — surface as a per-file failure. No partial
            // artifact to write; the outer try/catch error message would
            // duplicate the "Run 1/N failed" line we already printed, so
            // increment and continue without re-throwing.
            console.error(
              `[axl-eval] Aborting ${filePath}: no runs completed (${runFailure?.message ?? 'unknown failure'}).`,
            );
            failedFiles++;
            continue;
          }

          const partial = runResults.length < runs;
          if (partial) {
            // Mark every completed run so any consumer reading
            // `result.metadata` sees the partial-batch context. `aggregateRuns`
            // computes statistics over `runResults.length`, which is the
            // honest sample size to report.
            for (const r of runResults) {
              r.metadata.partialBatch = true;
              r.metadata.batchCompleted = runResults.length;
              r.metadata.batchAttempted = runs;
              r.metadata.batchFailure = runFailure?.message;
            }
            console.error(
              `[axl-eval] PARTIAL: ${runResults.length} of ${runs} runs completed for ${filePath}.`,
            );
            failedFiles++;
          }

          const summary = aggregateRuns(runResults);
          console.log('\n' + formatMultiRunTable(summary) + '\n');
          for (const r of runResults) results.push(r);
        } else {
          const result = await runEval(evalConfig, executeWorkflow, runtime, runOptions);
          results.push(result);

          console.log('\n' + formatTable(result) + '\n');
        }
      } catch (err) {
        console.error(
          `Error running eval ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
        failedFiles++;
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

  // Exit non-zero if any eval file failed to load/run. Previously we only
  // exited non-zero when zero evals succeeded, which silently masked
  // misconfigured files in mixed-success runs (a CI footgun).
  if (failedFiles > 0 || results.length === 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
