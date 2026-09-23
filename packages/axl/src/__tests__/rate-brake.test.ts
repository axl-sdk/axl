import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AxlRuntime } from '../runtime.js';
import { ProviderError } from '../providers/errors.js';
import { AdmissionDeniedError } from '../errors.js';
import { openaiQuotaDialect } from '../providers/quota.js';
import { DEFAULT_MAX_RATE_LIMIT_RETRIES, ScopeGovernor } from '../providers/governor-pool.js';
import { fetchWithRetry, type FetchTiming } from '../providers/retry.js';
import type { RateLimitConfig } from '../providers/rate-limiter.js';
import type { ChatOptions, Provider, ProviderResponse, StreamChunk } from '../providers/types.js';

// ---------------------------------------------------------------------------
// Phase 4 of adaptive rate governance: the fleet brake, the restructured retry
// loop and split budgets (plan §4.5, §4.6; AC16–AC28, AC33, AC39, AC40, and
// the AC22 containment half).
//
// Every case runs a REAL adapter resolved through `AxlRuntime` against a
// stubbed `globalThis.fetch` that returns real `Response` objects after a
// scripted delay on the fake clock. The dispatch log records who left when;
// assertions name calls and times, not bare counts. Fake timers without
// `shouldAdvanceTime`, `Math.random` pinned so jitter is exactly 1.0, manual
// AbortControllers only.
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 8, 22); // a realistic epoch: HTTP-date parsing compares against it

const OPENAI_CHAT_JSON = {
  choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};
const RESPONSES_JSON = {
  output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
};
const ANTHROPIC_JSON = {
  content: [{ type: 'text', text: 'hello' }],
  usage: { input_tokens: 1, output_tokens: 1 },
};
const GEMINI_JSON = {
  candidates: [{ content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
};

function okBodyFor(url: string, stream: boolean): string {
  if (stream) {
    return (
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'hello' } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
      'data: [DONE]\n\n'
    );
  }
  if (url.endsWith('/chat/completions')) return JSON.stringify(OPENAI_CHAT_JSON);
  if (url.endsWith('/responses')) return JSON.stringify(RESPONSES_JSON);
  if (url.endsWith('/messages')) return JSON.stringify(ANTHROPIC_JSON);
  if (url.includes(':generateContent')) return JSON.stringify(GEMINI_JSON);
  throw new Error(`unexpected URL in fetch stub: ${url}`);
}

// Vendor-documented spend-cap shapes (plan §9 Q7; live capture is L3).
const OPENAI_SPEND_CAP = JSON.stringify({
  error: {
    message: 'You exceeded your current quota, please check your plan and billing details.',
    type: 'insufficient_quota',
    param: null,
    code: 'insufficient_quota',
  },
});
const ANTHROPIC_SPEND_CAP = JSON.stringify({
  type: 'error',
  error: {
    type: 'rate_limit_error',
    message: 'You have reached your API usage limits.',
    details: { error_code: 'enforced_spend_limit_reached' },
  },
  request_id: 'req_1',
});
const RATE_LIMIT_BODY = JSON.stringify({
  error: { message: 'Rate limit reached', type: 'rate_limit_error', code: 'rate_limit_exceeded' },
});

type Reply = {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  /** Headers arrive this many ms after dispatch (fake clock). */
  after?: number;
  /** Return a bare object fixture (no clone, no body) instead of a Response. */
  bare?: boolean;
};

type Dispatch = {
  i: number;
  tag: string;
  /** 1-indexed dispatch count for this tag. */
  attempt: number;
  at: number;
  url: string;
  /** The Response returned, for body-cancel assertions. */
  res?: Response;
};

// `Response.clone()` replaces `res.body` with a tee branch, so a spy placed on
// the original stream would miss the transport's cancel. Record the receiver
// of every `ReadableStream.prototype.cancel` instead and look up the
// response's CURRENT body.
let cancelledStreams: Set<ReadableStream>;
function bodyCancelled(d: Dispatch): boolean {
  return d.res?.body != null && cancelledStreams.has(d.res.body);
}

/** `fetch` stub driven by `script`. Honors abort like real fetch. */
function stubFetch(script: (d: Dispatch) => Reply) {
  const log: Dispatch[] = [];
  const perTag = new Map<string, number>();
  let inFlight = 0;
  let peak = 0;
  globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError');
    const url = String(input);
    const tag = /call-[A-Za-z0-9]+/.exec(String(init?.body))?.[0] ?? 'untagged';
    const attempt = (perTag.get(tag) ?? 0) + 1;
    perTag.set(tag, attempt);
    const d: Dispatch = { i: log.length, tag, attempt, at: Date.now(), url };
    log.push(d);
    const reply = script(d);
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      if (reply.after) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, reply.after);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('This operation was aborted', 'AbortError'));
          });
        });
      }
    } finally {
      inFlight--;
    }
    if (reply.bare) {
      return { ok: false, status: reply.status, headers: new Headers(reply.headers) } as Response;
    }
    const stream = /"stream":true/.test(String(init?.body));
    const body = reply.body ?? (reply.status === 200 ? okBodyFor(url, stream) : RATE_LIMIT_BODY);
    const res = new Response(body, { status: reply.status, headers: reply.headers });
    d.res = res;
    return res;
  }) as unknown as typeof fetch;
  return {
    log,
    get peak() {
      return peak;
    },
    /** Dispatches of one call, in order. */
    of(tag: string) {
      return log.filter((d) => d.tag === tag);
    },
  };
}

type Outcome = { ok: true; value: ProviderResponse } | { ok: false; error: unknown };

function outcome(p: Promise<ProviderResponse>): Promise<Outcome> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

type Family = 'openai' | 'openai-responses' | 'anthropic' | 'google' | 'groq';
const MODEL: Record<Family, string> = {
  openai: 'gpt-4o',
  'openai-responses': 'gpt-4o',
  anthropic: 'claude-sonnet-4',
  google: 'gemini-2.5-flash',
  groq: 'llama-3.3-70b',
};

function providerFor(family: Family, rateLimit?: RateLimitConfig, baseUrl?: string): Provider {
  const runtime = new AxlRuntime({
    providers: {
      [family]: {
        apiKey: 'k',
        ...(rateLimit ? { rateLimit } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      },
    },
  });
  return runtime.resolveProvider(`${family}:${MODEL[family]}`).provider;
}

function ask(
  provider: Provider,
  tag: string,
  options: Partial<ChatOptions> = {},
  model = 'gpt-4o',
): Promise<ProviderResponse> {
  return provider.chat([{ role: 'user', content: tag }], { model, ...options });
}

/** The pooled governor behind `provider` for `model` (internal; for permit-count checks). */
function governorOf(provider: Provider, model = 'gpt-4o'): ScopeGovernor {
  const governors = (
    provider as unknown as {
      axlRateGovernors: { governorFor(m: string): ScopeGovernor | undefined };
    }
  ).axlRateGovernors;
  return governors.governorFor(model)!;
}
function activePermits(gov: ScopeGovernor): number {
  return (gov as unknown as { active: number }).active;
}

async function at(t: number): Promise<void> {
  const delta = T0 + t - Date.now();
  if (delta < 0) throw new Error(`clock already past T0+${t}`);
  await vi.advanceTimersByTimeAsync(delta);
}
const tick = () => vi.advanceTimersByTimeAsync(0);

const originalFetch = globalThis.fetch;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.spyOn(Math, 'random').mockReturnValue(0.5); // jitter factor exactly 1.0
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  cancelledStreams = new Set();
  const cancel = ReadableStream.prototype.cancel;
  vi.spyOn(ReadableStream.prototype, 'cancel').mockImplementation(function (
    this: ReadableStream,
    reason?: unknown,
  ) {
    cancelledStreams.add(this);
    return cancel.call(this, reason);
  });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// AC16 / AC17 / E9 — one rate-limit 429 brakes every caller on the scope.
// ---------------------------------------------------------------------------

describe('AC16/AC17: the fleet brake', () => {
  it('no dispatch during the brake — not queued callers, not a waking 503 sleeper; retriers go first after it', async () => {
    const net = stubFetch((d) => {
      if (d.attempt > 1) return { status: 200, after: 50 };
      if (d.tag === 'call-2') return { status: 429, headers: { 'retry-after': '2' }, after: 5 };
      if (d.tag === 'call-0') return { status: 503, after: 10 };
      return { status: 200, after: d.i < 5 ? 20 : 50 };
    });
    const provider = providerFor('openai', { maxConcurrent: 5 });
    const calls = Array.from({ length: 10 }, (_, k) => outcome(ask(provider, `call-${k}`)));

    await at(2004); // brake ends at T0 + 5 + 2000
    // Exactly the first wave left before the brake ended. The 503 sleeper
    // (call-0) woke at T0+1010 inside the brake and did not dispatch; the five
    // queued callers did not take the permits freed at T0+20.
    expect(net.log.map((d) => [d.tag, d.at - T0])).toEqual([
      ['call-0', 0],
      ['call-1', 0],
      ['call-2', 0],
      ['call-3', 0],
      ['call-4', 0],
    ]);

    await at(2005);
    // Retriers re-acquire ahead of first-time callers, in the order they parked.
    expect(net.log.slice(5).map((d) => [d.tag, d.attempt, d.at - T0])).toEqual([
      ['call-2', 2, 2005],
      ['call-0', 2, 2005],
      ['call-5', 1, 2005],
      ['call-6', 1, 2005],
      ['call-7', 1, 2005],
    ]);

    await vi.runAllTimersAsync();
    const results = await Promise.all(calls);
    // AC17: nothing lost; only the 429'd and 503'd calls retried.
    expect(results.map((r) => (r.ok ? r.value.timing?.attempts : 'rejected'))).toEqual([
      2, 1, 2, 1, 1, 1, 1, 1, 1, 1,
    ]);
    expect(net.peak).toBeLessThanOrEqual(5);
  });

  it('AC17: a saturated scope completes every call with zero loss', async () => {
    // The account refuses everything for 3 s, each time with Retry-After: 1.
    const net = stubFetch((d) =>
      d.at < T0 + 3000
        ? { status: 429, headers: { 'retry-after': '1' }, after: 5 }
        : { status: 200, after: 5 },
    );
    const provider = providerFor('openai', { maxConcurrent: 5 });
    const calls = Array.from({ length: 10 }, (_, k) => outcome(ask(provider, `call-${k}`)));
    await vi.runAllTimersAsync();
    const results = await Promise.all(calls);
    expect(results.filter((r) => !r.ok)).toEqual([]);
    // Every call's last attempt is the one that landed after the window.
    for (let k = 0; k < 10; k++) {
      const attempts = net.of(`call-${k}`);
      expect(attempts.at(-1)!.at).toBeGreaterThanOrEqual(T0 + 3000);
      expect(attempts.slice(0, -1).every((d) => d.at < T0 + 3000)).toBe(true);
    }
    expect(net.peak).toBeLessThanOrEqual(5);
  });

  it.each<[Family]>([['openai'], ['openai-responses'], ['anthropic']])(
    '%s: a rate-limit 429 holds a sibling that arrives during the brake, with no rateLimit configured',
    async (family) => {
      const model = MODEL[family];
      const net = stubFetch((d) =>
        d.tag === 'call-a' && d.attempt === 1
          ? { status: 429, headers: { 'retry-after': '1' } }
          : { status: 200 },
      );
      const provider = providerFor(family);
      const a = outcome(ask(provider, 'call-a', {}, model));
      await at(1);
      const b = outcome(ask(provider, 'call-b', {}, model));
      await vi.runAllTimersAsync();
      await Promise.all([a, b]);
      expect(net.log.map((d) => [d.tag, d.at - T0])).toEqual([
        ['call-a', 0],
        ['call-a', 1000],
        ['call-b', 1000],
      ]);
      expect(warn).not.toHaveBeenCalled();
    },
  );
});

// ---------------------------------------------------------------------------
// AC18 / AC40 / E3 — a spend cap fails fast and keeps its body.
// ---------------------------------------------------------------------------

describe('AC18/AC40: spend-cap 429s fail fast', () => {
  it.each<[Family, string, Record<string, string>]>([
    ['openai', OPENAI_SPEND_CAP, {}],
    ['anthropic', ANTHROPIC_SPEND_CAP, { 'retry-after': '30' }],
  ])(
    '%s: not retried, no brake, sibling not held, raw body on the error',
    async (family, body, headers) => {
      const model = MODEL[family];
      const net = stubFetch((d) =>
        d.tag === 'call-a'
          ? { status: 429, headers, body, after: 5 }
          : { status: 200, after: d.tag === 'call-b' ? 100 : 5 },
      );
      const provider = providerFor(family, { maxConcurrent: 2 });
      const a = outcome(ask(provider, 'call-a', {}, model));
      const b = outcome(ask(provider, 'call-b', {}, model));
      const c = outcome(ask(provider, 'call-c', {}, model)); // queued behind the cap
      await at(10);
      const d = outcome(ask(provider, 'call-d', {}, model));
      await vi.runAllTimersAsync();

      const ra = await a;
      expect(ra.ok).toBe(false);
      const err = (ra as { error: ProviderError }).error;
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.status).toBe(429);
      expect(err.body).toBe(body);
      expect(err.timing?.attempts).toBe(1);
      if (headers['retry-after']) expect(err.retryAfterMs).toBe(30_000);
      // The returned response's body was never cancelled (the adapter read it).
      expect(bodyCancelled(net.of('call-a')[0]!)).toBe(false);
      // c took a's permit the moment a returned; d dispatched on arrival.
      expect(net.log.map((x) => [x.tag, x.at - T0])).toEqual([
        ['call-a', 0],
        ['call-b', 0],
        ['call-c', 5],
        ['call-d', 10],
      ]);
      for (const r of await Promise.all([b, c, d])) expect(r.ok).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// AC19 — split budgets and explicit counters.
// ---------------------------------------------------------------------------

describe('AC19: rate-limit and transient retries use separate budgets', () => {
  it('429 → 503 → 429 → 503 → 200 succeeds in 5 dispatches (the shared budget would stop at 3)', async () => {
    const replies: Reply[] = [
      { status: 429, headers: { 'retry-after': '1' } },
      { status: 503 },
      { status: 429 },
      { status: 503 },
      { status: 200 },
    ];
    const net = stubFetch((d) => replies[d.attempt - 1]!);
    const r = await (async () => {
      const p = outcome(ask(providerFor('openai'), 'call-a'));
      await vi.runAllTimersAsync();
      return p;
    })();
    expect(r.ok).toBe(true);
    expect((r as { value: ProviderResponse }).value.timing?.attempts).toBe(5);
    // 1 s brake (Retry-After) → 1 s transient backoff (1st) → 2 s brake
    // (2nd rate limit, no Retry-After) → 2 s transient backoff (2nd).
    expect(net.log.map((d) => d.at - T0)).toEqual([0, 1000, 2000, 4000, 6000]);
  });

  it('503 × 3 exhausts the transient budget alone', async () => {
    const net = stubFetch(() => ({ status: 503 }));
    const p = outcome(ask(providerFor('openai'), 'call-a'));
    await vi.runAllTimersAsync();
    const r = await p;
    expect((r as { error: ProviderError }).error.status).toBe(503);
    expect(net.log).toHaveLength(3);
  });

  it('429 exhausts only the rate-limit budget (default + 1 dispatches), returning the last 429', async () => {
    const net = stubFetch((d) => ({
      status: 429,
      headers: { 'retry-after': '1' },
      body: `rl-${d.attempt}`,
    }));
    const p = outcome(ask(providerFor('openai'), 'call-a'));
    await vi.runAllTimersAsync();
    const err = ((await p) as { error: ProviderError }).error;
    expect(net.log).toHaveLength(DEFAULT_MAX_RATE_LIMIT_RETRIES + 1);
    expect(err.status).toBe(429);
    expect(err.body).toBe(`rl-${DEFAULT_MAX_RATE_LIMIT_RETRIES + 1}`);
    expect(err.timing?.attempts).toBe(DEFAULT_MAX_RATE_LIMIT_RETRIES + 1);
  });

  describe('brake-gate bounces consume no budget and are not attempts', () => {
    function governed(
      inject: (gov: ScopeGovernor) => void,
      replies: Reply[],
      limits: RateLimitConfig = {},
    ) {
      const gov = new ScopeGovernor(limits, openaiQuotaDialect, 'openai');
      inject(gov);
      const net = stubFetch((d) => replies[d.attempt - 1]!);
      let timing: FetchTiming | undefined;
      const p = fetchWithRetry(
        'https://api.openai.com/v1/chat/completions',
        { method: 'POST', body: '"call-a"' },
        { governor: gov, timing: { onComplete: (t) => (timing = t) } },
      );
      return { gov, net, p, timing: () => timing };
    }

    it('a brake that lands between the first grant and fetch sends the caller back to wait', async () => {
      const { net, p, timing } = governed(
        (gov) => {
          // The first grant is synchronous (a free permit), so the sibling's
          // 429 lands right after it, before the caller reaches fetch.
          const tryAcquire = gov.tryAcquire.bind(gov);
          let once = true;
          gov.tryAcquire = () => {
            const granted = tryAcquire();
            if (granted && once) {
              once = false;
              gov.brake(1000, Date.now());
            }
            return granted;
          };
        },
        [{ status: 200 }],
      );
      await vi.runAllTimersAsync();
      expect((await p).status).toBe(200);
      expect(net.log.map((d) => d.at - T0)).toEqual([1000]);
      expect(timing()).toMatchObject({ attempts: 1, queuedMs: 1000, retryMs: 0 });
    });

    it('a brake that lands between a re-acquire and fetch costs no rate-limit retry', async () => {
      const { net, p, timing } = governed(
        (gov) => {
          const reacquire = gov.reacquire.bind(gov);
          gov.reacquire = async (signal) => {
            await reacquire(signal);
            if (Date.now() === T0 + 1000) gov.brake(500, Date.now());
          };
        },
        [{ status: 429, headers: { 'retry-after': '1' } }, { status: 200 }],
        { maxRateLimitRetries: 1 },
      );
      await vi.runAllTimersAsync();
      // With a bounce counted as a retry, the budget of 1 would be spent.
      expect((await p).status).toBe(200);
      expect(net.log.map((d) => d.at - T0)).toEqual([0, 1500]);
      expect(timing()).toMatchObject({ attempts: 2, queuedMs: 1500, retryMs: 0 });
    });
  });
});

describe('brake state', () => {
  it('a shorter Retry-After never shortens an active brake', async () => {
    const net = stubFetch((d) => {
      if (d.attempt > 1) return { status: 200 };
      if (d.tag === 'call-long') return { status: 429, headers: { 'retry-after': '10' } };
      if (d.tag === 'call-short') return { status: 429, headers: { 'retry-after': '1' }, after: 5 };
      return { status: 200 };
    });
    const provider = providerFor('openai');
    const long = outcome(ask(provider, 'call-long'));
    const short = outcome(ask(provider, 'call-short'));
    await at(10);
    const c = outcome(ask(provider, 'call-c'));
    await vi.runAllTimersAsync();
    await Promise.all([long, short, c]);
    expect(net.log.slice(2).map((d) => [d.tag, d.at - T0])).toEqual([
      ['call-long', 10_000],
      ['call-short', 10_000],
      ['call-c', 10_000],
    ]);
  });

  it('a pre-aborted caller rejects at once during a brake instead of waiting it out', async () => {
    const net = stubFetch((d) =>
      d.tag === 'call-a' && d.attempt === 1
        ? { status: 429, headers: { 'retry-after': '30' } }
        : { status: 200 },
    );
    const provider = providerFor('openai');
    const a = outcome(ask(provider, 'call-a'));
    await at(100);
    const ctrl = new AbortController();
    const reason = new Error('pre');
    ctrl.abort(reason);
    let settled: Outcome | undefined;
    void outcome(ask(provider, 'call-b', { signal: ctrl.signal })).then((r) => (settled = r));
    await tick();
    expect(settled).toEqual({ ok: false, error: reason });
    await vi.runAllTimersAsync();
    await a;
    expect(net.of('call-b')).toEqual([]);
  });

  it('the brake-end timer does not outlive its waiters', async () => {
    const net = stubFetch((d) =>
      d.tag === 'call-a' && d.attempt === 1
        ? { status: 429, headers: { 'retry-after': '30' } }
        : { status: 200 },
    );
    const provider = providerFor('openai');
    const ctrlA = new AbortController();
    const ctrlB = new AbortController();
    const a = outcome(ask(provider, 'call-a', { signal: ctrlA.signal })); // re-acquires behind the brake
    await at(100);
    const b = outcome(ask(provider, 'call-b', { signal: ctrlB.signal })); // waits for the brake to clear
    await tick();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    ctrlA.abort(new Error('a gone'));
    ctrlB.abort(new Error('b gone'));
    await tick();
    expect(((await a) as { error: Error }).error.message).toBe('a gone');
    expect(((await b) as { error: Error }).error.message).toBe('b gone');
    // Nothing is left to wake, so no timer holds the 30 s brake open.
    expect(vi.getTimerCount()).toBe(0);
    expect(net.log.map((d) => [d.tag, d.at - T0])).toEqual([['call-a', 0]]);
    // The brake itself still stands for a newcomer.
    const c = outcome(ask(provider, 'call-c'));
    await vi.runAllTimersAsync();
    expect((await c).ok).toBe(true);
    expect(net.of('call-c').map((d) => d.at - T0)).toEqual([30_000]);
  });

  it('a dialect scope already in use adopts a rateLimit that a later block contributes', async () => {
    const net = stubFetch(() => ({ status: 200, after: 100 }));
    const runtime = new AxlRuntime({
      providers: {
        openai: { apiKey: 'k' },
        'openai-responses': { apiKey: 'k', rateLimit: { maxConcurrent: 1 } },
      },
    });
    const completions = runtime.resolveProvider('openai:gpt-4o').provider;
    const first = ask(completions, 'call-0'); // creates the scope's governor, unconfigured
    await vi.runAllTimersAsync();
    await first;
    runtime.resolveProvider('openai-responses:gpt-4o'); // contributes maxConcurrent 1
    const calls = [ask(completions, 'call-1'), ask(completions, 'call-2')];
    await vi.runAllTimersAsync();
    await Promise.all(calls);
    expect(net.log.slice(1).map((d) => [d.tag, d.at - T0])).toEqual([
      ['call-1', 100],
      ['call-2', 200],
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC20 / E4 — brake duration: clamped Retry-After, else the existing backoff.
// ---------------------------------------------------------------------------

describe('AC20: brake duration', () => {
  it('a hostile Retry-After brakes for 60 s, and the error keeps the raw value', async () => {
    const net = stubFetch((d) =>
      d.tag === 'call-a' ? { status: 429, headers: { 'retry-after': '3600' } } : { status: 200 },
    );
    const provider = providerFor('openai', { maxRateLimitRetries: 0 });
    const a = outcome(ask(provider, 'call-a'));
    await at(1);
    const b = outcome(ask(provider, 'call-b'));
    await vi.runAllTimersAsync();
    const err = ((await a) as { error: ProviderError }).error;
    expect(err.retryAfterMs).toBe(3_600_000);
    expect(net.of('call-b').map((d) => d.at - T0)).toEqual([60_000]);
    expect(((await b) as { value: ProviderResponse }).value.timing?.queuedMs).toBe(59_999);
  });

  it('an HTTP-date Retry-After 90 s ahead is clamped to 60 s', async () => {
    const when = new Date(T0 + 90_000).toUTCString();
    const net = stubFetch((d) =>
      d.attempt === 1 ? { status: 429, headers: { 'retry-after': when } } : { status: 200 },
    );
    const p = outcome(ask(providerFor('openai'), 'call-a'));
    await vi.runAllTimersAsync();
    expect((await p).ok).toBe(true);
    expect(net.log.map((d) => d.at - T0)).toEqual([0, 60_000]);
  });

  it.each([['absent'], ['0'], ['-1'], ['soon']])(
    'Retry-After %s: siblings wait the existing backoff, doubling per consecutive 429',
    async (header) => {
      const headers: Record<string, string> = header === 'absent' ? {} : { 'retry-after': header };
      // The retry's 429 lands 50 ms after dispatch, after the sibling left.
      const net = stubFetch((d) =>
        d.tag === 'call-a' && d.attempt <= 2
          ? { status: 429, headers, after: d.attempt === 1 ? 0 : 50 }
          : { status: 200 },
      );
      const provider = providerFor('openai');
      const a = outcome(ask(provider, 'call-a'));
      await at(1);
      const b = outcome(ask(provider, 'call-b'));
      await vi.runAllTimersAsync();
      await Promise.all([a, b]);
      // 1 s after the first 429 (attempt 1's backoff), 2 s after the second.
      expect(net.of('call-a').map((d) => d.at - T0)).toEqual([0, 1000, 3050]);
      expect(net.of('call-b').map((d) => d.at - T0)).toEqual([1000]);
    },
  );
});

// ---------------------------------------------------------------------------
// AC21 (guard) — dialect-less scopes keep today's transport behavior.
// ---------------------------------------------------------------------------

describe('AC21 (guard): dialect-less scopes are unchanged', () => {
  it.each<[Family]>([['google'], ['groq']])(
    '%s: a 429 holds no sibling and shares the transient budget',
    async (family) => {
      const model = MODEL[family];
      const net = stubFetch((d) =>
        d.tag === 'call-a' ? { status: 429, headers: { 'retry-after': '1' } } : { status: 200 },
      );
      const provider = providerFor(family, { maxConcurrent: 2 });
      const a = outcome(ask(provider, 'call-a', {}, model));
      await at(1);
      const b = outcome(ask(provider, 'call-b', {}, model));
      await vi.runAllTimersAsync();
      const ra = await a;
      expect((ra as { error: ProviderError }).error.status).toBe(429);
      expect((await b).ok).toBe(true);
      expect(net.log.map((d) => [d.tag, d.at - T0])).toEqual([
        ['call-a', 0],
        ['call-b', 1],
        ['call-a', 1000],
        ['call-a', 2000],
      ]);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it('a directly constructed RateLimiter is never adaptive, even for an OpenAI URL', async () => {
    const { RateLimiter } = await import('../providers/rate-limiter.js');
    const gov = new RateLimiter({ maxConcurrent: 2 });
    const net = stubFetch(() => ({ status: 429, headers: { 'retry-after': '1' } }));
    const p = fetchWithRetry(
      'https://api.openai.com/v1/chat/completions',
      { method: 'POST', body: '"call-a"' },
      { governor: gov },
    );
    await vi.runAllTimersAsync();
    expect((await p).status).toBe(429);
    expect(net.log.map((d) => d.at - T0)).toEqual([0, 1000, 2000]);
  });
});

describe('AC21 (guard): a first-party family behind a proxy is dialect-less', () => {
  const PROXY = 'https://llm-gateway.example.com/v1';
  const families: [Family][] = [['openai'], ['openai-responses'], ['anthropic']];

  it.each(families)('%s at a proxy origin: a 200 goes out with no governor', async (family) => {
    const model = MODEL[family];
    const net = stubFetch(() => ({ status: 200 }));
    const provider = providerFor(family, undefined, PROXY);
    const r = await outcome(ask(provider, 'call-a', {}, model));
    expect(r.ok).toBe(true);
    expect(
      net.log.map((d) => [d.tag, d.url.startsWith('https://llm-gateway.example.com/')]),
    ).toEqual([['call-a', true]]);
    expect(governorOf(provider, model)).toBeUndefined();
  });

  it.each(families)(
    '%s at a proxy origin: a 429 holds no sibling and shares the transient budget',
    async (family) => {
      const model = MODEL[family];
      const net = stubFetch((d) =>
        d.tag === 'call-a' ? { status: 429, headers: { 'retry-after': '1' } } : { status: 200 },
      );
      const provider = providerFor(family, undefined, PROXY);
      const a = outcome(ask(provider, 'call-a', {}, model));
      await at(1);
      const b = outcome(ask(provider, 'call-b', {}, model));
      await vi.runAllTimersAsync();
      const ra = await a;
      expect((ra as { error: ProviderError }).error.status).toBe(429);
      expect((await b).ok).toBe(true);
      expect(net.log.map((d) => [d.tag, d.at - T0])).toEqual([
        ['call-a', 0],
        ['call-b', 1],
        ['call-a', 1000],
        ['call-a', 2000],
      ]);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it.each(families)(
    '%s at a proxy origin: a 503 retries on the shared budget and holds no sibling',
    async (family) => {
      const model = MODEL[family];
      const net = stubFetch((d) => (d.tag === 'call-a' ? { status: 503 } : { status: 200 }));
      const provider = providerFor(family, undefined, PROXY);
      const a = outcome(ask(provider, 'call-a', {}, model));
      await at(1);
      const b = outcome(ask(provider, 'call-b', {}, model));
      await vi.runAllTimersAsync();
      expect(((await a) as { error: ProviderError }).error.status).toBe(503);
      expect((await b).ok).toBe(true);
      expect(net.log.map((d) => [d.tag, d.at - T0])).toEqual([
        ['call-a', 0],
        ['call-b', 1],
        ['call-a', 1000],
        ['call-a', 3000],
      ]);
    },
  );

  it.each(families)(
    '%s at a proxy origin with rateLimit: the governor paces but never brakes',
    async (family) => {
      const model = MODEL[family];
      const net = stubFetch((d) =>
        d.tag === 'call-a' ? { status: 429, headers: { 'retry-after': '1' } } : { status: 200 },
      );
      const provider = providerFor(family, { maxConcurrent: 2 }, PROXY);
      const a = outcome(ask(provider, 'call-a', {}, model));
      await at(1);
      const b = outcome(ask(provider, 'call-b', {}, model));
      await vi.runAllTimersAsync();
      expect(((await a) as { error: ProviderError }).error.status).toBe(429);
      expect((await b).ok).toBe(true);
      expect(net.log.map((d) => [d.tag, d.at - T0])).toEqual([
        ['call-a', 0],
        ['call-b', 1],
        ['call-a', 1000],
        ['call-a', 2000],
      ]);
      expect(governorOf(provider, model).adapts).toBe(false);
    },
  );

  it.each<[Family, string]>([
    ['openai', 'https://api.openai.com/v1'],
    ['openai-responses', 'https://API.openai.com:443/v1/'],
    ['anthropic', 'https://api.anthropic.com/v1'],
  ])('%s with baseUrl %s (the default origin) still brakes', async (family, baseUrl) => {
    const model = MODEL[family];
    const net = stubFetch((d) =>
      d.tag === 'call-a' && d.attempt === 1
        ? { status: 429, headers: { 'retry-after': '1' } }
        : { status: 200 },
    );
    const provider = providerFor(family, undefined, baseUrl);
    const a = outcome(ask(provider, 'call-a', {}, model));
    await at(1);
    const b = outcome(ask(provider, 'call-b', {}, model));
    await vi.runAllTimersAsync();
    await Promise.all([a, b]);
    expect(net.log.map((d) => [d.tag, d.at - T0])).toEqual([
      ['call-a', 0],
      ['call-a', 1000],
      ['call-b', 1000],
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC22 — quota headers never fail a 2xx.
// ---------------------------------------------------------------------------

describe('AC22: quota-header parsing is contained', () => {
  it('garbage and partial quota headers: every call resolves with zero added wait and no warning', async () => {
    const garbage: Record<string, string>[] = [
      { 'x-ratelimit-remaining-requests': 'abc', 'x-ratelimit-limit-requests': '' },
      { 'x-ratelimit-remaining-requests': '5' },
      { 'x-ratelimit-remaining-requests': '-5', 'x-ratelimit-limit-requests': '0' },
      {},
    ];
    const net = stubFetch((d) => ({ status: 200, headers: garbage[d.i % garbage.length] }));
    const provider = providerFor('openai');
    const calls = Array.from({ length: 8 }, (_, k) => ask(provider, `call-${k}`));
    await vi.runAllTimersAsync();
    const results = await Promise.all(calls);
    expect(net.log.every((d) => d.at === T0)).toBe(true);
    for (const r of results) expect(r.timing?.queuedMs).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a throwing dialect parser warns once, without header values, and never fails the 200', async () => {
    vi.spyOn(openaiQuotaDialect, 'hint').mockImplementation(() => {
      throw new Error('parser saw SECRET-VALUE');
    });
    stubFetch(() => ({
      status: 200,
      headers: { 'x-ratelimit-remaining-requests': 'SECRET-VALUE' },
    }));
    const provider = providerFor('openai');
    for (let k = 0; k < 3; k++) {
      const p = ask(provider, `call-${k}`);
      await vi.runAllTimersAsync();
      await expect(p).resolves.toBeDefined();
    }
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('openai');
    expect(message).not.toContain('SECRET');
  });
});

// ---------------------------------------------------------------------------
// AC23 — permit bookkeeping stays exact through re-acquires and aborts.
// ---------------------------------------------------------------------------

describe('AC23: permit count stays exact', () => {
  it('maxConcurrent 1: a re-acquire aborted mid-brake leaks nothing and double-releases nothing', async () => {
    const net = stubFetch((d) =>
      d.tag === 'call-a'
        ? { status: 429, headers: { 'retry-after': '5' } }
        : { status: 200, after: 50 },
    );
    const provider = providerFor('openai', { maxConcurrent: 1 });
    const ctrl = new AbortController();
    const reason = new Error('mine');
    const a = outcome(ask(provider, 'call-a', { signal: ctrl.signal }));
    await at(1000);
    ctrl.abort(reason);
    await tick();
    expect(await a).toEqual({ ok: false, error: reason });
    expect(activePermits(governorOf(provider))).toBe(0);

    const b = outcome(ask(provider, 'call-b'));
    const c = outcome(ask(provider, 'call-c'));
    await vi.runAllTimersAsync();
    await Promise.all([b, c]);
    expect(net.log.map((d) => [d.tag, d.at - T0])).toEqual([
      ['call-a', 0],
      ['call-b', 5000],
      ['call-c', 5050],
    ]);
    expect(net.peak).toBe(1);
  });

  it("maxConcurrent 2 with a sibling in flight: an aborted re-acquire does not free the sibling's permit", async () => {
    const net = stubFetch((d) => {
      if (d.tag === 'call-a') return { status: 429, headers: { 'retry-after': '1' } };
      if (d.tag === 'call-long') return { status: 200, after: 10_000 };
      return { status: 200, after: 5_000 };
    });
    const provider = providerFor('openai', { maxConcurrent: 2 });
    const ctrl = new AbortController();
    const long = outcome(ask(provider, 'call-long'));
    const a = outcome(ask(provider, 'call-a', { signal: ctrl.signal }));
    await at(500);
    ctrl.abort(new Error('stop'));
    await tick();
    expect((await a).ok).toBe(false);
    expect(activePermits(governorOf(provider))).toBe(1); // call-long's
    const c = outcome(ask(provider, 'call-c'));
    const d = outcome(ask(provider, 'call-d'));
    await vi.runAllTimersAsync();
    await Promise.all([long, c, d]);
    // c takes the one free permit after the brake; d waits for c.
    expect(net.log.map((x) => [x.tag, x.at - T0])).toEqual([
      ['call-long', 0],
      ['call-a', 0],
      ['call-c', 1000],
      ['call-d', 6000],
    ]);
    expect(net.peak).toBe(2);
  });

  it('maxConcurrent 2: a rate-limit retry releases once, so the cap holds through the brake', async () => {
    const net = stubFetch((d) => {
      if (d.tag === 'call-a' && d.attempt === 1)
        return { status: 429, headers: { 'retry-after': '1' } };
      if (d.tag === 'call-long') return { status: 200, after: 10_000 };
      return { status: 200, after: 3_000 };
    });
    const provider = providerFor('openai', { maxConcurrent: 2 });
    const long = outcome(ask(provider, 'call-long'));
    const a = outcome(ask(provider, 'call-a'));
    await at(10);
    const c = outcome(ask(provider, 'call-c'));
    const d = outcome(ask(provider, 'call-d'));
    await vi.runAllTimersAsync();
    await Promise.all([long, a, c, d]);
    expect(net.log.map((x) => [x.tag, x.at - T0])).toEqual([
      ['call-long', 0],
      ['call-a', 0],
      ['call-a', 1000],
      ['call-c', 4000],
      ['call-d', 7000],
    ]);
    expect(net.peak).toBe(2);
    expect(activePermits(governorOf(provider))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC24 — re-acquires are exempt from acquireTimeoutMs; exhaustion is a 429.
// ---------------------------------------------------------------------------

describe('AC24: re-acquire exemption and exhaustion', () => {
  it('a 30 s brake outlasts acquireTimeoutMs without failing the retrier; Q9 for first-time callers', async () => {
    const net = stubFetch((d) =>
      d.tag === 'call-a' && d.attempt === 1
        ? { status: 429, headers: { 'retry-after': '30' }, after: 50 }
        : { status: 200, after: 10 },
    );
    const provider = providerFor('openai', { maxConcurrent: 1, acquireTimeoutMs: 100 });
    const a = outcome(ask(provider, 'call-a'));
    // Queued behind a's permit BEFORE the brake: its clock runs through it.
    const early = outcome(ask(provider, 'call-early'));
    await at(1000);
    // Arrives DURING the brake: waits it out before its clock starts.
    const late = outcome(ask(provider, 'call-late'));
    await vi.runAllTimersAsync();

    expect((await a).ok).toBe(true);
    const e = await early;
    expect(e.ok).toBe(false);
    expect((e as { error: Error }).error).not.toBeInstanceOf(ProviderError);
    expect(String((e as { error: Error }).error.message)).toContain('timed out after 100ms');
    expect((await late).ok).toBe(true);
    expect(net.log.map((d) => [d.tag, d.at - T0])).toEqual([
      ['call-a', 0],
      ['call-a', 30_050],
      ['call-late', 30_060],
    ]);
  });

  it('an exhausted budget surfaces ProviderError{status: 429} with the last raw body and timing', async () => {
    stubFetch((d) => ({ status: 429, headers: { 'retry-after': '1' }, body: `rl-${d.attempt}` }));
    const provider = providerFor('openai', { maxRateLimitRetries: 2 });
    const p = outcome(ask(provider, 'call-a'));
    await vi.runAllTimersAsync();
    const err = ((await p) as { error: ProviderError }).error;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({
      provider: 'openai',
      status: 429,
      retryAfterMs: 1000,
      body: 'rl-3',
    });
    expect(err.timing?.attempts).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// AC25 / E7 — aborts reject with the signal's reason; denials stay denials.
// ---------------------------------------------------------------------------

describe('AC25: aborts and admission denials', () => {
  it("a 503 sleeper aborted mid-sleep rejects with signal.reason (today: fetch's AbortError)", async () => {
    const net = stubFetch(() => ({ status: 503 }));
    const ctrl = new AbortController();
    const reason = new Error('mine');
    const p = outcome(ask(providerFor('openai'), 'call-a', { signal: ctrl.signal }));
    await at(500);
    ctrl.abort(reason);
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ ok: false, error: reason });
    expect(net.log).toHaveLength(1);
  });

  it('braked, permit-queued and pre-aborted callers each reject with their reason; the count stays exact', async () => {
    const net = stubFetch((d) =>
      d.tag === 'call-a' && d.attempt === 1
        ? { status: 429, headers: { 'retry-after': '10' } }
        : { status: 200, after: 1000 },
    );
    const provider = providerFor('openai', { maxConcurrent: 1 });
    const a = outcome(ask(provider, 'call-a'));
    await at(1);
    const braked = new AbortController();
    const bReason = new Error('braked');
    const b = outcome(ask(provider, 'call-b', { signal: braked.signal }));
    await at(100);
    braked.abort(bReason);
    await tick();
    expect(await b).toEqual({ ok: false, error: bReason });

    await at(10_001); // a's retry holds the only permit until T0+11000
    const queued = new AbortController();
    const cReason = new Error('queued');
    const c = outcome(ask(provider, 'call-c', { signal: queued.signal }));
    await at(10_010);
    queued.abort(cReason);
    await tick();
    expect(await c).toEqual({ ok: false, error: cReason });

    const pre = new AbortController();
    const dReason = new Error('pre');
    pre.abort(dReason);
    expect(await outcome(ask(provider, 'call-d', { signal: pre.signal }))).toEqual({
      ok: false,
      error: dReason,
    });

    const e = outcome(ask(provider, 'call-e'));
    await vi.runAllTimersAsync();
    expect((await a).ok).toBe(true);
    expect((await e).ok).toBe(true);
    expect(net.log.map((x) => [x.tag, x.at - T0])).toEqual([
      ['call-a', 0],
      ['call-a', 10_000],
      ['call-e', 11_000],
    ]);
  });

  it('an admission denial on the retry after a brake propagates unnormalized and frees the permit', async () => {
    const net = stubFetch((d) =>
      d.tag === 'call-a' ? { status: 429, headers: { 'retry-after': '1' } } : { status: 200 },
    );
    const provider = providerFor('openai', { maxConcurrent: 1 });
    const denied = new AdmissionDeniedError({
      limit: 1,
      knownSpend: 1,
      operation: { kind: 'chat' },
    });
    const seen: number[] = [];
    const a = outcome(
      ask(provider, 'call-a', {
        dispatchAdmission: {
          beforeDispatch(n: number) {
            seen.push(n);
            if (n >= 2) throw denied;
          },
        },
      }),
    );
    await at(1);
    const s = outcome(ask(provider, 'call-s'));
    await vi.runAllTimersAsync();
    expect(await a).toEqual({ ok: false, error: denied });
    expect(seen).toEqual([1, 2]);
    expect((await s).ok).toBe(true);
    expect(net.log.map((x) => [x.tag, x.at - T0])).toEqual([
      ['call-a', 0],
      ['call-s', 1000],
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC26 (guard) — no permit is held across a nested ask, even after a brake.
// ---------------------------------------------------------------------------

describe('AC26 (guard): nesting under maxConcurrent 1', () => {
  it('a nested same-scope ask after a braked retry completes', async () => {
    const net = stubFetch((d) =>
      d.tag === 'call-outer' && d.attempt === 1
        ? { status: 429, headers: { 'retry-after': '1' } }
        : { status: 200 },
    );
    const runtime = new AxlRuntime({
      providers: { openai: { apiKey: 'k', rateLimit: { maxConcurrent: 1 } } },
    });
    const completions = runtime.resolveProvider('openai:gpt-4o').provider;
    const responses = runtime.resolveProvider('openai-responses:gpt-4o').provider;
    const p = ask(completions, 'call-outer').then(() => ask(responses, 'call-inner'));
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeDefined();
    expect(net.log.map((d) => [d.tag, d.at - T0])).toEqual([
      ['call-outer', 0],
      ['call-outer', 1000],
      ['call-inner', 1000],
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC27 — retriers go first, and first-time callers wait at most their budget.
// ---------------------------------------------------------------------------

describe('AC27: re-acquire priority', () => {
  it('after the brake: the retrier, then the caller queued before it, then those who arrived during it', async () => {
    const net = stubFetch((d) =>
      d.tag === 'call-r' && d.attempt === 1
        ? { status: 429, headers: { 'retry-after': '1' }, after: 5 }
        : { status: 200, after: 50 },
    );
    const provider = providerFor('openai', { maxConcurrent: 1 });
    const r = outcome(ask(provider, 'call-r'));
    const f0 = outcome(ask(provider, 'call-f0')); // queued for r's permit
    await at(10);
    const f1 = outcome(ask(provider, 'call-f1'));
    await at(20);
    const f2 = outcome(ask(provider, 'call-f2'));
    await vi.runAllTimersAsync();
    await Promise.all([r, f0, f1, f2]);
    expect(net.log.map((d) => [d.tag, d.at - T0])).toEqual([
      ['call-r', 0],
      ['call-r', 1005],
      ['call-f0', 1055],
      ['call-f1', 1105],
      ['call-f2', 1155],
    ]);
  });

  it("a first-time caller is passed over at most the retrier's rate-limit budget", async () => {
    const net = stubFetch((d) =>
      d.tag === 'call-r' ? { status: 429, headers: { 'retry-after': '1' } } : { status: 200 },
    );
    const provider = providerFor('openai', { maxConcurrent: 1, maxRateLimitRetries: 3 });
    const r = outcome(ask(provider, 'call-r'));
    await at(10);
    const f = outcome(ask(provider, 'call-f'));
    await vi.runAllTimersAsync();
    expect(((await r) as { error: ProviderError }).error.status).toBe(429);
    expect((await f).ok).toBe(true);
    expect(net.log.map((d) => [d.tag, d.at - T0])).toEqual([
      ['call-r', 0],
      ['call-r', 1000],
      ['call-r', 2000],
      ['call-r', 3000],
      ['call-f', 4000],
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC39 — transient sleepers give their permits back when they wake into a brake.
// ---------------------------------------------------------------------------

describe('AC39: no permit is held through a brake once in-flight calls land', () => {
  it('two 503 sleepers and a sibling 429 with Retry-After: 60', async () => {
    const net = stubFetch((d) => {
      if (d.tag === 'call-s1' && d.attempt === 1) return { status: 503, after: 10 };
      if (d.tag === 'call-s2' && d.attempt === 1) return { status: 503 };
      if (d.tag === 'call-s2' && d.attempt === 2) {
        return { status: 429, headers: { 'retry-after': '60' }, after: 5 };
      }
      return { status: 200, after: 5 };
    });
    const provider = providerFor('openai', { maxConcurrent: 2 });
    const gov = governorOf(provider);
    const s1 = outcome(ask(provider, 'call-s1'));
    const s2 = outcome(ask(provider, 'call-s2'));
    await at(1011); // s2's retry drew the 429 at T0+1005; s1 woke at T0+1010
    expect(activePermits(gov)).toBe(0);
    await at(1100);
    const n1 = outcome(ask(provider, 'call-n1'));
    const n2 = outcome(ask(provider, 'call-n2'));
    await at(61_004);
    expect(net.log.map((d) => [d.tag, d.at - T0])).toEqual([
      ['call-s1', 0],
      ['call-s2', 0],
      ['call-s2', 1000],
    ]);
    expect(activePermits(gov)).toBe(0);
    await vi.runAllTimersAsync();
    await Promise.all([s1, s2, n1, n2]);
    expect(net.log.slice(3).map((d) => [d.tag, d.attempt, d.at - T0])).toEqual([
      ['call-s2', 3, 61_005],
      ['call-s1', 2, 61_005],
      ['call-n1', 1, 61_010],
      ['call-n2', 1, 61_010],
    ]);
    expect(net.peak).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// AC33 — queuedMs holds every self-imposed wait; retryMs excludes them.
// ---------------------------------------------------------------------------

describe('AC33: queuedMs and retryMs stay disjoint', () => {
  it.each<[string, RateLimitConfig | undefined]>([
    ['no rateLimit', undefined],
    ['an unsaturated maxConcurrent', { maxConcurrent: 2 }],
  ])(
    'real timers: an unqueued dialect-scope call reports queuedMs exactly 0 (%s)',
    async (_label, rateLimit) => {
      vi.useRealTimers();
      // Every clock read advances, so any bracket around a wait that never
      // happened would show up as queue time.
      let now = T0;
      vi.spyOn(Date, 'now').mockImplementation(() => (now += 5));
      stubFetch(() => ({ status: 200 }));
      const provider = providerFor('openai', rateLimit);
      const res = await ask(provider, 'call-a');
      expect(res.timing?.attempts).toBe(1);
      expect(res.timing?.queuedMs).toBe(0);
    },
  );

  it('429 → 30 s brake → 200: the brake is queue time, not retry time', async () => {
    stubFetch((d) =>
      d.attempt === 1
        ? { status: 429, headers: { 'retry-after': '30' }, after: 7 }
        : { status: 200, after: 40 },
    );
    const start = Date.now();
    const p = ask(providerFor('openai'), 'call-a');
    await vi.runAllTimersAsync();
    const t = (await p).timing!;
    const wall = Date.now() - start;
    expect(t.attempts).toBe(2);
    expect(t.queuedMs).toBeGreaterThanOrEqual(30_000);
    expect(t.retryMs).toBeLessThan(30_000);
    expect(t.queuedMs + t.retryMs).toBeLessThanOrEqual(wall);
    expect({ queuedMs: t.queuedMs, retryMs: t.retryMs }).toEqual({ queuedMs: 30_000, retryMs: 7 });
  });

  it('pre-existing path (503 → 503 → 200, no brake): identical figures with and without adaptation', async () => {
    const figures = async (rateLimit?: RateLimitConfig) => {
      vi.setSystemTime(T0);
      stubFetch((d) => (d.attempt < 3 ? { status: 503, after: 3 } : { status: 200, after: 4 }));
      const p = ask(providerFor('openai', rateLimit), 'call-a');
      await vi.runAllTimersAsync();
      const t = (await p).timing!;
      return { queuedMs: t.queuedMs, attempts: t.attempts, retryMs: t.retryMs };
    };
    const adaptive = await figures();
    const plain = await figures({ adaptive: false });
    expect(adaptive).toEqual(plain);
    expect(adaptive).toEqual({ queuedMs: 0, attempts: 3, retryMs: 1003 + 2003 });
  });

  it('permit wait and brake both count as queue time', async () => {
    stubFetch((d) => {
      if (d.tag === 'call-s') return { status: 200, after: 500 };
      return d.attempt === 1
        ? { status: 429, headers: { 'retry-after': '2' }, after: 10 }
        : { status: 200 };
    });
    const provider = providerFor('openai', { maxConcurrent: 1 });
    const s = ask(provider, 'call-s');
    const x = ask(provider, 'call-x');
    await vi.runAllTimersAsync();
    await s;
    const t = (await x).timing!;
    expect({ queuedMs: t.queuedMs, retryMs: t.retryMs }).toEqual({ queuedMs: 2500, retryMs: 10 });
  });

  it('grant spacing inside a re-acquire counts as queue time', async () => {
    stubFetch((d) =>
      d.attempt === 1
        ? { status: 429, headers: { 'retry-after': '1' }, after: 10 }
        : { status: 200 },
    );
    const p = ask(providerFor('openai', { minIntervalMs: 5000 }), 'call-a');
    await vi.runAllTimersAsync();
    const t = (await p).timing!;
    // Brake to T0+1010, then spacing holds the grant to T0+5000.
    expect({ queuedMs: t.queuedMs, retryMs: t.retryMs }).toEqual({ queuedMs: 4990, retryMs: 10 });
  });

  it('stream(): the same split on the done chunk', async () => {
    stubFetch((d) =>
      d.attempt === 1
        ? { status: 429, headers: { 'retry-after': '30' }, after: 7 }
        : { status: 200, after: 40, headers: { 'content-type': 'text/event-stream' } },
    );
    const provider = providerFor('openai');
    const drain = (async () => {
      const chunks: StreamChunk[] = [];
      for await (const c of provider.stream([{ role: 'user', content: 'call-a' }], {
        model: 'gpt-4o',
      })) {
        chunks.push(c);
      }
      return chunks;
    })();
    await vi.runAllTimersAsync();
    const done = (await drain).find((c) => c.type === 'done') as {
      timing?: { queuedMs: number; retryMs: number; attempts: number };
    };
    expect(done.timing).toMatchObject({ attempts: 2, queuedMs: 30_000, retryMs: 7 });
  });

  it('error path: an exhausted budget reports brakes as queue time', async () => {
    stubFetch(() => ({ status: 429, headers: { 'retry-after': '10' }, after: 5 }));
    const p = outcome(ask(providerFor('openai', { maxRateLimitRetries: 2 }), 'call-a'));
    await vi.runAllTimersAsync();
    const err = ((await p) as { error: ProviderError }).error;
    expect(err.timing).toMatchObject({ attempts: 3, queuedMs: 20_000, retryMs: 10 });
  });
});

// ---------------------------------------------------------------------------
// AC40 / Q12 — a 429 that cannot be classified is a rate limit.
// ---------------------------------------------------------------------------

describe('AC40: bare fixtures classify as unknown → rate limit', () => {
  it('a bare 429 (no clone, no body) brakes the scope and retries without a TypeError', async () => {
    const net = stubFetch((d) =>
      d.tag === 'call-a' && d.attempt === 1 ? { status: 429, bare: true } : { status: 200 },
    );
    const provider = providerFor('openai');
    const a = outcome(ask(provider, 'call-a'));
    await at(1);
    const b = outcome(ask(provider, 'call-b'));
    await vi.runAllTimersAsync();
    expect((await a).ok).toBe(true);
    expect((await b).ok).toBe(true);
    expect(net.log.map((d) => [d.tag, d.at - T0])).toEqual([
      ['call-a', 0],
      ['call-a', 1000],
      ['call-b', 1000],
    ]);
  });

  it('a retried rate-limit 429 has its body cancelled; the returned one does not', async () => {
    const net = stubFetch((d) =>
      d.attempt <= 2
        ? { status: 429, headers: { 'retry-after': '1' }, body: `rl-${d.attempt}` }
        : { status: 200 },
    );
    const p = outcome(ask(providerFor('openai', { maxRateLimitRetries: 1 }), 'call-a'));
    await vi.runAllTimersAsync();
    const err = ((await p) as { error: ProviderError }).error;
    expect(err.body).toBe('rl-2');
    expect(bodyCancelled(net.log[0]!)).toBe(true);
    expect(bodyCancelled(net.log[1]!)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC32 and config — the kill switch, merge rules and validation.
// ---------------------------------------------------------------------------

describe('adaptive: false and config handling', () => {
  it('AC32: adaptive false restores the plain path on a dialect scope', async () => {
    const net = stubFetch((d) =>
      d.tag === 'call-a' ? { status: 429, headers: { 'retry-after': '1' } } : { status: 200 },
    );
    const provider = providerFor('openai', { adaptive: false });
    const a = outcome(ask(provider, 'call-a'));
    await at(1);
    const b = outcome(ask(provider, 'call-b'));
    await vi.runAllTimersAsync();
    expect(((await a) as { error: ProviderError }).error.status).toBe(429);
    expect((await b).ok).toBe(true);
    expect(net.log.map((d) => [d.tag, d.at - T0])).toEqual([
      ['call-a', 0],
      ['call-b', 1],
      ['call-a', 1000],
      ['call-a', 2000],
    ]);
  });

  it('two blocks on one scope: an explicit adaptive true beats false, the smaller retry budget wins, one warning', async () => {
    const net = stubFetch((d) =>
      d.tag === 'call-a'
        ? { status: 429, headers: { 'retry-after': '1' }, after: 50 }
        : { status: 200 },
    );
    const runtime = new AxlRuntime({
      providers: {
        openai: { apiKey: 'k', rateLimit: { adaptive: false, maxRateLimitRetries: 5 } },
        'openai-responses': { apiKey: 'k', rateLimit: { adaptive: true, maxRateLimitRetries: 1 } },
      },
    });
    const completions = runtime.resolveProvider('openai:gpt-4o').provider;
    runtime.resolveProvider('openai-responses:gpt-4o');
    const a = outcome(ask(completions, 'call-a'));
    await at(60); // after a's 429 at T0+50
    const b = outcome(ask(completions, 'call-b'));
    await vi.runAllTimersAsync();
    expect(((await a) as { error: ProviderError }).error.status).toBe(429);
    expect((await b).ok).toBe(true);
    // Adaptive (b is held by a's brake) with a budget of 1 (a stops at 2 dispatches).
    expect(net.log.map((d) => [d.tag, d.at - T0])).toEqual([
      ['call-a', 0],
      ['call-a', 1050],
      ['call-b', 1050],
    ]);
    const merges = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('rate-limit scope'));
    expect(merges).toHaveLength(1);
    expect(merges[0]).toContain('adaptive: false vs true');
    expect(merges[0]).toContain('maxRateLimitRetries: 5 vs 1');
  });

  it('invalid adaptive / maxRateLimitRetries warn and fall back to the defaults', async () => {
    const net = stubFetch((d) =>
      d.tag === 'call-a' ? { status: 429, headers: { 'retry-after': '1' } } : { status: 200 },
    );
    const provider = providerFor('openai', {
      adaptive: 'yes' as unknown as boolean,
      maxRateLimitRetries: 1.5,
    });
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('invalid adaptive'))).toBe(true);
    expect(messages.some((m) => m.includes('invalid maxRateLimitRetries'))).toBe(true);
    const a = outcome(ask(provider, 'call-a'));
    await vi.runAllTimersAsync();
    expect(((await a) as { error: ProviderError }).error.status).toBe(429);
    // Adaptive (the default), with the default budget.
    expect(net.log).toHaveLength(DEFAULT_MAX_RATE_LIMIT_RETRIES + 1);
  });
});
