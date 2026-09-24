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
import { InMemoryVectorStore } from '../memory/vector-memory.js';
import { OpenAIEmbedder } from '../memory/embedder-openai.js';
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
 * Both halves run: the refusal proves admission is read at this call site, and
 * the settlement proves an admitted transcription still reaches the provider —
 * a refusal test alone would pass just as well if transcription were broken
 * outright. `OPENROUTER_TRANSCRIPTION_MODEL` overrides the model.
 */
describe.skipIf(!process.env.OPENROUTER_API_KEY)(
  'L4 transcription dispatch scope (openrouter)',
  () => {
    const MODEL = process.env.OPENROUTER_TRANSCRIPTION_MODEL
      ? `openrouter-transcription:${process.env.OPENROUTER_TRANSCRIPTION_MODEL}`
      : 'openrouter-transcription:openai/whisper-1';

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

    it('settles a real transcription as one terminal operation', async () => {
      const runtime = transcriber();
      const outcome = await runtime.trackOutcome(() => runtime.execute('listen', {}));

      expect(outcome.status).toBe('fulfilled');
      expect(outcome.accounting.operations.total).toBe(1);
      expect(outcome.accounting.operations.settled).toBe(1);
    }, 60_000);

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

// ── L2 / L6: the changed native adapters ─────────────────────────────────

/**
 * `anthropic.ts`, `gemini.ts` and `openai-responses.ts` each rewrite the
 * provider-neutral request into their own wire shape — Anthropic hoists the
 * system message out of `messages`, Gemini renames roles and wraps content in
 * `parts`. Capture snapshots by value at the facade, BEFORE the adapter runs,
 * so what lands in a record must still be the caller's request. A10.6 proves
 * that against a hand-written mutating mock; these prove it against the
 * adapters that actually mutate.
 */
const NATIVE = [
  { env: 'OPENAI_API_KEY', label: 'openai-responses', uri: 'openai-responses:gpt-4o-mini' },
  { env: 'ANTHROPIC_API_KEY', label: 'anthropic', uri: 'anthropic:claude-haiku-4-5' },
  { env: 'GOOGLE_API_KEY', label: 'gemini', uri: 'google:gemini-3.5-flash-lite' },
] as const;

const Answer = z.object({ answer: z.number() });
const SYSTEM = 'You are terse. Answer with JSON only.';
const QUESTION = 'What is 2 + 2?';

for (const native of NATIVE) {
  describe.skipIf(!process.env[native.env])(`L2/L6 native capture parity (${native.label})`, () => {
    function askRuntime(): AxlRuntime {
      const runtime = new AxlRuntime({
        defaultProvider: native.uri.split(':')[0],
        trace: { enabled: false },
      });
      const asker = agent({ name: 'native', model: native.uri, system: SYSTEM });
      runtime.register(
        workflow({
          name: 'ask',
          input: z.any(),
          handler: (ctx) => ctx.ask(asker, QUESTION, { schema: Answer, maxTokens: 64 }),
        }),
      );
      return runtime;
    }

    it('captures the submitted request and its effective settings (L2)', async () => {
      const runtime = askRuntime();
      const { records, outcome } = await captured(runtime, () => runtime.execute('ask', {}));

      expect(outcome.status).toBe('fulfilled');
      expect(outcome.accounting.operations.total).toBeGreaterThanOrEqual(1);
      expect(outcome.accounting.operations.settled).toBe(outcome.accounting.operations.total);

      const starts = phase(records, 'start');
      expect(starts.length).toBeGreaterThanOrEqual(1);
      const request = starts[0].request!;
      // The model actually dispatched to, not the URI the caller wrote.
      expect(request.options.model).toBe(native.uri.slice(native.uri.indexOf(':') + 1));
      expect(request.options.maxTokens).toBe(64);
      // Structured output is part of the submitted request, so a record that
      // cannot show the response format cannot explain a schema rejection.
      expect(request.responseFormat).toBeDefined();
      // Nothing credential-bearing leaks in through the option allowlist.
      expect(JSON.stringify(request.options)).not.toContain('apiKey');
    });

    it('captures the caller request by value, not the adapter wire shape (L6)', async () => {
      const runtime = askRuntime();
      const { records } = await captured(runtime, () => runtime.execute('ask', {}));

      const request = phase(records, 'start')[0].request!;
      const roles = request.messages.map((m) => m.role);
      // Anthropic sends `system` as a top-level field and Gemini calls the
      // assistant `model` and wraps text in `parts`. Either shape appearing
      // here would mean the record was taken after the adapter rewrote it.
      expect(roles).toContain('system');
      expect(roles).toContain('user');
      expect(request.messages.find((m) => m.role === 'system')?.content).toBe(SYSTEM);
      // `toContain`, not equality: Axl appends its schema instruction to the
      // user turn at the neutral layer. That the appended text is here is the
      // point — the record is the normalized request Axl submitted, taken
      // before the adapter rewrote it, not the caller's raw string and not the
      // provider's wire body.
      expect(request.messages.find((m) => m.role === 'user')?.content).toContain(QUESTION);
      expect(roles).not.toContain('model');
      expect(JSON.stringify(request.messages)).not.toContain('parts');
    });
  });
}

// ── L4 (native half): transcription and embedding settlement ─────────────

describe.skipIf(!process.env.OPENAI_API_KEY)('L4 embedding settlement (openai)', () => {
  it('settles a real embed as one adapter-reported embedding operation', async () => {
    const runtime = new AxlRuntime({
      memory: { vectorStore: new InMemoryVectorStore(), embedder: new OpenAIEmbedder({}) },
      trace: { enabled: false },
    });

    const outcome = await runtime.trackOutcome(async () => {
      const ctx = runtime.createContext({ metadata: { sessionId: 'live-embed' } });
      await ctx.remember('pet', 'I love my cat', { embed: true });
    });

    expect(outcome.status).toBe('fulfilled');
    expect(outcome.accounting.operations.total).toBe(1);
    expect(outcome.accounting.operations.settled).toBe(1);
    // `embedAsOperation` settles with `provenance: 'adapter_reported'` — the
    // embedder reports its own charge rather than being priced from a table.
    expect(Object.keys(outcome.accounting.provenance)).toContain('adapter_reported');
  }, 60_000);
});

const NATIVE_TRANSCRIPTION = [
  { env: 'OPENAI_API_KEY', label: 'openai', model: 'openai-transcription:gpt-transcribe' },
  { env: 'GOOGLE_API_KEY', label: 'gemini', model: 'gemini-transcription:gemini-3.5-transcribe' },
] as const;

for (const t of NATIVE_TRANSCRIPTION) {
  describe.skipIf(!process.env[t.env])(`L4 transcription settlement (${t.label})`, () => {
    it('settles a real transcription as one terminal operation', async () => {
      const runtime = new AxlRuntime({ trace: { enabled: false } });
      runtime.register(
        workflow({
          name: 'listen',
          input: z.any(),
          handler: (ctx) =>
            ctx.transcribe({
              model: t.model,
              audio: {
                type: 'bytes',
                data: Buffer.from(
                  readFileSync(
                    new URL('./fixtures/recorded-call.mp3.b64', import.meta.url),
                    'utf-8',
                  ).trim(),
                  'base64',
                ),
                mediaType: 'audio/mpeg',
              },
            }),
        }),
      );

      const outcome = await runtime.trackOutcome(() => runtime.execute('listen', {}));

      expect(outcome.status).toBe('fulfilled');
      const { operations, usage } = outcome.accounting;
      // Correct category, and terminal: one transcription operation that
      // reached an end state rather than being left open or abandoned.
      expect(operations.byKind.transcription).toBe(1);
      expect(operations.total).toBe(1);
      expect(operations.settled + operations.unknown).toBe(operations.total);
      expect(operations.denied).toBe(0);
      // Usage in the units transcription is billed in. These built-in models
      // return usage without a price, so the operation lands `unknown` with
      // `unpriced_model` and `knownCost` stays an explicit lower bound — the
      // rail reports the gap instead of inventing a charge.
      expect(usage.audioSeconds + usage.inputTokens).toBeGreaterThan(0);
      expect(outcome.accounting.completeness).toBe('incomplete');
      expect(outcome.accounting.reasons.unpriced_model).toBe(1);
    }, 120_000);
  });
}
