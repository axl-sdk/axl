import { describe, expect, it, vi } from 'vitest';
import {
  CLASSIFY_BODY_CAP_BYTES,
  anthropicQuotaDialect,
  classifySafely,
  openaiQuotaDialect,
  quotaDialectFor,
  type QuotaDialect,
} from '../providers/quota.js';
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  OPENAI_DEFAULT_BASE_URL,
} from '../providers/default-endpoints.js';

const openai = openaiQuotaDialect;
const anthropic = anthropicQuotaDialect;

function openaiHeaders(v: {
  limitRequests?: string;
  remainingRequests?: string;
  limitTokens?: string;
  remainingTokens?: string;
}): Headers {
  const h = new Headers();
  if (v.limitRequests !== undefined) h.set('x-ratelimit-limit-requests', v.limitRequests);
  if (v.remainingRequests !== undefined)
    h.set('x-ratelimit-remaining-requests', v.remainingRequests);
  if (v.limitTokens !== undefined) h.set('x-ratelimit-limit-tokens', v.limitTokens);
  if (v.remainingTokens !== undefined) h.set('x-ratelimit-remaining-tokens', v.remainingTokens);
  return h;
}

function json429(body: unknown, headers: HeadersInit = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 429,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

// Vendor-documented shapes (plan §9 Q7). These are fixtures, not live evidence (L3).
const ANTHROPIC_SPEND_CAP = {
  type: 'error',
  error: {
    type: 'rate_limit_error',
    message:
      'You have reached your API usage limits: your organization has crossed its monthly API usage threshold.',
    details: { error_code: 'enforced_spend_limit_reached' },
  },
  request_id: 'req_018EeWyXxfu5pfWkrYcMdjWG',
};
const ANTHROPIC_RATE_LIMIT = {
  type: 'error',
  error: {
    type: 'rate_limit_error',
    message: 'Number of request tokens has exceeded your per-minute rate limit',
  },
};
const OPENAI_LEGACY_QUOTA = {
  error: {
    message: 'You exceeded your current quota, please check your plan and billing details.',
    type: 'insufficient_quota',
    param: null,
    code: 'insufficient_quota',
  },
};
const OPENAI_SLOW_DOWN = {
  error: {
    message: 'Your request rate increased too quickly.',
    type: 'rate_limit_error',
    code: 'slow_down',
  },
};

describe('quotaDialectFor', () => {
  // Derived from the adapters' default base URLs, never restated.
  const OPENAI = new URL(OPENAI_DEFAULT_BASE_URL).origin;
  const ANTHROPIC = new URL(ANTHROPIC_DEFAULT_BASE_URL).origin;
  const openaiHost = new URL(OPENAI_DEFAULT_BASE_URL).host;
  const anthropicHost = new URL(ANTHROPIC_DEFAULT_BASE_URL).host;

  it('returns a dialect for OpenAI and Anthropic at their own default origins', () => {
    expect(quotaDialectFor('openai', OPENAI)).toBe(openaiQuotaDialect);
    expect(quotaDialectFor('anthropic', ANTHROPIC)).toBe(anthropicQuotaDialect);
    // Spelling variants normalize to the same origin.
    expect(
      quotaDialectFor('anthropic', new URL(`https://${anthropicHost.toUpperCase()}:443/v1`).origin),
    ).toBe(anthropicQuotaDialect);
  });

  it('a first-party family at any other origin is dialect-less', () => {
    for (const origin of [
      'https://proxy.example.com',
      `http://${openaiHost}`,
      `https://${openaiHost}:8443`,
      `https://eu.${openaiHost}`,
      'http://localhost:4000',
      ANTHROPIC,
    ]) {
      expect(quotaDialectFor('openai', origin)).toBeUndefined();
    }
    for (const origin of ['https://gateway.example.com', OPENAI]) {
      expect(quotaDialectFor('anthropic', origin)).toBeUndefined();
    }
  });

  it('other families have no dialect, even at a vendor origin', () => {
    for (const family of [
      'google',
      'azure',
      'openrouter',
      'groq',
      'openai-responses',
      '',
      '__proto__',
      'constructor',
    ]) {
      expect(quotaDialectFor(family, OPENAI)).toBeUndefined();
      expect(quotaDialectFor(family, ANTHROPIC)).toBeUndefined();
    }
  });
});

describe('hint', () => {
  it('OpenAI: the minimum fraction over the request and token lanes', () => {
    const h = openaiHeaders({
      limitRequests: '500',
      remainingRequests: '450',
      limitTokens: '200000',
      remainingTokens: '50000',
    });
    expect(openai.hint(h)).toBe(0.25);
    const requestsTighter = openaiHeaders({
      limitRequests: '500',
      remainingRequests: '50',
      limitTokens: '200000',
      remainingTokens: '150000',
    });
    expect(openai.hint(requestsTighter)).toBe(0.1);
  });

  it('Anthropic: the minimum over requests, tokens, input-tokens and output-tokens lanes', () => {
    const base = {
      'anthropic-ratelimit-requests-limit': '1000',
      'anthropic-ratelimit-requests-remaining': '900',
      'anthropic-ratelimit-tokens-limit': '100000',
      'anthropic-ratelimit-tokens-remaining': '80000',
      'anthropic-ratelimit-input-tokens-limit': '80000',
      'anthropic-ratelimit-input-tokens-remaining': '60000',
      'anthropic-ratelimit-output-tokens-limit': '20000',
      'anthropic-ratelimit-output-tokens-remaining': '18000',
    };
    expect(anthropic.hint(new Headers(base))).toBe(0.75);
    // Each lane can be the binding one.
    const lanes: Array<[string, string, number]> = [
      ['anthropic-ratelimit-requests-remaining', '100', 0.1],
      ['anthropic-ratelimit-tokens-remaining', '10000', 0.1],
      ['anthropic-ratelimit-input-tokens-remaining', '8000', 0.1],
      ['anthropic-ratelimit-output-tokens-remaining', '2000', 0.1],
    ];
    for (const [name, value, expected] of lanes) {
      expect(anthropic.hint(new Headers({ ...base, [name]: value })), name).toBe(expected);
    }
  });

  it('OpenAI: the project-tokens lane can be the binding one', () => {
    const h = openaiHeaders({ limitTokens: '1000', remainingTokens: '900' });
    h.set('x-ratelimit-limit-project-tokens', '500');
    h.set('x-ratelimit-remaining-project-tokens', '50');
    expect(openai.hint(h)).toBe(0.1);
  });

  it('Anthropic: Priority Tier input and output lanes can be the binding one', () => {
    const base = {
      'anthropic-ratelimit-requests-limit': '1000',
      'anthropic-ratelimit-requests-remaining': '900',
    };
    for (const lane of ['input', 'output']) {
      const h = new Headers({
        ...base,
        [`anthropic-priority-${lane}-tokens-limit`]: '10000',
        [`anthropic-priority-${lane}-tokens-remaining`]: '1000',
      });
      expect(anthropic.hint(h), lane).toBe(0.1);
    }
  });

  it('reports exhaustion as 0 and ignores the reset headers entirely', () => {
    const h = openaiHeaders({ limitTokens: '1000', remainingTokens: '0' });
    h.set('x-ratelimit-reset-tokens', 'garbage-that-would-throw-if-parsed');
    expect(openai.hint(h)).toBe(0);
  });

  it("does not read the other dialect's headers", () => {
    const anthropicOnly = new Headers({
      'anthropic-ratelimit-requests-limit': '100',
      'anthropic-ratelimit-requests-remaining': '1',
    });
    expect(openai.hint(anthropicOnly)).toBeUndefined();
    expect(
      anthropic.hint(openaiHeaders({ limitRequests: '100', remainingRequests: '1' })),
    ).toBeUndefined();
  });

  it('absent headers yield undefined', () => {
    expect(openai.hint(new Headers())).toBeUndefined();
    expect(anthropic.hint(new Headers())).toBeUndefined();
  });

  it('a partial lane (only remaining, or only limit) is skipped, not read as 0', () => {
    expect(openai.hint(openaiHeaders({ remainingRequests: '0' }))).toBeUndefined();
    expect(openai.hint(openaiHeaders({ limitRequests: '100' }))).toBeUndefined();
    // A partial lane beside a complete one does not pull the minimum down.
    expect(
      openai.hint(
        openaiHeaders({ remainingRequests: '0', limitTokens: '1000', remainingTokens: '800' }),
      ),
    ).toBe(0.8);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['text', 'abc'],
    ['negative', '-5'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['exponent', '1e3'],
    ['hex', '0x10'],
    ['comma list', '10, 20'],
    ['overflow to Infinity', '9'.repeat(400)],
  ])('garbage remaining (%s) makes the lane unusable, never a throw', (_label, value) => {
    const h = openaiHeaders({
      limitRequests: '100',
      remainingRequests: value,
      limitTokens: '1000',
      remainingTokens: '500',
    });
    expect(() => openai.hint(h)).not.toThrow();
    expect(openai.hint(h)).toBe(0.5);
  });

  it.each([
    ['zero (division by zero)', '0'],
    ['empty', ''],
    ['negative', '-100'],
    ['text', 'unlimited'],
    ['overflow to Infinity', '9'.repeat(400)],
  ])('garbage limit (%s) makes the lane unusable', (_label, value) => {
    const h = openaiHeaders({
      limitRequests: value,
      remainingRequests: '0',
      limitTokens: '1000',
      remainingTokens: '500',
    });
    expect(openai.hint(h)).toBe(0.5);
    expect(
      openai.hint(openaiHeaders({ limitRequests: value, remainingRequests: '0' })),
    ).toBeUndefined();
  });

  it('accepts surrounding whitespace and decimal values', () => {
    expect(openai.hint(openaiHeaders({ limitTokens: ' 1000 ', remainingTokens: '250.0' }))).toBe(
      0.25,
    );
  });

  it('clamps remaining above limit to a full lane', () => {
    expect(openai.hint(openaiHeaders({ limitRequests: '100', remainingRequests: '500' }))).toBe(1);
    // A huge-but-finite remaining never lifts the hint above the tightest lane.
    expect(
      openai.hint(
        openaiHeaders({
          limitRequests: '100',
          remainingRequests: '1' + '0'.repeat(300),
          limitTokens: '10',
          remainingTokens: '3',
        }),
      ),
    ).toBe(0.3);
  });

  it('propagates a throw from the Headers object itself (governor containment, AC22)', () => {
    const broken = {
      get: () => {
        throw new Error('boom');
      },
    } as unknown as Headers;
    expect(() => openai.hint(broken)).toThrow('boom');
  });
});

describe('classify429', () => {
  it('Anthropic enforced_spend_limit_reached is a spend cap', async () => {
    await expect(anthropic.classify429(json429(ANTHROPIC_SPEND_CAP))).resolves.toBe('spend_cap');
  });

  it('an Anthropic rate_limit_error without the spend code is a rate limit', async () => {
    await expect(
      anthropic.classify429(json429(ANTHROPIC_RATE_LIMIT, { 'retry-after': '30' })),
    ).resolves.toBe('rate_limit');
  });

  it('Anthropic: a different details.error_code is not a spend cap', async () => {
    const body = {
      ...ANTHROPIC_SPEND_CAP,
      error: { ...ANTHROPIC_SPEND_CAP.error, details: { error_code: 'something_else' } },
    };
    await expect(anthropic.classify429(json429(body))).resolves.toBe('rate_limit');
  });

  it('OpenAI legacy insufficient_quota (type and code) is a spend cap', async () => {
    await expect(openai.classify429(json429(OPENAI_LEGACY_QUOTA))).resolves.toBe('spend_cap');
  });

  it('OpenAI error.type insufficient_quota alone is a spend cap', async () => {
    const body = { error: { message: 'm', type: 'insufficient_quota', code: 'some_future_code' } };
    await expect(openai.classify429(json429(body))).resolves.toBe('spend_cap');
  });

  it.each([
    'insufficient_quota',
    'credit_balance_exhausted',
    'organization_spend_limit_exceeded',
    'project_spend_limit_exceeded',
    'organization_usage_limit_exceeded',
  ])('OpenAI documented billing code %s is a spend cap regardless of type', async (code) => {
    const body = { error: { message: 'm', type: 'some_type', code } };
    await expect(openai.classify429(json429(body))).resolves.toBe('spend_cap');
  });

  it('OpenAI rate_limit_error (slow_down) is a rate limit', async () => {
    await expect(openai.classify429(json429(OPENAI_SLOW_DOWN))).resolves.toBe('rate_limit');
  });

  it("each dialect ignores the other vendor's spend-cap shape", async () => {
    // The Anthropic spend-cap body has type rate_limit_error and no OpenAI code.
    await expect(openai.classify429(json429(ANTHROPIC_SPEND_CAP))).resolves.toBe('rate_limit');
    await expect(anthropic.classify429(json429(OPENAI_LEGACY_QUOTA))).resolves.toBe('unknown');
  });

  it('the spend code must be under error.details / error, not elsewhere in the body', async () => {
    const misplacedAnthropic = {
      error: { type: 'x' },
      details: { error_code: 'enforced_spend_limit_reached' },
    };
    await expect(anthropic.classify429(json429(misplacedAnthropic))).resolves.toBe('unknown');
    const misplacedOpenai = {
      code: 'insufficient_quota',
      type: 'insufficient_quota',
      error: { type: 'x' },
    };
    await expect(openai.classify429(json429(misplacedOpenai))).resolves.toBe('unknown');
  });

  it.each<[string, string]>([
    ['non-JSON', 'Too Many Requests'],
    ['empty', ''],
    ['JSON null', 'null'],
    ['JSON array', '[1,2]'],
    ['error is a string', '{"error":"insufficient_quota"}'],
    ['error is null', '{"error":null}'],
    ['details is a string', '{"error":{"details":"enforced_spend_limit_reached"}}'],
    ['truncated JSON', '{"error":{"code":"insufficient_quota"'],
  ])('%s body classifies as unknown', async (_label, raw) => {
    await expect(openai.classify429(json429(raw))).resolves.toBe('unknown');
    await expect(anthropic.classify429(json429(raw))).resolves.toBe('unknown');
  });

  it('a non-429 is never classified', async () => {
    const res = new Response(JSON.stringify(OPENAI_LEGACY_QUOTA), { status: 400 });
    await expect(openai.classify429(res)).resolves.toBe('unknown');
    const res2 = new Response(JSON.stringify(ANTHROPIC_SPEND_CAP), { status: 400 });
    await expect(anthropic.classify429(res2)).resolves.toBe('unknown');
  });

  it('leaves the original body intact for the adapter (AC18/AC40)', async () => {
    const raw = JSON.stringify(ANTHROPIC_SPEND_CAP);
    const res = json429(raw);
    await expect(anthropic.classify429(res)).resolves.toBe('spend_cap');
    expect(res.bodyUsed).toBe(false);
    await expect(res.text()).resolves.toBe(raw);
  });

  it('reads at most the cap: a larger body is unknown, and the original still returns every byte', async () => {
    const padding = 'x'.repeat(CLASSIFY_BODY_CAP_BYTES * 4);
    const raw = JSON.stringify({ ...OPENAI_LEGACY_QUOTA, padding });
    expect(raw.length).toBeGreaterThan(CLASSIFY_BODY_CAP_BYTES);
    const res = json429(raw);
    await expect(openai.classify429(res)).resolves.toBe('unknown');
    await expect(res.text()).resolves.toBe(raw);
  });

  it('stops pulling a streamed body at the cap and cancels the rest', async () => {
    const chunk = new Uint8Array(4096).fill(0x20); // JSON whitespace
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 1000) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = new Response(stream, { status: 429 });
    await expect(openai.classify429(res)).resolves.toBe('unknown');
    // Pulls are bounded by the cap (plus the tee's read-ahead), not by the 4 MB stream.
    expect(pulled * chunk.byteLength).toBeLessThan(CLASSIFY_BODY_CAP_BYTES * 4);
    // The original branch is still live, so the source is not cancelled on its behalf...
    expect(cancelled).toBe(false);
    // ...and cancelling the original too releases it.
    await res.body!.cancel();
    expect(cancelled).toBe(true);
  });

  it('a body split across chunks at arbitrary boundaries still parses', async () => {
    const raw = new TextEncoder().encode(JSON.stringify(ANTHROPIC_SPEND_CAP));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < raw.length; i += 7) controller.enqueue(raw.subarray(i, i + 7));
        controller.close();
      },
    });
    await expect(anthropic.classify429(new Response(stream, { status: 429 }))).resolves.toBe(
      'spend_cap',
    );
  });

  it('a rejecting body read yields unknown', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('socket reset'));
      },
    });
    await expect(openai.classify429(new Response(stream, { status: 429 }))).resolves.toBe(
      'unknown',
    );
  });

  it('an already-consumed body yields unknown instead of throwing', async () => {
    const res = json429(OPENAI_LEGACY_QUOTA);
    await res.text();
    await expect(openai.classify429(res)).resolves.toBe('unknown');
  });

  it('bare fixtures without clone() or body yield unknown and do not throw (AC40, retry.test.ts shape)', async () => {
    const bare = { ok: false, status: 429, headers: new Headers() } as unknown as Response;
    await expect(openai.classify429(bare)).resolves.toBe('unknown');
    await expect(anthropic.classify429(bare)).resolves.toBe('unknown');
    const cloneWithoutBody = { status: 429, clone: () => ({ body: null }) } as unknown as Response;
    await expect(openai.classify429(cloneWithoutBody)).resolves.toBe('unknown');
    const throwingClone = {
      status: 429,
      clone: () => {
        throw new TypeError('Response.clone: Body has already been consumed.');
      },
    } as unknown as Response;
    await expect(anthropic.classify429(throwingClone)).resolves.toBe('unknown');
  });

  it('never logs the body', async () => {
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      await anthropic.classify429(json429(ANTHROPIC_SPEND_CAP));
      await openai.classify429(json429('not json at all'));
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe('classifySafely', () => {
  it('passes a dialect result through', async () => {
    await expect(classifySafely(anthropic, json429(ANTHROPIC_SPEND_CAP))).resolves.toBe(
      'spend_cap',
    );
  });

  it('contains a rejecting or synchronously throwing dialect as unknown', async () => {
    const rejecting: QuotaDialect = {
      hint: () => undefined,
      classify429: () => Promise.reject(new Error('x')),
    };
    const throwing: QuotaDialect = {
      hint: () => undefined,
      classify429: () => {
        throw new Error('sync');
      },
    };
    const res = json429(OPENAI_LEGACY_QUOTA);
    await expect(classifySafely(rejecting, res)).resolves.toBe('unknown');
    await expect(classifySafely(throwing, res)).resolves.toBe('unknown');
  });
});
