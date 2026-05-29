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
import { validateEvalConfig } from './cli-validate.js';
import { parseEvalArgs, envInt } from './cli-args.js';

/** Install a SIGINT/SIGTERM handler that aborts an in-flight eval gracefully.
 *  First signal: aborts the controller so runEval / rescore propagate cancellation
 *  through ScorerContext.signal into in-flight provider.chat calls. The eval
 *  unwinds normally and runtime.shutdown() runs in the `finally` block.
 *  Second signal: hard exit — the user has signalled twice; cleanup is hung
 *  or taking too long, so we abandon gracefulness rather than appear frozen. */
function installAbortHandler(controller: AbortController): void {
  let signalled = false;
  const onSignal = (sig: NodeJS.Signals) => {
    if (signalled) {
      console.error(`\n[axl-eval] Second ${sig} — forcing exit.`);
      process.exit(130);
    }
    signalled = true;
    console.error(`\n[axl-eval] ${sig} received — cancelling eval (press again to force exit)...`);
    controller.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

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
  axl-eval <path> --concurrency <n>       Override item concurrency (flag > env
                                          AXL_EVAL_CONCURRENCY > config > 5).
                                          Max concurrent scorer calls is
                                          concurrency x scorerConcurrency (the
                                          per-eval scorerConcurrency defaults to 5).
  axl-eval <path> --scorers <a,b>         Run only the named scorers (single eval
                                          file only). Stamps the result as a
                                          subset so compare won't treat it as a
                                          full baseline.
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
    // `compare` is pure computation — no LLM calls, no AbortSignal plumbing needed.
    await runCompare(args.slice(1));
    return;
  }

  // SIGINT/SIGTERM aborts in-flight LLM calls (eval + rescore) instead of leaving
  // the process to hard-exit mid-request, which would skip runtime.shutdown() and
  // leak streaming-buffer state.
  const controller = new AbortController();
  installAbortHandler(controller);

  if (args[0] === 'rescore') {
    await runRescore(args.slice(1), controller.signal);
    return;
  }

  await runEvalCommand(args, controller.signal);
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

  // A scorer-filtered result (CLI `--scorers`) tested only a subset of scorers,
  // so it isn't a sound baseline/candidate for a full comparison. Warn loudly;
  // and when the run is being used to GATE CI (`--fail-on-regression`), refuse
  // outright — a swallowed stderr line wouldn't actually prevent the footgun.
  const filteredSides = (['baseline', 'candidate'] as const).filter(
    (side) => comparison[side].metadata?.scorerFiltered === true,
  );
  for (const side of filteredSides) {
    const ran = comparison[side].metadata?.scorersRun;
    const ranStr = Array.isArray(ran) ? ` (ran: ${(ran as string[]).join(', ')})` : '';
    console.error(
      `[axl-eval] WARNING: ${side} was run with a filtered scorer subset${ranStr} — this comparison is incomplete.`,
    );
  }
  if (failOnRegression && filteredSides.length > 0) {
    console.error(
      `[axl-eval] Refusing to gate on a scorer-filtered result (${filteredSides.join(', ')}); re-run without --scorers.`,
    );
    process.exit(1);
  }

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

async function runRescore(args: string[], signal: AbortSignal) {
  const { outputPath, configArg, conditions, concurrency, paths } = parseEvalArgs(args);

  if (paths.length < 2) {
    console.error('Usage: axl-eval rescore <results.json> <eval-file> [--output <file>]');
    process.exit(1);
  }

  // Honor the same item-concurrency override as the run command (flag > env).
  // scorerConcurrency keeps its rescore default (5).
  const itemConcurrency = concurrency ?? envInt('AXL_EVAL_CONCURRENCY');

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
      if (signal.aborted) break;
      rescored.push(
        await rescore(resultData, evalConfig.scorers, runtime, {
          signal,
          ...(itemConcurrency != null ? { concurrency: itemConcurrency } : {}),
        }),
      );
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

// ── Main eval command ──────────────────────────────────────────────

async function runEvalCommand(args: string[], signal: AbortSignal) {
  const {
    outputPath,
    configArg,
    conditions,
    runs,
    captureTraces,
    concurrency,
    scorerNames,
    paths,
  } = parseEvalArgs(args);

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
      // Short-circuit if the user aborted between eval files. The in-flight eval
      // unwinds on its own via runEval({ signal }); this prevents starting the next one.
      if (signal.aborted) break;
      try {
        const mod = await importModule(path.resolve(filePath), import.meta.url);
        const evalConfig = pickDefault<EvalConfig>(mod);

        const validationError = validateEvalConfig(evalConfig);
        if (validationError) {
          console.error(`Error: ${filePath} ${validationError}`);
          failedFiles++;
          continue;
        }

        // Concurrency override precedence: flag > env > config > default.
        // Mutating evalConfig in place mirrors how this loop already stamps
        // result.metadata. `concurrency` is pure scheduling — never changes
        // results — so a per-run override is always safe.
        evalConfig.concurrency =
          concurrency ?? envInt('AXL_EVAL_CONCURRENCY') ?? evalConfig.concurrency ?? 5;

        // --scorers: run a subset of scorers for a focused iteration loop.
        // Single-file only — filtering by name across a glob/dir of evals with
        // different scorer sets is ambiguous (a name present in one file and
        // absent in another). Validate-then-filter so the error lists every
        // available name.
        if (scorerNames?.length) {
          if (evalFiles.length > 1) {
            console.error('Error: --scorers requires a single eval file (got multiple).');
            process.exit(1);
          }
          const available = evalConfig.scorers.map((s) => s.name);
          const unknown = scorerNames.filter((n) => !available.includes(n));
          if (unknown.length) {
            console.error(
              `Error: --scorers: unknown scorer(s): ${unknown.join(', ')}. Available: ${available.join(', ')}`,
            );
            process.exit(1);
          }
          evalConfig.scorers = evalConfig.scorers.filter((s) => scorerNames.includes(s.name));
          if (evalConfig.scorers.length === 0) {
            console.error('Error: --scorers matched no scorers.');
            process.exit(1);
          }
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
          //
          // Surface what WAS exported (top-level + .default) so users
          // recognize a typo like `execute_workflow` and can spot the
          // CJS-interop case that motivates this whole code path: when tsx
          // loads a `.ts` file as CJS, all named exports land on
          // `mod.default.<name>`. The chain walk above already handled this,
          // but a user who removed `executeWorkflow` will see exactly what
          // export names ARE present.
          const exportShape = (() => {
            const top = Object.keys(mod).filter((k) => k !== 'default');
            const fromDefault =
              mod.default && typeof mod.default === 'object'
                ? Object.keys(mod.default as Record<string, unknown>)
                : [];
            const all = [...new Set([...top, ...fromDefault])];
            return all.length > 0 ? `Found exports: [${all.join(', ')}].` : '';
          })();
          console.error(
            `[axl-eval] Error: ${filePath} does not export an executeWorkflow function ` +
              `and no workflow named "${evalConfig.workflow}" is registered on the runtime.\n` +
              (exportShape ? `  ${exportShape}\n` : '') +
              `  Add either:\n` +
              `    export async function executeWorkflow(input, runtime) { ... }\n` +
              `  or register the workflow on your runtime via runtime.registerWorkflow(workflow).\n` +
              `  Tip: if your eval previously worked, your package.json may be missing\n` +
              `    "type": "module" — tsx loads .ts as CJS, putting named exports on\n` +
              `    mod.default.<name>. The CLI handles that interop, but if you renamed\n` +
              `    or removed the export the file path is your fix.`,
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
        // Always pass the SIGINT-driven signal so Ctrl+C aborts in-flight
        // workflows + scorer LLM calls instead of dropping the connection mid-request.
        const runOptions = { signal, ...(captureTraces ? { captureTraces: true } : {}) };

        // Stamp filtered runs so a scorer-subset result can't be silently used
        // as a full baseline. `compare` warns (and refuses to gate) on it. Must
        // be applied to EVERY run in a multi-run batch — Studio's multi-run
        // builder spreads only run[0]'s metadata.
        const scorersRun = scorerNames?.length ? evalConfig.scorers.map((s) => s.name) : undefined;
        const stampFiltered = (result: EvalResult) => {
          if (scorersRun) {
            result.metadata.scorerFiltered = true;
            result.metadata.scorersRun = scorersRun;
          }
        };

        if (runs > 1) {
          // Multi-run mode. Buffer per-run results locally so we can mark the
          // batch correctly before committing to outer `results[]`. The
          // original bug was the opposite: results pushed eagerly per-run, a
          // throw mid-batch left partial results posing as a complete run
          // (no `fromPartialBatch` marker, aggregate never ran). The fix ISN'T
          // to throw the partials away — those runs cost money and have
          // statistical signal. Instead we preserve them with explicit
          // partial-batch metadata, aggregate over what completed, and exit
          // non-zero so CI knows the batch wasn't clean.
          const { randomUUID } = await import('node:crypto');
          const runGroupId = randomUUID();
          const runResults: EvalResult[] = [];
          let runFailure: Error | undefined;

          for (let r = 0; r < runs; r++) {
            if (signal.aborted) break;
            console.error(`[axl-eval] Run ${r + 1}/${runs}...`);
            try {
              const result = await runEval(evalConfig, executeWorkflow, runtime, runOptions);
              result.metadata.runGroupId = runGroupId;
              result.metadata.runIndex = r;
              stampFiltered(result);
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
            //
            // The flag is `fromPartialBatch` — a per-run marker meaning
            // "this run came from a batch that did not complete." It is
            // NOT named `partialBatch` because that read as "this run is
            // partial," and a defensive consumer wrote
            // `if (run.metadata.partialBatch) skipThisRun()`, throwing
            // away successful work that cost real money. The flag describes
            // the BATCH the run belongs to, not the run itself.
            //
            // `runFailure?.message` can be empty (e.g. `new Error('')` from a
            // misbehaving provider); fall back to `String(runFailure)` so the
            // banner never renders a blank "Stopped after:" line. Skip the
            // field entirely if both are empty so `buildMultiRunResult`'s
            // empty-string filter doesn't have to defensively guess.
            const failureMsg = runFailure
              ? runFailure.message || String(runFailure) || undefined
              : undefined;
            for (const r of runResults) {
              r.metadata.fromPartialBatch = true;
              r.metadata.batchCompleted = runResults.length;
              r.metadata.batchAttempted = runs;
              if (failureMsg) r.metadata.batchFailure = failureMsg;
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
          stampFiltered(result);
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
