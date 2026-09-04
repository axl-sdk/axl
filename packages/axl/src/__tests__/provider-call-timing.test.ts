import { describe, it, expect, afterEach, vi } from 'vitest';
import { AnthropicProvider } from '../providers/anthropic.js';
import { OpenAIProvider } from '../providers/openai.js';
import { OpenAIResponsesProvider } from '../providers/openai-responses.js';
import { GeminiProvider } from '../providers/gemini.js';
import { ProviderError } from '../providers/errors.js';
import type { CallTiming, Provider, StreamChunk } from '../providers/types.js';
import { expectWindow } from './helpers.js';

// ---------------------------------------------------------------------------
// AC-3 — every built-in chat adapter reports a CallTiming block on chat() and
// stream(), with each bucket anchored to the right timestamp.
//
// The fetch mock delays headers by H, the first content chunk by a further F,
// and the final chunk by a further B. Those three gaps are far enough apart
// that a swapped or shared anchor lands outside the asserted window — ordering
// assertions alone (`ttfbMs <= wireMs`) would pass on a broken implementation.
//
// Real timers on purpose: the figures under test ARE `Date.now()` deltas, and
// vitest's `shouldAdvanceTime` fake clock ticks in ~20ms steps, which would
// quantize away the very differences these windows discriminate.
// ---------------------------------------------------------------------------

const H = 60; // headers
const F = 90; // headers → first content chunk
const B = 120; // first content chunk → final chunk

/**
 * Two-sided windows, deliberately DISJOINT so the three figures cannot collapse
 * into one another. `ttfbMs`'s upper bound sits below `firstTokenMs`'s lower
 * bound, so aliasing `firstTokenMs` to `ttfbMs` — the single most likely fault —
 * fails a bound rather than sliding through an ordering check.
 *
 * Tolerance is ±40ms on a single delta and −60/+90ms on `wireMs`, which is a sum
 * of three transport gaps plus body parsing.
 */
const TTFB_WINDOW: [number, number] = [H - 40, H + 40]; // 20..100
const FIRST_TOKEN_WINDOW: [number, number] = [H + F - 40, H + F + 40]; // 110..190
const WIRE_WINDOW: [number, number] = [H + F + B - 60, H + F + B + 90]; // 210..360

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** R-T2 specifies integer milliseconds. A float or a negative is a broken clock read. */
function expectValueDomain(t: CallTiming): void {
  for (const [field, value] of Object.entries(t)) {
    if (value === undefined) continue;
    expect(Number.isInteger(value), `${field} must be an integer, got ${String(value)}`).toBe(true);
    expect(value, `${field} must be >= 0`).toBeGreaterThanOrEqual(0);
  }
  expect(t.wireMs).toBeGreaterThanOrEqual(t.ttfbMs);
  if (t.firstTokenMs !== undefined) expect(t.firstTokenMs).toBeGreaterThanOrEqual(t.ttfbMs);
}

/** Non-streaming: headers after H, body resolved a further F + B later. */
function mockChatFetch(json: unknown, delays = { headers: H, body: F + B }) {
  globalThis.fetch = (async () => {
    await sleep(delays.headers);
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => {
        await sleep(delays.body);
        return json;
      },
      text: async () => '',
    };
  }) as unknown as typeof fetch;
}

/**
 * Streaming: headers after H, then one SSE chunk per entry, each enqueued
 * `delayMs` after the previous one was pulled.
 */
function mockStreamFetch(chunks: Array<{ delayMs: number; text: string }>) {
  globalThis.fetch = (async () => {
    await sleep(H);
    const enc = new TextEncoder();
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (i >= chunks.length) {
          controller.close();
          return;
        }
        const chunk = chunks[i++];
        await sleep(chunk.delayMs);
        controller.enqueue(enc.encode(chunk.text));
      },
    });
    return { ok: true, status: 200, headers: new Headers(), body };
  }) as unknown as typeof fetch;
}

async function drain(stream: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

function doneChunk(chunks: StreamChunk[]): Extract<StreamChunk, { type: 'done' }> {
  const done = chunks.find((c) => c.type === 'done');
  expect(done, 'stream produced no terminal done chunk').toBeDefined();
  return done as Extract<StreamChunk, { type: 'done' }>;
}

// ── Per-adapter wire fixtures ───────────────────────────────────────────────

type AdapterCase = {
  name: string;
  model: string;
  make: (rateLimit?: { maxConcurrent: number }) => Provider;
  chatJson: unknown;
  /** SSE text for the first content delta and for the terminal event. */
  sseFirst: string;
  sseLast: string;
};

const sse = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;

const CASES: AdapterCase[] = [
  {
    name: 'anthropic',
    model: 'claude-sonnet-4',
    make: (rateLimit) => new AnthropicProvider({ apiKey: 'k', rateLimit }),
    chatJson: {
      content: [{ type: 'text', text: 'hello' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    sseFirst: sse({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'hello' },
    }),
    sseLast: sse({ type: 'message_stop' }),
  },
  {
    name: 'openai-compatible',
    model: 'gpt-4o',
    make: (rateLimit) => new OpenAIProvider({ apiKey: 'k', rateLimit }),
    chatJson: {
      choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
    sseFirst: sse({ choices: [{ delta: { content: 'hello' } }] }),
    sseLast: 'data: [DONE]\n\n',
  },
  {
    name: 'openai-responses',
    model: 'gpt-4o',
    make: (rateLimit) => new OpenAIResponsesProvider({ apiKey: 'k', rateLimit }),
    chatJson: {
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
    sseFirst: `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: 'hello' })}\n\n`,
    sseLast: `event: response.completed\ndata: ${JSON.stringify({
      response: { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
    })}\n\n`,
  },
  {
    name: 'gemini',
    model: 'gemini-2.5-flash',
    make: (rateLimit) => new GeminiProvider({ apiKey: 'k', rateLimit }),
    chatJson: {
      candidates: [
        { content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    },
    sseFirst: sse({
      candidates: [{ content: { role: 'model', parts: [{ text: 'hello' }] } }],
    }),
    sseLast: sse({
      candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    }),
  },
];

const messages = [{ role: 'user' as const, content: 'hi' }];

for (const c of CASES) {
  describe(`CallTiming — ${c.name}`, () => {
    it('chat() anchors ttfbMs at headers and wireMs at the parsed body', async () => {
      mockChatFetch(c.chatJson);
      const res = await c.make().chat(messages, { model: c.model });

      const t = res.timing;
      expect(t, 'chat() returned no timing block').toBeDefined();
      expect(t!.queuedMs).toBe(0);
      expect(t!.attempts).toBe(1);
      expect(t!.retryMs).toBe(0);
      expectWindow(t!.ttfbMs, TTFB_WINDOW, 'ttfbMs');
      expectWindow(t!.wireMs, WIRE_WINDOW, 'wireMs');
      // An implementation that stops the clock at headers sets wireMs = ttfbMs.
      expect(t!.wireMs - t!.ttfbMs).toBeGreaterThan(100);
      // chat() has no content deltas to time — absent, not zero.
      expect('firstTokenMs' in t!).toBe(false);
      expectValueDomain(t!);
    });

    it('stream() separates headers, first token, and last byte', async () => {
      mockStreamFetch([
        { delayMs: F, text: c.sseFirst },
        { delayMs: B, text: c.sseLast },
      ]);
      const chunks = await drain(c.make().stream(messages, { model: c.model }));

      expect(chunks.some((ch) => ch.type === 'text_delta')).toBe(true);
      const t = doneChunk(chunks).timing;
      expect(t, 'done chunk carried no timing block').toBeDefined();
      expectWindow(t!.ttfbMs, TTFB_WINDOW, 'ttfbMs');
      expectWindow(t!.firstTokenMs, FIRST_TOKEN_WINDOW, 'firstTokenMs');
      expectWindow(t!.wireMs, WIRE_WINDOW, 'wireMs');
      // The windows are disjoint, so this ordering is implied — asserted anyway
      // because it is the property a reader of a trace relies on.
      expect(t!.ttfbMs).toBeLessThan(t!.firstTokenMs!);
      expect(t!.firstTokenMs!).toBeLessThan(t!.wireMs);
      expect(t!.queuedMs).toBe(0);
      expect(t!.attempts).toBe(1);
      expect(t!.retryMs).toBe(0);
      expectValueDomain(t!);
    });

    it('stream() with no content delta reports timing but omits firstTokenMs', async () => {
      // A tool-call-only or empty stream never yields a text/thinking delta.
      // `firstTokenMs` must then be ABSENT, not 0 and not aliased to ttfbMs —
      // either fallback would silently corrupt a cross-model comparison.
      mockStreamFetch([{ delayMs: F + B, text: c.sseLast }]);
      const chunks = await drain(c.make().stream(messages, { model: c.model }));

      expect(chunks.some((ch) => ch.type === 'text_delta' || ch.type === 'thinking_delta')).toBe(
        false,
      );
      const t = doneChunk(chunks).timing;
      expect(t, 'a content-less stream still reports timing').toBeDefined();
      expect('firstTokenMs' in t!).toBe(false);
      expectWindow(t!.ttfbMs, TTFB_WINDOW, 'ttfbMs');
      expectWindow(t!.wireMs, WIRE_WINDOW, 'wireMs');
      expectValueDomain(t!);
    });

    it('stream() releases its permit at headers, not at body end', async () => {
      // Two governed stream() calls, one permit. The first has instant headers
      // and a slow BODY. Since fetchWithRetry releases as it returns the
      // Response, the second call must not wait on that body at all — an
      // implementation holding the permit to generator completion would put
      // ~BODY into the second call's queuedMs. This is the streaming half of
      // the permit-lifetime claim `docs/providers.md` now makes; the
      // non-streaming half is covered per-transport below.
      const BODY = 250;
      let n = 0;
      globalThis.fetch = (async () => {
        const slow = n++ === 0;
        const enc = new TextEncoder();
        const frames = [c.sseFirst, c.sseLast];
        let i = 0;
        return {
          ok: true,
          status: 200,
          headers: new Headers(), // headers are instant for both calls
          body: new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (i >= frames.length) {
                controller.close();
                return;
              }
              await sleep(slow && i === 0 ? BODY : 5);
              controller.enqueue(enc.encode(frames[i++]));
            },
          }),
          text: async () => '',
        };
      }) as unknown as typeof fetch;

      const provider = c.make({ maxConcurrent: 1 });
      const firstDrain = drain(provider.stream(messages, { model: c.model }));
      await sleep(20); // let the first call take the permit
      const secondDrain = drain(provider.stream(messages, { model: c.model }));
      const [firstChunks, secondChunks] = await Promise.all([firstDrain, secondDrain]);

      const first = doneChunk(firstChunks).timing!;
      const second = doneChunk(secondChunks).timing!;
      expectWindow(first.queuedMs, [0, 60], 'first queuedMs');
      expectWindow(second.queuedMs, [0, BODY * 0.4], 'queuedMs behind a slow stream body');
      // The slow body is not lost — it lands in the first call's wireMs, which
      // is what makes the assertion above a separation rather than an absence.
      // Positive control for the near-zero window: the governed fan-out case
      // below, and `retry.test.ts`'s AC-1 case, both show queuedMs rising to
      // hundreds of ms when the permit genuinely IS held that long. So a ~0
      // here means "excluded", not "never measured".
      expect(first.wireMs).toBeGreaterThan(BODY * 0.7);
    });

    it('stream() does not charge consumer time to wireMs', async () => {
      // Same stream, but the consumer sleeps a long time between pulls. wireMs
      // measures transport only, so it stays bounded by the transport delays;
      // a naive "now minus dispatch, at the done chunk" implementation would
      // grow by the consumer's sleeps and blow the bound.
      const SLOW = 250;
      mockStreamFetch([
        { delayMs: F, text: c.sseFirst },
        { delayMs: B, text: c.sseLast },
      ]);

      const collected: StreamChunk[] = [];
      const started = Date.now();
      for await (const chunk of c.make().stream(messages, { model: c.model })) {
        collected.push(chunk);
        await sleep(SLOW);
      }
      const wallClock = Date.now() - started;

      const t = doneChunk(collected).timing;
      // Upper bound is the transport's own delays; the later chunk may well
      // have arrived DURING the consumer's sleep, which legitimately shortens
      // the measured read wait. What must never happen is absorbing the sleep.
      expectWindow(t!.wireMs, [TTFB_WINDOW[0], WIRE_WINDOW[1]], 'wireMs under a slow consumer');
      // firstTokenMs is unshifted too — it is stamped at the delta, not at the
      // consumer's next pull.
      expectWindow(t!.firstTokenMs, FIRST_TOKEN_WINDOW, 'firstTokenMs under a slow consumer');
      // The discriminating comparison, stated against the measured run rather
      // than a fixture formula (how many consumer sleeps elapse before the
      // done chunk is built depends on how the adapter frames its last SSE
      // event): a naive `Date.now() - dispatchedAt` at the done chunk reports
      // roughly the whole wall clock. wireMs must exclude at least one full
      // consumer sleep.
      expect(
        t!.wireMs,
        `wireMs ${t!.wireMs}ms must exclude consumer time (wall clock ${wallClock}ms)`,
      ).toBeLessThan(wallClock - SLOW * 0.9);
      // And the run really was slow, so the comparison above is not vacuous.
      expect(wallClock - t!.wireMs).toBeGreaterThan(2 * SLOW * 0.9);
    });
  });
}

describe('CallTiming — governed fan-out', () => {
  it('charges the queued call, not the provider (openai-compatible)', async () => {
    // One permit, two concurrent asks. The first fetch is slow, the second is
    // fast, so the waiter's queue time and its own response time differ.
    let n = 0;
    globalThis.fetch = (async () => {
      const first = n++ === 0;
      await sleep(first ? 200 : 20);
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider({ apiKey: 'k', rateLimit: { maxConcurrent: 1 } });
    const [a, b] = await Promise.all([
      provider.chat(messages, { model: 'gpt-4o' }),
      provider.chat(messages, { model: 'gpt-4o' }),
    ]);

    const queued = [a.timing!.queuedMs, b.timing!.queuedMs].sort((x, y) => x - y);
    expectWindow(queued[0], [0, 50], 'winner queuedMs');
    expectWindow(queued[1], [150, 320], 'waiter queuedMs');
    // The waiter's own wire time is the fast fetch and nothing else. An
    // implementation measuring from acquire-start would land near 220 here.
    const waiter = a.timing!.queuedMs > b.timing!.queuedMs ? a.timing! : b.timing!;
    expectWindow(waiter.wireMs, [0, 120], 'waiter wireMs');
  });
});

// ---------------------------------------------------------------------------
// Permit lifetime. `fetchWithRetry` releases in a `finally` as it returns the
// Response, so the release is at HEADERS on both transports — the adapter reads
// the body afterwards, outside the permit. `docs/providers.md` now makes this a
// load-bearing claim about how to read `queuedMs`; these two cases pin it.
// ---------------------------------------------------------------------------

const OPENAI_CHAT_JSON = {
  choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

describe('CallTiming — permit lifetime', () => {
  it('does not charge a slow response BODY to the next call (release is at headers)', async () => {
    // Headers land instantly; only `json()` is slow. If the permit were held
    // until the adapter finished reading the body, the second call would report
    // queuedMs ≈ BODY. Release-at-headers predicts ≈ 0 for both.
    const BODY = 300;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => {
        await sleep(BODY);
        return OPENAI_CHAT_JSON;
      },
      text: async () => '',
    })) as unknown as typeof fetch;

    const provider = new OpenAIProvider({ apiKey: 'k', rateLimit: { maxConcurrent: 1 } });
    const [a, b] = await Promise.all([
      provider.chat(messages, { model: 'gpt-4o' }),
      provider.chat(messages, { model: 'gpt-4o' }),
    ]);

    for (const t of [a.timing!, b.timing!]) {
      expectWindow(t.queuedMs, [0, 100], 'queuedMs with a slow body');
    }
    // Body time is real and is attributed to wireMs, just not to the queue.
    expectWindow(a.timing!.wireMs, [BODY - 60, BODY + 150], 'wireMs covers the body');
  });

  it('does not charge a slow stream CONSUMER to the next call (A7)', async () => {
    // One permit. Call A streams and its consumer dawdles for SLOW after
    // headers before draining. If the permit were released at generator
    // completion rather than at headers, B's queuedMs would absorb SLOW.
    const SLOW = 400;
    let n = 0;
    globalThis.fetch = (async () => {
      const enc = new TextEncoder();
      const isStream = n++ === 0;
      if (!isStream) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => OPENAI_CHAT_JSON,
          text: async () => '',
        };
      }
      let i = 0;
      const frames = [sse({ choices: [{ delta: { content: 'hello' } }] }), 'data: [DONE]\n\n'];
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (i >= frames.length) {
              controller.close();
              return;
            }
            await sleep(20);
            controller.enqueue(enc.encode(frames[i++]));
          },
        }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider({ apiKey: 'k', rateLimit: { maxConcurrent: 1 } });

    const streamed = (async () => {
      const out: StreamChunk[] = [];
      let first = true;
      for await (const chunk of provider.stream(messages, { model: 'gpt-4o' })) {
        if (first) {
          first = false;
          await sleep(SLOW); // dawdle right after headers
        }
        out.push(chunk);
      }
      return out;
    })();
    // Started after the stream so it queues behind it.
    await sleep(10);
    const chatted = provider.chat(messages, { model: 'gpt-4o' });

    const [chunks, chat] = await Promise.all([streamed, chatted]);

    expectWindow(chat.timing!.queuedMs, [0, 150], 'queuedMs behind a slow stream consumer');
    // The stream's own wireMs is likewise unmoved by its consumer.
    expect(doneChunk(chunks).timing!.wireMs).toBeLessThan(SLOW);
  });
});

// ---------------------------------------------------------------------------
// Adapter-level retry (matrix A8). Retries were only covered at the transport
// level; `wireMs` is computed in the adapter's recorder, so a wrong anchor
// there — the fault that would reproduce the original inflation inside the new
// field — was untested on the public path.
// ---------------------------------------------------------------------------

describe('CallTiming — adapter-level retry (A8)', () => {
  const BACKOFF = 300; // Retry-After: 0.3 ⇒ jittered to 225..375ms
  const WIRE = 150; // the successful attempt's own latency

  /** 429 with Retry-After, then a 200 whose headers take WIRE ms. */
  function mock429ThenOk(ok: () => Record<string, unknown>, stream = false) {
    let n = 0;
    globalThis.fetch = (async () => {
      if (n++ === 0) {
        return {
          ok: false,
          status: 429,
          headers: new Headers({ 'retry-after': '0.3' }),
          text: async () => '{"error":{"message":"slow down"}}',
          json: async () => ({}),
        };
      }
      await sleep(WIRE);
      const enc = new TextEncoder();
      let i = 0;
      const frames = [sse({ choices: [{ delta: { content: 'hello' } }] }), 'data: [DONE]\n\n'];
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ok(),
        text: async () => '',
        ...(stream
          ? {
              body: new ReadableStream<Uint8Array>({
                pull(controller) {
                  if (i >= frames.length) controller.close();
                  else controller.enqueue(enc.encode(frames[i++]));
                },
              }),
            }
          : {}),
      };
    }) as unknown as typeof fetch;
  }

  it('chat(): retryMs holds the backoff and wireMs holds only the final attempt', async () => {
    mock429ThenOk(() => OPENAI_CHAT_JSON);
    const res = await new OpenAIProvider({ apiKey: 'k' }).chat(messages, { model: 'gpt-4o' });

    const t = res.timing!;
    expect(t.attempts).toBe(2);
    expectWindow(t.retryMs, [BACKOFF * 0.75 - 40, BACKOFF * 1.25 + 120], 'retryMs');
    // The decisive bound: wireMs must NOT contain the ~300ms backoff. An
    // implementation anchoring on the first dispatch lands near 450.
    expectWindow(t.wireMs, [WIRE - 60, WIRE + 150], 'wireMs excludes the backoff');
    expect(t.wireMs).toBeLessThan(t.retryMs);
    expectWindow(t.ttfbMs, [WIRE - 60, WIRE + 100], 'ttfbMs anchors on the final attempt');
    expectValueDomain(t);
  });

  it('stream(): same anchoring on the done chunk', async () => {
    mock429ThenOk(() => OPENAI_CHAT_JSON, true);
    const chunks = await drain(
      new OpenAIProvider({ apiKey: 'k' }).stream(messages, { model: 'gpt-4o' }),
    );

    const t = doneChunk(chunks).timing!;
    expect(t.attempts).toBe(2);
    expectWindow(t.retryMs, [BACKOFF * 0.75 - 40, BACKOFF * 1.25 + 120], 'retryMs');
    expectWindow(t.wireMs, [WIRE - 60, WIRE + 150], 'wireMs excludes the backoff');
    // firstTokenMs is measured from the FINAL dispatch, so the backoff is not
    // inside it either.
    expect(t.firstTokenMs).toBeLessThan(t.retryMs);
    expectValueDomain(t);
  });
});

// ---------------------------------------------------------------------------
// Stream lifecycle through the `withCallTiming` wrapper. The wrapper adds a
// generator frame between the runtime's `for await` and the adapter's parser;
// the one thing it could have broken is cleanup when a consumer walks away
// mid-body.
// ---------------------------------------------------------------------------

describe('CallTiming — abandoned stream still releases the reader', () => {
  it('runs the adapter reader cleanup when the consumer breaks early', async () => {
    const enc = new TextEncoder();
    const frames = [
      sse({ choices: [{ delta: { content: 'one' } }] }),
      sse({ choices: [{ delta: { content: 'two' } }] }),
      'data: [DONE]\n\n',
    ];
    let i = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= frames.length) controller.close();
        else controller.enqueue(enc.encode(frames[i++]));
      },
    });
    // Spy on the real reader so we can prove releaseLock() ran.
    const realReader = source.getReader();
    realReader.releaseLock();
    const releaseLock = vi.fn();
    const body = {
      getReader: () => {
        const reader = source.getReader();
        return {
          read: () => reader.read(),
          releaseLock: () => {
            releaseLock();
            reader.releaseLock();
          },
        };
      },
    } as unknown as ReadableStream<Uint8Array>;

    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body,
      text: async () => '',
    })) as unknown as typeof fetch;

    const stream = new OpenAIProvider({ apiKey: 'k' }).stream(messages, { model: 'gpt-4o' });
    for await (const chunk of stream) {
      if (chunk.type === 'text_delta') break; // walk away mid-body
    }

    // `for await` closes the wrapper, which closes the adapter generator, whose
    // `finally` releases the lock. Without that chain the stream stays locked
    // and the socket leaks.
    expect(releaseLock).toHaveBeenCalled();
    expect(source.locked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error-path timing. A failed call is the case an operator most wants measured
// — "is the provider slow or is it throttling me?" is asked about failures far
// more often than about successes. Every adapter's non-2xx throw site now
// carries the same block a success would, on both transports.
//
// The discriminating property is not merely "a timing block exists": it is that
// the block is REAL. The mocks below delay headers by H and the error body by a
// further F + B, so a throw site that reused a zero-filled block, or stopped the
// clock at dispatch, lands outside both windows.
// ---------------------------------------------------------------------------

/** Non-2xx whose headers land after H and whose error body resolves F + B later. */
function mockErrorFetch(status: number, body = '{"error":{"message":"boom"}}') {
  globalThis.fetch = (async () => {
    await sleep(H);
    return {
      ok: false,
      status,
      headers: new Headers(),
      text: async () => {
        await sleep(F + B);
        return body;
      },
      json: async () => JSON.parse(body) as unknown,
    };
  }) as unknown as typeof fetch;
}

async function caught(fn: () => Promise<unknown>): Promise<ProviderError> {
  const err = await fn().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, 'expected the call to throw').toBeInstanceOf(ProviderError);
  return err as ProviderError;
}

for (const c of CASES) {
  describe(`CallTiming — error path (${c.name})`, () => {
    it('chat() attaches timing to the thrown ProviderError', async () => {
      mockErrorFetch(500);
      const err = await caught(() => c.make().chat(messages, { model: c.model }));

      expect(err.status).toBe(500);
      const t = err.timing;
      expect(t, 'a 500 with a response carries timing').toBeDefined();
      expect(t!.attempts).toBe(1);
      expect(t!.queuedMs).toBe(0);
      expect(t!.retryMs).toBe(0);
      expectWindow(t!.ttfbMs, TTFB_WINDOW, 'error ttfbMs');
      expectWindow(t!.wireMs, WIRE_WINDOW, 'error wireMs');
      // A zero-filled or dispatch-anchored block would collapse these two.
      expect(t!.wireMs - t!.ttfbMs).toBeGreaterThan(100);
      expectValueDomain(t!);
      // The rest of the typed error is untouched by the addition.
      expect(err.retryable).toBe(true);
      expect(err.body).toContain('boom');
    });

    it('stream() attaches timing to the pre-body ProviderError', async () => {
      // Headers have arrived and no body will be streamed, so the streaming
      // throw site reports chat semantics: dispatch → now.
      mockErrorFetch(500);
      const err = await caught(() => drain(c.make().stream(messages, { model: c.model })));

      const t = err.timing;
      expect(t, 'a failed stream carries timing too').toBeDefined();
      expectWindow(t!.ttfbMs, TTFB_WINDOW, 'error ttfbMs (stream)');
      expectWindow(t!.wireMs, WIRE_WINDOW, 'error wireMs (stream)');
      // Nothing streamed, so there is no first token to report.
      expect('firstTokenMs' in t!).toBe(false);
      expectValueDomain(t!);
    });
  });
}

describe('CallTiming — error path, exhausted retries', () => {
  const RETRY_AFTER_MS = 200;

  it('reports every attempt and the accumulated backoff on a 429 storm', async () => {
    let n = 0;
    globalThis.fetch = (async () => {
      n++;
      return {
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': '0.2' }),
        text: async () => '{"error":{"message":"rate limited"}}',
        json: async () => ({}),
      };
    }) as unknown as typeof fetch;

    const err = await caught(() =>
      new OpenAIProvider({ apiKey: 'k' }).chat(messages, { model: 'gpt-4o' }),
    );

    expect(err.status).toBe(429);
    expect(n).toBe(3); // transport default: 2 retries, 3 attempts
    const t = err.timing!;
    expect(t.attempts).toBe(3);
    // Two jittered (±25%) Retry-After sleeps. An implementation reporting only
    // the final attempt would land near 0 here — this is the figure that makes
    // "the provider is throttling me" legible from a failure.
    expectWindow(
      t.retryMs,
      [RETRY_AFTER_MS * 0.75 * 2 - 60, RETRY_AFTER_MS * 1.25 * 2 + 250],
      'retryMs across exhausted retries',
    );
    // ttfb/wire stay anchored on the FINAL attempt, so the backoff is not in
    // them — the same separation the success path guarantees.
    expect(t.ttfbMs).toBeLessThan(t.retryMs);
    expectValueDomain(t);
  });

  it('a network failure carries NO timing key at all', async () => {
    // `fetch` rejects: there is no Response, so nothing was measured. The KEY
    // must be absent — `timing: undefined` would survive a JSON round-trip as
    // a present-but-null field and read as "measured, and it was nothing".
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    const err = await caught(() =>
      new OpenAIProvider({ apiKey: 'k' }).chat(messages, { model: 'gpt-4o' }),
    );

    expect(err.status).toBe(0);
    expect(err.message).toBe('fetch failed');
    expect('timing' in err).toBe(false);
    expect(err.timing).toBeUndefined();
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Mid-stream provider errors. A provider that opens a 200 stream and then sends
// an SSE `error` frame is a failure with a *response* — so it falls under the
// same contract as a non-2xx: timing present. Unlike the pre-body throws above,
// content may already have flowed, so these sites report STREAM semantics
// (read-wait `wireMs`, and a real `firstTokenMs`).
// ---------------------------------------------------------------------------

describe('CallTiming — mid-stream error frame (anthropic)', () => {
  it('carries stream-semantics timing on the thrown ProviderError', async () => {
    mockStreamFetch([
      {
        delayMs: F,
        text: sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hel' } }),
      },
      {
        delayMs: B,
        text: sse({ type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }),
      },
    ]);

    const err = await caught(() =>
      drain(new AnthropicProvider({ apiKey: 'k' }).stream(messages, { model: 'claude-sonnet-4' })),
    );

    expect(err.status).toBe(529);
    expect(err.message).toBe('overloaded');
    const t = err.timing;
    expect(t, 'a mid-stream error frame carries timing').toBeDefined();
    expect(t!.attempts).toBe(1);
    expectWindow(t!.ttfbMs, TTFB_WINDOW, 'mid-stream ttfbMs');
    // The discriminating figure: a delta really did arrive before the error, so
    // firstTokenMs must be present and land in its own disjoint window. A site
    // reusing `chatTiming()` here would omit it entirely, and a zero-filled
    // block would land below the window.
    expectWindow(t!.firstTokenMs, FIRST_TOKEN_WINDOW, 'mid-stream firstTokenMs');
    expectWindow(t!.wireMs, WIRE_WINDOW, 'mid-stream wireMs');
    expect(t!.firstTokenMs!).toBeLessThan(t!.wireMs);
    expectValueDomain(t!);
  });
});

describe('CallTiming — mid-stream error frame (openai-compatible)', () => {
  // These two sites stamp `status: 0` because OpenAI's stream error payloads
  // carry no HTTP status to map. That is NOT the "no response" case: headers and
  // body bytes arrived and tokens streamed, so timing is present. Presence keys
  // off the response, not off the status — the property these two cases pin.

  it('carries stream-semantics timing on an SSE error frame', async () => {
    mockStreamFetch([
      { delayMs: F, text: sse({ choices: [{ delta: { content: 'hel' } }] }) },
      { delayMs: B, text: sse({ error: { message: 'upstream exploded', type: 'server_error' } }) },
    ]);

    const err = await caught(() =>
      drain(new OpenAIProvider({ apiKey: 'k' }).stream(messages, { model: 'gpt-4o' })),
    );

    expect(err.message).toBe('upstream exploded');
    expect(err.status).toBe(0);
    const t = err.timing;
    expect(t, 'a status-0 mid-stream frame still carries timing').toBeDefined();
    expectWindow(t!.ttfbMs, TTFB_WINDOW, 'mid-stream ttfbMs');
    expectWindow(t!.firstTokenMs, FIRST_TOKEN_WINDOW, 'mid-stream firstTokenMs');
    expectWindow(t!.wireMs, WIRE_WINDOW, 'mid-stream wireMs');
    expectValueDomain(t!);
  });

  it('carries timing on a stream truncated before [DONE]', async () => {
    // The figure that matters here: a provider that hung AFTER first token must
    // be distinguishable from one that never produced a token at all. Only
    // `firstTokenMs` separates them, and it exists solely because the error
    // carries timing.
    mockStreamFetch([{ delayMs: F, text: sse({ choices: [{ delta: { content: 'hel' } }] }) }]);

    const err = await caught(() =>
      drain(new OpenAIProvider({ apiKey: 'k' }).stream(messages, { model: 'gpt-4o' })),
    );

    expect(err.message).toContain('stream ended before [DONE]');
    const t = err.timing;
    expect(t, 'a truncated stream still carries timing').toBeDefined();
    expectWindow(t!.ttfbMs, TTFB_WINDOW, 'truncated ttfbMs');
    expectWindow(t!.firstTokenMs, FIRST_TOKEN_WINDOW, 'truncated firstTokenMs');
    expect(t!.wireMs).toBeGreaterThanOrEqual(t!.firstTokenMs!);
    expectValueDomain(t!);
  });
});
