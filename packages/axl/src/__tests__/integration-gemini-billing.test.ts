import { describe, expect, it, vi } from 'vitest';
import type { ModelInput } from '../input.js';
import { GeminiProvider } from '../providers/gemini.js';
import type { ProviderResponse } from '../types.js';
import { TINY_PNG_BASE64 } from './fixtures/rich-input-baselines.js';

// Paid billing probes are separately armed from the routine integration suite.
// A provider key alone never spends, and the repository-wide kill switch wins.
function geminiBillingLiveEnabled(env: Record<string, string | undefined>): boolean {
  return env.AXL_GEMINI_BILLING_LIVE === '1' && env.AXL_DISABLE_LIVE_INTEGRATION !== '1';
}

const RUN = geminiBillingLiveEnabled(process.env);
const HAS_KEY = !!(process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY);
const MODEL = 'gemini-3.7-flash';

type RawModality = { modality?: unknown; tokens?: unknown };
type RawUsage = {
  total_input_tokens?: unknown;
  total_output_tokens?: unknown;
  total_thought_tokens?: unknown;
  total_cached_tokens?: unknown;
  total_tool_use_tokens?: unknown;
  total_tokens?: unknown;
  input_tokens_by_modality?: unknown;
};

type WireAttempt = {
  method: string;
  path: string;
  request: {
    apiKeyHeaderPresent: boolean;
    headerNames: string[];
    model?: unknown;
    serviceTier?: unknown;
    store?: unknown;
    stream?: unknown;
    inputTypes: string[];
    maxOutputTokens?: unknown;
    thinkingLevel?: unknown;
  };
  response?: {
    status: number;
    serviceTier?: unknown;
    header: Record<string, string>;
    usage?: RawUsage;
    diagnosticBody: 'parsed-json' | 'malformed-json' | 'not-json';
  };
  networkError?: { name?: unknown; code?: unknown };
};

type WireObservation = {
  totalAttempts: number;
  attempts: WireAttempt[];
};

function recordNumber(value: unknown, name: string): number {
  expect(value, name).toBeTypeOf('number');
  expect(Number.isSafeInteger(value), name).toBe(true);
  expect(value, name).toBeGreaterThanOrEqual(0);
  return value as number;
}

function safeResponseHeaders(headers: Headers): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const name of [
    'content-type',
    'x-gemini-service-tier',
    'x-goog-request-id',
    'x-request-id',
  ]) {
    const value = headers.get(name);
    if (value !== null) safe[name] = value;
  }
  return safe;
}

function safeRequestBody(body: unknown): WireAttempt['request'] {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const generation =
    record.generation_config && typeof record.generation_config === 'object'
      ? (record.generation_config as Record<string, unknown>)
      : {};
  const inputTypes = Array.isArray(record.input)
    ? record.input.flatMap((step) => {
        if (!step || typeof step !== 'object') return [];
        const content = (step as { content?: unknown }).content;
        if (!Array.isArray(content)) return [];
        return content.flatMap((part) =>
          part && typeof part === 'object' && typeof (part as { type?: unknown }).type === 'string'
            ? [(part as { type: string }).type]
            : [],
        );
      })
    : [];
  return {
    apiKeyHeaderPresent: false,
    headerNames: [],
    model: record.model,
    serviceTier: record.service_tier,
    store: record.store,
    stream: record.stream,
    inputTypes,
    maxOutputTokens: generation.max_output_tokens,
    thinkingLevel: generation.thinking_level,
  };
}

/** Capture only billing evidence; raw credentials and inline media are never retained. */
async function observeGeminiCall(
  call: () => Promise<ProviderResponse>,
): Promise<{ result: ProviderResponse; wire: WireObservation }> {
  const originalFetch = globalThis.fetch;
  let totalAttempts = 0;
  const attempts: WireAttempt[] = [];
  globalThis.fetch = async (input, init) => {
    totalAttempts++;
    const request = input instanceof Request ? input : undefined;
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const headers = new Headers(init?.headers ?? request?.headers);
    let parsedBody: unknown;
    if (typeof init?.body === 'string') {
      try {
        parsedBody = JSON.parse(init.body) as unknown;
      } catch {
        parsedBody = undefined;
      }
    }
    const safeRequest = safeRequestBody(parsedBody);
    safeRequest.apiKeyHeaderPresent = headers.has('x-goog-api-key');
    safeRequest.headerNames = [...headers.keys()].sort();
    const attempt: WireAttempt = {
      method: init?.method ?? request?.method ?? 'GET',
      path: url.pathname,
      request: safeRequest,
    };
    // Retain at most the transport's three expected attempts. Counting
    // continues separately so an unexpected fourth attempt still fails.
    if (attempts.length < 3) attempts.push(attempt);

    let response: Response;
    try {
      response = await originalFetch(input, init);
    } catch (error) {
      attempt.networkError =
        error && typeof error === 'object'
          ? {
              name: (error as { name?: unknown }).name,
              code: (error as { code?: unknown }).code,
            }
          : { name: typeof error };
      throw error;
    }

    // Status and safe headers survive even if diagnostic body parsing fails.
    attempt.response = {
      status: response.status,
      header: safeResponseHeaders(response.headers),
      diagnosticBody: 'not-json',
    };
    if ((response.headers.get('content-type') ?? '').includes('application/json')) {
      try {
        const parsed = (await response.clone().json()) as unknown;
        attempt.response.diagnosticBody = 'parsed-json';
        if (parsed && typeof parsed === 'object') {
          const responseBody = parsed as Record<string, unknown>;
          attempt.response.serviceTier = responseBody.service_tier;
          if (responseBody.usage && typeof responseBody.usage === 'object') {
            attempt.response.usage = responseBody.usage as RawUsage;
          }
        }
      } catch {
        // Capture is diagnostic only. The untouched response continues to the
        // adapter, which owns the original success/error behavior.
        attempt.response.diagnosticBody = 'malformed-json';
      }
    }
    return response;
  };

  try {
    const result = await call();
    if (attempts.length === 0) throw new Error('Gemini billing probe captured no request');
    return { result, wire: { totalAttempts, attempts } };
  } catch (error) {
    console.info(
      '[Gemini billing probe failed]',
      JSON.stringify({
        totalAttempts,
        attempts,
        error:
          error && typeof error === 'object'
            ? {
                name: (error as { name?: unknown }).name,
                code: (error as { code?: unknown }).code,
                status: (error as { status?: unknown }).status,
              }
            : { name: typeof error },
      }),
    );
    throw error;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function logEvidence(row: 'V5' | 'V3', result: ProviderResponse, wire: WireObservation): void {
  console.info(
    `[${row}] Gemini billing evidence`,
    JSON.stringify({
      model: MODEL,
      totalAttempts: wire.totalAttempts,
      attempts: wire.attempts,
      answer: result.content.slice(0, 200),
      cost: result.cost,
    }),
  );
}

type ActualTierAssessment = {
  valid: boolean;
  observed?: 'priority' | 'standard';
  downgraded?: boolean;
  reason?: 'missing' | 'unknown' | 'conflict';
};

function recognizedActualTier(value: unknown): 'priority' | 'standard' | undefined {
  switch (value) {
    case 'priority':
    case 'SERVICE_TIER_PRIORITY':
      return 'priority';
    case 'standard':
    case 'SERVICE_TIER_STANDARD':
    case 'SERVICE_TIER_UNSPECIFIED':
      return 'standard';
    default:
      return undefined;
  }
}

function assessActualTier(attempt: WireAttempt): ActualTierAssessment {
  const topLevel = attempt.response?.serviceTier;
  const header = attempt.response?.header['x-gemini-service-tier'];
  if (topLevel === undefined && header === undefined) return { valid: false, reason: 'missing' };
  const topLevelTier = topLevel === undefined ? undefined : recognizedActualTier(topLevel);
  const headerTier = header === undefined ? undefined : recognizedActualTier(header);
  if (
    (topLevel !== undefined && topLevelTier === undefined) ||
    (header !== undefined && headerTier === undefined)
  ) {
    return { valid: false, reason: 'unknown' };
  }
  if (topLevelTier !== undefined && headerTier !== undefined && topLevelTier !== headerTier) {
    return { valid: false, reason: 'conflict' };
  }
  const observed = topLevelTier ?? headerTier;
  if (observed === undefined) return { valid: false, reason: 'missing' };
  return { valid: true, observed, downgraded: observed === 'standard' };
}

function terminalAttempt(wire: WireObservation): WireAttempt {
  const attempt = wire.attempts.at(-1);
  if (!attempt) throw new Error('Gemini billing probe captured no terminal attempt');
  return attempt;
}

describe('Gemini billing tier evidence assessment', () => {
  const attempt = (serviceTier?: unknown, headerTier?: string): WireAttempt => ({
    method: 'POST',
    path: '/v1beta/interactions',
    request: safeRequestBody({ service_tier: 'priority' }),
    response: {
      status: 200,
      header: headerTier === undefined ? {} : { 'x-gemini-service-tier': headerTier },
      serviceTier,
      diagnosticBody: 'parsed-json',
    },
  });

  it.each([
    [
      'priority body',
      attempt('priority'),
      { valid: true, observed: 'priority', downgraded: false },
    ],
    [
      'Standard downgrade header',
      attempt(undefined, 'standard'),
      { valid: true, observed: 'standard', downgraded: true },
    ],
    ['missing', attempt(), { valid: false, reason: 'missing' }],
    ['unknown', attempt('future-tier'), { valid: false, reason: 'unknown' }],
    ['conflict', attempt('priority', 'standard'), { valid: false, reason: 'conflict' }],
  ])('%s', (_label, wireAttempt, expected) => {
    expect(assessActualTier(wireAttempt)).toEqual(expected);
  });

  it('retains sanitized request, status, and headers when diagnostic JSON is malformed', async () => {
    const outerFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{malformed', {
        status: 503,
        headers: {
          'content-type': 'application/json',
          'x-gemini-service-tier': 'standard',
        },
      }),
    ) as typeof globalThis.fetch;
    try {
      const { wire } = await observeGeminiCall(async () => {
        const response = await fetch(
          'https://generativelanguage.googleapis.com/v1beta/interactions',
          {
            method: 'POST',
            headers: { 'x-goog-api-key': 'never-log-this-key' },
            body: JSON.stringify({
              model: MODEL,
              service_tier: 'priority',
              store: false,
              input: [{ type: 'user_input', content: [{ type: 'text', text: 'ready' }] }],
            }),
          },
        );
        expect(await response.text()).toBe('{malformed');
        return { content: 'captured' };
      });
      expect(terminalAttempt(wire)).toMatchObject({
        path: '/v1beta/interactions',
        request: {
          apiKeyHeaderPresent: true,
          model: MODEL,
          serviceTier: 'priority',
          store: false,
          inputTypes: ['text'],
        },
        response: {
          status: 503,
          header: { 'x-gemini-service-tier': 'standard' },
          diagnosticBody: 'malformed-json',
        },
      });
    } finally {
      globalThis.fetch = outerFetch;
    }
  });

  it('retains the sanitized pre-dispatch request and rethrows the same network failure', async () => {
    const outerFetch = globalThis.fetch;
    const failure = Object.assign(new Error('network unavailable'), { code: 'ENETDOWN' });
    globalThis.fetch = vi.fn().mockRejectedValue(failure) as typeof globalThis.fetch;
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      let thrown: unknown;
      try {
        await observeGeminiCall(async () => {
          await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
            method: 'POST',
            headers: { 'x-goog-api-key': 'never-log-this-key' },
            body: JSON.stringify({ model: MODEL, service_tier: 'priority', store: false }),
          });
          return { content: 'unreachable' };
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(failure);
      const diagnostic = JSON.stringify(info.mock.calls);
      const evidence = JSON.parse(info.mock.calls[0]![1] as string);
      expect(evidence.attempts[0].request).toMatchObject({
        model: MODEL,
        serviceTier: 'priority',
        store: false,
        apiKeyHeaderPresent: true,
      });
      expect(diagnostic).toContain('/v1beta/interactions');
      expect(diagnostic).toContain('ENETDOWN');
      expect(diagnostic).not.toContain('never-log-this-key');
    } finally {
      info.mockRestore();
      globalThis.fetch = outerFetch;
    }
  });
});

describe.skipIf(!RUN || !HAS_KEY)('Gemini billing live V5: image formula', () => {
  it('V5 uses the Interactions image bucket and matches the Standard catalog formula', async () => {
    const input: ModelInput = [
      {
        type: 'image',
        source: { type: 'base64', data: TINY_PNG_BASE64, mediaType: 'image/png' },
      },
      { type: 'text', text: 'Reply with one short word describing whether this image is visible.' },
    ];
    const provider = new GeminiProvider();
    const { result, wire } = await observeGeminiCall(() =>
      provider.chat([{ role: 'user', content: input }], {
        model: MODEL,
        maxTokens: 400,
        effort: 'low',
        signal: AbortSignal.timeout(55_000),
        providerOptions: { service_tier: 'standard' },
      }),
    );

    const attempt = terminalAttempt(wire);
    logEvidence('V5', result, wire);
    expect(wire.totalAttempts).toBeLessThanOrEqual(3);
    expect(attempt.path).toBe('/v1beta/interactions');
    expect(attempt.request).toMatchObject({
      apiKeyHeaderPresent: true,
      model: MODEL,
      serviceTier: 'standard',
      store: false,
      stream: false,
    });
    expect(attempt.request.inputTypes).toContain('image');
    const usage = attempt.response?.usage;
    expect(usage).toBeDefined();
    const modalities = usage?.input_tokens_by_modality;
    expect(Array.isArray(modalities)).toBe(true);
    const imageTokens = (modalities as RawModality[])
      .filter((entry) => String(entry.modality).toLowerCase() === 'image')
      .reduce((sum, entry) => sum + recordNumber(entry.tokens, 'image modality tokens'), 0);
    expect(imageTokens).toBeGreaterThan(0);

    const inputTokens = recordNumber(usage?.total_input_tokens, 'total input tokens');
    const outputTokens = recordNumber(usage?.total_output_tokens, 'total output tokens');
    const thoughtTokens =
      usage?.total_thought_tokens === undefined
        ? 0
        : recordNumber(usage.total_thought_tokens, 'thought tokens');
    const cachedTokens =
      usage?.total_cached_tokens === undefined
        ? 0
        : recordNumber(usage.total_cached_tokens, 'cached tokens');
    const expected =
      (inputTokens - cachedTokens) * 0.75e-6 +
      cachedTokens * 0.075e-6 +
      (outputTokens + thoughtTokens) * 3.75e-6;
    expect(result.cost).toBeTypeOf('number');
    expect(result.cost).toBeGreaterThan(0);
    expect(result.cost).toBeCloseTo(expected, 14);
  });
});

describe.skipIf(!RUN || !HAS_KEY)('Gemini billing live V3: priority tier', () => {
  it('V3 emits documented priority service_tier and remains conservatively unpriced', async () => {
    const input: ModelInput = [{ type: 'text', text: 'Reply with exactly one short word: ready' }];
    const provider = new GeminiProvider();
    const { result, wire } = await observeGeminiCall(() =>
      provider.chat([{ role: 'user', content: input }], {
        model: MODEL,
        maxTokens: 400,
        effort: 'low',
        signal: AbortSignal.timeout(55_000),
        providerOptions: { service_tier: 'priority' },
      }),
    );

    const attempt = terminalAttempt(wire);
    const actualTier = assessActualTier(attempt);
    console.info(
      '[V3] observed service tier',
      JSON.stringify({
        actualTier,
        topLevel: attempt.response?.serviceTier,
        header: attempt.response?.header['x-gemini-service-tier'],
      }),
    );
    logEvidence('V3', result, wire);
    expect(actualTier.valid).toBe(true);
    expect(['priority', 'standard']).toContain(actualTier.observed);
    expect(actualTier.downgraded).toBe(actualTier.observed === 'standard');
    expect(wire.totalAttempts).toBeLessThanOrEqual(3);
    expect(attempt.path).toBe('/v1beta/interactions');
    expect(attempt.request).toMatchObject({
      apiKeyHeaderPresent: true,
      model: MODEL,
      serviceTier: 'priority',
      store: false,
      stream: false,
    });
    expect(attempt.request.inputTypes).toEqual(['text']);
    expect(result.usage?.prompt_tokens).toBeGreaterThan(0);
    expect(result.usage?.completion_tokens).toBeGreaterThan(0);
    expect(result.cost).toBeUndefined();
  });
});
