import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataset, scorer, llmScorer, runEval, evalCompare } from '@axlsdk/eval';
import type { EvalResult } from '@axlsdk/eval';
import { AxlRuntime } from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';

const mockRuntime = {} as AxlRuntime;

describe('Eval E2E', () => {
  it('dataset + scorer + runEval returns valid EvalResult', async () => {
    const ds = dataset({
      name: 'test-dataset',
      schema: z.object({ question: z.string() }),
      items: [{ input: { question: 'What is 1+1?' } }, { input: { question: 'What is 2+2?' } }],
    });

    const exactMatch = scorer({
      name: 'contains-number',
      description: 'Check if output contains a number',
      score: (output: unknown) => {
        const str = String(output);
        return /\d/.test(str) ? 1 : 0;
      },
    });

    const executeFn = async (input: unknown) => {
      const q = (input as { question: string }).question;
      return { output: `The answer to "${q}" is 2.`, cost: 0.001 };
    };

    const result = await runEval(
      { workflow: 'test-wf', dataset: ds, scorers: [exactMatch] },
      executeFn,
      mockRuntime,
    );

    expect(result.id).toBeDefined();
    expect(result.dataset).toBe('test-dataset');
    expect(result.items.length).toBe(2);
    expect(result.summary.count).toBe(2);
    expect(result.summary.failures).toBe(0);
    expect(result.summary.scorers['contains-number']).toBeDefined();
    expect(result.summary.scorers['contains-number'].mean).toBe(1);
  });

  it('evalCompare detects improvements and regressions', async () => {
    const ds = dataset({
      name: 'compare-dataset',
      schema: z.object({ q: z.string() }),
      items: [{ input: { q: 'a' } }, { input: { q: 'b' } }, { input: { q: 'c' } }],
    });

    const qualityScorer = scorer({
      name: 'quality',
      description: 'Quality score',
      score: (output: unknown) => {
        const str = String(output);
        return str.includes('good') ? 1 : 0;
      },
    });

    // Baseline: all bad
    const baselineResult = await runEval(
      { workflow: 'test', dataset: ds, scorers: [qualityScorer] },
      async () => ({ output: 'bad result' }),
      mockRuntime,
    );

    // Candidate: all good
    const candidateResult = await runEval(
      { workflow: 'test', dataset: ds, scorers: [qualityScorer] },
      async () => ({ output: 'good result' }),
      mockRuntime,
    );

    const comparison = evalCompare(baselineResult as EvalResult, candidateResult as EvalResult);

    expect(comparison.scorers.quality).toBeDefined();
    expect(comparison.scorers.quality.delta).toBeGreaterThan(0);
    expect(comparison.improvements.length).toBeGreaterThan(0);
    expect(comparison.summary).toContain('improves');
  });

  it('scorer returning out-of-range value is captured in eval item errors', async () => {
    const ds = dataset({
      name: 'range-dataset',
      schema: z.object({ q: z.string() }),
      items: [{ input: { q: 'test' } }],
    });

    const badScorer = scorer({
      name: 'bad-scorer',
      description: 'Returns invalid score',
      score: () => 2.5, // out of [0, 1] range
    });

    const result = await runEval(
      { workflow: 'test', dataset: ds, scorers: [badScorer] },
      async () => ({ output: 'anything' }),
      mockRuntime,
    );

    expect(result.items[0].scorerErrors).toBeDefined();
    expect(result.items[0].scorerErrors!.length).toBeGreaterThan(0);
    expect(result.items[0].scorerErrors![0]).toContain('out-of-range');
    expect(result.items[0].scores['bad-scorer']).toBeNull();
  });

  it('EvalResult has correct structure with metadata and timestamp', async () => {
    const ds = dataset({
      name: 'struct-dataset',
      schema: z.object({ q: z.string() }),
      items: [{ input: { q: 'test' } }],
    });

    const s = scorer({
      name: 'simple',
      description: 'Always 1',
      score: () => 1,
    });

    const result = (await runEval(
      {
        workflow: 'struct-test',
        dataset: ds,
        scorers: [s],
        metadata: { version: '1.0' },
      },
      async () => ({ output: 'ok' }),
      mockRuntime,
    )) as EvalResult;

    expect(result.id).toBeTruthy();
    // Workflow now lives in metadata.workflows (trace-derived, with fallback
    // to config.workflow when no traces were captured).
    expect(result.metadata.workflows).toEqual(['struct-test']);
    expect(result.dataset).toBe('struct-dataset');
    expect(result.metadata).toEqual({
      version: '1.0',
      scorerTypes: { simple: 'deterministic' },
      workflows: ['struct-test'],
      workflowCounts: { 'struct-test': 1 },
    });
    expect(result.timestamp).toBeTruthy();
    expect(typeof result.duration).toBe('number');
    expect(typeof result.totalCost).toBe('number');
  });

  it('eval with annotations passes them to scorer', async () => {
    const ds = dataset({
      name: 'annotated-dataset',
      schema: z.object({ q: z.string() }),
      annotations: z.object({ expected: z.string() }),
      items: [{ input: { q: 'hello' }, annotations: { expected: 'greeting' } }],
    });

    const annotationScorer = scorer<unknown, unknown, { expected: string }>({
      name: 'annotation-check',
      description: 'Check annotations pass through',
      score: (output, _input, annotations) => {
        return annotations?.expected === 'greeting' ? 1 : 0;
      },
    });

    const result = await runEval(
      { workflow: 'test', dataset: ds, scorers: [annotationScorer] },
      async () => ({ output: 'some output' }),
      mockRuntime,
    );

    expect(result.items[0].scores['annotation-check']).toBe(1);
  });

  it('runtime.eval() executes workflow against dataset with scorers', async () => {
    const provider = MockProvider.fn(() => ({ content: 'mock answer' }));
    const runtime = new AxlRuntime();
    runtime.registerProvider('mock', provider);

    const { agent, workflow } = await import('@axlsdk/axl');
    const a = agent({ name: 'eval-agent', model: 'mock:test', system: 'test' });
    const wf = workflow({
      name: 'eval-target-wf',
      input: z.object({ question: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.question),
    });
    runtime.register(wf);

    const ds = dataset({
      name: 'runtime-eval-ds',
      schema: z.object({ question: z.string() }),
      items: [{ input: { question: 'q1' } }, { input: { question: 'q2' } }],
    });

    const alwaysPass = scorer({
      name: 'pass',
      description: 'Always passes',
      score: () => 1,
    });

    // Call runtime.eval() directly — now works since import('@axlsdk/eval') resolves
    const result = (await runtime.eval({
      workflow: 'eval-target-wf',
      dataset: ds,
      scorers: [alwaysPass],
    })) as EvalResult;

    expect(result.items.length).toBe(2);
    expect(result.items[0].output).toBe('mock answer');
    expect(result.items[0].scores['pass']).toBe(1);
    expect(result.summary.scorers['pass'].mean).toBe(1);
  });

  it('runtime.eval() auto-resolves provider for LLM scorers', async () => {
    // MockProvider that returns valid scorer JSON
    const scorerProvider = MockProvider.fn(() => ({
      content: JSON.stringify({ score: 0.95, reasoning: 'Excellent output' }),
    }));

    const provider = MockProvider.fn(() => ({ content: 'workflow output' }));
    const runtime = new AxlRuntime();
    runtime.registerProvider('mock', provider);
    runtime.registerProvider('scorer-mock', scorerProvider);

    const { agent, workflow } = await import('@axlsdk/axl');
    const a = agent({ name: 'eval-agent', model: 'mock:test', system: 'test' });
    const wf = workflow({
      name: 'llm-eval-wf',
      input: z.object({ question: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.question),
    });
    runtime.register(wf);

    const ds = dataset({
      name: 'llm-eval-ds',
      schema: z.object({ question: z.string() }),
      items: [{ input: { question: 'q1' } }],
    });

    const judge = llmScorer({
      name: 'quality',
      description: 'Quality judge',
      model: 'scorer-mock:judge-model',
      system: 'Rate the quality',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    const result = (await runtime.eval({
      workflow: 'llm-eval-wf',
      dataset: ds,
      scorers: [judge],
    })) as EvalResult;

    expect(result.items.length).toBe(1);
    expect(result.items[0].scores['quality']).toBe(0.95);
    expect(result.items[0].scorerErrors).toBeUndefined();
  });

  it('llmScorer uses default schema when none provided, through full runEval() pipeline', async () => {
    const scorerProvider = MockProvider.fn(() => ({
      // Returns only score+reasoning (the default schema fields)
      content: JSON.stringify({ score: 0.8, reasoning: 'Good answer' }),
    }));

    const provider = MockProvider.fn(() => ({ content: 'workflow output' }));
    const runtime = new AxlRuntime();
    runtime.registerProvider('mock', provider);
    runtime.registerProvider('scorer-mock', scorerProvider);

    const { agent, workflow } = await import('@axlsdk/axl');
    const a = agent({ name: 'default-schema-agent', model: 'mock:test', system: 'test' });
    const wf = workflow({
      name: 'default-schema-wf',
      input: z.object({ question: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.question),
    });
    runtime.register(wf);

    const ds = dataset({
      name: 'default-schema-ds',
      schema: z.object({ question: z.string() }),
      items: [{ input: { question: 'q1' } }],
    });

    // No schema — should use the default { score: z.number(), reasoning: z.string() }
    const judge = llmScorer({
      name: 'quality-default',
      description: 'Quality judge with default schema',
      model: 'scorer-mock:judge-model',
      system: 'Rate the quality',
    });

    const result = (await runtime.eval({
      workflow: 'default-schema-wf',
      dataset: ds,
      scorers: [judge],
    })) as EvalResult;

    expect(result.items.length).toBe(1);
    expect(result.items[0].scores['quality-default']).toBe(0.8);
    expect(result.items[0].scorerErrors).toBeUndefined();
  });

  it('per-item duration and cost are captured', async () => {
    const ds = dataset({
      name: 'timing-ds',
      schema: z.object({ q: z.string() }),
      items: [{ input: { q: 'test' } }],
    });

    const s = scorer({
      name: 'pass',
      description: 'Always passes',
      score: () => 1,
    });

    const result = await runEval(
      { workflow: 'test', dataset: ds, scorers: [s] },
      async () => ({ output: 'ok', cost: 0.005 }),
      mockRuntime,
    );

    const item = result.items[0];
    expect(item.duration).toBeDefined();
    expect(typeof item.duration).toBe('number');
    expect(item.duration!).toBeGreaterThanOrEqual(0);
    expect(item.cost).toBe(0.005);
  });

  it('scoreDetails are populated with metadata for LLM scorers through runtime.eval()', async () => {
    const scorerProvider = MockProvider.fn(() => ({
      content: JSON.stringify({ score: 0.9, reasoning: 'Well structured answer' }),
      cost: 0.002,
    }));

    const provider = MockProvider.fn(() => ({ content: 'workflow output' }));
    const runtime = new AxlRuntime();
    runtime.registerProvider('mock', provider);
    runtime.registerProvider('scorer-mock', scorerProvider);

    const { agent, workflow } = await import('@axlsdk/axl');
    const a = agent({ name: 'detail-agent', model: 'mock:test', system: 'test' });
    const wf = workflow({
      name: 'detail-wf',
      input: z.object({ question: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.question),
    });
    runtime.register(wf);

    const ds = dataset({
      name: 'detail-ds',
      schema: z.object({ question: z.string() }),
      items: [{ input: { question: 'q1' } }],
    });

    const judge = llmScorer({
      name: 'quality',
      description: 'Quality judge',
      model: 'scorer-mock:judge-model',
      system: 'Rate the quality',
    });

    const result = (await runtime.eval({
      workflow: 'detail-wf',
      dataset: ds,
      scorers: [judge],
    })) as EvalResult;

    const item = result.items[0];

    // scoreDetails should be populated
    expect(item.scoreDetails).toBeDefined();
    expect(item.scoreDetails!['quality']).toBeDefined();
    expect(item.scoreDetails!['quality'].score).toBe(0.9);
    expect(item.scoreDetails!['quality'].metadata).toEqual({ reasoning: 'Well structured answer' });
    expect(item.scoreDetails!['quality'].cost).toBeDefined();
    expect(typeof item.scoreDetails!['quality'].duration).toBe('number');

    // scores still works for backwards compat
    expect(item.scores['quality']).toBe(0.9);

    // Per-item duration and scorerCost
    expect(item.duration).toBeDefined();
    // scorerCost depends on provider cost pass-through; just verify it's tracked
    expect(item.scoreDetails!['quality'].duration).toBeGreaterThanOrEqual(0);
  });

  it('summary includes timing stats', async () => {
    const ds = dataset({
      name: 'timing-summary-ds',
      schema: z.object({ q: z.string() }),
      items: [{ input: { q: 'a' } }, { input: { q: 'b' } }],
    });

    const s = scorer({
      name: 'pass',
      description: 'Always passes',
      score: () => 1,
    });

    const result = await runEval(
      { workflow: 'test', dataset: ds, scorers: [s] },
      async () => ({ output: 'ok' }),
      mockRuntime,
    );

    expect(result.summary.timing).toBeDefined();
    expect(typeof result.summary.timing!.mean).toBe('number');
    expect(typeof result.summary.timing!.p50).toBe('number');
    expect(typeof result.summary.timing!.p95).toBe('number');
  });

  it('eval CLI runs eval file and produces formatted output', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'axl-eval-cli-'));
    const evalFile = join(tmpDir, 'test.eval.mjs');

    // Write a self-contained eval file that needs no workspace imports.
    // The dataset must have a getItems() method (matching the Dataset interface).
    writeFileSync(
      evalFile,
      `
export default {
  workflow: 'cli-test',
  dataset: {
    name: 'cli-dataset',
    getItems: async () => [
      { input: { q: 'hello' } },
      { input: { q: 'world' } },
    ],
  },
  scorers: [{
    name: 'length-check',
    score: (output) => String(output).length > 0 ? 1 : 0,
  }],
};

export async function executeWorkflow(input) {
  return { output: 'result for ' + input.q, cost: 0.001 };
}
`,
    );

    const ROOT = join(import.meta.dirname, '../../..');
    const cliPath = join(ROOT, 'packages/axl-eval/dist/cli.js');

    const stdout = execSync(`node ${cliPath} ${evalFile}`, {
      encoding: 'utf-8',
      cwd: ROOT,
    });

    // CLI should output the formatted table
    expect(stdout).toContain('cli-test');
    expect(stdout).toContain('cli-dataset');
    expect(stdout).toContain('length-check');
    expect(stdout).toContain('2 items');

    // Clean up
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('axl-eval compare produces comparison output', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'axl-eval-compare-'));
    try {
      const ds = dataset({
        name: 'compare-cli-ds',
        schema: z.object({ q: z.string() }),
        items: [{ input: { q: 'a' } }, { input: { q: 'b' } }, { input: { q: 'c' } }],
      });

      const qualityScorer = scorer({
        name: 'quality',
        description: 'Quality score',
        score: (output: unknown) => (String(output).includes('good') ? 1 : 0),
      });

      const baselineResult = await runEval(
        { workflow: 'compare-test', dataset: ds, scorers: [qualityScorer] },
        async () => ({ output: 'bad result' }),
        mockRuntime,
      );

      const candidateResult = await runEval(
        { workflow: 'compare-test', dataset: ds, scorers: [qualityScorer] },
        async () => ({ output: 'good result' }),
        mockRuntime,
      );

      const baselinePath = join(tmpDir, 'baseline.json');
      const candidatePath = join(tmpDir, 'candidate.json');
      writeFileSync(baselinePath, JSON.stringify(baselineResult));
      writeFileSync(candidatePath, JSON.stringify(candidateResult));

      const ROOT = join(import.meta.dirname, '../../..');
      const cliPath = join(ROOT, 'packages/axl-eval/dist/cli.js');

      const stdout = execSync(`node ${cliPath} compare ${baselinePath} ${candidatePath}`, {
        encoding: 'utf-8',
        cwd: ROOT,
      });

      expect(stdout).toContain('quality');
      expect(stdout).toContain('Regressions:');
      expect(stdout).toContain('Improvements:');
      // Candidate improved from 0 to 1, so improvements should be non-zero
      expect(stdout).not.toContain('Improvements: 0');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('axl-eval compare --threshold 0 flags small improvements', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'axl-eval-threshold-'));
    try {
      // Construct EvalResults manually WITHOUT scorerTypes metadata
      // so legacy threshold (0.1) is used by default
      const makeResult = (id: string, scores: number[]): EvalResult => ({
        id,
        dataset: 'threshold-ds',
        metadata: {},
        timestamp: new Date().toISOString(),
        totalCost: 0,
        duration: 100,
        items: scores.map((s, i) => ({
          input: { q: `item-${i}` },
          output: `output-${i}`,
          scores: { accuracy: s },
        })),
        summary: {
          count: scores.length,
          failures: 0,
          scorers: {
            accuracy: {
              mean: scores.reduce((a, b) => a + b, 0) / scores.length,
              min: Math.min(...scores),
              max: Math.max(...scores),
              p50: scores[Math.floor(scores.length / 2)],
              p95: scores[scores.length - 1],
            },
          },
        },
      });

      const baseline = makeResult('baseline-001', [0.8, 0.8, 0.8]);
      const candidate = makeResult('candidate-001', [0.82, 0.82, 0.82]);

      const baselinePath = join(tmpDir, 'baseline.json');
      const candidatePath = join(tmpDir, 'candidate.json');
      writeFileSync(baselinePath, JSON.stringify(baseline));
      writeFileSync(candidatePath, JSON.stringify(candidate));

      const ROOT = join(import.meta.dirname, '../../..');
      const cliPath = join(ROOT, 'packages/axl-eval/dist/cli.js');

      // With --threshold 0: delta 0.02 > 0 → flagged as improvement
      const withThreshold = execSync(
        `node ${cliPath} compare ${baselinePath} ${candidatePath} --threshold 0`,
        { encoding: 'utf-8', cwd: ROOT },
      );
      expect(withThreshold).toContain('accuracy');
      expect(withThreshold).not.toContain('Improvements: 0');

      // Without threshold: legacy 0.1, delta 0.02 < 0.1 → NOT flagged
      const withoutThreshold = execSync(
        `node ${cliPath} compare ${baselinePath} ${candidatePath}`,
        { encoding: 'utf-8', cwd: ROOT },
      );
      expect(withoutThreshold).toContain('Improvements: 0');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('axl-eval --runs 3 produces multi-run output and array JSON', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'axl-eval-runs-'));
    try {
      const evalFile = join(tmpDir, 'test.eval.mjs');
      const outputFile = join(tmpDir, 'results.json');

      writeFileSync(
        evalFile,
        `
export default {
  workflow: 'runs-test',
  dataset: {
    name: 'runs-dataset',
    getItems: async () => [
      { input: { q: 'hello' } },
      { input: { q: 'world' } },
    ],
  },
  scorers: [{
    name: 'length-check',
    score: (output) => String(output).length > 0 ? 1 : 0,
  }],
};

export async function executeWorkflow(input) {
  return { output: 'result for ' + input.q, cost: 0.001 };
}
`,
      );

      const ROOT = join(import.meta.dirname, '../../..');
      const cliPath = join(ROOT, 'packages/axl-eval/dist/cli.js');

      const stdout = execSync(`node ${cliPath} ${evalFile} --runs 3 --output ${outputFile}`, {
        encoding: 'utf-8',
        cwd: ROOT,
      });

      // Multi-run table should mention "3 runs"
      expect(stdout).toContain('3 runs');

      // Output file should be a JSON array with 3 results
      const results = JSON.parse(readFileSync(outputFile, 'utf-8'));
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(3);

      // Each result should have runGroupId and runIndex metadata
      for (let i = 0; i < 3; i++) {
        expect(results[i].metadata.runGroupId).toBeDefined();
        expect(results[i].metadata.runIndex).toBe(i);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('axl-eval rescore re-scores saved outputs', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'axl-eval-rescore-'));
    try {
      const evalFile = join(tmpDir, 'test.eval.mjs');
      const resultsFile = join(tmpDir, 'results.json');
      const rescoredFile = join(tmpDir, 'rescored.json');

      writeFileSync(
        evalFile,
        `
export default {
  workflow: 'rescore-test',
  dataset: {
    name: 'rescore-dataset',
    getItems: async () => [
      { input: { q: 'hello' } },
      { input: { q: 'world' } },
    ],
  },
  scorers: [{
    name: 'length-check',
    score: (output) => String(output).length > 0 ? 1 : 0,
  }],
};

export async function executeWorkflow(input) {
  return { output: 'result for ' + input.q, cost: 0.001 };
}
`,
      );

      const ROOT = join(import.meta.dirname, '../../..');
      const cliPath = join(ROOT, 'packages/axl-eval/dist/cli.js');

      // Step 1: Run eval and save results
      execSync(`node ${cliPath} ${evalFile} --output ${resultsFile}`, {
        encoding: 'utf-8',
        cwd: ROOT,
      });

      // Step 2: Rescore the saved results
      const stdout = execSync(
        `node ${cliPath} rescore ${resultsFile} ${evalFile} --output ${rescoredFile}`,
        { encoding: 'utf-8', cwd: ROOT },
      );

      expect(stdout).toContain('Rescored results saved to');

      // Step 3: Verify rescored output
      const rescored = JSON.parse(readFileSync(rescoredFile, 'utf-8'));
      expect(rescored.metadata.rescored).toBe(true);
      expect(rescored.metadata.originalId).toBeDefined();
      expect(rescored.items.length).toBe(2);
      expect(rescored.items[0].scores['length-check']).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
