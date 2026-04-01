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

// ── Per-item inspection ──────────────────────────────
for (const item of results.items) {
  if (item.error) continue;                              // workflow threw

  // Timing and cost
  console.log(item.duration);                            // workflow execution ms
  console.log(item.cost);                                // workflow LLM cost
  console.log(item.scorerCost);                          // total scorer cost for this item

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
}
```

## Comparing Results

Compare two runs to detect regressions and improvements. Runs must use the same dataset and scorers.

```bash
npx axl-eval compare ./results/v1.json ./results/v2.json
npx axl-eval compare v1.json v2.json --fail-on-regression  # exit 1 if worse
```

```
Compare: baseline (3f8a2b1c) -> candidate (9d4e7f6a)

  Scorer     Baseline  Candidate  Delta     Change
  ──────────────────────────────────────────────────
  quality       0.750      0.850    +0.100   +13.3%
  safety        0.900      0.900    +0.000    +0.0%

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

// Timing and cost tradeoffs
console.log(comparison.timing?.deltaPercent);  // +104.8 (slower)
console.log(comparison.cost?.deltaPercent);    // -31.1 (cheaper)

// Per-item regressions/improvements (delta > 0.1 threshold)
for (const r of comparison.regressions) {
  console.log(`Item ${r.itemIndex}: ${r.scorer} dropped ${r.baselineScore} → ${r.candidateScore}`);
}

console.log(comparison.summary);  // human-readable one-liner
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

## License

[Apache 2.0](../../LICENSE)
