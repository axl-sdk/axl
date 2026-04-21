import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { tool } from '../tool.js';
import { workflow } from '../workflow.js';
import { AxlRuntime } from '../runtime.js';
import type { AxlEvent } from '../types.js';

/**
 * Regression guard: a multi-turn workflow must produce O(N) events, not
 * O(N²). Pins a class of bugs where a future change accidentally emits
 * per-token or per-retry work items into `events` and quietly blows up
 * memory under real workloads.
 *
 * Bound: 100 turns × ~5 events/turn (ask_start/end + agent_call_start/end +
 * tool_call_start/end + lifecycle/log) ≈ 500. Allow generous headroom for
 * the 2 ask boundary events + 2 workflow lifecycle events.
 */
describe('Event-volume regression — O(N) growth, not O(N²)', () => {
  it('100-turn workflow with 1 tool call per turn stays under 700 events', async () => {
    const TURNS = 100;
    const passthrough = tool({
      name: 'passthrough',
      description: 'Echo input back',
      input: z.object({ value: z.number() }),
      handler: async ({ value }) => ({ value }),
    });

    const a = agent({
      name: 'turn-runner',
      model: 'mock:test',
      system: 'system',
      tools: [passthrough],
      maxTurns: TURNS + 1,
    });

    // Sequence: TURNS responses each calling the tool, then a final answer.
    let idx = 0;
    const responses: Array<{
      content: string;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      cost: number;
    }> = [];
    for (let i = 0; i < TURNS; i++) {
      responses.push({
        content: '',
        tool_calls: [
          {
            id: `c${i}`,
            type: 'function',
            function: { name: 'passthrough', arguments: JSON.stringify({ value: i }) },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        cost: 0.0001,
      });
    }
    responses.push({
      content: 'final',
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      cost: 0.0001,
    });

    const runtime = new AxlRuntime({ defaultProvider: 'mock' });
    runtime.registerProvider('mock', {
      name: 'mock',
      chat: async () => {
        const r = responses[idx] ?? responses[responses.length - 1];
        idx++;
        return r;
      },
      stream: async function* () {
        yield {
          type: 'done' as const,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      },
    });

    const wf = workflow({
      name: 'volume-wf',
      input: z.object({}),
      handler: async (ctx) => ctx.ask(a, 'go'),
    });
    runtime.register(wf);

    const collected: AxlEvent[] = [];
    runtime.on('trace', (e: AxlEvent) => collected.push(e));
    await runtime.execute('volume-wf', {});

    // Expect close to TURNS turns × constant per-turn events. Generous upper
    // bound — tightening only when the new emission set stabilizes.
    expect(collected.length).toBeLessThan(700);
    // Sanity: at least the ask boundary, workflow lifecycle, and one event
    // per turn each fired.
    expect(collected.filter((e) => e.type === 'agent_call_end').length).toBeGreaterThanOrEqual(
      TURNS,
    );
  });
});
