import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
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
    expect(result.workflow).toBe('struct-test');
    expect(result.dataset).toBe('struct-dataset');
    expect(result.metadata).toEqual({ version: '1.0' });
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
});
