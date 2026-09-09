/**
 * `axl-eval --budget` end to end: what the process prints and what it exits
 * with (matrix A15.5–A15.7, A16.10(d), A16.11).
 *
 * These drive the real binary, because the thing under test IS the process exit
 * code — the layer no unit test over the formatters can reach. A budget stop
 * must fail the build with a distinct, greppable line; a run that merely
 * finished on its limit must not.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../../..');
const CLI = join(ROOT, 'packages/axl-eval/dist/cli.js');

/**
 * Fixtures live INSIDE the repo, not in the OS temp dir: the eval file imports
 * `@axlsdk/axl`, and Node resolves that by walking up to a `node_modules`. A
 * fixture under `/tmp` has none above it and fails to load before the CLI can
 * do anything interesting.
 */
function tempDir(prefix: string): string {
  return mkdtempSync(join(ROOT, 'tests/e2e', `.tmp-${prefix}-`));
}

/**
 * A self-contained eval file whose workflow makes one PAID provider call per
 * item, so a budget has something real to close on. The provider is registered
 * on the runtime the CLI hands to `executeWorkflow`, which is how an eval file
 * gets measured spend without a config file or an API key.
 */
function writeEvalFile(dir: string, options: { items: number; cost: number }): string {
  const file = join(dir, 'budget.eval.mjs');
  writeFileSync(
    file,
    `
import { agent } from '@axlsdk/axl';

const fixture = agent({ name: 'fixture', model: 'mock:m', system: 'fixture' });
let registered = false;

export default {
  workflow: 'budget-cli',
  dataset: {
    name: 'budget-ds',
    getItems: async () => Array.from({ length: ${options.items} }, (_, i) => ({
      input: { q: 'q' + i },
    })),
  },
  concurrency: 1,
  scorers: [{ name: 'pass', score: () => 1 }],
};

export async function executeWorkflow(input, runtime) {
  if (!registered) {
    runtime.registerProvider('mock', {
      name: 'mock',
      chat: async () => ({
        content: 'ok',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        cost: ${options.cost},
      }),
    });
    registered = true;
  }
  const ctx = runtime.createContext();
  await ctx.ask(fixture, 'go');
  return { output: 'result for ' + input.q };
}
`,
  );
  return file;
}

type Run = { status: number; stdout: string; stderr: string };

/** Run the CLI, capturing the exit code rather than throwing on non-zero. */
function runCli(args: string[]): Run {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf-8',
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AXL_DEFAULT_PROVIDER: 'mock' },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('axl-eval --budget (CLI)', () => {
  it('exits 1 with a distinct BUDGET STOPPED line when the budget refused work', () => {
    // 3 items at $0.50 under a $1 budget: two run, the third never starts.
    const dir = tempDir('axl-eval-budget');
    try {
      const file = writeEvalFile(dir, { items: 3, cost: 0.5 });
      const run = runCli([file, '--budget', '$1']);

      expect(run.status).toBe(1);
      // Distinct and greppable: a CI log scanner keys on this prefix, and it
      // must not be confused with a model or scorer failure.
      expect(run.stderr).toContain('[axl-eval] BUDGET STOPPED:');
      expect(run.stderr).toContain('NOT a model or scorer failure');
      expect(run.stderr).toContain('1 case(s) never started');
      // The table still reports what WAS measured.
      expect(run.stdout).toContain('Cost: $1.00');
      expect(run.stdout).toContain('Budget: STOPPED');
      expect(run.stdout).toContain('budget-skipped');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 0 when spend lands exactly on the limit with everything completed', () => {
    // The H1 regression: `--budget` set to a run's expected spend is the
    // obvious CI usage, and it closes the controller with nothing refused.
    // Failing that build would make the feature unusable for its main purpose.
    const dir = tempDir('axl-eval-budget-exact');
    try {
      const file = writeEvalFile(dir, { items: 2, cost: 0.5 });
      const run = runCli([file, '--budget', '$1']);

      expect(run.status).toBe(0);
      expect(run.stderr).not.toContain('BUDGET STOPPED');
      // The informational row still shows the budget closed — that is honest,
      // it just does not gate the exit code.
      expect(run.stdout).toContain('Budget: STOPPED');
      expect(run.stdout).toContain('Cost: $1.00');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies the budget PER RUN under --runs, not across the batch', () => {
    // A shared budget would let run 1 consume the whole limit and leave run 2
    // with nothing, making a multi-run batch report a fake regression.
    const dir = tempDir('axl-eval-budget-runs');
    try {
      const file = writeEvalFile(dir, { items: 2, cost: 0.5 });
      const output = join(dir, 'runs.json');
      const run = runCli([file, '--runs', '2', '--budget', '$1', '--output', output]);

      expect(run.status).toBe(0);
      const results = JSON.parse(readFileSync(output, 'utf-8')) as {
        accounting: { knownCost: number; budget: { limit: number; knownSpend: number } };
        summary: { coverage: { items: { completed: number } } };
      }[];
      expect(results).toHaveLength(2);
      for (const r of results) {
        // Each run got its OWN $1 and spent its own $1 — not $1 between them.
        expect(r.accounting.budget.limit).toBe(1);
        expect(r.accounting.budget.knownSpend).toBeCloseTo(1, 10);
        expect(r.accounting.knownCost).toBeCloseTo(1, 10);
        expect(r.summary.coverage.items.completed).toBe(2);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("overrides the eval file's own budget", () => {
    const dir = tempDir('axl-eval-budget-override');
    try {
      const file = join(dir, 'has-budget.eval.mjs');
      writeFileSync(
        file,
        readFileSync(writeEvalFile(dir, { items: 3, cost: 0.5 }), 'utf-8').replace(
          '  concurrency: 1,',
          "  concurrency: 1,\n  budget: '$100',",
        ),
      );

      // The file says $100; the flag says $1 and must win, so the run stops.
      const run = runCli([file, '--budget', '$1']);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('BUDGET STOPPED');
      expect(run.stdout).toContain('$1.00 limit');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unusable budget with a formatted line, before running anything', () => {
    const dir = tempDir('axl-eval-budget-invalid');
    try {
      const file = writeEvalFile(dir, { items: 3, cost: 0.5 });
      const run = runCli([file, '--budget', 'free']);

      expect(run.status).toBe(1);
      // The message names the offending value and the accepted syntax rather
      // than failing somewhere downstream with a NaN limit.
      expect(run.stderr).toContain('Invalid budget "free"');
      expect(run.stderr).toMatch(/\$1|0\.50/);
      // No table: validation happens before the dataset is even loaded.
      expect(run.stdout).not.toContain('Cost:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('axl-eval rescore --budget (CLI)', () => {
  /**
   * A judging fixture in two files: a config exporting a runtime with a priced
   * provider registered, and an eval file whose scorer is a real `llmScorer`.
   *
   * The config is what makes this work for RESCORE: `executeWorkflow` does not
   * run on a rescore, so a provider registered from inside it would never
   * exist. The runtime the CLI resolves from `--config` is the one both
   * commands share — which is exactly how a user configures a judge model.
   */
  function writeJudgeFixture(dir: string, cost: number): { evalFile: string; config: string } {
    const config = join(dir, 'axl.config.mjs');
    writeFileSync(
      config,
      `
import { AxlRuntime } from '@axlsdk/axl';

const runtime = new AxlRuntime({ defaultProvider: 'mock', trace: { enabled: false } });
runtime.registerProvider('mock', {
  name: 'mock',
  chat: async () => ({
    content: JSON.stringify({ score: 1, reasoning: 'ok' }),
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    cost: ${cost},
  }),
});

export default runtime;
`,
    );

    const evalFile = join(dir, 'judge.eval.mjs');
    writeFileSync(
      evalFile,
      `
import { llmScorer } from '@axlsdk/eval';
import { z } from 'zod';

export default {
  workflow: 'rescore-cli',
  dataset: {
    name: 'rescore-ds',
    getItems: async () => [{ input: { q: 'a' } }, { input: { q: 'b' } }, { input: { q: 'c' } }],
  },
  concurrency: 1,
  scorerConcurrency: 1,
  scorers: [
    llmScorer({
      name: 'judge',
      description: 'judge',
      model: 'mock:m',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    }),
  ],
};

export async function executeWorkflow(input) {
  return { output: 'out for ' + input.q };
}
`,
    );
    return { evalFile, config };
  }

  it('exits 1 with a BUDGET STOPPED line when the judging budget refused work', () => {
    // The M1 regression: rescore threaded `--budget` through but never reported
    // the stop, so CI recorded a green rescore that scored nothing.
    const dir = tempDir('axl-eval-rescore-budget');
    try {
      const { evalFile, config } = writeJudgeFixture(dir, 0.6);
      const resultsPath = join(dir, 'results.json');

      // First produce a real artifact (no budget), then rescore it under one.
      const first = runCli([evalFile, '--config', config, '--output', resultsPath]);
      expect(first.status).toBe(0);

      const rescored = join(dir, 'rescored.json');
      const run = runCli([
        'rescore',
        resultsPath,
        evalFile,
        '--config',
        config,
        '--budget',
        '$1',
        '--output',
        rescored,
        '--concurrency',
        '1',
      ]);

      expect(run.status).toBe(1);
      expect(run.stderr).toContain('[axl-eval] BUDGET STOPPED:');
      expect(run.stderr).toContain('NOT a model or scorer failure');

      // The partial artifact is still written — the scores that WERE produced
      // are worth keeping, and the exit code is what fails the build.
      const artifact = JSON.parse(readFileSync(rescored, 'utf-8')) as {
        accounting: { scope: string; budget: { status: string } };
        items: { scoreDetails: Record<string, { outcome: string }> }[];
      };
      expect(artifact.accounting.scope).toBe('rescore');
      expect(artifact.accounting.budget.status).toBe('closed');
      expect(artifact.items.map((i) => i.scoreDetails.judge.outcome)).toEqual([
        'scored',
        'scored',
        'budget_skipped',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 0 when the rescore stayed inside its budget', () => {
    const dir = tempDir('axl-eval-rescore-ok');
    try {
      const { evalFile, config } = writeJudgeFixture(dir, 0.1);
      const resultsPath = join(dir, 'results.json');
      expect(runCli([evalFile, '--config', config, '--output', resultsPath]).status).toBe(0);

      const run = runCli(['rescore', resultsPath, evalFile, '--config', config, '--budget', '$10']);
      expect(run.status).toBe(0);
      expect(run.stderr).not.toContain('BUDGET STOPPED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unusable rescore budget with a formatted line, not a stack trace', () => {
    const dir = tempDir('axl-eval-rescore-invalid');
    try {
      const { evalFile, config } = writeJudgeFixture(dir, 0.1);
      const resultsPath = join(dir, 'results.json');
      expect(runCli([evalFile, '--config', config, '--output', resultsPath]).status).toBe(0);

      const run = runCli([
        'rescore',
        resultsPath,
        evalFile,
        '--config',
        config,
        '--budget',
        '$1,000',
      ]);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('[axl-eval]');
      expect(run.stderr).not.toContain('at Object.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CLI accounting parity (A16.10d)', () => {
  it('reports the same measured spend through the CLI as through runEval', async () => {
    const dir = tempDir('axl-eval-parity');
    try {
      const file = writeEvalFile(dir, { items: 2, cost: 0.25 });
      const output = join(dir, 'cli.json');
      const run = runCli([file, '--output', output]);
      expect(run.status).toBe(0);

      const artifact = JSON.parse(readFileSync(output, 'utf-8')) as {
        totalCost: number;
        unpriced?: boolean;
        accounting: {
          knownCost: number;
          completeness: string;
          breakdown: { generation: number; judging: number };
        };
        items: { cost: number; outcome: string }[];
      };

      // The same identities the in-process entry points hold.
      expect(artifact.totalCost).toBeCloseTo(0.5, 10);
      expect(artifact.accounting.knownCost).toBeCloseTo(0.5, 10);
      expect(artifact.accounting.completeness).toBe('complete');
      expect(artifact.unpriced).toBeUndefined();
      expect(artifact.accounting.breakdown.generation).toBeCloseTo(0.5, 10);
      expect(artifact.accounting.breakdown.judging).toBe(0);
      expect(artifact.items.map((i) => i.outcome)).toEqual(['completed', 'completed']);
      expect(artifact.items.every((i) => i.cost === 0.25)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
