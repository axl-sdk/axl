import { ProviderRegistry } from '../providers/registry.js';
import { WorkflowContext } from '../context.js';
import { randomUUID } from 'node:crypto';
import type { AxlEvent } from '../types.js';
import type { Provider, ProviderResponse, ToolCallMessage } from '../providers/types.js';

/** A mock provider that replays a fixed sequence of responses, with optional call tracking. */
export type SequenceProvider = Provider & {
  calls: Array<{ messages: unknown[]; options: unknown }>;
};

/**
 * Create a mock provider from a sequence of responses.
 * Each response is either a string (text) or an object with tool_calls.
 * Tracks all calls in the `calls` array for assertions.
 */
export function createSequenceProvider(
  responses: Array<string | { content?: string; tool_calls: ToolCallMessage[] }>,
): SequenceProvider {
  let callIndex = 0;
  const calls: Array<{ messages: unknown[]; options: unknown }> = [];
  return {
    name: 'mock',
    calls,
    chat: async (messages, options) => {
      calls.push({ messages, options });
      const item = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      if (typeof item === 'string') {
        return {
          content: item,
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          cost: 0.001,
        } as ProviderResponse;
      }
      return {
        content: item.content ?? '',
        tool_calls: item.tool_calls,
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        cost: 0.001,
      } as ProviderResponse;
    },
    stream: async function* () {
      yield {
        type: 'done' as const,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    },
  };
}

/**
 * Create a WorkflowContext with a SequenceProvider pre-registered as 'mock'.
 * Returns the context, trace array, provider, and registry for test assertions.
 */
export function createTestCtx(overrides: Record<string, unknown> = {}) {
  const registry = (overrides.registry as ProviderRegistry) ?? new ProviderRegistry();
  const provider = (overrides.provider as SequenceProvider) ?? createSequenceProvider(['Done']);
  // Only auto-register if no custom registry was provided
  if (!overrides.registry) {
    registry.registerInstance('mock', provider);
  }
  const traces: AxlEvent[] = [];
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { registry: _omit, provider: _omitProvider, ...restOverrides } = overrides;
  return {
    ctx: new WorkflowContext({
      input: 'test',
      executionId: randomUUID(),
      config: {},
      providerRegistry: registry,
      onTrace: (e: AxlEvent) => traces.push(e),
      ...restOverrides,
    }),
    traces,
    provider,
    registry,
  };
}
