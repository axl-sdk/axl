#!/usr/bin/env node

import { readdirSync, statSync } from 'node:fs';
import { readFile as readFileAsync, writeFile as writeFileAsync, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { evalCompare } from './compare.js';
import { runEval } from './runner.js';
import type { EvalConfig, EvalResult } from './types.js';

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log(`
Usage:
  npx axl eval <path>              Run eval file(s)
  npx axl eval <path> --output <f> Run eval and save results to JSON
  npx axl eval compare <a> <b>     Compare two eval result files
  npx axl eval compare <a> <b> --fail-on-regression  Exit 1 if regressions
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
    console.error('Usage: npx axl eval compare <baseline.json> <candidate.json>');
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
        .filter((e) => e.endsWith('.eval.ts') || e.endsWith('.eval.js'))
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
    lines.push(
      `  ${name.padEnd(maxNameLen)}  ${s.mean.toFixed(2).padStart(colWidth)}  ${s.min.toFixed(2).padStart(colWidth)}  ${s.max.toFixed(2).padStart(colWidth)}  ${s.p50.toFixed(2).padStart(colWidth)}  ${s.p95.toFixed(2).padStart(colWidth)}`,
    );
  }

  const durationSec = (result.duration / 1000).toFixed(1);
  const costStr = result.totalCost > 0 ? `$${result.totalCost.toFixed(2)}` : '$0.00';
  lines.push('');
  lines.push(
    `  Failures: ${result.summary.failures}/${result.summary.count} | Cost: ${costStr} | Duration: ${durationSec}s`,
  );

  return lines.join('\n');
}

async function runEvalCommand(args: string[]) {
  let outputPath: string | undefined;
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && i + 1 < args.length) {
      outputPath = args[++i];
    } else if (!args[i].startsWith('--')) {
      paths.push(args[i]);
    }
  }

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

  const results: EvalResult[] = [];

  for (const filePath of evalFiles) {
    try {
      const mod = await import(path.resolve(filePath));
      const evalConfig: EvalConfig = mod.default ?? mod.config ?? mod;

      if (!evalConfig.workflow || !evalConfig.dataset || !evalConfig.scorers) {
        console.error(
          `Error: ${filePath} does not export a valid eval config (missing workflow, dataset, or scorers)`,
        );
        continue;
      }

      const executeWorkflow =
        mod.executeWorkflow ?? (async (input: unknown) => ({ output: input }));

      const result = await runEval(evalConfig, executeWorkflow, mod.provider);
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
    // Ensure output directory exists
    const outputDir = path.dirname(path.resolve(outputPath));
    await mkdir(outputDir, { recursive: true });
    await writeFileAsync(outputPath, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`Results saved to ${outputPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
