# @axlsdk/eval

[![npm version](https://img.shields.io/npm/v/@axlsdk/eval)](https://www.npmjs.com/package/@axlsdk/eval)

Evaluation framework for [Axl](https://github.com/axl-sdk/axl) agentic workflows. Define datasets, scoring functions, and run evaluations to measure and compare agent performance.

## Installation

```bash
npm install @axlsdk/eval
```

## API

### `dataset(config)`

Define evaluation datasets:

```typescript
import { dataset } from '@axlsdk/eval';
import { z } from 'zod';

// Inline items with schema and annotations
const ds = dataset({
  name: 'math-basics',
  schema: z.object({ question: z.string() }),
  annotations: z.object({ answer: z.number() }),
  items: [
    { input: { question: '2+2' }, annotations: { answer: 4 } },
    { input: { question: '3*5' }, annotations: { answer: 15 } },
    { input: { question: '10/2' }, annotations: { answer: 5 } },
  ],
});

// Load from file
const ds = dataset({
  name: 'math-advanced',
  schema: z.object({ question: z.string() }),
  file: './datasets/math.json',
});
```

### `scorer(config)`

Define deterministic scoring functions. The `score` callback receives `(output, input, annotations?)`:

```typescript
import { scorer } from '@axlsdk/eval';

const exactMatch = scorer({
  name: 'exact-match',
  description: 'Checks if the output answer exactly matches the expected answer',
  score: (output, input, annotations) => output.answer === annotations?.answer ? 1 : 0,
});

const partialMatch = scorer({
  name: 'partial',
  description: 'Checks if the output contains the expected answer',
  score: (output, input, annotations) => {
    const outputStr = String(output).toLowerCase();
    const expected = String(annotations?.answer).toLowerCase();
    return outputStr.includes(expected) ? 1 : 0;
  },
});
```

### `llmScorer(config)`

Use an LLM as a judge. The scorer automatically constructs a prompt from the input, output, and annotations, then validates the response against your Zod schema:

```typescript
import { llmScorer } from '@axlsdk/eval';
import { z } from 'zod';

const qualityJudge = llmScorer({
  name: 'quality',
  description: 'Rates output quality on a 0-1 scale',
  model: 'openai-responses:gpt-5.4',
  system: 'You are an expert evaluator. Rate the quality of AI outputs.',
  schema: z.object({
    score: z.number().min(0).max(1),
    reasoning: z.string(),
  }),
  temperature: 0.2,
});
```

### `runEval(config, executeFn, runtime)`

Run an evaluation. LLM scorer providers are automatically resolved from the runtime's provider registry using each scorer's `model` URI (e.g., `google:gemini-3.1-flash`). Ensure the relevant API key environment variable is set (e.g., `OPENAI_API_KEY`, `GOOGLE_AI_API_KEY`) or register providers via `runtime.registerProvider()`:

```typescript
import { runEval } from '@axlsdk/eval';

const results = await runEval(
  {
    workflow: 'my-workflow',  // label stored in results for comparison
    dataset: ds,
    scorers: [exactMatch, qualityJudge],
    concurrency: 5,
  },
  async (input) => {
    const output = await runtime.execute('my-workflow', input);
    return { output };
  },
  runtime,
);

console.log(results.summary);
// { count: 3, failures: 0, scorers: { 'exact-match': { mean: 0.85, min: 0, max: 1, p50: 1, p95: 1 }, ... } }
```

### `evalCompare(baseline, candidate)`

Compare two evaluation runs:

```typescript
import { evalCompare } from '@axlsdk/eval';

const comparison = evalCompare(baselineResults, candidateResults);

console.log(comparison.regressions);
// [{ input: ..., scorer: 'exact-match', baselineScore: 1, candidateScore: 0, delta: -1 }]

console.log(comparison.improvements);
// [{ input: ..., scorer: 'quality', baselineScore: 0.5, candidateScore: 0.9, delta: 0.4 }]
```

### `defineEval(config)`

Define an eval file for discovery by the CLI or Studio middleware:

```typescript
// evals/math.eval.ts
import { defineEval, dataset, scorer } from '@axlsdk/eval';
import { z } from 'zod';

const mathDataset = dataset({
  name: 'math-basics',
  schema: z.object({ question: z.string() }),
  annotations: z.object({ answer: z.number() }),
  items: [
    { input: { question: '2+2' }, annotations: { answer: 4 } },
    { input: { question: '3*5' }, annotations: { answer: 15 } },
  ],
});

const correctAnswer = scorer({
  name: 'correct-answer',
  description: 'Checks if the output contains the expected numeric answer',
  score: (output, _input, annotations) =>
    String(output).includes(String(annotations?.answer)) ? 1 : 0,
});

export default defineEval({
  workflow: 'math-workflow',
  dataset: mathDataset,
  scorers: [correctAnswer],
});
```

When running via `runtime.eval()` or `runtime.runRegisteredEval()`, the runner calls `runtime.execute(workflow, input)` by default, which requires the workflow to be registered on the runtime.

When running via the CLI, the eval runner resolves the execution function in order: (1) the exported `executeWorkflow` function, (2) `runtime.execute(workflow, input)` if the workflow is registered on the runtime, or (3) a passthrough that returns the input as the output (with a warning).

The function receives `(input, runtime)` — the second argument is the `AxlRuntime` instance, always provided by the CLI, Studio, and `runtime.runRegisteredEval()`. Use it to call agents without needing a registered workflow:

```typescript
// evals/qa-quality.eval.ts — calls an agent directly via the runtime
import { defineEval, dataset, scorer } from '@axlsdk/eval';
import type { AxlRuntime } from '@axlsdk/axl';
import { z } from 'zod';
import { qaAgent } from '../src/agents/qa.js'; // import your agent definition

const qaDataset = dataset({
  name: 'qa-pairs',
  schema: z.object({ question: z.string() }),
  items: [
    { input: { question: 'What is TypeScript?' } },
    { input: { question: 'How do promises work?' } },
  ],
});

const notEmpty = scorer({
  name: 'not-empty',
  description: 'Output is non-empty',
  score: (output) => (String(output).length > 0 ? 1 : 0),
});

export default defineEval({
  workflow: 'qa-quality', // label for results (not a runtime lookup)
  dataset: qaDataset,
  scorers: [notEmpty],
});

export async function executeWorkflow(input: { question: string }, runtime: AxlRuntime) {
  const ctx = runtime.createContext();
  const output = await ctx.ask(qaAgent, input.question);
  return { output }; // cost tracked automatically via runtime.trackCost()
}
```

When no runtime is needed (e.g., testing a pure function), omit the runtime parameter — these evals work from both the CLI and Studio:

```typescript
// evals/parser.eval.ts — tests a pure function, no runtime needed
export async function executeWorkflow(input: { raw: string }) {
  const result = parseDocument(input.raw);
  return { output: result };
}
```

> **Note:** The CLI always provides a runtime to `executeWorkflow`. By default it auto-detects `axl.config.*` in the working directory or falls back to a bare `AxlRuntime` (providers resolved from environment variables). Use `--config` for explicit config files.

### Cost Tracking

Cost is tracked automatically. You don't need to return `cost` from your `executeWorkflow` — the eval runner wraps each item with `runtime.trackCost()`, which captures cost from all `createContext()` and `execute()` calls.

```typescript
export async function executeWorkflow(input: { question: string }, runtime: AxlRuntime) {
  const ctx = runtime.createContext();
  const output = await ctx.ask(myAgent, input.question);
  return { output }; // cost captured automatically
}
```

To override the automatic cost (e.g., to exclude setup calls), return it explicitly:

```typescript
return { output, cost: ctx.totalCost };
```

You can also read `ctx.totalCost` at any point to inspect accumulated cost.

### Common Patterns

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

## CLI

Run evaluations from the command line:

```bash
# Run an eval file
npx axl-eval ./evals/math.eval.ts

# Run all evals in a directory
npx axl-eval ./evals/

# Save results to a file
npx axl-eval ./evals/math.eval.ts --output ./results/baseline.json

# Use a config file for runtime access
npx axl-eval ./evals/ --config ./axl.config.ts

# Use custom import conditions (monorepo source exports)
npx axl-eval ./evals/ --config ./axl.config.ts --conditions development

# Compare two results
npx axl-eval compare ./results/baseline.json ./results/candidate.json

# Fail CI if regressions detected
npx axl-eval compare baseline.json candidate.json --fail-on-regression
```

TypeScript config and eval files require [tsx](https://github.com/privatenumber/tsx) as a dev dependency (`npm install -D tsx`).

### Runtime Resolution

The CLI resolves an `AxlRuntime` to pass to `executeWorkflow`:

1. **`--config <path>`** — use an explicit config file
2. **Auto-detect** — search for `axl.config.mts` → `.ts` → `.mjs` → `.js` in cwd
3. **Fallback** — create a bare `new AxlRuntime()` (providers resolve from environment variables)

When a runtime is available, each `executeWorkflow` call is wrapped with `runtime.trackCost()` for automatic cost attribution.

## Studio Integration

Eval files can also be lazy-loaded by the Studio middleware, enabling the Eval Runner panel without static imports that would create circular dependencies:

```typescript
import { createStudioMiddleware } from '@axlsdk/studio/middleware';

const studio = createStudioMiddleware({
  runtime,
  evals: 'evals/**/*.eval.ts',
});
```

See the [@axlsdk/studio README](../axl-studio/README.md#lazy-eval-loading) for details.

## Integration with AxlRuntime

```typescript
import { AxlRuntime } from '@axlsdk/axl';

const runtime = new AxlRuntime();
runtime.register(myWorkflow);

const results = await runtime.eval({
  workflow: 'my-workflow',
  dataset: ds,
  scorers: [exactMatch],
  concurrency: 3,
});
```

## License

[Apache 2.0](../../LICENSE)
