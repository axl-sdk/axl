import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WorkflowContext } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { agent } from '../agent.js';
import type { AxlEvent, AxlEventOf } from '../types.js';

/**
 * Live row for `provider_diagnostic { kind: 'effort_clamped' }`: Gemini 3.x
 * cannot disable thinking, so `effort: 'none'` must be reported as a clamp
 * to the model's minimum level, once per ask, before the first agent call,
 * and the request must still succeed on the wire.
 */
describe.skipIf(!process.env.GOOGLE_API_KEY)('effort clamp live: google:gemini-3.6-flash', () => {
  it("reports effort:'none' as a clamp and completes", async () => {
    const events: AxlEvent[] = [];
    const ctx = new WorkflowContext({
      input: 'x',
      executionId: `int-${randomUUID()}`,
      config: {},
      providerRegistry: new ProviderRegistry(),
      onTrace: (e) => events.push(e),
    });
    const a = agent({
      name: 'c',
      model: 'google:gemini-3.6-flash',
      system: 'Reply with JSON only.',
    });
    const r = await ctx.ask(a, 'Return {"value": 3}.', {
      effort: 'none',
      maxTokens: 256,
      schema: z.object({ value: z.number() }),
    });
    expect(r.value).toBe(3);
    const diags = events.filter(
      (e): e is AxlEventOf<'provider_diagnostic'> => e.type === 'provider_diagnostic',
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].data).toMatchObject({
      kind: 'effort_clamped',
      requested: 'none',
      model: 'gemini-3.6-flash',
    });
    const firstCall = events.findIndex((e) => e.type === 'agent_call_start');
    expect(events.indexOf(diags[0])).toBeLessThan(firstCall);
    const start = events.find((e) => e.type === 'agent_call_start') as
      | { params?: { effort?: string } }
      | undefined;

    console.log(
      `[live effort] diag=${JSON.stringify(diags[0].data)} requestedOnCall=${JSON.stringify(start?.params?.effort ?? (start as { data?: { params?: { effort?: string } } })?.data?.params?.effort)}`,
    );
  }, 60_000);
});
