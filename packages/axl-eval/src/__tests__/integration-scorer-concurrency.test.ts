import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AxlRuntime } from '@axlsdk/axl';
import { dataset } from '../dataset.js';
import { llmScorer } from '../llm-scorer.js';
import { runEval } from '../runner.js';
import type { EvalConfig, EvalProgressEvent } from '../types.js';

/**
 * Live-API integration test for the concurrent-scorer path (spec: scorers run
 * concurrently within an item, bounded by `scorerConcurrency`). The unit suite
 * validates the mechanics deterministically with constant scorers; this proves
 * the motivating case end-to-end: multiple real `llmScorer` judges per item
 * against a live provider, with cost tracked and `AbortSignal` honored.
 *
 * Gated on `OPENAI_API_KEY` and excluded from the default `vitest run` — runs
 * only via `pnpm --filter @axlsdk/eval test:integration`. Uses the cheapest
 * model and tiny payloads to keep spend negligible (~7 calls).
 */
const cheapModel = 'openai:gpt-4.1-nano';

describe.skipIf(!process.env.OPENAI_API_KEY)(
  'Eval: concurrent llmScorer judges (live OpenAI)',
  () => {
    // Echo workflow — generation does no LLM work, so the only provider spend
    // is the judges. Isolates the concurrent-scorer path under test.
    const executeWorkflow = async (input: unknown) => ({
      output: (input as { statement: string }).statement,
    });

    const judge = (name: string, criterion: string) =>
      llmScorer({
        name,
        description: `Judge: ${criterion}`,
        model: cheapModel,
        system:
          `You are a strict grader. Score from 0 to 1 how well the output satisfies this ` +
          `criterion: ${criterion}. Respond as JSON {"score": number, "reasoning": string}.`,
        temperature: 0,
        maxTokens: 200,
      });

    it('runs multiple judges per item concurrently, scoring every item and tracking cost', async () => {
      const runtime = new AxlRuntime();
      const ds = dataset({
        name: 'facts',
        schema: z.object({ statement: z.string() }),
        items: [
          { input: { statement: 'The Earth orbits the Sun.' } },
          { input: { statement: 'Water boils at 100 degrees Celsius at sea level.' } },
        ],
      });
      const config: EvalConfig = {
        workflow: 'facts-eval',
        dataset: ds,
        scorers: [
          judge('accuracy', 'factual accuracy'),
          judge('clarity', 'clarity of phrasing'),
          judge('conciseness', 'conciseness'),
        ],
        scorerConcurrency: 3,
      };

      const result = await runEval(config, executeWorkflow, runtime);

      expect(result.summary.failures).toBe(0);
      expect(result.items).toHaveLength(2);
      for (const item of result.items) {
        expect(item.error).toBeUndefined();
        for (const name of ['accuracy', 'clarity', 'conciseness']) {
          const s = item.scores[name];
          expect(typeof s).toBe('number');
          expect(s as number).toBeGreaterThanOrEqual(0);
          expect(s as number).toBeLessThanOrEqual(1);
          // Each judge call recorded its own timing + cost (proves per-scorer
          // attribution survives the concurrent fan-out).
          expect(item.scoreDetails?.[name]?.duration).toBeGreaterThan(0);
          expect(item.scoreDetails?.[name]?.cost).toBeGreaterThan(0);
        }
        expect(item.scorerCost as number).toBeGreaterThan(0);
      }
      // Judge spend is tracked end-to-end (the motivating cost rail).
      expect(result.totalCost).toBeGreaterThan(0);
      expect(result.metadata.scorerTypes).toMatchObject({
        accuracy: 'llm',
        clarity: 'llm',
        conciseness: 'llm',
      });
    }, 60_000);

    it('cancels remaining items mid-run via AbortSignal (live)', async () => {
      const runtime = new AxlRuntime();
      const controller = new AbortController();
      const ds = dataset({
        name: 'facts3',
        schema: z.object({ statement: z.string() }),
        items: [
          { input: { statement: 'Paris is the capital of France.' } },
          { input: { statement: 'The Pacific is the largest ocean.' } },
          { input: { statement: 'A triangle has three sides.' } },
        ],
      });
      const config: EvalConfig = {
        workflow: 'facts-eval',
        dataset: ds,
        scorers: [judge('accuracy', 'factual accuracy')],
        concurrency: 1, // serial items → a deterministic cancellation boundary
      };

      // Abort the moment the first item finishes; the remaining items must be
      // marked cancelled rather than judged. This exercises the signal reaching
      // the runner with a live provider (mid-flight judge abort is unit-tested).
      const onProgress = (e: EvalProgressEvent) => {
        if (e.type === 'item_done' && e.itemIndex === 0) controller.abort();
      };

      const result = await runEval(config, executeWorkflow, runtime, {
        signal: controller.signal,
        onProgress,
      });

      // First item was judged before the abort fired.
      expect(typeof result.items[0].scores.accuracy).toBe('number');
      // The rest were cancelled, not scored.
      const cancelled = result.items.filter((i) => i.error === 'Cancelled');
      expect(cancelled.length).toBeGreaterThanOrEqual(1);
    }, 60_000);
  },
);
