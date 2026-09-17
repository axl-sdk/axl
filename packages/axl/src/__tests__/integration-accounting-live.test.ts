/**
 * Live-provider closure of the plan's accounting checklist (rows L1, L3, L7).
 *
 * The branch changed two contracts inside `OpenAICompatibleProvider` that only
 * a real transport can exercise end to end:
 *
 *   - `costProvenance` on the chat response and the stream's `done` tick, which
 *     distinguishes a vendor-supplied USD figure (`from-response` profiles:
 *     OpenRouter, xAI) from an Axl price-table estimate (DeepSeek, Mistral,
 *     Groq). Both branches are asserted against their own live provider.
 *   - `admission: options.dispatchAdmission` handed to the retry transport,
 *     which checks admission immediately before every `fetch`. The live claim
 *     is that a closed budget stops the request from leaving the process, so
 *     the assertion counts real `fetch` calls rather than trusting the error.
 *
 * Gated per provider and excluded from the default run; fires under
 * `pnpm test:integration`. Payloads are one short message at `maxTokens: 16`.
 */

import { readFileSync } from 'node:fs';

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

import { agent } from '../agent.js';
import { workflow } from '../workflow.js';
import { AxlRuntime } from '../runtime.js';
import { AdmissionController } from '../accounting.js';
import { AdmissionDeniedError } from '../errors.js';
import type { CapturedRequestRecord } from '../diagnostics/capture.js';
import type { ChatMessage } from '../providers/types.js';
import { CollectingSink, channelWith, phase } from './request-capture-helpers.js';

const PROMPT: ChatMessage[] = [{ role: 'user', content: 'Reply with the single word: ok' }];
const TINY = { maxTokens: 16, temperature: 0 } as const;

/**
 * Cheapest configured model per pricing kind — the two `costProvenance`
 * branches. Groq leads the table-priced list because DeepSeek does not
 * currently reach a price at all: a request for `deepseek-v4-flash` comes back
 * echoing `deepseek-flash`, which its exact-match table has no row for, so the
 * call settles `unpriced_model`. That is a pre-existing catalog gap (the table
 * predates this branch, which touches neither it nor the matcher) and it is
 * recorded as such rather than papered over here — but it cannot carry a row
 * that needs a real charge to exist.
 */
const TABLE_PRICED = process.env.GROQ_API_KEY
  ? { uri: 'groq:openai/gpt-oss-20b', label: 'groq' }
  : process.env.MISTRAL_API_KEY
    ? { uri: 'mistral:mistral-small-latest', label: 'mistral' }
    : undefined;

const RESPONSE_PRICED = process.env.OPENROUTER_API_KEY
  ? { uri: 'openrouter:openai/gpt-4o-mini', label: 'openrouter' }
  : process.env.XAI_API_KEY
    ? { uri: 'xai:grok-4.20', label: 'xai' }
    : undefined;

function runtimeFor(uri: string): AxlRuntime {
  return new AxlRuntime({ defaultProvider: uri.split(':')[0], trace: { enabled: false } });
}

/** Run `fn` under capture and hand back the sealed records. */
async function captured(
  runtime: AxlRuntime,
  fn: () => Promise<unknown>,
): Promise<{
  records: CapturedRequestRecord[];
  outcome: Awaited<ReturnType<AxlRuntime['trackOutcome']>>;
}> {
  const sink = new CollectingSink();
  const channel = channelWith(sink);
  const outcome = await runtime.trackOutcome(fn, { capture: channel });
  await channel.close();
  return { records: sink.records(), outcome };
}

// ── L1: settlement and provenance on a real call ─────────────────────────

describe.skipIf(!TABLE_PRICED)(`L1 table-priced settlement (${TABLE_PRICED?.label})`, () => {
  const uri = TABLE_PRICED?.uri ?? 'unconfigured:none';

  it('settles one operation with a usable charge marked as an Axl estimate', async () => {
    const runtime = runtimeFor(uri);
    const { provider, model } = runtime.resolveProvider(uri);

    const outcome = await runtime.trackOutcome(() => provider.chat(PROMPT, { model, ...TINY }));

    expect(outcome.status).toBe('fulfilled');
    // A table-priced provider prices every call it returns usage for, so the
    // run is complete — `incomplete` here would mean the rail lost a charge.
    expect(outcome.accounting.completeness).toBe('complete');
    expect(outcome.accounting.operations.total).toBe(1);
    expect(outcome.accounting.knownCost).toBeGreaterThan(0);

    const response = await outcome.value;
    expect(response.usage?.total_tokens).toBeGreaterThan(0);
    expect(response.costProvenance).toBe('price_table_estimate');
  });

  it('marks the stream done tick with the same provenance as the chat path', async () => {
    const runtime = runtimeFor(uri);
    const { provider, model } = runtime.resolveProvider(uri);

    let done: { cost?: number; costProvenance?: string } | undefined;
    const outcome = await runtime.trackOutcome(async () => {
      for await (const chunk of provider.stream!(PROMPT, { model, ...TINY })) {
        if (chunk.type === 'done') done = chunk as typeof done;
      }
    });

    expect(outcome.status).toBe('fulfilled');
    expect(outcome.accounting.operations.total).toBe(1);
    expect(done?.costProvenance).toBe('price_table_estimate');
    expect(done?.cost).toBeGreaterThan(0);
  });

  it('reports the same accounting shape with capture on as with it off', async () => {
    const runtime = runtimeFor(uri);
    const { provider, model } = runtime.resolveProvider(uri);
    const call = () => provider.chat(PROMPT, { model, ...TINY });

    const off = await runtime.trackOutcome(call);
    const { records, outcome: on } = await captured(runtime, call);

    // Token counts differ run to run, so the invariant is the shape of the
    // record, not the dollar figure: capture cannot add, drop, or unsettle an
    // operation.
    expect(on.accounting.completeness).toBe(off.accounting.completeness);
    expect(on.accounting.operations.total).toBe(off.accounting.operations.total);
    expect(on.accounting.knownCost).toBeGreaterThan(0);
    expect(phase(records, 'start')).toHaveLength(1);
    expect(phase(records, 'end')).toHaveLength(1);
  });
});

describe.skipIf(!RESPONSE_PRICED)(
  `L1 vendor-reported settlement (${RESPONSE_PRICED?.label})`,
  () => {
    const uri = RESPONSE_PRICED?.uri ?? 'unconfigured:none';

    it('marks a vendor-supplied USD figure as provider-reported, not an estimate', async () => {
      const runtime = runtimeFor(uri);
      const { provider, model } = runtime.resolveProvider(uri);

      const outcome = await runtime.trackOutcome(() => provider.chat(PROMPT, { model, ...TINY }));

      expect(outcome.status).toBe('fulfilled');
      expect(outcome.accounting.operations.total).toBe(1);

      const response = await outcome.value;
      expect(typeof response.cost).toBe('number');
      expect(response.costProvenance).toBe('provider_reported');
    });
  },
);

// ── L3: a closed budget stops the request before it leaves the process ───

describe.skipIf(!TABLE_PRICED)(
  `L3 admission denial before dispatch (${TABLE_PRICED?.label})`,
  () => {
    const uri = TABLE_PRICED?.uri ?? 'unconfigured:none';

    it('does not dispatch a second request once a real charge closes the budget', async () => {
      const runtime = runtimeFor(uri);
      const { provider, model } = runtime.resolveProvider(uri);
      // Any real call exceeds this, so the first is admitted and settles, and the
      // second meets a closed controller.
      const admission = new AdmissionController({ limit: 1e-9 });

      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      let denied: unknown;
      try {
        const outcome = await runtime.trackOutcome(
          async () => {
            await provider.chat(PROMPT, { model, ...TINY });
            try {
              await provider.chat(PROMPT, { model, ...TINY });
            } catch (err) {
              denied = err;
            }
          },
          { admission },
        );

        expect(outcome.status).toBe('fulfilled');
        // The refusal is typed, and it arrives without a charge of its own.
        expect(denied).toBeInstanceOf(AdmissionDeniedError);
        expect(admission.status).toBe('closed');
        expect(admission.knownSpend).toBeGreaterThan(0);
        expect(outcome.accounting.operations.settled).toBe(1);
        expect(outcome.accounting.operations.denied).toBe(1);
        // The point of the row: the denied call never reached the network.
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  },
);

// ── L7: a real close is sealed with the reason it ended ─────────────────

describe.skipIf(!TABLE_PRICED)(`L7 termination fidelity (${TABLE_PRICED?.label})`, () => {
  const uri = TABLE_PRICED?.uri ?? 'unconfigured:none';

  it('seals a real stall-timeout close with the stall as its reason', async () => {
    const runtime = runtimeFor(uri);
    const asker = agent({ name: 'staller', model: uri, system: 'Answer in one word.' });
    runtime.register(
      workflow({
        name: 'stall',
        input: z.any(),
        handler: (ctx) =>
          // The stall timer is armed at fetch dispatch, and no live provider
          // answers within a millisecond, so this is a real stall close on a
          // real in-flight request rather than a simulated one.
          ctx.ask(asker, 'Reply with the single word: ok', {
            stallTimeout: '1ms',
            maxTokens: 16,
          } as never),
      }),
    );

    const { records, outcome } = await captured(runtime, () => runtime.execute('stall', {}));

    expect(outcome.status).toBe('rejected');
    const ends = phase(records, 'end');
    // `start_only` is reserved for a call that never came back. A request the
    // runtime deliberately cut short has to be distinguishable from one, or
    // stall triage reads every abandoned request as a hang. On the chat path
    // the closing error is what says why — `termination` labels a stream that
    // ended with no error to explain it.
    expect(ends).toHaveLength(1);
    expect(ends[0].error?.name).toBe('StallTimeout');
    expect(ends[0].transportAttempts).toBe(1);
  });

  it('labels a real stream cut short mid-flight with its termination reason', async () => {
    const runtime = runtimeFor(uri);
    const { provider, model } = runtime.resolveProvider(uri);

    const { records, outcome } = await captured(runtime, async () => {
      for await (const chunk of provider.stream!(PROMPT, { model, ...TINY })) {
        void chunk;
        // The runtime's stall-timeout close and a consumer break land on the
        // same iterator path, so this exercises it over a real network stream.
        break;
      }
    });

    expect(outcome.status).toBe('fulfilled');
    const ends = phase(records, 'end');
    expect(ends).toHaveLength(1);
    expect(ends[0].termination).toBe('stream closed by the consumer');
    // Diagnostics stay subordinate: a stream cut short before its `done` tick
    // has no charge to report, and the rail says so instead of inventing one.
    expect(outcome.accounting.operations.total).toBe(1);
    expect(outcome.accounting.completeness).toBe('incomplete');
  });
});

// ── L4: transcription settlement and dispatch scope ──────────────────────

/**
 * The transcription adapters take admission from the ambient dispatch scope
 * (`currentDispatchAdmission()`) rather than a call option, so the wiring is
 * distinct from the chat path proven in L3 and needs its own live evidence.
 * OpenRouter is the only changed transcription adapter with a configured key;
 * the OpenAI and Gemini transcription adapters, and the OpenAI embedder, carry
 * the same one-line change and remain unverified for want of credentials.
 *
 * Only the refusal runs by default. OpenRouter's `/audio/transcriptions`
 * endpoint serves no model on a default account — the sole audio model in its
 * catalog (`mistralai/voxtral-small-24b-2507`) is chat-completions only and the
 * endpoint answers `400 Model ... does not exist` — so the settlement half is
 * gated on an explicitly configured model, the way the Bedrock preset test is.
 * That leaves the refusal proving that admission is read at this call site, and
 * NOT proving that an admitted transcription reaches the provider.
 */
describe.skipIf(!process.env.OPENROUTER_API_KEY)(
  'L4 transcription dispatch scope (openrouter)',
  () => {
    const MODEL = process.env.OPENROUTER_TRANSCRIPTION_MODEL
      ? `openrouter-transcription:${process.env.OPENROUTER_TRANSCRIPTION_MODEL}`
      : 'openrouter-transcription:mistralai/voxtral-small-24b-2507';

    const audio = () => ({
      type: 'bytes' as const,
      data: Buffer.from(
        readFileSync(new URL('./fixtures/recorded-call.mp3.b64', import.meta.url), 'utf-8').trim(),
        'base64',
      ),
      mediaType: 'audio/mpeg' as const,
    });

    function transcriber(): AxlRuntime {
      const runtime = new AxlRuntime({ defaultProvider: 'openrouter', trace: { enabled: false } });
      runtime.register(
        workflow({
          name: 'listen',
          input: z.any(),
          handler: (ctx) => ctx.transcribe({ model: MODEL, audio: audio() }),
        }),
      );
      return runtime;
    }

    it.skipIf(!process.env.OPENROUTER_TRANSCRIPTION_MODEL)(
      'settles a real transcription as one terminal operation',
      async () => {
        const runtime = transcriber();
        const outcome = await runtime.trackOutcome(() => runtime.execute('listen', {}));

        expect(outcome.status).toBe('fulfilled');
        expect(outcome.accounting.operations.total).toBe(1);
        expect(outcome.accounting.operations.settled).toBe(1);
      },
      60_000,
    );

    it('refuses a transcription on a closed budget before the audio leaves the process', async () => {
      const runtime = transcriber();
      // Closed on construction: nothing in this scope may dispatch.
      const admission = new AdmissionController({ limit: 0 });

      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      try {
        const outcome = await runtime.trackOutcome(() => runtime.execute('listen', {}), {
          admission,
        });

        expect(outcome.status).toBe('rejected');
        expect(outcome.error).toBeInstanceOf(AdmissionDeniedError);
        expect(outcome.accounting.operations.denied).toBe(1);
        expect(outcome.accounting.knownCost).toBe(0);
        // The row is about dispatch scope: the upload never happened.
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  },
);
