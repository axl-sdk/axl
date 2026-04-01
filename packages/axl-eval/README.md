# @axlsdk/eval

[![npm version](https://img.shields.io/npm/v/@axlsdk/eval)](https://www.npmjs.com/package/@axlsdk/eval)

Evaluation framework for [Axl](https://github.com/axl-sdk/axl) agentic workflows. Define datasets, scoring functions, and run evaluations to measure and compare agent performance.

## Installation

```bash
npm install @axlsdk/eval
```

TypeScript eval files require [tsx](https://github.com/privatenumber/tsx) as a dev dependency (`npm install -D tsx`).

## Quick Start

Create an eval file, define your dataset and scorers, and run it:

```typescript
// evals/qa.eval.ts
import { defineEval, dataset, scorer, llmScorer } from '@axlsdk/eval';
import { z } from 'zod';

export default defineEval({
  workflow: 'qa-workflow',
  dataset: dataset({
    name: 'qa-basics',
    schema: z.object({ question: z.string() }),
    items: [
      { input: { question: 'What is TypeScript?' } },
      { input: { question: 'Explain closures.' } },
    ],
  }),
  scorers: [
    // Deterministic scorer — runs in-process, no LLM call
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
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    }),
  ],
});

// Tell the runner how to get output for each input
export async function executeWorkflow(input: { question: string }, runtime: AxlRuntime) {
  const ctx = runtime.createContext();
  return { output: await ctx.ask(myAgent, input.question) };
}
```

```bash
# Run it — set the API key for whichever provider your LLM scorer uses
OPENAI_API_KEY=sk-... npx axl-eval ./evals/qa.eval.ts
```

Output:

```
Eval: qa-workflow x qa-basics (2 items)
  Scorer     Mean      Min      Max      p50      p95
  ─────────────────────────────────────────────────────
  not-empty  1.00     1.00     1.00     1.00     1.00
  relevance  0.90     0.80     1.00     0.90     1.00

  Failures: 0/2 | Cost: $0.01 | Duration: 3.2s
```

## Datasets

Define evaluation datasets inline or from a file:

```typescript
import { dataset } from '@axlsdk/eval';
import { z } from 'zod';

// Inline with annotations (ground truth)
const ds = dataset({
  name: 'math-basics',
  schema: z.object({ question: z.string() }),
  annotations: z.object({ answer: z.number() }),
  items: [
    { input: { question: '2+2' }, annotations: { answer: 4 } },
    { input: { question: '3*5' }, annotations: { answer: 15 } },
  ],
});

// From a JSON file
const ds = dataset({
  name: 'math-advanced',
  schema: z.object({ question: z.string() }),
  file: './datasets/math.json',
});
```

## Scorers

Scorers rate each output on a 0-1 scale. You can mix deterministic and LLM scorers in the same eval.

### Deterministic scorers

Pure functions — fast, free, and deterministic:

```typescript
import { scorer } from '@axlsdk/eval';

const exactMatch = scorer({
  name: 'exact-match',
  description: 'Checks if output matches expected answer',
  score: (output, input, annotations) =>
    output.answer === annotations?.answer ? 1 : 0,
});
```

### LLM scorers

Use an LLM as a judge. The scorer constructs a prompt from the input, output, and annotations, calls the LLM, and validates the response against your Zod schema:

```typescript
import { llmScorer } from '@axlsdk/eval';
import { z } from 'zod';

const qualityJudge = llmScorer({
  name: 'quality',
  description: 'Rates overall output quality',
  model: 'openai:gpt-4o',           // provider:model URI
  system: 'Rate the quality of the AI output.',
  schema: z.object({
    score: z.number().min(0).max(1),
    reasoning: z.string(),
  }),
  temperature: 0.2,                  // default: 0.2 (low for consistency)
});
```

The `model` field uses a `provider:model` URI. The provider is resolved automatically from the runtime at eval time — you just need the right API key in your environment:

| Provider | URI prefix | Env var |
|----------|-----------|---------|
| OpenAI (Chat Completions) | `openai:` | `OPENAI_API_KEY` |
| OpenAI (Responses API) | `openai-responses:` | `OPENAI_API_KEY` |
| Anthropic | `anthropic:` | `ANTHROPIC_API_KEY` |
| Google Gemini | `google:` | `GOOGLE_API_KEY` or `GEMINI_API_KEY` |
| Custom | `your-name:` | Via `runtime.registerProvider('your-name', provider)` |

Different LLM scorers can use different providers — each resolves independently:

```typescript
const qualityJudge = llmScorer({ model: 'openai:gpt-4o', ... });
const safetyJudge = llmScorer({ model: 'anthropic:claude-sonnet-4-5-20250514', ... });
```

### Score results

Scores are `number | null` per scorer per item. `null` means the scorer failed (threw an error or returned out-of-range). Error details are in `item.scorerErrors`. Summary statistics (mean, p50, p95, etc.) exclude null scores.

## Running Evals

### CLI

The most common way to run evals:

```bash
# Run a single eval file
npx axl-eval ./evals/qa.eval.ts

# Run all eval files in a directory
npx axl-eval ./evals/

# Save results to JSON
npx axl-eval ./evals/qa.eval.ts --output ./results/baseline.json

# Use a specific config file for runtime
npx axl-eval ./evals/ --config ./axl.config.ts

# Monorepo: use custom import conditions
npx axl-eval ./evals/ --config ./axl.config.ts --conditions development
```

The CLI resolves a runtime automatically:

1. **`--config <path>`** — use an explicit config file
2. **Auto-detect** — search for `axl.config.mts` → `.ts` → `.mjs` → `.js` in cwd
3. **Fallback** — create a bare `new AxlRuntime()` (providers resolved from env vars)

### Programmatic

Use `runtime.eval()` when you want to run evals from your own code:

```typescript
import { AxlRuntime } from '@axlsdk/axl';

const runtime = new AxlRuntime();
runtime.register(myWorkflow);

const results = await runtime.eval({
  workflow: 'my-workflow',
  dataset: ds,
  scorers: [exactMatch, qualityJudge],
  concurrency: 3,
});
```

Or use `runEval()` directly for full control over the execution function:

```typescript
import { runEval } from '@axlsdk/eval';

const results = await runEval(
  { workflow: 'my-workflow', dataset: ds, scorers: [exactMatch, qualityJudge] },
  async (input) => {
    const output = await runtime.execute('my-workflow', input);
    return { output };
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

## Comparing Results

Compare two eval runs to detect regressions and improvements:

```bash
# CLI
npx axl-eval compare ./results/baseline.json ./results/candidate.json

# Fail CI if regressions detected
npx axl-eval compare baseline.json candidate.json --fail-on-regression
```

```typescript
// Programmatic
import { evalCompare } from '@axlsdk/eval';

const comparison = evalCompare(baselineResults, candidateResults);
console.log(comparison.regressions);  // items that got worse
console.log(comparison.improvements); // items that got better
```

## Eval Files

### Execution function

By default, `runtime.execute(workflow, input)` runs the workflow. Export `executeWorkflow` to override:

```typescript
// evals/qa.eval.ts
import type { AxlRuntime } from '@axlsdk/axl';
import { qaAgent } from '../src/agents/qa.js';

export default defineEval({ ... });

export async function executeWorkflow(input: { question: string }, runtime: AxlRuntime) {
  const ctx = runtime.createContext();
  const output = await ctx.ask(qaAgent, input.question);
  return { output }; // cost tracked automatically
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

**Budget per item** — cap cost to prevent runaway evals:

```typescript
export async function executeWorkflow(input: { question: string }, runtime: AxlRuntime) {
  const ctx = runtime.createContext({ budget: '$0.50' });
  const output = await ctx.ask(myAgent, input.question);
  return { output };
}
```

**Timeout per item** — cancel items that take too long:

```typescript
export async function executeWorkflow(input: { question: string }, runtime: AxlRuntime) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30_000);
  const ctx = runtime.createContext({ signal: controller.signal });
  const output = await ctx.ask(myAgent, input.question);
  return { output };
}
```

**Auto-approve tools** — when testing agents that have tools with `requireApproval`:

```typescript
export async function executeWorkflow(input: { question: string }, runtime: AxlRuntime) {
  const ctx = runtime.createContext({
    awaitHumanHandler: async () => ({ approved: true }),
  });
  const output = await ctx.ask(myAgent, input.question);
  return { output };
}
```

**Multi-turn evaluation** — test follow-up responses with conversation history:

```typescript
export async function executeWorkflow(
  input: { setupPrompt: string; setupResponse: string; followUp: string },
  runtime: AxlRuntime,
) {
  const ctx = runtime.createContext({
    sessionHistory: [
      { role: 'user', content: input.setupPrompt },
      { role: 'assistant', content: input.setupResponse },
    ],
  });
  const output = await ctx.ask(myAgent, input.followUp);
  return { output };
}
```

## License

[Apache 2.0](../../LICENSE)
