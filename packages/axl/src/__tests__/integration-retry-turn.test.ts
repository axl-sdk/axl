import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WorkflowContext } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { agent } from '../agent.js';
import type { AxlEvent } from '../types.js';

/**
 * Live rows for the retry-turn-shape fix: a `validate` rejection must produce a
 * real retry (feedback as a user turn) on every adapter, including the Gemini
 * models that reject a terminal model turn and the Responses API that replays
 * encrypted reasoning on the assistant attempt.
 */
const MATRIX: Array<{ key: string; uri: string }> = [
  { key: 'GOOGLE_API_KEY', uri: 'google:gemini-3.6-flash' },
  { key: 'GOOGLE_API_KEY', uri: 'google:gemini-3.5-flash-lite' },
  { key: 'ANTHROPIC_API_KEY', uri: 'anthropic:claude-haiku-4-5' },
  { key: 'OPENAI_API_KEY', uri: 'openai:gpt-4.1-nano' },
  { key: 'OPENAI_API_KEY', uri: 'openai-responses:gpt-5-nano' },
];

const ValueSchema = z.object({ value: z.number().int() });

function ctxLive(config: ConstructorParameters<typeof WorkflowContext>[0]['config'] = {}) {
  const events: AxlEvent[] = [];
  const registry = new ProviderRegistry();
  const ctx = new WorkflowContext({
    input: 'x',
    executionId: `int-${randomUUID()}`,
    config,
    providerRegistry: registry,
    onTrace: (e) => events.push(e),
  });
  return { ctx, events };
}

for (const m of MATRIX) {
  describe.skipIf(!process.env[m.key])(`retry turn live: ${m.uri}`, () => {
    it('validate rejection yields a changed second attempt instead of a throw or repeat', async () => {
      const { ctx, events } = ctxLive();
      const a = agent({
        name: 'v',
        model: m.uri,
        system: 'Reply with a single JSON object and nothing else.',
      });
      const attempts: number[] = [];
      const result = await ctx.ask(a, 'Return {"value": 7} exactly.', {
        maxTokens: 512,
        schema: ValueSchema,
        validate: (o) => {
          attempts.push(o.value);
          return o.value === 7
            ? { valid: false, reason: '7 is reserved. Choose a different integer.' }
            : { valid: true };
        },
      });
      expect(attempts[0]).toBe(7);
      expect(attempts.length).toBeGreaterThanOrEqual(2);
      expect(result.value).not.toBe(7);
      const pipeline = events.filter((e) => e.type === 'pipeline').map((e) => e.status);
      expect(pipeline).toContain('failed');
      expect(pipeline.at(-1)).toBe('committed');
      const calls = events.filter((e) => e.type === 'agent_call_end');
      // `agent_call_end.cost` is `undefined` for a model the pricing table does not carry.
      // Summing with `?? 0` would report a pricing-table miss as genuinely free spend.
      const unpriced = calls.filter((e) => (e as { cost?: number }).cost === undefined).length;
      const cost = calls.reduce((sum, e) => sum + ((e as { cost?: number }).cost ?? 0), 0);
      const costLabel =
        unpriced === 0
          ? `$${cost.toFixed(5)}`
          : `$${cost.toFixed(5)}+unpriced(${unpriced}/${calls.length} calls have no price)`;
      const stages = events
        .filter((e) => e.type === 'pipeline')
        .map((e) => `${(e as { stage: string }).stage}:${e.status}`);

      console.log(
        `[live ${m.uri}] attempts=${JSON.stringify(attempts)} calls=${calls.length} cost=${costLabel} pipeline=${stages.join(',')}`,
      );
    }, 120_000);
  });
}

function pipelineStages(events: AxlEvent[]): string[] {
  return events
    .filter((e) => e.type === 'pipeline')
    .map((e) => `${(e as { stage: string }).stage}:${e.status}`);
}

describe.skipIf(!process.env.OPENAI_API_KEY)(
  'retry turn live: accumulated pairs on the Responses API',
  () => {
    it('replays three encrypted-reasoning attempts in one store:false input and still commits', async () => {
      const { ctx, events } = ctxLive();
      const a = agent({
        name: 'v',
        model: 'openai-responses:gpt-5-nano',
        system: 'Reply with a single JSON object and nothing else.',
      });
      const seen: number[] = [];
      await ctx.ask(a, 'Return {"value": 1}.', {
        maxTokens: 1024,
        schema: ValueSchema,
        validateRetries: 3,
        validate: (o) => {
          seen.push(o.value);
          return seen.length <= 3
            ? {
                valid: false,
                reason: `${o.value} is rejected; choose an integer you have not used.`,
              }
            : { valid: true };
        },
      });
      expect(seen).toHaveLength(4);
      expect(pipelineStages(events).filter((s) => s === 'validate:failed')).toHaveLength(3);
      expect(pipelineStages(events).at(-1)).toBe('validate:committed');
    }, 180_000);
  },
);

describe.skipIf(!process.env.ANTHROPIC_API_KEY)(
  'retry turn live: Anthropic thinking replay',
  () => {
    it('replays signed thinking blocks on the non-terminal attempt and answers afresh', async () => {
      const { ctx, events } = ctxLive({ trace: { level: 'full' } });
      const a = agent({
        name: 'v',
        model: 'anthropic:claude-haiku-4-5',
        system: 'Reply with a single JSON object and nothing else.',
      });
      const seen: number[] = [];
      const r = await ctx.ask(a, 'Return {"value": 7}.', {
        thinkingBudget: 2048,
        maxTokens: 4096,
        schema: ValueSchema,
        validate: (o) => {
          seen.push(o.value);
          return o.value === 7
            ? { valid: false, reason: '7 is reserved. Choose a different integer.' }
            : { valid: true };
        },
      });
      expect(seen[0]).toBe(7);
      expect(r.value).not.toBe(7);
      const secondCall = events.filter((e) => e.type === 'agent_call_start')[1] as
        | {
            data?: {
              messages?: Array<{ role: string; providerMetadata?: Record<string, unknown> }>;
            };
          }
        | undefined;
      const replayed = secondCall?.data?.messages;
      const attempt = replayed?.at(-2);
      expect(attempt?.role).toBe('assistant');
      expect(attempt?.providerMetadata).toHaveProperty('anthropicThinkingBlocks');
      expect(replayed?.at(-1)?.role).toBe('user');
    }, 120_000);
  },
);
