/**
 * `axl-eval` item coverage gate end to end (adaptive-rate-governance AC1, AC3,
 * AC5, AC6; matrix E-01, E-03c/d, E-05a/b, E-06).
 *
 * These drive the real binary, because the thing under test IS the process exit
 * code: a run that lost more than 5% of its items must fail the build by
 * default, name the rate, and still write its artifact.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../../..');
const CLI = join(ROOT, 'packages/axl-eval/dist/cli.js');

/** Inside the repo so the eval file can resolve `@axlsdk/axl` (see eval-cli-budget). */
function tempDir(prefix: string): string {
  return mkdtempSync(join(ROOT, 'tests/e2e', `.tmp-${prefix}-`));
}

/**
 * An eval of `items` items whose workflow throws a 429 `ProviderError` for the
 * global call indices listed in `failCalls` (0-based, counted across every run
 * of a `--runs` batch, with `concurrency: 1` so the order is the dataset order).
 */
function writeEvalFile(
  dir: string,
  options: { items: number; failCalls: number[]; failOnItemErrorRate?: number },
): string {
  const file = join(dir, 'gate.eval.mjs');
  writeFileSync(
    file,
    `
import { ProviderError } from '@axlsdk/axl';

const failCalls = new Set(${JSON.stringify(options.failCalls)});
let call = 0;

export default {
  workflow: 'gate-cli',
  dataset: {
    name: 'gate-ds',
    getItems: async () => Array.from({ length: ${options.items} }, (_, i) => ({ input: { i } })),
  },
  concurrency: 1,
  scorers: [{ name: 'pass', score: () => 1 }],
  ${options.failOnItemErrorRate !== undefined ? `failOnItemErrorRate: ${options.failOnItemErrorRate},` : ''}
};

export async function executeWorkflow(input) {
  const n = call++;
  if (failCalls.has(n)) {
    throw new ProviderError({ provider: 'openai', status: 429, retryable: true, message: 'Rate limit reached' });
  }
  return { output: 'ok ' + input.i };
}
`,
  );
  return file;
}

type Run = { status: number; stdout: string; stderr: string };

/** Run the CLI, capturing the exit code and BOTH streams (a warning on exit 0 matters). */
function runCli(args: string[]): Run {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8',
    cwd: ROOT,
    env: { ...process.env, AXL_DEFAULT_PROVIDER: 'mock' },
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

describe('axl-eval item error rate gate (CLI)', () => {
  it('fails a thinned run by default, names the rate, and still writes the artifact', () => {
    const dir = tempDir('item-gate-default');
    try {
      const file = writeEvalFile(dir, { items: 10, failCalls: [0, 1, 2] });
      const out = join(dir, 'result.json');
      const run = runCli([file, '--output', out]);

      expect(run.status).toBe(1);
      expect(run.stderr).toContain('[axl-eval] ITEM ERROR RATE EXCEEDED:');
      expect(run.stderr).toContain('3 of 10 attempted item(s) failed');
      expect(run.stderr).toContain('item error rate 30%');
      expect(run.stderr).toContain('over the 5% limit');
      // Gates govern the exit code, never persistence.
      expect(existsSync(out)).toBe(true);
      const artifact = JSON.parse(readFileSync(out, 'utf-8'));
      expect(artifact.summary.itemErrorRate).toEqual({
        failed: 3,
        attempted: 10,
        rate: 0.3,
        limit: 0.05,
        exceeded: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 0 at exactly the default limit (strict >)', () => {
    const dir = tempDir('item-gate-boundary');
    try {
      const file = writeEvalFile(dir, { items: 20, failCalls: [0] });
      const run = runCli([file]);

      expect(run.status).toBe(0);
      expect(run.stdout).toContain('item error rate 5% (limit 5%)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets --max-item-error-rate override the eval file in both directions', () => {
    const dir = tempDir('item-gate-override');
    try {
      // Config 0.5 would pass 30%; the flag tightens it to 2%.
      const loose = writeEvalFile(dir, {
        items: 10,
        failCalls: [0, 1, 2],
        failOnItemErrorRate: 0.5,
      });
      expect(runCli([loose]).status).toBe(0);
      const tightened = runCli([loose, '--max-item-error-rate', '0.02']);
      expect(tightened.status).toBe(1);
      expect(tightened.stderr).toContain('over the 2% limit');
      expect(tightened.stderr).not.toContain('50% limit');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('disables the gate with --max-item-error-rate 1 but keeps the rate visible', () => {
    const dir = tempDir('item-gate-off');
    try {
      const file = writeEvalFile(dir, {
        items: 10,
        failCalls: range(0, 9),
        failOnItemErrorRate: 0.01,
      });
      const run = runCli([file, '--max-item-error-rate', '1']);

      expect(run.status).toBe(0);
      expect(run.stderr).not.toContain('ITEM ERROR RATE EXCEEDED');
      expect(run.stdout).toContain('item error rate 90% (limit 100%)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the unconditional total-wipeout guard when the item gate is off', () => {
    const dir = tempDir('item-gate-wipeout');
    try {
      const file = writeEvalFile(dir, { items: 4, failCalls: range(0, 4) });
      const run = runCli([file, '--max-item-error-rate', '1']);

      expect(run.status).toBe(1);
      expect(run.stderr).toContain('all 4 item(s) errored in the workflow');
      expect(run.stderr).not.toContain('ITEM ERROR RATE EXCEEDED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unusable flag value before running anything', () => {
    const dir = tempDir('item-gate-invalid');
    try {
      const file = writeEvalFile(dir, { items: 2, failCalls: [] });
      const run = runCli([file, '--max-item-error-rate', '5']);

      expect(run.status).toBe(1);
      expect(run.stderr).toContain('--max-item-error-rate must be a number in [0, 1], got "5"');
      expect(run.stdout).not.toContain('Eval:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gates each run of a --runs batch individually and names the thinned run', () => {
    const dir = tempDir('item-gate-runs');
    try {
      // 3 runs × 4 items. Run 2 is calls 4–7; two of them fail (50%). Pooled
      // over the batch that is 2/12 ≈ 16.7% — not the figure that must be reported.
      const file = writeEvalFile(dir, { items: 4, failCalls: [4, 5] });
      const run = runCli([file, '--runs', '3']);

      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/ITEM ERROR RATE EXCEEDED: \S+ run 2\/3 — 2 of 4/);
      expect(run.stderr).toContain('item error rate 50%');
      expect(run.stderr).not.toMatch(/run [13]\/3 — /);
      expect(run.stderr).not.toContain('16.7%');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to certify a thinned side in compare by default, and warns when accepted', () => {
    const dir = tempDir('item-gate-compare');
    try {
      const clean = writeEvalFile(dir, { items: 10, failCalls: [] });
      const baseline = join(dir, 'baseline.json');
      expect(runCli([clean, '--output', baseline]).status).toBe(0);

      const thinnedFile = writeEvalFile(dir, {
        items: 10,
        failCalls: [0],
        failOnItemErrorRate: 1,
      });
      const candidate = join(dir, 'candidate.json');
      expect(runCli([thinnedFile, '--output', candidate]).status).toBe(0);

      const refused = runCli(['compare', baseline, candidate]);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('[axl-eval] Refusing to gate: coverage: candidate');
      expect(refused.stderr).toContain('item error rate 10%');
      expect(refused.stderr).toContain('exceeds the 5% limit');

      const swapped = runCli(['compare', candidate, baseline]);
      expect(swapped.status).toBe(1);
      expect(swapped.stderr).toContain('Refusing to gate: coverage: baseline');

      const accepted = runCli(['compare', baseline, candidate, '--max-item-error-rate', '0.2']);
      expect(accepted.status).toBe(0);
      expect(accepted.stderr).toContain('[axl-eval] WARNING: candidate');
      expect(accepted.stderr).toContain('within the 20% limit');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects --max-item-error-rate on rescore, whose item failures belong to the source run', () => {
    const dir = tempDir('item-gate-rescore');
    try {
      const file = writeEvalFile(dir, { items: 2, failCalls: [] });
      const out = join(dir, 'result.json');
      expect(runCli([file, '--output', out]).status).toBe(0);

      const run = runCli(['rescore', out, file, '--max-item-error-rate', '0.5']);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('--max-item-error-rate is not supported with rescore');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
