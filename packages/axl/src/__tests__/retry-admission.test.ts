/**
 * Dispatch-level admission (plan A8, I7).
 *
 * Checking the budget only when an operation OPENS is not enough: a request can
 * sit behind a rate governor or sleep through retry backoff for a long time,
 * and by the time it would leave the process the budget may have closed. These
 * tests pin the transport-level check that closes that window, and pin what it
 * must NOT do — become a retryable provider error, look like an abort, or leak
 * the governor permit a sibling call is waiting for.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

import { fetchWithRetry } from '../providers/retry.js';
import { RateLimiter } from '../providers/rate-limiter.js';
import { AdmissionController, externalOperation } from '../accounting.js';
import { AdmissionDeniedError, TranscriptionOperationError } from '../errors.js';
import { ProviderError } from '../providers/errors.js';
import { AxlRuntime } from '../runtime.js';
import { workflow } from '../workflow.js';
import { agent } from '../agent.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { OPENROUTER_PROFILE } from '../providers/profiles/openrouter.js';
import { OpenAIEmbedder } from '../memory/embedder-openai.js';
import { GeminiTranscriptionProvider } from '../providers/gemini-transcription.js';
import { MemoryManager } from '../memory/manager.js';
import { deferred } from './accounting-helpers.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

/** An admission hook that refuses from the Nth attempt onwards. */
function denyFrom(attempt: number): {
  hook: { beforeDispatch(a: number): void };
  seen: number[];
} {
  const seen: number[] = [];
  return {
    seen,
    hook: {
      beforeDispatch(a: number): void {
        seen.push(a);
        if (a >= attempt) {
          throw new AdmissionDeniedError({
            limit: 1,
            knownSpend: 1,
            operation: { kind: 'chat' },
          });
        }
      },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// fetchWithRetry: the checkpoint itself
// ═══════════════════════════════════════════════════════════════════════════

describe('I7: fetchWithRetry checks admission before every dispatch', () => {
  it('does not fetch at all when admission is already closed', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as never;
    const { hook } = denyFrom(1);

    await expect(
      fetchWithRetry('https://example.com', undefined, { admission: hook }),
    ).rejects.toBeInstanceOf(AdmissionDeniedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks again before a RETRY dispatch, so backoff cannot outrun the budget', async () => {
    const retryable = { ok: false, status: 429, headers: new Headers() };
    const fetchMock = vi.fn().mockResolvedValue(retryable);
    globalThis.fetch = fetchMock as never;
    const { hook, seen } = denyFrom(2);

    const call = fetchWithRetry('https://example.com', undefined, { admission: hook });
    const rejection = expect(call).rejects.toBeInstanceOf(AdmissionDeniedError);
    await vi.advanceTimersByTimeAsync(5000);
    await rejection;

    // Attempt 1 dispatched; attempt 2 was refused after the backoff sleep.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([1, 2]);
  });

  it('is not normalized into a ProviderError and is not retried', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as never;
    const { hook } = denyFrom(1);

    let caught: unknown;
    try {
      await fetchWithRetry('https://example.com', undefined, { admission: hook, provider: 'x' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AdmissionDeniedError);
    expect(caught).not.toBeInstanceOf(ProviderError);
    expect((caught as Error).name).not.toBe('AbortError');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('releases the governor permit so a sibling call on the same governor proceeds', async () => {
    // Governors are per adapter instance and shared across concurrent scopes,
    // so a denial that leaked its permit would stall unrelated work.
    const governor = new RateLimiter({ maxConcurrent: 1 });
    const firstDispatched = deferred();
    const releaseFirst = deferred<{ ok: boolean; status: number; headers: Headers }>();

    globalThis.fetch = vi.fn(async () => {
      firstDispatched.resolve();
      return releaseFirst.promise;
    }) as never;

    // Occupies the single permit.
    const holder = fetchWithRetry('https://example.com/first', undefined, { governor });
    await firstDispatched.promise;

    // Queues behind it, and is denied the moment it is granted the permit.
    const { hook } = denyFrom(1);
    const denied = fetchWithRetry('https://example.com/denied', undefined, {
      governor,
      admission: hook,
    });

    releaseFirst.resolve({ ok: true, status: 200, headers: new Headers() });
    await holder;
    await expect(denied).rejects.toBeInstanceOf(AdmissionDeniedError);

    // The permit came back: a third call still gets through.
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
    })) as never;
    const after = await fetchWithRetry('https://example.com/after', undefined, { governor });
    expect(after.ok).toBe(true);
  });

  it('leaves behavior byte-identical when no admission hook is supplied', async () => {
    const success = { ok: true, status: 200, headers: new Headers() };
    const fetchMock = vi.fn().mockResolvedValue(success);
    globalThis.fetch = fetchMock as never;

    const res = await fetchWithRetry('https://example.com');
    expect(res).toBe(success);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// End to end, per transport
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A real built-in adapter (the OpenRouter profile, whose pricing is
 * `from-response`) pointed at a stubbed fetch, so the stub can report an
 * authoritative USD figure and close the budget mid-queue.
 */
function compatibleProvider(governor?: { maxConcurrent: number }): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    profile: OPENROUTER_PROFILE,
    apiKey: 'k',
    ...(governor ? { rateLimit: governor } : {}),
  });
}

describe('I7: a queued built-in chat request is not dispatched after closure', () => {
  it('denies the queued call at dispatch and never fetches it', async () => {
    // Both operations OPEN while the budget is still open, and the second is
    // parked behind the governor's single permit. Only the transport-level
    // check can stop it, because the budget closes while it waits.
    const admission = new AdmissionController({ limit: 1 });
    const provider = compatibleProvider({ maxConcurrent: 1 });
    const runtime = new AxlRuntime({ defaultProvider: 'openrouter' });
    runtime.registerProvider('openrouter', provider);
    const facade = runtime.resolveProvider('openrouter:m').provider;

    const firstDispatched = deferred();
    const releaseFirst = deferred<void>();
    let fetches = 0;
    globalThis.fetch = vi.fn(async () => {
      fetches += 1;
      firstDispatched.resolve();
      await releaseFirst.promise;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          model: 'm',
          choices: [{ message: { role: 'assistant', content: 'hi' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 },
        }),
      };
    }) as never;

    let secondError: unknown;
    const outcome = await runtime.trackOutcome(
      async () => {
        const first = facade.chat([], { model: 'm' });
        const second = facade.chat([], { model: 'm' }).catch((error: unknown) => {
          secondError = error;
          return undefined;
        });
        await firstDispatched.promise;
        // A sibling operation settles and closes the budget while the second
        // chat is still parked in the governor queue.
        await externalOperation({ name: 'sibling' }, async (report) => {
          report.setCost(1);
        });
        releaseFirst.resolve();
        await Promise.all([first, second]);
        return null;
      },
      { admission },
    );

    // The queued request never left the process.
    expect(fetches).toBe(1);
    expect(secondError).toBeInstanceOf(AdmissionDeniedError);
    expect(admission.closed).toBe(true);
    expect(outcome.accounting.knownCost).toBe(1);
    // The denied operation is RETRACTED rather than counted as work, so the
    // identity `total === settled + unknown` still holds.
    expect(outcome.accounting.operations.denied).toBe(1);
    expect(outcome.accounting.operations.total).toBe(2);
    expect(outcome.accounting.operations.settled).toBe(2);
    expect(outcome.accounting.operations.unknown).toBe(0);
    expect(outcome.accounting.operations.byKind).toEqual({ chat: 1, external: 1 });
    expect(outcome.accounting.reasons).toEqual({});
  });
  it('does NOT retract an operation whose earlier attempt already dispatched', async () => {
    // The dangerous case: attempt 1 left the process and may well have been
    // billed, then the budget closed during the backoff. Retracting here would
    // erase a real, possibly-charged operation and let the scope claim it
    // measured everything.
    const admission = new AdmissionController({ limit: 1 });
    const provider = compatibleProvider();
    const runtime = new AxlRuntime({ defaultProvider: 'openrouter' });
    runtime.registerProvider('openrouter', provider);
    const facade = runtime.resolveProvider('openrouter:m').provider;

    const firstDispatched = deferred();
    let fetches = 0;
    globalThis.fetch = vi.fn(async () => {
      fetches += 1;
      firstDispatched.resolve();
      // Retryable, so the transport sleeps and tries again.
      return { ok: false, status: 429, headers: new Headers(), text: async () => 'slow down' };
    }) as never;

    let chatError: unknown;
    const outcome = await runtime.trackOutcome(
      async () => {
        const call = facade.chat([], { model: 'm' }).catch((error: unknown) => {
          chatError = error;
        });
        await firstDispatched.promise;
        // A sibling settles and closes the budget while attempt 2 is backing off.
        await externalOperation({ name: 'sibling' }, async (report) => {
          report.setCost(1);
        });
        await vi.advanceTimersByTimeAsync(5000);
        await call;
        return null;
      },
      { admission },
    );

    expect(fetches).toBe(1);
    expect(chatError).toBeInstanceOf(AdmissionDeniedError);
    // The dispatched call is UNKNOWN, not denied: we cannot prove it was free.
    expect(outcome.accounting.operations.unknown).toBe(1);
    expect(outcome.accounting.reasons).toEqual({ usage_missing: 1 });
    expect(outcome.accounting.operations.denied).toBe(0);
    expect(outcome.accounting.completeness).toBe('incomplete');
    // The identity still holds, and the chat is still counted as an operation.
    expect(outcome.accounting.operations.total).toBe(2);
    expect(outcome.accounting.operations.settled).toBe(1);
    expect(outcome.accounting.operations.byKind).toEqual({ chat: 1, external: 1 });
    expect(outcome.accounting.knownCost).toBe(1);
  });
});

describe('I7: embedding and transcription transports honor the same hook', () => {
  it('denies a queued embedding before it dispatches', async () => {
    const admission = new AdmissionController({ limit: 0 });
    const runtime = new AxlRuntime();
    let fetches = 0;
    globalThis.fetch = vi.fn(async () => {
      fetches += 1;
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ data: [] }) };
    }) as never;

    const embedder = new OpenAIEmbedder({ apiKey: 'k' });
    const manager = new MemoryManager({
      embedder,
      vectorStore: {
        upsert: async () => {},
        search: async () => [],
        delete: async () => {},
      } as never,
    });

    const outcome = await runtime.trackOutcome(
      () => manager.recall('k', {} as never, undefined, { query: 'q' }),
      { admission },
    );

    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.error).toBeInstanceOf(AdmissionDeniedError);
    }
    expect(fetches).toBe(0);
  });

  it('surfaces a transcription denial unwrapped, not as a TranscriptionOperationError', async () => {
    const admission = new AdmissionController({ limit: 0 });
    const runtime = new AxlRuntime();
    let transcribeCalls = 0;
    runtime.registerTranscriptionProvider('stubvoice', {
      name: 'stubvoice',
      capabilities: () => ({ sources: ['bytes'] }),
      transcribe: async () => {
        transcribeCalls += 1;
        return { transcript: { text: 'hi' } };
      },
    } as never);

    runtime.register(
      workflow({
        name: 'transcribe',
        input: z.any(),
        handler: async (ctx) =>
          ctx.transcribe({
            model: 'stubvoice:v',
            audio: { type: 'bytes', data: new Uint8Array([1, 2, 3]), mediaType: 'audio/wav' },
          } as never),
      }),
    );

    const outcome = await runtime.trackOutcome(() => runtime.execute('transcribe', {}), {
      admission,
    });

    expect(outcome.status).toBe('rejected');
    expect(transcribeCalls).toBe(0);
    let sawDenial = false;
    let sawWrapper = false;
    for (
      let c: unknown = outcome.status === 'rejected' ? outcome.error : undefined;
      c != null;
      c = (c as { cause?: unknown }).cause
    ) {
      if (c instanceof AdmissionDeniedError) sawDenial = true;
      if (c instanceof TranscriptionOperationError) sawWrapper = true;
    }
    expect(sawDenial).toBe(true);
    // A budget stop must stay tellable from a vendor failure.
    expect(sawWrapper).toBe(false);
  });
  it('still deletes an uploaded file when the billable request is denied', async () => {
    // Dispatch admission gates BILLABLE requests. Gating the Files API upload
    // and its cleanup DELETE would turn a budget stop into orphaned audio
    // sitting on the vendor's storage for its whole retention window.
    const admission = new AdmissionController({ limit: 1 });
    const runtime = new AxlRuntime();
    runtime.registerTranscriptionProvider(
      'geminivoice',
      new GeminiTranscriptionProvider({ apiKey: 'key' }) as never,
    );
    runtime.register(
      workflow({
        name: 'transcribe-upload',
        input: z.any(),
        handler: async (ctx) =>
          ctx.transcribe({
            model: 'geminivoice:gemini-3.5-transcribe',
            audio: { type: 'bytes', data: new Uint8Array([1, 2, 3]), mediaType: 'audio/wav' },
          } as never),
      }),
    );

    const seen: Array<[string, string | undefined]> = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      seen.push([String(url), init?.method]);
      if (seen.length === 1) {
        return new Response('', {
          status: 200,
          headers: { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/session' },
        });
      }
      if (seen.length === 2) {
        // The upload is finalized — the file now exists and must be cleaned up.
        // The budget closes right here, before the billable request.
        await externalOperation({ name: 'sibling' }, async (report) => {
          report.setCost(1);
        });
        return new Response(
          JSON.stringify({
            file: {
              name: 'files/orphan-candidate',
              uri: 'https://files.test/orphan-candidate',
              mimeType: 'audio/wav',
              state: 'ACTIVE',
            },
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 204 });
    }) as never;

    const outcome = await runtime.trackOutcome(() => runtime.execute('transcribe-upload', {}), {
      admission,
    });

    expect(outcome.status).toBe('rejected');
    expect(outcome.error).toBeInstanceOf(AdmissionDeniedError);
    // The billable `interactions` request never left; the DELETE still did.
    expect(seen).toEqual([
      ['https://generativelanguage.googleapis.com/upload/v1beta/files', 'POST'],
      ['https://generativelanguage.googleapis.com/session', 'POST'],
      ['https://generativelanguage.googleapis.com/v1beta/files/orphan-candidate', 'DELETE'],
    ]);
    expect((outcome.error as { cleanupStatus?: string }).cleanupStatus).toBe('deleted');
  });
});

describe('I7: a custom adapter that ignores the hook still gets the open check', () => {
  it('denies its NEXT operation even though its in-flight transport is uncontrollable', async () => {
    const admission = new AdmissionController({ limit: 1 });
    let calls = 0;
    const uncooperative: import('../providers/types.js').Provider = {
      name: 'custom',
      async chat() {
        calls += 1;
        // Deliberately ignores `options.dispatchAdmission`.
        return {
          content: 'ok',
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          cost: 1,
        };
      },
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error('unused');
      },
    };
    const runtime = new AxlRuntime({ defaultProvider: 'custom' });
    runtime.registerProvider('custom', uncooperative);
    const asker = agent({ name: 'a', model: 'custom:m' });
    let secondError: unknown;
    runtime.register(
      workflow({
        name: 'custom-adapter',
        input: z.any(),
        handler: async (ctx) => {
          await ctx.ask(asker, 'one');
          try {
            await ctx.ask(asker, 'two');
          } catch (error) {
            secondError = error;
          }
          return 'done';
        },
      }),
    );

    const outcome = await runtime.trackOutcome(() => runtime.execute('custom-adapter', {}), {
      admission,
    });

    expect(calls).toBe(1);
    expect(outcome.accounting.knownCost).toBe(1);
    expect(outcome.accounting.operations.denied).toBe(1);
    let sawDenial = false;
    for (let c: unknown = secondError; c != null; c = (c as { cause?: unknown }).cause) {
      if (c instanceof AdmissionDeniedError) sawDenial = true;
    }
    expect(sawDenial).toBe(true);
  });
});
