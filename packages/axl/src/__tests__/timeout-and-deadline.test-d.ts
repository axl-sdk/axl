/** Public compile-time contract for ctx.ask timeout and cancellation options. */
import { StallTimeoutError, TimeoutError, agent, defineConfig, type AskOptions } from '../index.js';

const controller = new AbortController();

const askOptions: AskOptions = {
  timeout: '30s',
  stallTimeout: '120s',
  signal: controller.signal,
};
void askOptions;

agent({
  model: 'mock:test',
  system: 'test',
  timeout: '45s',
  stallTimeout: '2m',
});

defineConfig({
  defaults: {
    timeout: '60s',
    stallTimeout: '120s',
  },
});

const broadTimeout: TimeoutError = new StallTimeoutError('ctx.ask()', 1_000, 'test-agent');
void broadTimeout;

// @ts-expect-error timeout durations are strings, not raw millisecond numbers.
const invalidTimeout: AskOptions = { timeout: 1_000 };
void invalidTimeout;

// @ts-expect-error stallTimeout durations are strings, not raw millisecond numbers.
const invalidStall: AskOptions = { stallTimeout: 1_000 };
void invalidStall;
