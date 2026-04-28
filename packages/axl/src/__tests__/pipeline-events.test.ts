import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { createTestCtx, createSequenceProvider } from './helpers.js';
import type { AxlEvent } from '../types.js';

/** Narrow `pipeline` events out of the full trace stream. */
function pipelineEvents(traces: AxlEvent[]): Array<Extract<AxlEvent, { type: 'pipeline' }>> {
  return traces.filter((t): t is Extract<AxlEvent, { type: 'pipeline' }> => t.type === 'pipeline');
}

describe('pipeline events (spec/16 §4.2)', () => {
  it('emits exactly one pipeline(start, initial) and one pipeline(committed) on the success path', async () => {
    const a = agent({ name: 'happy', model: 'mock:test', system: 'test' });
    const { ctx, traces } = createTestCtx();
    await ctx.ask(a, 'hello');

    const pipeline = pipelineEvents(traces);
    expect(pipeline.length).toBe(2);

    const start = pipeline[0];
    expect(start.status).toBe('start');
    if (start.status === 'start') {
      expect(start.stage).toBe('initial');
      expect(start.attempt).toBe(1);
      expect(start.maxAttempts).toBe(1);
    }

    const committed = pipeline[1];
    expect(committed.status).toBe('committed');
    if (committed.status === 'committed') {
      expect(committed.attempt).toBe(1);
    }
  });

  it('schema retry: pipeline(failed, schema) followed by pipeline(start, schema, attempt: 2)', async () => {
    const a = agent({ name: 'schema-retry', model: 'mock:test', system: 'test' });
    // First attempt: malformed JSON. Second attempt: valid.
    const provider = createSequenceProvider(['not-json-at-all', JSON.stringify({ x: 42 })]);
    const { ctx, traces } = createTestCtx({ provider });

    await ctx.ask(a, 'q', { schema: z.object({ x: z.number() }), retries: 3 });

    const pipeline = pipelineEvents(traces);
    // Expected sequence: start(initial,1) → failed(schema,1) → start(schema,2) → committed(2)
    expect(pipeline.length).toBe(4);
    expect(pipeline[0].status).toBe('start');
    if (pipeline[0].status === 'start') expect(pipeline[0].stage).toBe('initial');

    expect(pipeline[1].status).toBe('failed');
    if (pipeline[1].status === 'failed') {
      expect(pipeline[1].stage).toBe('schema');
      expect(pipeline[1].attempt).toBe(1);
      expect(pipeline[1].reason).toContain('did not match');
    }

    expect(pipeline[2].status).toBe('start');
    if (pipeline[2].status === 'start') {
      expect(pipeline[2].stage).toBe('schema');
      expect(pipeline[2].attempt).toBe(2);
    }

    expect(pipeline[3].status).toBe('committed');
    if (pipeline[3].status === 'committed') expect(pipeline[3].attempt).toBe(2);
  });

  it('terminal failure (schema retries exhausted): NO trailing pipeline(failed); ask_end carries the error', async () => {
    const a = agent({ name: 'fail', model: 'mock:test', system: 'test' });
    // Always-malformed responses; retries: 0 means 1 attempt total.
    const provider = createSequenceProvider(['nope', 'nope', 'nope']);
    const { ctx, traces } = createTestCtx({ provider });

    await expect(
      ctx.ask(a, 'q', { schema: z.object({ x: z.number() }), retries: 0 }),
    ).rejects.toThrow();

    const pipeline = pipelineEvents(traces);
    // Expected: just the initial start; no committed, no failed (since the
    // single attempt's schema failure exhausts immediately and throws).
    // `failed` always means "another start is coming" (spec invariant);
    // since no retry happens, no failed event fires.
    const failed = pipeline.filter((e) => e.status === 'failed');
    expect(failed.length).toBe(0);
    const committed = pipeline.filter((e) => e.status === 'committed');
    expect(committed.length).toBe(0);

    // ask_end carries the failure (spec decision 9).
    const askEnd = traces.find((t) => t.type === 'ask_end') as
      | Extract<AxlEvent, { type: 'ask_end' }>
      | undefined;
    expect(askEnd).toBeDefined();
    expect(askEnd!.outcome.ok).toBe(false);
  });

  it('reason field is present only on failed events (type-enforced)', async () => {
    const a = agent({ name: 'r-only-failed', model: 'mock:test', system: 'test' });
    const provider = createSequenceProvider(['bad', JSON.stringify({ x: 1 })]);
    const { ctx, traces } = createTestCtx({ provider });
    await ctx.ask(a, 'q', { schema: z.object({ x: z.number() }) });

    for (const e of pipelineEvents(traces)) {
      if (e.status === 'failed') {
        expect(typeof e.reason).toBe('string');
      } else {
        // start / committed don't have a `reason` field — type enforces this.
        expect((e as { reason?: unknown }).reason).toBeUndefined();
      }
    }
  });

  it('validate retry: pipeline(failed, validate) followed by pipeline(start, validate, attempt: 2)', async () => {
    // Mirrors the schema-retry test for the validate stage.
    // Both responses parse cleanly under the schema; first fails the
    // post-schema `validate` callback, second passes. Validate requires a
    // schema (per the docs) — we provide one and it parses successfully on
    // every attempt; only the validate gate flips between fail and pass.
    const a = agent({ name: 'validate-retry', model: 'mock:test', system: 'test' });
    const provider = createSequenceProvider([
      JSON.stringify({ value: 1 }), // schema OK, validate FAILS
      JSON.stringify({ value: 99 }), // schema OK, validate PASSES
    ]);
    const { ctx, traces } = createTestCtx({ provider });

    await ctx.ask(a, 'q', {
      schema: z.object({ value: z.number() }),
      validate: (out) => (out.value > 50 ? { valid: true } : { valid: false, reason: 'too small' }),
      validateRetries: 2,
    });

    const pipeline = pipelineEvents(traces);
    // Expected: start(initial,1) → failed(validate,1) → start(validate,2) → committed(2)
    expect(pipeline.length).toBe(4);

    expect(pipeline[0].status).toBe('start');
    if (pipeline[0].status === 'start') {
      expect(pipeline[0].stage).toBe('initial');
      expect(pipeline[0].attempt).toBe(1);
    }

    expect(pipeline[1].status).toBe('failed');
    if (pipeline[1].status === 'failed') {
      expect(pipeline[1].stage).toBe('validate');
      expect(pipeline[1].attempt).toBe(1);
      // The reason is the feedback message about the failure.
      expect(typeof pipeline[1].reason).toBe('string');
    }

    expect(pipeline[2].status).toBe('start');
    if (pipeline[2].status === 'start') {
      expect(pipeline[2].stage).toBe('validate');
      expect(pipeline[2].attempt).toBe(2);
    }

    expect(pipeline[3].status).toBe('committed');
    if (pipeline[3].status === 'committed') {
      expect(pipeline[3].attempt).toBe(2);
    }

    // Sanity: the validate gate fired twice in lockstep with the pipeline
    // events (one fail, one pass).
    const validateEvents = traces.filter((t) => t.type === 'validate');
    expect(validateEvents).toHaveLength(2);
  });

  it('guardrail retry: pipeline(failed, guardrail) followed by pipeline(start, guardrail, attempt: 2)', async () => {
    // Mirrors the schema-retry test for the output guardrail stage.
    // First attempt is blocked by the output guardrail; second attempt passes.
    const a = agent({
      name: 'guardrail-retry',
      model: 'mock:test',
      system: 'test',
      guardrails: {
        output: async (response) => {
          if (response.includes('unsafe')) return { block: true, reason: 'unsafe content' };
          return { block: false };
        },
        onBlock: 'retry',
        maxRetries: 2,
      },
    });
    const provider = createSequenceProvider([
      'unsafe content', // guardrail BLOCKS
      'safe and approved', // guardrail PASSES
    ]);
    const { ctx, traces } = createTestCtx({ provider });

    await ctx.ask(a, 'q');

    const pipeline = pipelineEvents(traces);
    // Expected: start(initial,1) → failed(guardrail,1) → start(guardrail,2) → committed(2)
    expect(pipeline.length).toBe(4);

    expect(pipeline[0].status).toBe('start');
    if (pipeline[0].status === 'start') {
      expect(pipeline[0].stage).toBe('initial');
      expect(pipeline[0].attempt).toBe(1);
    }

    expect(pipeline[1].status).toBe('failed');
    if (pipeline[1].status === 'failed') {
      expect(pipeline[1].stage).toBe('guardrail');
      expect(pipeline[1].attempt).toBe(1);
      expect(typeof pipeline[1].reason).toBe('string');
    }

    expect(pipeline[2].status).toBe('start');
    if (pipeline[2].status === 'start') {
      expect(pipeline[2].stage).toBe('guardrail');
      expect(pipeline[2].attempt).toBe(2);
    }

    expect(pipeline[3].status).toBe('committed');
    if (pipeline[3].status === 'committed') {
      expect(pipeline[3].attempt).toBe(2);
    }

    // Sanity: guardrail fired twice (blocked + passed).
    const guardrailEvents = traces.filter((t) => t.type === 'guardrail');
    expect(guardrailEvents).toHaveLength(2);
  });

  it('tool-calling turns within a single ask do NOT produce extra pipeline starts', async () => {
    // Multi-turn agent (turn 1: tool call, turn 2: final answer). Pipeline
    // should fire ONE start (initial) and ONE committed — the inner tool
    // turns are agent-loop iterations, not retry attempts.
    const { tool } = await import('../tool.js');
    const passthrough = tool({
      name: 'pt',
      description: 'echo',
      input: z.object({}),
      handler: async () => ({ ok: true }),
    });
    const a = agent({
      name: 'multi-turn',
      model: 'mock:test',
      system: 'test',
      tools: [passthrough],
    });
    const provider = createSequenceProvider([
      {
        tool_calls: [
          { id: 'c1', type: 'function' as const, function: { name: 'pt', arguments: '{}' } },
        ],
      },
      'final answer',
    ]);
    const { ctx, traces } = createTestCtx({ provider });
    await ctx.ask(a, 'go');

    const pipeline = pipelineEvents(traces);
    expect(pipeline.length).toBe(2);
    expect(pipeline[0].status).toBe('start');
    expect(pipeline[1].status).toBe('committed');

    // Sanity: there ARE multiple agent_call_end events (one per turn).
    const agentCalls = traces.filter((t) => t.type === 'agent_call_end');
    expect(agentCalls.length).toBe(2);
  });
});
