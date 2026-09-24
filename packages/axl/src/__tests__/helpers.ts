import { expect, vi } from 'vitest';
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
 * One response in a `createSequenceProvider` sequence: bare text, or an object carrying
 * tool calls and/or the `providerMetadata` a real adapter would return (Gemini thought
 * signatures, Anthropic thinking blocks) so tests can assert it survives onto later turns.
 */
export type SequenceResponse =
  | string
  | {
      content?: string;
      tool_calls?: ToolCallMessage[];
      providerMetadata?: Record<string, unknown>;
    };

/**
 * Create a mock provider from a sequence of responses.
 * Each response is either a string (text) or an object with tool_calls/providerMetadata.
 * Tracks all calls in the `calls` array for assertions.
 */
export function createSequenceProvider(responses: SequenceResponse[]): SequenceProvider {
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
        ...(item.tool_calls ? { tool_calls: item.tool_calls } : {}),
        ...(item.providerMetadata ? { providerMetadata: item.providerMetadata } : {}),
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

/**
 * Assert a measured millisecond figure falls inside a TWO-SIDED window.
 *
 * Timing assertions must bound both ends. A bare `>=` is satisfied by an
 * implementation that reports total elapsed time in every bucket — precisely
 * the latency inflation `CallTiming` exists to separate out — so a one-sided
 * threshold silently stops discriminating.
 *
 * `actual` accepts `undefined` so an optional field (`firstTokenMs`) fails with
 * the window in the message rather than on a non-null assertion.
 */
export function expectWindow(
  actual: number | undefined,
  [lo, hi]: [number, number],
  label: string,
): void {
  const message = `${label}: expected ${lo}..${hi}ms, got ${String(actual)}ms`;
  expect(actual, message).toBeGreaterThanOrEqual(lo);
  expect(actual, message).toBeLessThanOrEqual(hi);
}

/**
 * Clear every provider credential and base-URL env var for the current test.
 *
 * The unit vitest config loads the repo-root `.env`, and every provider with
 * no configured `apiKey` or `baseUrl` falls back to `OPENAI_API_KEY` /
 * `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` / `*_BASE_URL`. A transport test that
 * asserts on credentials, scopes or origins must therefore not see the
 * developer's environment, or it passes in a key-less worktree, fails in a
 * checkout with `.env`, and prints the real key in the failure diff. Pair it with `vi.unstubAllEnvs()` in `afterEach`;
 * `vi.restoreAllMocks()` does not restore env.
 */
export function isolateProviderEnv(): void {
  for (const name of [
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
  ]) {
    vi.stubEnv(name, undefined);
  }
}
