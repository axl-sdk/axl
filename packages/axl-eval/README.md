# @axlsdk/eval

[![npm version](https://img.shields.io/npm/v/@axlsdk/eval)](https://www.npmjs.com/package/@axlsdk/eval)

Evaluation framework for [Axl](https://github.com/axl-sdk/axl) agentic workflows. Define datasets, scoring functions, and run evaluations to measure and compare agent performance.

## Installation

```bash
npm install @axlsdk/eval
```

TypeScript eval files require [tsx](https://github.com/privatenumber/tsx) as a dev dependency (`npm install -D tsx`).

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

## Running Evals

### CLI

The most common way to run evals:

```bash
npx axl-eval ./evals/qa.eval.ts                    # run a single file
npx axl-eval ./evals/                               # run all *.eval.* files in a directory
npx axl-eval ./evals/ --output ./results/v1.json    # save results to JSON
npx axl-eval ./evals/ --config ./axl.config.ts      # use a specific runtime config
npx axl-eval ./evals/ --conditions development      # add Node.js import conditions (monorepo source exports)
```

The CLI resolves a runtime automatically: `--config <path>` > auto-detect `axl.config.*` > bare `new AxlRuntime()` (providers from env vars). Use `--conditions` when your eval file imports from monorepo packages that use conditional exports (e.g., `"development"` condition for source TypeScript instead of compiled dist).

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

- **`item.scores`** — quick numeric lookup: `Record<string, number | null>`. Use this for simple checks and aggregation. `null` means the scorer failed (see `item.scorerErrors`).
- **`item.scoreDetails`** — full context: `Record<string, ScorerDetail>`. Each detail has the numeric score plus `metadata` (e.g., LLM reasoning), per-scorer `duration`, and `cost`. Use this when you need to understand *why* a score is what it is.

Summary statistics (mean, p50, p95, etc.) exclude `null` scores. If all scores for a scorer are `null`, the CLI shows `--` instead of misleading `0.00`.

```typescript
const results = await runtime.eval({ ... });

// ── Aggregate stats ──────────────────────────────────
console.log(results.summary.scorers['quality'].mean);  // 0.85
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
    console.log(detail.score);                           // 0.85
    console.log(detail.metadata?.reasoning);             // "The answer is relevant..."
    console.log(detail.duration);                        // scorer execution ms
    console.log(detail.cost);                            // scorer LLM cost
  }

  // Error handling
  if (item.scores['quality'] === null) {
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

`captureTraces` strips verbose-mode `agent_call_end.data.messages` snapshots and high-volume events (`token`, `partial_object`) from the captured array to keep memory bounded. The structural events you'd want for debugging — `agent_call_start`/`agent_call_end`, `tool_call_*`, gate events, `pipeline`, `verify`, `handoff_*` — are all retained.

## Comparing Results

Compare two runs to detect regressions and improvements. Runs must use the same dataset and scorers.

```bash
npx axl-eval compare ./results/v1.json ./results/v2.json
npx axl-eval compare v1.json v2.json --fail-on-regression  # exit 1 if significant regressions
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

By default, the runner calls `runtime.execute(workflow, input)` for each item. Export `executeWorkflow` to override:

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

**Concurrency** — process items in parallel (default: 5):

```typescript
export default defineEval({
  workflow: 'qa-eval',
  dataset: ds,
  scorers: [qualityJudge],
  concurrency: 10,       // run 10 items in parallel
  budget: '$5.00',        // stop if total cost exceeds $5
});
```

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

The rescored result gets a new `id` and has `metadata.rescored: true` and `metadata.originalId` pointing to the source run. `runGroupId` and `runIndex` are stripped from inherited metadata (rescored results are independent evaluations). Only scorer cost is tracked (workflow cost is zero).

Programmatically:

```typescript
import { rescore } from '@axlsdk/eval';

const rescored = await rescore(originalResult, [updatedScorer, newScorer], runtime, {
  concurrency: 10,
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
| `scorer(config)` | Create a deterministic scorer |
| `llmScorer(config)` | Create an LLM-as-judge scorer |
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
| `EvalConfig` | Eval definition (workflow, dataset, scorers, concurrency, budget) |
| `EvalResult` | Full eval output (items, summary, cost, duration) |
| `EvalItem` | Per-item result (input, output, scores, scoreDetails, metadata, traces?) |
| `EvalSummary` | Aggregate statistics (count, failures, scorer stats, timing) |
| `EvalComparison` | Comparison output (scorer deltas, CI, pRegression/pImprovement, n, regressions, improvements) |
| `EvalCompareOptions` | Options for `evalCompare()` (`thresholds`) |
| `EvalRegression` / `EvalImprovement` | Per-item change record (itemIndex, scorer, scores, delta) |
| `ScorerDetail` | Per-scorer detail (score, metadata, duration, cost) |
| `ScorerResult` | Scorer return type (`{ score, metadata?, cost? }`) |
| `RescoreOptions` | Options for `rescore()` (`concurrency`) |
| `MultiRunSummary` | Aggregated multi-run output (per-scorer mean/std/min/max) |
| `BootstrapCIResult` | CI result (`{ lower, upper, mean, pRegression, pImprovement }`) |
| `RunEvalOptions` | Options for `runEval()` (`onProgress`, `signal`, `captureTraces`) |
| `EvalProgressEvent` | Event passed to `onProgress`: `{ type: 'item_done', itemIndex, totalItems }` (emitted after each item finishes — success, failure, cancellation, or budget-exceeded) \| `{ type: 'run_done', totalItems, failures }` (emitted once after all items finish and stats are computed) |

## License

[Apache 2.0](../../LICENSE)
