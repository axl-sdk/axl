/**
 * Adapter-side plumbing that turns `fetchWithRetry`'s transport observer into
 * the public {@link CallTiming} block on `ProviderResponse` and the terminal
 * `done` stream chunk.
 *
 * Lives here rather than inline in each adapter because the two non-obvious
 * rules — streamed `wireMs` counts only time spent *awaiting* body reads, and
 * EVERY terminal `done` path must carry timing including the usage-less
 * fallbacks — are exactly the ones that rot when copied four times.
 */

import type { CallTiming } from '../types.js';
import type { StreamChunk } from './types.js';
import type { FetchTiming, FetchWithRetryOptions } from './retry.js';

/**
 * Accumulates one provider call's timing. Create one per `chat()`/`stream()`
 * invocation, hand {@link observer} to `fetchWithRetry`, then read the figures
 * back out.
 *
 * Every accessor returns `undefined` when the transport never reported — a call
 * that threw before returning a `Response` has no timing, by design.
 */
export class CallTimingRecorder {
  private fetchTiming: FetchTiming | undefined;
  private firstTokenAt: number | undefined;
  /** Cumulative time awaiting `reader.read()`, i.e. transport, not consumer. */
  private readWaitMs = 0;

  /** Pass as `timing` in the `fetchWithRetry` options object. */
  readonly observer: NonNullable<FetchWithRetryOptions['timing']> = {
    onComplete: (timing: FetchTiming) => {
      this.fetchTiming = timing;
    },
  };

  /**
   * Await one body read, charging only the wait itself to `wireMs`. Time the
   * consumer spends between reads is excluded because it elapses outside this
   * call.
   */
  async read<T>(
    reader: ReadableStreamDefaultReader<T>,
  ): ReturnType<ReadableStreamDefaultReader<T>['read']> {
    const start = Date.now();
    try {
      return await reader.read();
    } finally {
      this.readWaitMs += Date.now() - start;
    }
  }

  /** Stamp the first content delta. Idempotent — only the first call counts. */
  markFirstToken(): void {
    this.firstTokenAt ??= Date.now();
  }

  /**
   * Timing for a non-streaming call. Call once the response body is parsed.
   *
   * Also the right reading at an adapter's `!res.ok` throw site on BOTH
   * transports: headers have arrived, no body will be streamed, so
   * dispatch → now is the whole of what the provider cost us.
   */
  chatTiming(): CallTiming | undefined {
    const t = this.fetchTiming;
    if (!t) return undefined;
    return {
      queuedMs: t.queuedMs,
      attempts: t.attempts,
      retryMs: t.retryMs,
      ttfbMs: Math.max(0, t.headersAt - t.dispatchedAt),
      wireMs: Math.max(0, Date.now() - t.dispatchedAt),
    };
  }

  /** Timing for a streamed call. Call when building the terminal `done` chunk. */
  streamTiming(): CallTiming | undefined {
    const t = this.fetchTiming;
    if (!t) return undefined;
    const ttfbMs = Math.max(0, t.headersAt - t.dispatchedAt);
    return {
      queuedMs: t.queuedMs,
      attempts: t.attempts,
      retryMs: t.retryMs,
      ttfbMs,
      ...(this.firstTokenAt !== undefined
        ? { firstTokenMs: Math.max(0, this.firstTokenAt - t.dispatchedAt) }
        : {}),
      wireMs: ttfbMs + this.readWaitMs,
    };
  }
}

/**
 * Wrap an adapter's SSE generator so first-token time is stamped and the
 * terminal `done` chunk carries `timing`, whichever of an adapter's several
 * `done` paths produced it. Wrapping at the generator boundary is what makes
 * "every terminal `done` carries timing" structural rather than a checklist.
 */
export async function* withCallTiming(
  recorder: CallTimingRecorder,
  source: AsyncGenerator<StreamChunk>,
): AsyncGenerator<StreamChunk> {
  for await (const chunk of source) {
    if (chunk.type === 'text_delta' || chunk.type === 'thinking_delta') {
      recorder.markFirstToken();
      yield chunk;
    } else if (chunk.type === 'done') {
      const timing = recorder.streamTiming();
      yield timing ? { ...chunk, timing } : chunk;
    } else {
      yield chunk;
    }
  }
}

/** Attach timing to a parsed non-streaming response, when the transport reported it. */
export function withChatTiming<T extends { timing?: CallTiming }>(
  recorder: CallTimingRecorder,
  response: T,
): T {
  const timing = recorder.chatTiming();
  return timing ? { ...response, timing } : response;
}
