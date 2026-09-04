import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockProvider } from '../mock-provider.js';

const messages = [{ role: 'user' as const, content: 'hello' }];

describe('MockProvider signal handling', () => {
  afterEach(() => vi.useRealTimers());

  it('rejects a pre-aborted chat before invoking the response function, preserving the reason', async () => {
    const controller = new AbortController();
    const reason = new Error('already cancelled');
    controller.abort(reason);
    let invoked = false;
    const provider = MockProvider.fn(async () => {
      invoked = true;
      return { content: 'unexpected' };
    });

    await expect(provider.chat(messages, { signal: controller.signal } as never)).rejects.toBe(
      reason,
    );
    expect(invoked).toBe(false);
    expect(provider.calls).toHaveLength(1);
  });

  it('rejects an in-flight async chat promptly with the exact abort reason', async () => {
    const controller = new AbortController();
    const reason = { source: 'test-abort' };
    const provider = MockProvider.fn(
      () =>
        new Promise<{ content: string }>((resolve) =>
          setTimeout(() => resolve({ content: 'late' }), 100),
        ),
    );

    const pending = provider.chat(messages, { signal: controller.signal } as never);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(provider.calls).toHaveLength(1);
  });

  it('aborts an inter-chunk delay and emits no later chunks or done chunk', async () => {
    const controller = new AbortController();
    const reason = new Error('stop stream');
    const provider = MockProvider.chunked(['abcdef'], 2);
    provider.chunkDelayMs = 100;
    const iterator = provider.stream(messages, { signal: controller.signal } as never);

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'text_delta', content: 'ab' },
      done: false,
    });
    controller.abort(reason);
    await expect(iterator.next()).rejects.toBe(reason);
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it('clears the pending inter-chunk timer when aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const provider = MockProvider.chunked(['abcdef'], 2);
    provider.chunkDelayMs = 10_000;
    const iterator = provider.stream(messages, { signal: controller.signal } as never);

    await iterator.next();
    const pending = iterator.next();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    controller.abort('cancelled');
    await expect(pending).rejects.toBe('cancelled');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps normal no-signal chat and stream behavior', async () => {
    const provider = MockProvider.chunked(['abcdef', 'abcdef'], 2);
    provider.chunkDelayMs = 1;

    await expect(provider.chat(messages, {} as never)).resolves.toMatchObject({
      content: 'abcdef',
    });
    const chunks: string[] = [];
    for await (const chunk of provider.stream(messages, {} as never)) {
      if (chunk.type === 'text_delta') chunks.push(chunk.content);
    }
    expect(chunks).toEqual(['ab', 'cd', 'ef']);
  });
});
