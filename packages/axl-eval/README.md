# @axlsdk/eval

[![npm version](https://img.shields.io/npm/v/@axlsdk/eval)](https://www.npmjs.com/package/@axlsdk/eval)

Evaluation framework for [Axl](https://github.com/axl-sdk/axl) agentic workflows. Define datasets, scoring functions, and run evaluations to measure and compare agent performance.

## Installation

```bash
npm install @axlsdk/eval
```

TypeScript eval files are loaded via [tsx](https://github.com/privatenumber/tsx), declared as an optional peer dependency. pnpm 8+ and npm 7+ install it automatically; on Yarn Classic or pnpm with `auto-install-peers=false`, install it explicitly: `npm install -D tsx`.

## Quick Start

An eval file defines what to test (dataset), how to run it (execution function), and how to score it (scorers):

```typescript
// evals/qa.eval.ts
import { defineEval, dataset, scorer, llmScorer } from '@axlsdk/eval';
import type { AxlRuntime } from '@axlsdk/axl';
import { z } from 'zod';
import { qaAgent } from '../src/agents/qa.js';

export default defineEval({
  workflow: 'qa-eval',  // label for results (used in output table and comparisons)
  dataset: dataset({
    name: 'qa-basics',
    schema: z.object({ question: z.string() }),
    items: [
      { input: { question: 'What is TypeScript?' } },
      { input: { question: 'Explain closures.' } },
    ],
  }),
  scorers: [
    // Deterministic — runs in-process, no LLM call
    scorer({
      name: 'not-empty',
      description: 'Output is non-empty',
      score: (output) => (String(output).length > 10 ? 1 : 0),
    }),
    // LLM-as-judge — calls an LLM to evaluate quality
    llmScorer({
      name: 'relevance',
      description: 'Is the answer relevant to the question?',
      model: 'openai:gpt-4o',
      system: 'Rate whether the answer is relevant to the question asked.',
    }),
  ],
});

// How to produce output for each dataset item
export async function executeWorkflow(input: { question: string }, runtime: AxlRuntime) {
  const ctx = runtime.createContext();
  return { output: await ctx.ask(qaAgent, input.question) };
}
```

Run it:

```bash
OPENAI_API_KEY=sk-... npx axl-eval ./evals/qa.eval.ts
```

```
Eval: qa-eval x qa-basics (2 items)
  Scorer     Mean      Min      Max      p50      p95
  ─────────────────────────────────────────────────────
  not-empty  1.00     1.00     1.00     1.00     1.00
  relevance  0.90     0.80     1.00     0.90     1.00

  Failures: 0/2 | Cost: $0.01 | Duration: 3.2s
```

If an LLM scorer fails (wrong API key, provider down, invalid response), you'll see:

```
  relevance    --       --       --       --       --

  Scorer errors (2/2 items affected):
    - Scorer "relevance" threw: OpenAI API key is required. Set OPENAI_API_KEY or pass apiKey in options.
```

## Datasets

```typescript
import { dataset } from '@axlsdk/eval';
import { z } from 'zod';

const ds = dataset({
  name: 'math-basics',
  schema: z.object({ question: z.string() }),
  annotations: z.object({ answer: z.number() }),  // optional ground truth
  items: [
    { input: { question: '2+2' }, annotations: { answer: 4 } },
    { input: { question: '3*5' }, annotations: { answer: 15 } },
  ],
});
```

You can also load from a file: `dataset({ name: 'large', schema, file: './data.json' })`.

> **Annotation keys must be in the schema.** Zod strips keys it doesn't declare, so an annotation field missing from the `annotations` schema is dropped before it reaches your scorers — and a scorer reading `annotations?.thatField` then silently sees `undefined` and becomes a no-op. By default `dataset()` warns once per dataset listing any dropped keys (`annotation key(s) dropped by schema: ...`). Set `onExtraAnnotationKeys: 'error'` to fail instead (recommended in CI), or `'ignore'` to silence. This is the only guard for `file:` datasets, which aren't type-checked.

## Scorers

Scorers rate each output on a 0-1 scale. You can mix deterministic and LLM scorers in the same eval.

### Deterministic scorers

Pure functions — fast, free, deterministic. The `score` callback receives `(output, input, annotations?)` and returns a number (0-1) or a `ScorerResult` with metadata:

```typescript
import { scorer } from '@axlsdk/eval';

const containsAnswer = scorer({
  name: 'contains-answer',
  description: 'Output contains the expected numeric answer',
  score: (output, _input, annotations) =>
    String(output).includes(String(annotations?.answer)) ? 1 : 0,
});

// Returning rich metadata via ScorerResult
const lengthScore = scorer({
  name: 'length',
  description: 'Rates output by character length',
  score: (output) => {
    const len = String(output).length;
    return { score: Math.min(len / 500, 1), metadata: { charCount: len } };
  },
});
```

Scorers that return a non-finite value (`NaN` / `Infinity`) or a score outside `[0, 1]` are recorded as `null` with an entry in `item.scorerErrors` — they don't abort the run.

### Conditional scorers (`applies`)

By default every scorer runs against every item. When a scorer only applies to a subset — a refusal judge for refusal-expected items, a constraint judge for constrained items, an asymmetry scorer for asymmetric exercises — declare its scope with an `applies` predicate. It mirrors the `score` signature (`output, input, annotations?`) and returns `true` to run or `false` to skip:

```typescript
import { scorer } from '@axlsdk/eval';

// Deterministic: only score items the dataset flagged as "constrained"
const constraintAdherence = scorer({
  name: 'constraint-adherence',
  description: 'Output respects the stated constraint',
  applies: (_output, _input, annotations) => annotations?.constrained === true,
  score: (output, _input, annotations) =>
    String(output).includes(String(annotations?.constraint)) ? 1 : 0,
});
```

When `applies` returns `false`, the scorer is **skipped** for that item:

- The scorer body never runs — for an `llmScorer`, **no provider call is made**, saving real cost and rate-limit budget (a skipped judge can't 429 you).
- The item counts as **neither `scored` nor `failed`** — it's excluded from the `mean` *and* from the failure-rate denominator (`failOnScorerErrorRate` and `compare --max-scorer-error-rate`), so a conditional scorer stays honest to both the mean and the trust gate.
- The skip is visible: `item.scoreDetails[name].skipped === true`, and the run summary carries a per-scorer `skipped` count (alongside `scored` / `failed`). Studio's Eval Runner shows an "N/A" chip.

Applicability usually keys off `input` / `annotations` (a flag or exercise type), but `output` is available too (e.g. "only score outputs that actually refused"). The predicate runs **before** the scorer body, so an inapplicable `llmScorer` never makes its provider call:

```typescript
import { llmScorer } from '@axlsdk/eval';

// LLM judge: only invoke the (expensive) judge for items where a refusal was expected
const refusalQuality = llmScorer({
  name: 'refusal-quality',
  description: 'Did the model refuse appropriately and explain why?',
  model: 'openai:gpt-4o',
  system: 'Rate whether the output is a well-justified refusal.',
  applies: (_output, _input, annotations) => annotations?.expectRefusal === true,
});
```

A predicate that **throws** is treated as a scorer failure (it's a bug), not a skip — the item lands in the `failed` bucket with an entry in `item.scorerErrors`, never silently swallowed.

> **Deprecated: the `NaN`-skip workaround.** Before `applies`, the only way to express "not applicable" was to return a `NaN` / out-of-range sentinel for skipped items. The failure-rate gate (correctly) treats a non-finite score as a real failure, so a deterministic conditional scorer that returned `NaN` for inapplicable items showed a ~90% failure rate and permanently tripped the zero-tolerance deterministic gate. Use `applies` instead. The gate's strictness about `NaN` is intentional and unchanged.

### LLM scorers

Use an LLM as a judge. The scorer constructs a prompt from the input, output, and annotations, calls the LLM, and validates the response:

```typescript
import { llmScorer } from '@axlsdk/eval';

const qualityJudge = llmScorer({
  name: 'quality',
  description: 'Rates overall output quality',
  model: 'openai:gpt-4o',           // provider:model URI
  system: 'Rate the quality of the AI output.',
});
```

The default schema is `z.object({ score: z.number().min(0).max(1), reasoning: z.string() })` — the LLM returns a 0-1 score with an explanation. The reasoning (and any other schema fields) are available on each item via `scoreDetails` — see [Understanding Results](#understanding-results). For custom scoring dimensions, provide your own schema:

```typescript
import { z } from 'zod';

const detailedJudge = llmScorer({
  name: 'detailed',
  description: 'Rates quality with confidence',
  model: 'openai:gpt-4o',
  system: 'Rate quality and your confidence in the rating.',
  schema: z.object({
    score: z.number().min(0).max(1),
    reasoning: z.string(),
    confidence: z.number().min(0).max(1),
  }),
  temperature: 0.2,                  // default: 0.2 (low for consistency)
});
```

The schema is converted to JSON Schema and included in the LLM prompt, so the judge knows exactly what structure to produce.

The `model` field uses a `provider:model` URI. The provider is resolved automatically at eval time — just set the right API key:

| Provider | URI prefix | Env var |
|----------|-----------|---------|
| OpenAI (Chat Completions) | `openai:` | `OPENAI_API_KEY` |
| OpenAI (Responses API) | `openai-responses:` | `OPENAI_API_KEY` |
| Anthropic | `anthropic:` | `ANTHROPIC_API_KEY` |
| Google Gemini | `google:` | `GOOGLE_API_KEY` or `GEMINI_API_KEY` |
| Custom | `your-name:` | Via `runtime.registerProvider('your-name', provider)` |

Different LLM scorers can use different providers — each resolves independently:

```typescript
const qualityJudge = llmScorer({ name: 'quality', model: 'openai:gpt-4o', ... });
const safetyJudge = llmScorer({ name: 'safety', model: 'anthropic:claude-sonnet-4-5-20250514', ... });
```

LLM scorers also accept the conditional `applies` predicate described in [Conditional scorers](#conditional-scorers-applies) — the most valuable place to use it, since a skipped judge makes no provider call at all.

#### Tuning the judge

For reasoning-capable judge models (gpt-5.x, Anthropic Opus/Sonnet 4.5+, Gemini 3.x), `effort` is the highest-leverage knob — judges with reasoning enabled are materially more consistent. The full `ChatOptions` surface is forwarded:

```typescript
const carefulJudge = llmScorer({
  name: 'careful',
  description: 'Reasoning-grade quality judge',
  model: 'openai-responses:gpt-5',
  system: 'Rate output quality and explain your reasoning.',
  effort: 'high',              // huge calibration improvement on reasoning models
  maxTokens: 1024,             // cap chatty judges to control spend
  includeThoughts: true,       // surface reasoning summaries — Gemini + openai-responses only
  // thinkingBudget: 4096,     // precise token budget (advanced)
  // stop: ['\n###'],          // stop sequences
  // providerOptions: { ... }, // provider-specific escape hatch
});
```

A note on a few of the knobs:

- **`includeThoughts`** is a no-op on Anthropic and the `openai:` (Chat Completions) provider. Use `openai-responses:` or any `google:` model to actually receive reasoning summaries.
- **`providerOptions`** is merged last into the raw API request, so it can override anything Axl computes — including `responseFormat`. To switch the judge to strict JSON Schema mode on providers that support it (OpenAI Chat Completions, OpenAI Responses, Gemini), pass `providerOptions: { response_format: { type: 'json_schema', json_schema: { name: 'judgment', strict: true, schema: <your-schema-as-json> } } }`. The downstream `extractJson` pipeline handles either shape.

The eval runner also propagates its `AbortSignal` into the judge call, so cancelling a run aborts in-flight LLM calls mid-flight (instead of letting the connection finish and silently completing a doomed item).

## Running Evals

### CLI

The most common way to run evals:

```bash
npx axl-eval ./evals/qa.eval.ts                    # run a single file
npx axl-eval ./evals/                               # run all *.eval.* files in a directory
npx axl-eval ./evals/ --output ./results/v1.json    # save results to JSON
npx axl-eval ./evals/ --config ./axl.config.ts      # use a specific runtime config
npx axl-eval ./evals/ --conditions development      # add Node.js import conditions (monorepo source exports)
npx axl-eval ./evals/qa.eval.ts --concurrency 10    # override item concurrency for this run
npx axl-eval ./evals/qa.eval.ts --scorers accuracy  # run only named scorer(s) (single file)
```

The CLI resolves a runtime automatically: `--config <path>` > auto-detect `axl.config.*` > bare `new AxlRuntime()` (providers from env vars). Use `--conditions` when your eval file imports from monorepo packages that use conditional exports (e.g., `"development"` condition for source TypeScript instead of compiled dist).

**`--concurrency <n>` / `AXL_EVAL_CONCURRENCY`** override item concurrency per-invocation (precedence: flag > env > `defineEval` value > default 5). Concurrency is pure scheduling — it never changes results. Note the per-eval `scorerConcurrency` (default 5) is independent, so the worst-case number of simultaneous scorer calls is `concurrency × scorerConcurrency`; lower `--concurrency` if a rate-limited judge model needs a tighter ceiling.

**`--scorers <a,b>`** runs only the named scorers (single eval file only) for a fast iteration loop. The result is stamped `metadata.scorerFiltered: true` so `axl-eval compare` warns — and, under `--fail-on-regression`, refuses — to gate on a subset run mistaken for a full baseline.

#### Scorer failure rate — two complementary gates

Concurrent scorers (`concurrency × scorerConcurrency`, up to 25 in-flight by default) can overrun a rate-limited judge model. When a judge call exhausts the provider's retry backoff it throws, the runner records that item's score as `null`, and the mean is computed over the **survivors** — so a thinned sample can still look green. The runner now always reports per-scorer `scored`/`failed` counts (visible in the table as `(18/20 scored, 2 failed)` and in Studio as an amber badge), and two opt-in gates turn that signal into a non-zero exit:

| Gate | Where | When it fires |
|------|-------|---------------|
| `failOnScorerErrorRate` (config field) | **Source-side** — at run/produce time | `runEval` flags `summary.degraded` (and the CLI exits non-zero) when a scorer exceeds tolerance, *before* the thinned result is saved. `runEval` never throws — it returns the result with the flag set, preserving multi-run partials and auto-save. |
| `--max-scorer-error-rate <0..1>` (compare flag) | **Gate-side** — at consume/gate time | `axl-eval compare` refuses (exit 1) to certify a baseline/candidate whose failure rate is over the limit. Always *warns* when either side rests on a thinned sample, even without the flag. |

Both are **type-aware**: deterministic scorers tolerate **zero** failures (a deterministic scorer that throws is a bug, not noise); LLM judges use the configured rate. They're complementary — set `failOnScorerErrorRate` in the eval file to fail fast at run time, and pass `--max-scorer-error-rate` in CI to refuse to gate on an artifact that was already thinned (e.g. an imported result).

**Skipped items don't count against either gate.** The failure rate is `failed / (scored + failed)` — items a scorer's `applies` predicate skipped land in neither bucket, so they're excluded from the denominator. This is the supported way to scope a conditional scorer (a refusal judge that only runs on refusal-expected items, say) to its applicable subset without polluting the trust signal. **Do not** return `NaN` for inapplicable items: the gate (correctly) treats a non-finite score as a real failure, so a `NaN`-skipping deterministic scorer trips the zero-tolerance deterministic gate on every skipped item. Use [`applies`](#conditional-scorers-applies) instead.

Because skips are excluded rather than failed, two failure modes are surfaced as **advisories** (stderr, non-fatal) so a conditional scorer can't silently mislead:

- **Fully N/A scorer** — if a scorer ends up applicable to *zero* items (an over-strict predicate, a dataset missing the flagged items, or a predicate that forgot to `return`), its mean is a meaningless empty-sample `0` and the failure-rate gate can't assess it. `axl-eval` prints a `NOTE` (the run still exits 0 — skips are legitimately conditional).
- **Asymmetric skips in `compare`** — if the baseline and candidate applied a scorer to *different* item subsets (different N/A counts, or the same count of *different* items — detected as fewer items scored on both sides than either scored alone), their per-side means cover different subsets, so a delta may be a sample mismatch rather than a real change. `axl-eval compare` prints a `NOTE` alongside the usual thinned-sample warning. (Studio's compare view shows the same as a "paired n" note.)

```ts
// eval file — fail this run if the judge errored on >10% of the items it ran against
export default { workflow: 'qa', dataset: ds, scorers: [judge], failOnScorerErrorRate: 0.1 };
```

```bash
npx axl-eval compare base.json cand.json --fail-on-regression --max-scorer-error-rate 0.05
```

Building a custom CI gate? Both decisions are exported as pure functions — `evaluateScorerErrorRateGate` and `evaluateScorerTolerance` (see the [API reference](../../docs/api-reference.md)).

#### Total-workflow-wipeout guard

Separate from the scorer signal above: if **every** item errored in the *workflow* (0 succeeded), the eval produced no scorable output, so `axl-eval` always exits non-zero with `FAILED: … all N item(s) errored in the workflow` — a fully-broken eval (bad provider URI, an exception in every run) can never go green in CI. This is non-configurable (a 0%-success eval is unambiguously broken) and distinct from `failOnScorerErrorRate` (which is about a flaky *scorer* and deliberately ignores a run with no scored items). Partial workflow-failure rates stay visible (`Failures: N/M` in the table) but non-gating.

### Programmatic

**`runtime.eval()`** — when you have a workflow registered on the runtime. The `workflow` field must match the registered name:

```typescript
import { AxlRuntime, workflow, agent } from '@axlsdk/axl';
import { dataset, scorer } from '@axlsdk/eval';
import { z } from 'zod';

const qaAgent = agent({ name: 'qa', model: 'openai:gpt-4o', system: 'Answer questions.' });
const qaWorkflow = workflow({
  name: 'qa-workflow',
  input: z.object({ question: z.string() }),
  handler: async (ctx) => ctx.ask(qaAgent, ctx.input.question),
});

const runtime = new AxlRuntime();
runtime.register(qaWorkflow);

const results = await runtime.eval({
  workflow: 'qa-workflow',  // must match the registered workflow name
  dataset: ds,
  scorers: [containsAnswer, qualityJudge],
});
```

**`runEval()`** — when you want full control. The `workflow` field is just a label; the second argument is the function that produces output:

```typescript
import { runEval } from '@axlsdk/eval';

const results = await runEval(
  { workflow: 'my-eval', dataset: ds, scorers: [containsAnswer, qualityJudge] },
  async (input, runtime) => {
    const ctx = runtime.createContext();
    return { output: await ctx.ask(qaAgent, input.question) };
  },
  runtime,
);
```

**Optional `RunEvalOptions` 4th arg** (`onProgress` / `signal` / `captureTraces`):

```typescript
import type { RunEvalOptions, EvalProgressEvent } from '@axlsdk/eval';

const controller = new AbortController();

const results = await runEval(
  { workflow: 'my-eval', dataset: ds, scorers: [...] },
  executeWorkflow,
  runtime,
  {
    onProgress: (event: EvalProgressEvent) => {
      // `item_done` fires after each dataset item finishes (execution + scoring,
      // or aborted/budget-exceeded). `run_done` fires once after all items.
      // Narrow on `type` — `itemIndex` only exists on `item_done`.
      if (event.type === 'item_done') {
        console.log(`Item ${event.itemIndex + 1}/${event.totalItems} done`);
      } else {
        console.log(`All done: ${event.failures}/${event.totalItems} failed`);
      }
    },
    signal: controller.signal,   // cancels between items (and between scorers within an item)
    captureTraces: true,          // populates EvalItem.traces (success + failure paths)
  },
);
```

**Trust-boundary validation on workflow returns.** When your `executeWorkflow` callback returns `{ output, cost, metadata }`, the runner validates the untrusted fields before trusting them: `cost` must be a non-negative finite number, `metadata` must be a plain object (`Date`, `Map`, `Set`, class instances are rejected). Invalid values trigger a `console.warn` and fall back to trace-derived values from `runtime.trackExecution()`. A buggy workflow returning `{ cost: 'free' }` no longer silently NaN-poisons `totalCost`.

### Studio

Eval files can be lazy-loaded by the Studio middleware for the Eval Runner panel:

```typescript
import { createStudioMiddleware } from '@axlsdk/studio/middleware';

const studio = createStudioMiddleware({
  runtime,
  evals: 'evals/**/*.eval.ts',
});
```

See the [@axlsdk/studio README](../axl-studio/README.md#lazy-eval-loading) for details.

## Understanding Results

Each eval run returns an `EvalResult` with per-item scores and aggregate statistics. Every item captures timing and cost alongside scores.

Each item has two ways to access scores:

- **`item.scores`** — quick numeric lookup: `Record<string, number | null>`. Use this for simple checks and aggregation. `null` means the scorer failed (see `item.scorerErrors`) **or** was skipped by its `applies` predicate — disambiguate with `scoreDetails[name].skipped`.
- **`item.scoreDetails`** — full context: `Record<string, ScorerDetail>`. Each detail has the numeric score plus `metadata` (e.g., LLM reasoning), per-scorer `duration`, `cost`, and a `skipped` flag. Use this when you need to understand *why* a score is what it is.

A `ScorerDetail` distinguishes three terminal states for a scorer on a given item:

| State | `score` | `skipped` | `duration` |
|-------|---------|-----------|------------|
| Scored | `number` | absent | set |
| Ran-and-failed (threw / out-of-range) | `null` | absent | set |
| Skipped by `applies` | `null` | `true` | absent |

Summary statistics (mean, p50, p95, etc.) exclude `null` scores. If all scores for a scorer are `null`, the CLI shows `--` instead of misleading `0.00`.

```typescript
const results = await runtime.eval({ ... });

// ── Aggregate stats ──────────────────────────────────
console.log(results.summary.scorers['quality'].mean);  // 0.85
console.log(results.summary.scorers['quality'].scored); // 48 (items that produced a numeric score)
console.log(results.summary.scorers['quality'].failed); // 2  (scorer ran and threw / out-of-range)
console.log(results.summary.scorers['quality'].skipped); // 0  (items the applies predicate skipped)
console.log(results.summary.count);                     // 50 items
console.log(results.summary.failures);                  // 2 workflow errors
console.log(results.summary.timing);                    // { mean, min, max, p50, p95 } in ms
console.log(results.totalCost);                          // 0.42 (workflow + scorer LLM costs)
console.log(results.metadata.models);                    // ["openai:gpt-4o"] (sorted by usage)
console.log(results.metadata.modelCounts);               // { "openai:gpt-4o": 48, "openai:gpt-4o-mini": 2 } (total LLM calls per model)

// ── Per-item inspection ──────────────────────────────
for (const item of results.items) {
  if (item.error) continue;                              // workflow threw

  // Timing and cost
  console.log(item.duration);                            // workflow execution ms
  console.log(item.cost);                                // workflow LLM cost
  console.log(item.scorerCost);                          // total scorer cost for this item

  // Execution metadata (models, tokens, agent calls — captured by AxlRuntime)
  console.log(item.metadata?.models);                    // ["openai:gpt-4o"]
  console.log(item.metadata?.tokens);                    // { input: 150, output: 320, reasoning: 0 }
  console.log(item.metadata?.agentCalls);                // 1

  // Quick score access
  console.log(item.scores['quality']);                    // 0.85 or null

  // Rich per-scorer detail — reasoning, timing, cost
  const detail = item.scoreDetails?.['quality'];
  if (detail) {
    if (detail.skipped) {
      // This scorer's `applies` predicate returned false — not run, not counted
      console.log('Scorer skipped (not applicable to this item)');
    } else {
      console.log(detail.score);                         // 0.85
      console.log(detail.metadata?.reasoning);           // "The answer is relevant..."
      console.log(detail.duration);                      // scorer execution ms
      console.log(detail.cost);                          // scorer LLM cost
    }
  }

  // Error handling — a null score is either a failure OR a skip
  if (item.scores['quality'] === null && !item.scoreDetails?.['quality']?.skipped) {
    console.log('Scorer failed:', item.scorerErrors);    // ["Scorer "quality" threw: ..."]
  }

  // Per-item trace events (when run with { captureTraces: true })
  if (item.traces) {
    console.log(`${item.traces.length} trace events captured`);
    const agentCalls = item.traces.filter(e => e.type === 'agent_call_end');
    console.log(`${agentCalls.length} LLM turns`);
    // Failure-path traces are also populated (recovered from axlCapturedTraces
    // on the thrown error) — captureTraces is especially useful for debugging
    // items that error
  }
}
```

`captureTraces` strips verbose-mode `agent_call_start.data.messages` request snapshots and high-volume events (`token`, `partial_object`) from the captured array to keep memory bounded. The structural events you'd want for debugging — `agent_call_start`/`agent_call_end`, `tool_call_*`, gate events, `pipeline`, `verify`, `handoff_*` — are all retained.

For tool-using evals, these events let your own analysis distinguish a tool that
failed after starting from one that was rejected, denied, or cancelled. Axl Evals does
not assign scores to those states automatically; they are evidence for your scorers
and debugging.

#### Per-item live observation with `ctx.events`

`captureTraces` collects events for post-hoc inspection on `EvalItem.traces`. For **live** per-item observation — e.g., printing each item's `partial_object` snapshots as they stream during eval execution — use `ctx.events` inside your top-level `executeWorkflow` export. The two are complementary: `captureTraces` records the structural timeline; `ctx.events` is the live firehose.

```typescript
// evals/extract.eval.ts
import { defineEval, dataset, scorer } from '@axlsdk/eval';
import type { AxlRuntime } from '@axlsdk/axl';
import { z } from 'zod';
import { extractor } from '../src/agents/extractor.js'; // your agent

const extractSchema = z.object({ id: z.string(), summary: z.string() });

export default defineEval({
  workflow: 'extract-fields',
  dataset: dataset({ items: [{ id: 'a', text: 'hello world' }] }),
  scorers: [scorer({ name: 'has-id', score: ({ output }) => (output.id ? 1 : 0) })],
});

// Top-level export, NOT nested inside defineEval. The eval runner
// imports both the default-exported config AND this named function.
export async function executeWorkflow(
  input: { id: string; text: string },
  runtime: AxlRuntime,
) {
  const ctx = runtime.createContext({ signal: AbortSignal.timeout(30_000) });
  // Allocate the bus before the first ctx.ask() — the streaming gate
  // is per-ask, and a late subscription leaves the in-flight ask
  // through the non-streaming code path.
  const events = ctx.events;
  void (async () => {
    for await (const partial of events.partialObjects) {
      console.log(`[${input.id}] attempt ${partial.attempt}:`, partial.object);
    }
  })().catch((err) => console.error('observer failed:', err));
  const output = await ctx.ask(extractor, input.text, { schema: extractSchema });
  return { output };
}
```

The `signal` from `createContext` auto-disposes the bus on timeout, so the iterator terminates cleanly even if the eval item never emits a workflow terminal. See [`ctx.events`](../../docs/api-reference.md#ctxevents) for the full type reference.

## Comparing Results

Compare two runs to detect regressions and improvements. Runs must use the same dataset and scorers.

```bash
npx axl-eval compare ./results/v1.json ./results/v2.json
npx axl-eval compare v1.json v2.json --fail-on-regression  # exit 1 if significant regressions
npx axl-eval compare v1.json v2.json --max-scorer-error-rate 0.05  # exit 1 if a scorer failed on >5% of the items it ran against (deterministic scorers: zero tolerance)
```

```
Compare: baseline (3f8a2b1c) -> candidate (9d4e7f6a)

  Scorer     Baseline  Candidate  Delta     Change  CI 95%            Sig
  ────────────────────────────────────────────────────────────────────────
  quality       0.750      0.850    +0.100   +13.3%  [+0.0312, +0.1688]  *
  safety        0.900      0.900    +0.000    +0.0%  [-0.0250, +0.0250]

  Timing: baseline 2.10s -> candidate 4.30s (+104.8%)
  Cost: baseline $0.45 -> candidate $0.31 (-31.1%)

  Regressions: 1 | Improvements: 3 | Stable: 16
```

Programmatically:

```typescript
import { evalCompare } from '@axlsdk/eval';

const comparison = evalCompare(v1Results, v2Results);

// Score changes
console.log(comparison.scorers.quality.delta);      // +0.1
console.log(comparison.scorers.quality.deltaPercent); // +13.3

// Statistical significance
console.log(comparison.scorers.quality.ci);         // { lower: 0.0312, upper: 0.1688 }
console.log(comparison.scorers.quality.significant); // true
console.log(comparison.scorers.quality.pRegression); // 0.02 (2% chance of regression)
console.log(comparison.scorers.quality.pImprovement); // 0.98 (98% chance of improvement)
console.log(comparison.scorers.quality.n);            // 50 (paired sample count)

// Timing and cost tradeoffs
console.log(comparison.timing?.deltaPercent);  // +104.8 (slower)
console.log(comparison.cost?.deltaPercent);    // -31.1 (cheaper)

// Per-item regressions/improvements
for (const r of comparison.regressions) {
  console.log(`Item ${r.itemIndex}: ${r.scorer} dropped ${r.baselineScore} → ${r.candidateScore}`);
}

console.log(comparison.summary);  // human-readable one-liner
```

`evalCompare()` also accepts arrays for multi-run comparison — see [Multi-Run](#multi-run).

### Configurable Thresholds

By default, thresholds auto-calibrate from scorer type metadata embedded in eval results: **0** for deterministic scorers, **0.05** for LLM scorers (which have natural variance). Results without `scorerTypes` metadata fall back to **0.1**.

Override with `--threshold` on the CLI:

```bash
# Global threshold for all scorers
npx axl-eval compare v1.json v2.json --threshold 0.05

# Per-scorer thresholds
npx axl-eval compare v1.json v2.json --threshold accuracy=0,tone=0.1
```

Programmatically via `EvalCompareOptions`:

```typescript
import { evalCompare } from '@axlsdk/eval';
import type { EvalCompareOptions } from '@axlsdk/eval';

// Global threshold
evalCompare(baseline, candidate, { thresholds: 0.05 });

// Per-scorer map
evalCompare(baseline, candidate, { thresholds: { accuracy: 0, tone: 0.1 } });
```

### Statistical Significance

`evalCompare()` computes a 95% bootstrap confidence interval on paired per-item score differences. A scorer change is marked `significant` when:

1. The CI excludes zero (the effect is unlikely due to chance), **and**
2. The absolute delta exceeds the threshold (the effect is practically meaningful).

`--fail-on-regression` uses significance when available — it only exits with code 1 if at least one scorer has a significant negative delta. Without enough paired data for CI (fewer than 2 items), it falls back to threshold-only comparison.

The underlying `pairedBootstrapCI()` function is exported for direct use:

```typescript
import { pairedBootstrapCI } from '@axlsdk/eval';

const ci = pairedBootstrapCI(differences, { nResamples: 1000, alpha: 0.05, seed: 42 });
console.log(ci); // { lower: -0.02, upper: 0.15, mean: 0.065, pRegression: 0.12, pImprovement: 0.88 }
```

## Eval Files in Detail

### Execution function

By default, the runner calls `runtime.execute(workflow, input)` for each item. Export `executeWorkflow` to override.

If neither an `executeWorkflow` export nor a registered workflow matching `workflow` exists, the CLI exits non-zero with an explanatory error. (This used to fall through to identity passthrough with a warning, which silently produced all-zero scores in CI — see CHANGELOG for the breaking-change note.)

```typescript
// evals/qa.eval.ts
import { defineEval, dataset, scorer } from '@axlsdk/eval';
import type { AxlRuntime } from '@axlsdk/axl';
import { qaAgent } from '../src/agents/qa.js';

export default defineEval({
  workflow: 'qa-eval',
  dataset: dataset({ ... }),
  scorers: [scorer({ ... })],
});

export async function executeWorkflow(input: { question: string }, runtime: AxlRuntime) {
  const ctx = runtime.createContext();
  return { output: await ctx.ask(qaAgent, input.question) };
}
```

When no runtime is needed (e.g., testing a pure function):

```typescript
export async function executeWorkflow(input: { raw: string }) {
  return { output: parseDocument(input.raw) };
}
```

### Cost tracking

Cost is tracked automatically — the runner wraps each item with `runtime.trackCost()`. LLM scorer costs are also included in `totalCost` and count toward the `budget` limit.

To override (e.g., exclude setup calls), return cost explicitly:

```typescript
return { output, cost: ctx.totalCost };
```

### Common patterns

**Concurrency** — process items in parallel (default: 5), and fan out each item's scorers (default: 5):

```typescript
export default defineEval({
  workflow: 'qa-eval',
  dataset: ds,
  scorers: [qualityJudge, toneJudge, safetyJudge],
  concurrency: 10,        // run 10 items in parallel
  scorerConcurrency: 3,   // run up to 3 of an item's scorers at once
  budget: '$5.00',        // stop if total cost exceeds $5
});
```

`scorerConcurrency` parallelizes the per-item judge phase — the dominant cost for evals with several `llmScorer`s. The worst-case number of simultaneous scorer calls is `concurrency × scorerConcurrency`, so a rate-limited judge model may need a lower value (set `scorerConcurrency: 1` for the old serial behavior). Because the per-item `budget` check runs once before an item's scorers, scorer-cost overshoot is bounded by `concurrency × scorerConcurrency × max-scorer-cost`.

**Per-item budget** — cap cost for a single workflow execution:

```typescript
export async function executeWorkflow(input: { question: string }, runtime: AxlRuntime) {
  const ctx = runtime.createContext({ budget: '$0.50' });
  return { output: await ctx.ask(qaAgent, input.question) };
}
```

**Timeout** — abort slow items:

```typescript
const controller = new AbortController();
setTimeout(() => controller.abort(), 30_000);
const ctx = runtime.createContext({ signal: controller.signal });
```

**Auto-approve tools** — skip human approval in evals: `runtime.createContext({ awaitHumanHandler: async () => ({ approved: true }) })`.

**Multi-turn** — provide conversation history:

```typescript
const ctx = runtime.createContext({
  sessionHistory: [
    { role: 'user', content: input.setupPrompt },
    { role: 'assistant', content: input.setupResponse },
  ],
});
```

## Rescore Mode

Re-run scorers on saved outputs without re-executing the workflow. Useful when iterating on scorer logic — avoids burning LLM cost on generation.

```bash
npx axl-eval rescore ./results/v1.json ./evals/qa.eval.ts
npx axl-eval rescore ./results/v1.json ./evals/qa.eval.ts --output ./results/v1-rescored.json
```

The rescored result gets a new `id` and has `metadata.rescored: true` and `metadata.originalId` pointing to the source run. `runGroupId`, `runIndex`, and any `scorerFiltered`/`scorersRun` stamp are stripped from inherited metadata (rescored results are independent evaluations, and a rescore always runs the eval file's full scorer set). Only scorer cost is tracked (workflow cost is zero).

`--concurrency`/`AXL_EVAL_CONCURRENCY` are honored by `rescore` too (item-level; `scorerConcurrency` keeps its default 5). `--scorers` is **not** supported with `rescore` — it's a run-command-only filter; rescore re-runs whatever scorers the eval file exports (pass a subset there instead).

Programmatically:

```typescript
import { rescore } from '@axlsdk/eval';

const rescored = await rescore(originalResult, [updatedScorer, newScorer], runtime, {
  concurrency: 10,        // items rescored in parallel
  scorerConcurrency: 3,   // scorers per item run in parallel (default 5)
});

console.log(rescored.metadata.rescored);    // true
console.log(rescored.metadata.originalId);  // original result ID
console.log(rescored.totalCost);            // scorer cost only
```

## Multi-Run

Run the same eval multiple times to measure variance across runs. The CLI aggregates per-scorer means into mean ± std:

```bash
npx axl-eval ./evals/qa.eval.ts --runs 5
npx axl-eval ./evals/qa.eval.ts --runs 5 --output ./results/qa-5runs.json
```

```
Eval: qa-eval x qa-basics — 5 runs
  Scorer         Mean ± Std       Min       Max
  ──────────────────────────────────────────────
  not-empty     1.000 ± 0.000     1.000     1.000
  relevance     0.870 ± 0.024     0.840     0.900

  Total Cost: $0.05 | Total Duration: 16.2s
```

The output JSON contains all individual run results (as an array). Each run has `metadata.runGroupId` and `metadata.runIndex`.

### Partial batches

If a run fails mid-batch (e.g. provider rate-limit on run 3 of 5), completed runs are preserved — they cost real money and have statistical signal — and the CLI exits non-zero so CI still flags the failure. Each preserved run is tagged with:

| Metadata key | Type | Description |
|--------------|------|-------------|
| `fromPartialBatch` | `boolean` | This run came from a batch that did not complete. The flag describes the BATCH, not the run — these runs are still valid and their data is honest |
| `batchCompleted` | `number` | How many runs actually completed (`< batchAttempted`) |
| `batchAttempted` | `number` | The originally-planned `--runs N` count |
| `batchFailure` | `string?` | The error message that stopped the batch. Omitted when the partial state came from user cancellation rather than a thrown error |

The aggregate is computed over the completed runs only (the honest sample size); `aggregateRuns().runCount` reflects this. When *every* run fails (`runResults.length === 0`), no artifact is written.

Programmatically, use `aggregateRuns()`:

```typescript
import { aggregateRuns } from '@axlsdk/eval';
import type { MultiRunSummary } from '@axlsdk/eval';

const summary: MultiRunSummary = aggregateRuns(runs);
console.log(summary.scorers.relevance.mean);  // 0.87
console.log(summary.scorers.relevance.std);   // 0.024
console.log(summary.runCount);                // 5
```

### Multi-run comparison

`evalCompare()` accepts arrays of `EvalResult` for both baseline and candidate, pooling paired differences across runs for more robust CI estimates:

```typescript
import { evalCompare } from '@axlsdk/eval';

const comparison = evalCompare(baselineRuns, candidateRuns);
// CI is computed from all paired (baseline[r].items[i], candidate[r].items[i]) differences
```

## API Reference

### Functions

| Function | Description |
|----------|-------------|
| `dataset(config)` | Create a dataset from inline items or a JSON file |
| `scorer(config)` | Create a deterministic scorer (optional `applies` predicate for conditional scoring) |
| `llmScorer(config)` | Create an LLM-as-judge scorer (optional `applies` predicate — a skipped judge makes no provider call) |
| `defineEval(config)` | Wrap an eval config for CLI discovery |
| `runEval(config, executeFn, runtime, options?)` | Run an eval programmatically. `options: RunEvalOptions` accepts `onProgress` / `signal` / `captureTraces` |
| `evalCompare(baseline, candidate, options?)` | Compare eval results with bootstrap CI |
| `rescore(result, scorers, runtime, options?)` | Re-run scorers on saved outputs |
| `aggregateRuns(runs)` | Aggregate multiple runs into mean ± std |
| `pairedBootstrapCI(differences, options?)` | Compute bootstrap confidence interval |
| `normalizeScorerResult(value)` | Convert `number \| ScorerResult` to `ScorerResult` |

### Types

| Type | Description |
|------|-------------|
| `EvalConfig` | Eval definition (workflow, dataset, scorers, concurrency, scorerConcurrency, budget) |
| `EvalResult` | Full eval output (items, summary, cost, duration) |
| `EvalItem` | Per-item result (input, output, scores, scoreDetails, metadata, traces?) |
| `EvalSummary` | Aggregate statistics (count, failures, per-scorer stats incl. `scored`/`failed`/`skipped`, timing) |
| `EvalComparison` | Comparison output (scorer deltas, CI, pRegression/pImprovement, n, per-side `runCount` / `partial?`, regressions, improvements). Both sides truncate to `min(baseline.length, candidate.length)` so means align with the paired bootstrap CI's sample |
| `EvalComparisonPartial` | `{ completed, attempted }` set on a comparison side when the pooled run count is less than the original batch's planned count |
| `EvalCompareOptions` | Options for `evalCompare()` (`thresholds`) |
| `EvalRegression` / `EvalImprovement` | Per-item change record (itemIndex, scorer, scores, delta) |
| `ScorerDetail` | Per-scorer detail (score, metadata, duration, cost, `skipped?`) |
| `ScorerResult` | Scorer return type (`{ score, metadata?, cost? }`) |
| `RescoreOptions` | Options for `rescore()` (`concurrency`, `scorerConcurrency`, `signal`) |
| `MultiRunSummary` | Aggregated multi-run output (per-scorer mean/std/min/max) |
| `BootstrapCIResult` | CI result (`{ lower, upper, mean, pRegression, pImprovement }`) |
| `RunEvalOptions` | Options for `runEval()` (`onProgress`, `signal`, `captureTraces`) |
| `EvalProgressEvent` | Event passed to `onProgress`: `{ type: 'item_done', itemIndex, totalItems }` (emitted after each item finishes — success, failure, cancellation, or budget-exceeded) \| `{ type: 'run_done', totalItems, failures }` (emitted once after all items finish and stats are computed) |

## License

[Apache 2.0](../../LICENSE)
