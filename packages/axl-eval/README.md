# axl-eval

Evaluation framework for Axl agentic workflows. Define datasets, scoring functions, and run evaluations to measure and compare agent performance.

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
  model: 'openai:gpt-4o',
  system: 'You are an expert evaluator. Rate the quality of AI outputs.',
  schema: z.object({
    score: z.number().min(0).max(1),
    reasoning: z.string(),
  }),
  temperature: 0.2,
});
```

### `runEval(config, executeFn)`

Run an evaluation:

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

Register an eval for CLI discovery:

```typescript
import { defineEval } from '@axlsdk/eval';

export default defineEval({
  workflow: 'math-workflow',
  dataset: ds,
  scorers: [exactMatch],
});
```

## CLI

Run evaluations from the command line:

```bash
# Run an eval file
npx axl eval ./evals/math.ts

# Save results to a file
npx axl eval ./evals/math.ts --output ./results/baseline.json

# Compare two results
npx axl eval compare ./results/baseline.json ./results/candidate.json
```

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
