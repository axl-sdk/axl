import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AxlRuntime } from '../runtime.js';
import { ADAPTIVE_RATE, ScopeGovernor } from '../providers/governor-pool.js';
import type { RateLimitConfig } from '../providers/rate-limiter.js';
import type { ChatMessage, ChatOptions, Provider, ProviderResponse } from '../providers/types.js';

// ---------------------------------------------------------------------------
// Phase 5 of adaptive rate governance: rate-space AIMD on a dialect scope
// (plan §4.4; AC29–AC32, AC35–AC38, Q10, Q11).
//
// Every case runs a REAL adapter resolved through `AxlRuntime` against a
// stubbed `globalThis.fetch` returning real `Response`s after a scripted delay
// on the fake clock (`Date` faked too). `Math.random` is pinned so jitter is
// exactly 1.0. Assertions name who dispatched when, and every expected rate or
// spacing is derived from the internal constants (Q10), never restated.
// ---------------------------------------------------------------------------

const {
  BETA,
  RECOVERY_HORIZON_MS,
  WINDOW_MS,
  REOPEN_PERIOD_MS,
  HINT_THRESHOLD,
  MIN_RATE,
  ALPHA_FLOOR_RATE,
} = ADAPTIVE_RATE;
/** Additive increase per second of success after a cut to `rateAtCut`. */
const alphaFor = (rateAtCut: number) =>
  Math.max(rateAtCut, ALPHA_FLOOR_RATE) / (RECOVERY_HORIZON_MS / 1000);

const T0 = Date.UTC(2026, 8, 22);
const WAVE = 25;

const OPENAI_CHAT_JSON = JSON.stringify({
  choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});
const ANTHROPIC_JSON = JSON.stringify({
  content: [{ type: 'text', text: 'hello' }],
  usage: { input_tokens: 1, output_tokens: 1 },
});
const GROQ_JSON = OPENAI_CHAT_JSON;
const RATE_LIMIT_BODY = JSON.stringify({
  error: { message: 'Rate limit reached', type: 'rate_limit_error', code: 'rate_limit_exceeded' },
});

/** OpenAI request-lane quota headers with `remaining / limit` = `fraction`. */
function openaiHint(fraction: number): Record<string, string> {
  return {
    'x-ratelimit-limit-requests': '1000',
    'x-ratelimit-remaining-requests': String(Math.round(fraction * 1000)),
  };
}
const HEALTHY = openaiHint(0.9);
const LOW = openaiHint(HINT_THRESHOLD / 5);

type Reply = { status: number; headers?: Record<string, string>; after?: number };
type Dispatch = { tag: string; attempt: number; at: number };

function stubFetch(script: (d: Dispatch) => Reply) {
  const log: Dispatch[] = [];
  const perTag = new Map<string, number>();
  globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const tag = /call-[A-Za-z0-9]+/.exec(String(init?.body))?.[0] ?? 'untagged';
    const attempt = (perTag.get(tag) ?? 0) + 1;
    perTag.set(tag, attempt);
    const d: Dispatch = { tag, attempt, at: Date.now() - T0 };
    log.push(d);
    const reply = script(d);
    const after = reply.after ?? 10;
    if (after > 0) await new Promise<void>((r) => setTimeout(r, after));
    const ok = url.endsWith('/messages') ? ANTHROPIC_JSON : GROQ_JSON;
    return new Response(reply.status === 200 ? ok : RATE_LIMIT_BODY, {
      status: reply.status,
      headers: reply.headers,
    });
  }) as unknown as typeof fetch;
  return {
    log,
    /** Dispatch times (ms after T0) of the entries matching `pick`, in order. */
    times(pick: (d: Dispatch) => boolean = () => true) {
      return log.filter(pick).map((d) => d.at);
    },
  };
}

type Family = 'openai' | 'anthropic' | 'groq';
const MODEL: Record<Family, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-opus-5',
  groq: 'llama-3.3-70b',
};

function providerFor(
  options: { family?: Family; rateLimit?: RateLimitConfig; baseUrl?: string; apiKey?: string } = {},
): Provider {
  const family = options.family ?? 'openai';
  const runtime = new AxlRuntime({
    providers: {
      [family]: {
        apiKey: options.apiKey ?? 'k',
        ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      },
    },
  });
  return runtime.resolveProvider(`${family}:${MODEL[family]}`).provider;
}

function governorOf(provider: Provider, model = 'gpt-4o'): ScopeGovernor {
  return (
    provider as unknown as {
      axlRateGovernors: { governorFor(m: string): ScopeGovernor | undefined };
    }
  ).axlRateGovernors.governorFor(model)!;
}

type Outcome = { ok: true; value: ProviderResponse } | { ok: false; error: unknown };
function ask(
  provider: Provider,
  tag: string,
  options: Partial<ChatOptions> = {},
  messages?: ChatMessage[],
): Promise<Outcome> {
  return provider
    .chat(messages ?? [{ role: 'user', content: tag }], { model: 'gpt-4o', ...options })
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
}

async function at(t: number): Promise<void> {
  const delta = T0 + t - Date.now();
  if (delta < 0) throw new Error(`clock already past T0+${t}`);
  await vi.advanceTimersByTimeAsync(delta);
}

/** Consecutive differences of a sorted list. */
const gaps = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i]!);

/** Most entries of `times` inside any one-second span starting at an entry. */
function peakPerSecond(times: number[]): number {
  let peak = 0;
  for (let i = 0; i < times.length; i++) {
    let n = 0;
    for (let j = i; j < times.length && times[j]! - times[i]! < 1000; j++) n++;
    peak = Math.max(peak, n);
  }
  return peak;
}

/**
 * A 25-call wave at T0 whose first attempts all draw a rate-limit 429
 * (`Retry-After: retryAfterS`) 10 ms later: one congestion epoch.
 */
function isWaveFirstAttempt(d: Dispatch): boolean {
  return d.tag.startsWith('call-w') && d.attempt === 1;
}
function launchWave(provider: Provider): Promise<Outcome>[] {
  return Array.from({ length: WAVE }, (_, k) => ask(provider, `call-w${k}`));
}

const originalFetch = globalThis.fetch;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// AC35 — one cut per congestion epoch, seeded from the window count.
// ---------------------------------------------------------------------------

describe('AC35: one cut per congestion epoch', () => {
  it('25 simultaneous grants then 25 429s cut once, to BETA × 25/s, and the retriers leave spaced', async () => {
    const net = stubFetch((d) =>
      isWaveFirstAttempt(d)
        ? { status: 429, headers: { 'retry-after': '1' } }
        : { status: 200, headers: HEALTHY },
    );
    const provider = providerFor();
    const gov = governorOf(provider);
    const wave = launchWave(provider);
    await at(11);
    // Demand: 25 grants over the 1 s floor. Not BETA^25 × 25, not MIN_RATE.
    const r1 = BETA * WAVE;
    expect(gov.currentRate).toBe(r1);

    await vi.runAllTimersAsync();
    expect((await Promise.all(wave)).every((r) => r.ok)).toBe(true);
    const retries = net.times((d) => d.attempt === 2);
    expect(retries[0]).toBe(1010); // brake end
    const span = retries.at(-1)! - retries[0]!;
    // Every gap is one interval at the rate of that moment: at most the
    // interval right after the cut, and at least the interval the rate could
    // have recovered to by the last retry.
    const fastest = 1000 / (r1 + (alphaFor(r1) * span) / 1000);
    for (const gap of gaps(retries)) {
      expect(gap).toBeGreaterThanOrEqual(Math.floor(fastest));
      expect(gap).toBeLessThanOrEqual(Math.ceil(1000 / r1));
    }
  });

  it('a 429 on a request dispatched after the cut cuts again, from the current rate', async () => {
    stubFetch((d) =>
      isWaveFirstAttempt(d) || (d.tag === 'call-w0' && d.attempt === 2)
        ? { status: 429, headers: { 'retry-after': '1' }, after: d.attempt === 2 ? 0 : 10 }
        : { status: 200 },
    );
    const provider = providerFor();
    const gov = governorOf(provider);
    const wave = launchWave(provider);
    await at(1010); // w0 re-dispatches first at the brake end and draws a 429 at once
    expect(gov.currentRate).toBe(BETA * BETA * WAVE);
    await vi.runAllTimersAsync();
    await Promise.all(wave);
  });

  it('a late 429 from a request dispatched before the cut extends the brake without cutting', async () => {
    const net = stubFetch((d) => {
      if (isWaveFirstAttempt(d)) return { status: 429, headers: { 'retry-after': '1' } };
      if (d.tag === 'call-slow' && d.attempt === 1) {
        return { status: 429, headers: { 'retry-after': '2' }, after: 500 };
      }
      return { status: 200 };
    });
    const provider = providerFor();
    const gov = governorOf(provider);
    const slow = ask(provider, 'call-slow');
    const wave = launchWave(provider);
    await at(501); // slow's 429 arrives after the wave's cut
    expect(gov.currentRate).toBe(BETA * (WAVE + 1));
    await vi.runAllTimersAsync();
    await Promise.all([slow, ...wave]);
    // Its brake did apply: nothing left before T0 + 500 + 2000.
    expect(Math.min(...net.times((d) => d.attempt === 2))).toBe(2500);
  });
});

// ---------------------------------------------------------------------------
// AC36 — after a long brake the window is not trusted until it holds a full
// unbraked second; demand excludes braked time once it is.
// ---------------------------------------------------------------------------

describe('AC36: demand after a brake', () => {
  it('a 429 240 ms after a 60 s brake cuts from the current rate, not the deflated window count', async () => {
    let rateBefore: number | undefined;
    const provider = providerFor();
    const gov = governorOf(provider);
    stubFetch((d) => {
      if (isWaveFirstAttempt(d)) return { status: 429, headers: { 'retry-after': '60' } };
      if (d.tag === 'call-w3' && d.attempt === 2) {
        rateBefore = gov.currentRate;
        return { status: 429, headers: { 'retry-after': '1' }, after: 0 };
      }
      return { status: 200, after: 5 };
    });
    const wave = launchWave(provider);
    await at(11);
    const r1 = gov.currentRate!;
    expect(r1).toBe(BETA * WAVE);
    // w0, w1, w2 leave spaced after the brake; w3 is fourth, ~240 ms in.
    await at(60_010 + 3 * Math.ceil(1000 / r1));
    expect(rateBefore).toBeDefined();
    expect(gov.currentRate).toBe(BETA * rateBefore!);
    expect(gov.currentRate).toBeGreaterThanOrEqual(BETA * BETA * WAVE);
    await vi.runAllTimersAsync();
    await Promise.all(wave);
  });

  it('once the window holds a full unbraked second, braked time is excluded from demand', async () => {
    // Cut 1 (T0+10): a 20-call burst, one 429 → BETA × 20.
    // Saturating demand then flows paced. Cut 2 (~T0+4000, Retry-After 4)
    // brakes until ~T0+8000. Cut 3 (~T0+10500) sees a window with grants on
    // both sides of that 4 s brake. Measured over unbraked time, demand
    // exceeds the current rate, so the cut is BETA × rate. Counting the brake
    // as elapsed time would deflate demand below the rate.
    let cuts = 0;
    let rateBefore: number | undefined;
    const provider = providerFor();
    const gov = governorOf(provider);
    stubFetch((d) => {
      if (d.tag === 'call-b0' && d.attempt === 1) {
        return { status: 429, headers: { 'retry-after': '1' } };
      }
      if (d.tag.startsWith('call-f') && d.attempt === 1) {
        if (cuts === 0 && d.at >= 4000) {
          cuts = 1;
          return { status: 429, headers: { 'retry-after': '4' }, after: 0 };
        }
        if (cuts === 1 && d.at >= 10_500) {
          cuts = 2;
          rateBefore = gov.currentRate;
          // Long enough that no recovery accrues before the assertion below.
          return { status: 429, headers: { 'retry-after': '5' }, after: 0 };
        }
      }
      return { status: 200 };
    });
    const calls = Array.from({ length: 20 }, (_, k) => ask(provider, `call-b${k}`));
    await at(20);
    calls.push(...Array.from({ length: 300 }, (_, k) => ask(provider, `call-f${k}`)));
    await at(12_000);
    expect(cuts).toBe(2);
    expect(rateBefore).toBeDefined();
    expect(gov.currentRate).toBe(BETA * rateBefore!);
    await vi.runAllTimersAsync();
    await Promise.all(calls);
  });
});

// ---------------------------------------------------------------------------
// AC29 — spacing applies to every grant, so nothing bursts at brake end.
// ---------------------------------------------------------------------------

describe('AC29: no burst at brake end', () => {
  it('one 429 in a 25-burst, 100 callers queued behind the brake: no second holds more than rate + alpha', async () => {
    const net = stubFetch((d) =>
      d.tag === 'call-w2' && d.attempt === 1
        ? { status: 429, headers: { 'retry-after': '2' } }
        : { status: 200, headers: HEALTHY },
    );
    const provider = providerFor();
    const calls = launchWave(provider);
    await at(100);
    calls.push(...Array.from({ length: 100 }, (_, k) => ask(provider, `call-q${k}`)));
    await vi.runAllTimersAsync();
    expect((await Promise.all(calls)).every((r) => r.ok)).toBe(true);

    const r1 = BETA * WAVE;
    const after = net.times((d) => d.at >= 2010);
    expect(after[0]).toBe(2010);
    expect(after).toHaveLength(101); // the retrier and the 100 queued callers
    const span = after.at(-1)! - after[0]!;
    const rateCeiling = r1 + (alphaFor(r1) * span) / 1000;
    for (const gap of gaps(after))
      expect(gap).toBeGreaterThanOrEqual(Math.floor(1000 / rateCeiling));
    // One grant of rounding: a half-open second spaced at 1000/rate holds ceil(rate).
    expect(peakPerSecond(after)).toBeLessThanOrEqual(Math.ceil(rateCeiling + alphaFor(r1)));
  });

  it('a lone caller arriving inside the interval waits it out on the sync-grant path, and it counts as queuedMs', async () => {
    const net = stubFetch((d) =>
      isWaveFirstAttempt(d)
        ? { status: 429, headers: { 'retry-after': '1' } }
        : { status: 200, after: 5 },
    );
    const provider = providerFor();
    const gov = governorOf(provider);
    const wave = launchWave(provider);
    await vi.runAllTimersAsync();
    await Promise.all(wave);
    await at(10_000);
    const a = ask(provider, 'call-a'); // queue empty, interval long elapsed: goes at once
    await at(10_005);
    const interval = 1000 / gov.currentRate!;
    const b = ask(provider, 'call-b'); // queue empty, but the interval has not elapsed
    await vi.runAllTimersAsync();
    const [ra, rb] = await Promise.all([a, b]);
    expect(net.times((d) => d.tag === 'call-a')).toEqual([10_000]);
    const [bAt] = net.times((d) => d.tag === 'call-b');
    expect(bAt).toBeGreaterThanOrEqual(10_000 + Math.floor(interval));
    expect(bAt).toBeLessThanOrEqual(10_000 + Math.ceil(interval));
    expect((ra as { value: ProviderResponse }).value.timing?.queuedMs).toBe(0);
    // AC33: the spacing wait is queue time, never retry time.
    const tb = (rb as { value: ProviderResponse }).value.timing!;
    expect(tb.queuedMs).toBe(bAt! - 10_005);
    expect(tb.retryMs).toBe(0);
  });
});

describe('AC39 with adaptive spacing live (review N2)', () => {
  it('two 503 sleepers and a sibling 429 (Retry-After 60): no permit held through the brake; after it, the retriers and newcomers leave spaced', async () => {
    const net = stubFetch((d) => {
      if (d.tag === 'call-s1' && d.attempt === 1) return { status: 503, after: 10 };
      if (d.tag === 'call-s2' && d.attempt === 1) return { status: 503, after: 0 };
      if (d.tag === 'call-s2' && d.attempt === 2) {
        return { status: 429, headers: { 'retry-after': '60' }, after: 5 };
      }
      return { status: 200, after: 5 };
    });
    const provider = providerFor({ rateLimit: { maxConcurrent: 2 } });
    const gov = governorOf(provider);
    const active = () => (gov as unknown as { active: number }).active;
    const s1 = ask(provider, 'call-s1');
    const s2 = ask(provider, 'call-s2');
    await at(1011); // s2's retry drew the 429 at T0+1005; s1 woke into the brake at T0+1010
    expect(active()).toBe(0);
    const rate = gov.currentRate!;
    expect(rate).toBeDefined();
    await at(1100);
    const n1 = ask(provider, 'call-n1');
    const n2 = ask(provider, 'call-n2');
    await at(61_004);
    expect(net.log.map((d) => [d.tag, d.at])).toEqual([
      ['call-s1', 0],
      ['call-s2', 0],
      ['call-s2', 1000],
    ]);
    expect(active()).toBe(0);
    await vi.runAllTimersAsync();
    expect((await Promise.all([s1, s2, n1, n2])).every((r) => r.ok)).toBe(true);
    const after = net.log.slice(3);
    // Retriers first, in the order they parked, then the newcomers.
    expect(after.map((d) => [d.tag, d.attempt])).toEqual([
      ['call-s2', 3],
      ['call-s1', 2],
      ['call-n1', 1],
      ['call-n2', 1],
    ]);
    expect(after[0]!.at).toBe(61_005);
    // Each grant is one adaptive interval after the last. Recovery can only
    // shorten it: at most alpha per second of the (under 3 s) span.
    const fastest = rate + alphaFor(rate) * (after.length - 1);
    for (const gap of gaps(after.map((d) => d.at))) {
      expect(gap).toBeGreaterThanOrEqual(Math.floor(1000 / fastest));
      expect(gap).toBeLessThanOrEqual(Math.ceil(1000 / rate));
    }
  });
});

describe('timers do not outlive their waiters', () => {
  it('callers aborted while adaptively spaced leave no spacing timer behind', async () => {
    stubFetch((d) =>
      isWaveFirstAttempt(d)
        ? { status: 429, headers: { 'retry-after': '1' } }
        : { status: 200, after: d.tag.startsWith('call-s') ? 0 : 10 },
    );
    const provider = providerFor();
    const wave = launchWave(provider);
    await vi.runAllTimersAsync();
    await Promise.all(wave);
    await at(10_000); // well past the last retrier's interval
    // Paced at about BETA × 25/s: the first caller goes, the rest wait on spacing.
    const first = ask(provider, 'call-s0');
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const spaced = controllers.map((c, k) => ask(provider, `call-s${k + 1}`, { signal: c.signal }));
    await vi.advanceTimersByTimeAsync(0);
    expect((await first).ok).toBe(true);
    expect(vi.getTimerCount()).toBe(1); // the shared spacing timer
    for (const c of controllers) c.abort(new Error('gone'));
    expect((await Promise.all(spaced)).every((r) => !r.ok)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC37 / Q11 — linear, success-gated recovery.
// ---------------------------------------------------------------------------

describe('AC37: recovery is linear in rate and success-gated', () => {
  it('under continuous success, rate after t seconds is rateAtCut + alpha × t', async () => {
    const net = stubFetch((d) =>
      isWaveFirstAttempt(d)
        ? { status: 429, headers: { 'retry-after': '1' } }
        : { status: 200, headers: HEALTHY },
    );
    const provider = providerFor();
    const gov = governorOf(provider);
    const calls = launchWave(provider);
    await at(20);
    calls.push(...Array.from({ length: 400 }, (_, k) => ask(provider, `call-f${k}`)));
    const r1 = BETA * WAVE;
    const alpha = alphaFor(r1);
    const brakeEnd = 1010;
    for (let k = 1; k <= 10; k++) {
      await at(brakeEnd + k * 1000);
      // Recovery accrues up to the latest 2xx, at most one interval ago.
      const lagS = 1 / gov.currentRate! + 0.01;
      expect(gov.currentRate).toBeLessThanOrEqual(r1 + alpha * k + 1e-9);
      expect(gov.currentRate).toBeGreaterThanOrEqual(r1 + alpha * (k - lagS));
    }
    // Per-second dispatch counts grow by at most alpha, plus one grant of
    // rounding in each of the two seconds compared.
    const counts = Array.from(
      { length: 10 },
      (_, k) =>
        net.times((d) => d.at >= brakeEnd + k * 1000 && d.at < brakeEnd + (k + 1) * 1000).length,
    );
    for (const step of gaps(counts)) expect(step).toBeLessThanOrEqual(alpha + 2);
    await vi.runAllTimersAsync();
    await Promise.all(calls);
  });

  it('idle time recovers at most one second of alpha (Q11)', async () => {
    const net = stubFetch((d) =>
      isWaveFirstAttempt(d)
        ? { status: 429, headers: { 'retry-after': '1' } }
        : { status: 200, headers: HEALTHY },
    );
    const provider = providerFor();
    const gov = governorOf(provider);
    const wave = launchWave(provider);
    await vi.runAllTimersAsync();
    await Promise.all(wave);
    await at(5000);
    const before = gov.currentRate!;
    await at(25_000); // 20 s idle
    const a = ask(provider, 'call-a');
    await vi.runAllTimersAsync();
    await a;
    expect(gov.currentRate).toBeCloseTo(before + alphaFor(BETA * WAVE), 9);
    // A following burst is still spaced at (about) that rate: no idle credit to spend.
    const burst = Array.from({ length: 10 }, (_, k) => ask(provider, `call-i${k}`));
    await vi.runAllTimersAsync();
    await Promise.all(burst);
    const idleBurst = net.times((d) => d.tag.startsWith('call-i'));
    for (const gap of gaps(idleBurst)) {
      expect(gap).toBeGreaterThanOrEqual(Math.floor(1000 / (before + 2 * alphaFor(BETA * WAVE))));
    }
  });
});

describe('J1: a stray 429 on a quiet scope does not pin a later fan-out (review F1)', () => {
  /** One call on a quiet scope draws a 429: demand is one grant, so the cut is BETA × 1/s. */
  async function strayCut(provider: Provider, gov: ScopeGovernor): Promise<number> {
    const stray = ask(provider, 'call-stray');
    await at(11); // its 429 landed at T0+10
    const r0 = gov.currentRate!;
    expect(r0).toBe(BETA * 1);
    await vi.runAllTimersAsync(); // its retry succeeds after the 1 s brake
    expect((await stray).ok).toBe(true);
    return r0;
  }

  it('a 25-worker fan-out regains ALPHA_FLOOR_RATE within the floor-driven recovery time', async () => {
    const latency = 500;
    stubFetch((d) =>
      d.tag === 'call-stray' && d.attempt === 1
        ? { status: 429, headers: { 'retry-after': '1' } }
        : { status: 200, headers: HEALTHY, after: latency },
    );
    const provider = providerFor();
    const gov = governorOf(provider);
    const r0 = await strayCut(provider, gov);
    const alpha = alphaFor(r0);
    expect(alpha).toBe(ALPHA_FLOOR_RATE / (RECOVERY_HORIZON_MS / 1000)); // the floor governs

    const start = 5000;
    await at(start);
    let next = 0;
    const worker = async () => {
      while (next < 1000) await ask(provider, `call-f${next++}`);
    };
    const workers = Array.from({ length: WAVE }, worker);
    // Linear recovery from r0 at alpha, lagging by at most one response latency
    // plus one interval at r0 (the first 2xx of the fan-out).
    const slackMs = latency + 1000 / r0;
    const deadline = start + ((ALPHA_FLOOR_RATE - r0) / alpha) * 1000 + slackMs;
    await at(Math.ceil(deadline));
    expect(gov.currentRate).toBeGreaterThanOrEqual(ALPHA_FLOOR_RATE);
    // …and no faster than linear: at most alpha per second since the cut's brake ended.
    expect(gov.currentRate).toBeLessThanOrEqual(r0 + (alpha * (deadline - 1010)) / 1000);
    next = 1000; // stop issuing
    await vi.runAllTimersAsync();
    await Promise.all(workers);
  });

  it('idle time still does not inflate a low rate: one 2xx accrues at most one spacing interval (Q11)', async () => {
    stubFetch((d) =>
      d.tag === 'call-stray' && d.attempt === 1
        ? { status: 429, headers: { 'retry-after': '1' } }
        : { status: 200, headers: HEALTHY },
    );
    const provider = providerFor();
    const gov = governorOf(provider);
    const r0 = await strayCut(provider, gov);
    await at(60_000); // a minute idle
    const before = gov.currentRate!;
    const a = ask(provider, 'call-a');
    await vi.runAllTimersAsync();
    expect((await a).ok).toBe(true);
    const capS = Math.max(1, 1 / before); // the scope's own spacing, not the idle minute
    expect(gov.currentRate).toBeCloseTo(before + alphaFor(r0) * capS, 9);
  });
});

// ---------------------------------------------------------------------------
// AC30 / RQ5 / RQ6 — growth, the static floor, and the hint.
// ---------------------------------------------------------------------------

describe('AC30: growth, the configured floor and the hint', () => {
  it('a hint below threshold holds growth; a healthy one resumes it', async () => {
    let hint = LOW;
    stubFetch((d) =>
      isWaveFirstAttempt(d)
        ? { status: 429, headers: { 'retry-after': '1' } }
        : { status: 200, headers: hint },
    );
    const provider = providerFor();
    const gov = governorOf(provider);
    const calls = launchWave(provider);
    await at(20);
    calls.push(...Array.from({ length: 200 }, (_, k) => ask(provider, `call-f${k}`)));
    const r1 = BETA * WAVE;
    await at(6010); // 5 s of successes, every one reporting a low hint
    expect(gov.currentRate).toBe(r1);
    hint = HEALTHY;
    await at(8010);
    expect(gov.currentRate).toBeGreaterThan(r1);
    // Growth resumed from the hold, it did not jump: at most 2 s of alpha,
    // plus the one interval since the last held 2xx.
    expect(gov.currentRate).toBeLessThanOrEqual(r1 + alphaFor(r1) * (2 + 1 / r1) + 1e-9);
    await vi.runAllTimersAsync();
    await Promise.all(calls);
  });

  it('the effective interval never goes below the configured minIntervalMs', async () => {
    const minIntervalMs = 100;
    let cut = false;
    const net = stubFetch((d) => {
      if (!cut && d.at >= 3000) {
        cut = true;
        return { status: 429, headers: { 'retry-after': '1' }, after: 0 };
      }
      return { status: 200, headers: HEALTHY, after: 5 };
    });
    const provider = providerFor({ rateLimit: { minIntervalMs } });
    const gov = governorOf(provider);
    const calls = Array.from({ length: 500 }, (_, k) => ask(provider, `call-f${k}`));
    await at(48_000);
    // Recovery has carried the adaptive rate past the configured ceiling…
    expect(gov.currentRate).toBeGreaterThan(1000 / minIntervalMs);
    await vi.runAllTimersAsync();
    await Promise.all(calls);
    // …yet no two grants were ever closer than the configured interval.
    for (const gap of gaps(net.times())) expect(gap).toBeGreaterThanOrEqual(minIntervalMs);
  });
});

// ---------------------------------------------------------------------------
// AC38 — return to fully open against the PEAK one-second grant count.
// ---------------------------------------------------------------------------

describe('AC38: return to fully open', () => {
  it('sustained light load with a healthy hint reopens; the next burst goes out in one tick', async () => {
    const net = stubFetch((d) =>
      isWaveFirstAttempt(d)
        ? { status: 429, headers: { 'retry-after': '1' } }
        : { status: 200, headers: HEALTHY },
    );
    const provider = providerFor();
    const gov = governorOf(provider);
    const wave = launchWave(provider);
    await vi.runAllTimersAsync();
    await Promise.all(wave);
    const lastRetry = Math.max(...net.times((d) => d.attempt === 2));
    let reopenedAt: number | undefined;
    for (let t = 4000; t <= 40_000; t += 1000) {
      await at(t);
      const light = ask(provider, `call-l${t}`);
      await at(t + 100);
      await light;
      if (reopenedAt === undefined && gov.currentRate === undefined) reopenedAt = t;
    }
    expect(reopenedAt).toBeDefined();
    // Not before the retriers' burst left the window and the period elapsed.
    expect(reopenedAt!).toBeGreaterThanOrEqual(lastRetry + WINDOW_MS + REOPEN_PERIOD_MS - 1000);
    await at(41_000);
    const burst = Array.from({ length: WAVE }, (_, k) => ask(provider, `call-o${k}`));
    await vi.advanceTimersByTimeAsync(0);
    expect(net.times((d) => d.tag.startsWith('call-o'))).toEqual(Array(WAVE).fill(41_000));
    await vi.runAllTimersAsync();
    for (const r of await Promise.all(burst)) {
      expect((r as { value: ProviderResponse }).value.timing?.queuedMs).toBe(0);
    }
  });

  it('the same light load with a low hint never reopens and never grows', async () => {
    stubFetch((d) =>
      isWaveFirstAttempt(d)
        ? { status: 429, headers: { 'retry-after': '1' } }
        : { status: 200, headers: LOW },
    );
    const provider = providerFor();
    const gov = governorOf(provider);
    const wave = launchWave(provider);
    await vi.runAllTimersAsync();
    await Promise.all(wave);
    for (let t = 4000; t <= 40_000; t += 1000) {
      await at(t);
      const light = ask(provider, `call-l${t}`);
      await at(t + 100);
      await light;
    }
    expect(gov.currentRate).toBe(BETA * WAVE);
  });

  it('a bursty-but-light workload whose peak second is near rate does not reopen', async () => {
    const net = stubFetch((d) =>
      isWaveFirstAttempt(d)
        ? { status: 429, headers: { 'retry-after': '1' } }
        : { status: 200, headers: HEALTHY },
    );
    const provider = providerFor();
    const gov = governorOf(provider);
    const calls = launchWave(provider);
    await vi.runAllTimersAsync();
    // A burst of 25 every 5 s: light on average, but each burst fills a second.
    for (let t = 5000; t <= 80_000; t += 5000) {
      await at(t);
      calls.push(...Array.from({ length: WAVE }, (_, k) => ask(provider, `call-b${t}x${k}`)));
    }
    await vi.runAllTimersAsync();
    await Promise.all(calls);
    expect(gov.currentRate).toBeDefined();
    const last = net.times((d) => d.tag.startsWith('call-b80000x'));
    for (const gap of gaps(last)) expect(gap).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC32 / AC21 — no adaptation without a dialect or with the kill switch.
// ---------------------------------------------------------------------------

describe('AC32 / AC21 (guards): nothing adapts without a dialect or with adaptive: false', () => {
  it.each<[string, Parameters<typeof providerFor>[0], string]>([
    [
      'adaptive: false on OpenAI',
      { rateLimit: { adaptive: false, maxConcurrent: WAVE } },
      'gpt-4o',
    ],
    [
      'OpenAI behind a proxy',
      { rateLimit: { maxConcurrent: WAVE }, baseUrl: 'https://llm-gateway.example.com/v1' },
      'gpt-4o',
    ],
    [
      'groq (dialect-less)',
      { family: 'groq', rateLimit: { maxConcurrent: WAVE } },
      'llama-3.3-70b',
    ],
  ])(
    '%s: the 429 wave neither brakes nor paces; every retry leaves together',
    async (_l, options, model) => {
      const net = stubFetch((d) =>
        isWaveFirstAttempt(d) ? { status: 429, headers: { 'retry-after': '1' } } : { status: 200 },
      );
      const provider = providerFor(options);
      const wave = Array.from({ length: WAVE }, (_, k) => ask(provider, `call-w${k}`, { model }));
      await vi.runAllTimersAsync();
      expect((await Promise.all(wave)).every((r) => r.ok)).toBe(true);
      // Each call slept its own Retry-After holding its permit: no spacing, no brake.
      expect(net.times((d) => d.attempt === 2)).toEqual(Array(WAVE).fill(1010));
      expect(governorOf(provider, model).currentRate).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    },
  );
});

// ---------------------------------------------------------------------------
// AC31 (guard) — before the first 429 nothing is paced, whatever the body.
// ---------------------------------------------------------------------------

describe('AC31 (guard): fully open before the first 429', () => {
  const ONE_MB_BASE64 = Buffer.alloc(768 * 1024, 7).toString('base64'); // 1 MiB of base64

  function heavyMessages(tag: string): ChatMessage[] {
    return [
      {
        role: 'system',
        content: `You are a careful assistant. ${'Long cached preamble. '.repeat(5000)}`,
      },
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', data: ONE_MB_BASE64, mediaType: 'image/png' },
          },
          { type: 'text', text: tag },
        ],
      },
    ];
  }

  it('10 cached-prompt calls with a 1 MB base64 image each dispatch in one tick, queuedMs 0, even after low hints', async () => {
    expect(ONE_MB_BASE64.length).toBe(1024 * 1024);
    const lowAnthropicHint = {
      'anthropic-ratelimit-requests-limit': '1000',
      'anthropic-ratelimit-requests-remaining': '1',
    };
    const net = stubFetch(() => ({ status: 200, headers: lowAnthropicHint }));
    const provider = providerFor({ family: 'anthropic', rateLimit: { maxConcurrent: 10 } });
    const gov = governorOf(provider, MODEL.anthropic);
    for (const round of ['r1', 'r2']) {
      const start = Date.now() - T0;
      const calls = Array.from({ length: 10 }, (_, k) =>
        ask(
          provider,
          `call-${round}x${k}`,
          { model: MODEL.anthropic, promptCache: true },
          heavyMessages(`call-${round}x${k}`),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(net.times((d) => d.tag.startsWith(`call-${round}`))).toEqual(Array(10).fill(start));
      await vi.runAllTimersAsync();
      for (const r of await Promise.all(calls)) {
        expect(r.ok).toBe(true);
        expect((r as { value: ProviderResponse }).value.timing?.queuedMs).toBe(0);
      }
    }
    // The low hint was read, and it paced nothing: a hint never brakes or spaces.
    expect(gov.lastHint).toBeLessThan(HINT_THRESHOLD);
    expect(gov.currentRate).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Messages — adaptation says so once; the static-cap warning stays static.
// ---------------------------------------------------------------------------

describe('adaptation messages', () => {
  it('one engagement message per scope, naming the family only; no queued warning for adaptive spacing', async () => {
    stubFetch((d) =>
      isWaveFirstAttempt(d) || (d.tag === 'call-w0' && d.attempt === 2)
        ? { status: 429, headers: { 'retry-after': '1' } }
        : { status: 200 },
    );
    const provider = providerFor({ rateLimit: { maxConcurrent: 100 }, apiKey: 'sk-SECRET-KEY' });
    const gov = governorOf(provider);
    const calls = launchWave(provider);
    await at(20);
    calls.push(...Array.from({ length: 50 }, (_, k) => ask(provider, `call-q${k}`)));
    await vi.runAllTimersAsync();
    await Promise.all(calls);
    expect(gov.currentRate).toBeLessThan(BETA * WAVE); // it cut twice
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('Rate governor');
    expect(messages[0]).toContain('openai');
    expect(messages[0]).not.toContain('SECRET');
    expect(messages[0]).not.toContain('api.openai.com');
  });

  it('a binding static cap still warns once, alongside the engagement message', async () => {
    stubFetch((d) =>
      isWaveFirstAttempt(d) ? { status: 429, headers: { 'retry-after': '1' } } : { status: 200 },
    );
    const provider = providerFor({ rateLimit: { maxConcurrent: 5 } });
    const calls = launchWave(provider);
    await vi.runAllTimersAsync();
    await Promise.all(calls);
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.filter((m) => m.includes('request queued'))).toHaveLength(1);
    expect(messages.filter((m) => m.includes('Rate governor'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Constants (Q10): internal, and consistent with the plan's shape.
// ---------------------------------------------------------------------------

describe('ADAPTIVE_RATE', () => {
  it('is frozen, and MIN_RATE is a floor below any seeded cut', () => {
    expect(Object.isFrozen(ADAPTIVE_RATE)).toBe(true);
    expect(MIN_RATE).toBeLessThan(BETA);
  });
});
