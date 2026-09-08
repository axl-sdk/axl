import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { AxlRuntime } from '../runtime.js';
import type { AxlEvent } from '../types.js';
import { workflow } from '../workflow.js';

const RUN =
  process.env.AXL_SESSION_INPUT_LIVE === '1' && process.env.AXL_DISABLE_LIVE_INTEGRATION !== '1';
const MODEL = 'openrouter:google/gemini-2.5-flash-lite';

type OpenRouterWireBody = {
  messages?: Array<{ role?: unknown; content?: unknown }>;
};

describe.skipIf(!RUN || !process.env.OPENROUTER_API_KEY)(
  'Session current-input live verification',
  () => {
    it('sends one matching user message and reports bounded usage/cost', async () => {
      const marker = `AXL_SESSION_INPUT_${randomUUID()}`;
      const originalFetch = globalThis.fetch;
      let wireBody: OpenRouterWireBody | undefined;
      let modelRequestCount = 0;
      globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        if (
          url.hostname === 'openrouter.ai' &&
          url.pathname === '/api/v1/chat/completions' &&
          typeof init?.body === 'string'
        ) {
          modelRequestCount++;
          wireBody = JSON.parse(init.body) as OpenRouterWireBody;
        }
        return originalFetch(input, init);
      };

      const runtime = new AxlRuntime();
      const events: AxlEvent[] = [];
      runtime.on('trace', (event) => events.push(event));
      const assistant = agent({
        name: 'session-input-live',
        model: MODEL,
        system: 'Reply with exactly OK.',
        maxTokens: 32,
      });
      runtime.register(
        workflow({
          name: 'session-input-live',
          input: z.string(),
          handler: (ctx) => ctx.ask(assistant, ctx.input, { maxTokens: 32 }),
        }),
      );

      let wireUserMessages: number | undefined;
      let terminal: Extract<AxlEvent, { type: 'agent_call_end' }> | undefined;
      try {
        const session = runtime.session(`session-input-live-${randomUUID()}`);
        const result = await session.send('session-input-live', marker);
        expect(typeof result).toBe('string');

        const matchingUsers = (wireBody?.messages ?? []).filter(
          (message) => message.role === 'user' && message.content === marker,
        );
        wireUserMessages = matchingUsers.length;
        expect(matchingUsers).toHaveLength(1);
        expect(
          (wireBody?.messages ?? []).filter((message) => message.role === 'user'),
        ).toHaveLength(1);
        expect(modelRequestCount).toBeGreaterThanOrEqual(1);
        expect(modelRequestCount).toBeLessThanOrEqual(3);

        const history = await session.history();
        expect(history).toHaveLength(2);
        expect(history[0]).toEqual({ role: 'user', content: marker });
        expect(history[1]).toMatchObject({
          role: 'assistant',
          content: result,
          agent: 'session-input-live',
        });

        terminal = events.find(
          (event): event is Extract<AxlEvent, { type: 'agent_call_end' }> =>
            event.type === 'agent_call_end',
        );
        expect(terminal).toBeDefined();
        expect(terminal?.tokens?.input).toBeGreaterThan(0);
        expect(terminal?.tokens?.output).toBeGreaterThan(0);
        expect(terminal?.cost).toBeGreaterThan(0);
        expect(terminal?.unpriced).not.toBe(true);
      } finally {
        console.log(
          JSON.stringify({
            check: 'session-current-input-deduplication',
            model: MODEL,
            httpAttempts: modelRequestCount,
            wireUserMessages,
            usage: terminal?.tokens,
            costUsd: terminal?.cost,
            unpriced: terminal?.unpriced === true,
          }),
        );
        globalThis.fetch = originalFetch;
        await runtime.shutdown();
      }
    }, 30_000);
  },
);
