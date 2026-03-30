# Use Cases

Real-world examples showing how Axl's primitives compose to solve common agentic patterns.

## BFF Agent (Backend-for-Frontend)

A React Native app sends "Refund my order". Axl orchestrates the agent, keeping API keys and logic on the server.

```typescript
import { agent, tool, workflow } from '@axlsdk/axl';
import { z } from 'zod';

const getOrder = tool({
  name: 'get_order',
  description: 'Look up an order by ID',
  input: z.object({ orderId: z.string() }),
  handler: async ({ orderId }) => db.orders.findOne(orderId),
});

const refundOrder = tool({
  name: 'refund_order',
  description: 'Process a refund for an order',
  input: z.object({ orderId: z.string() }),
  handler: async ({ orderId }) => db.orders.refund(orderId),
});

const SupportBot = agent({
  model: 'openai-responses:gpt-5.4',
  system: 'You are a helpful customer support agent. Be concise.',
  tools: [getOrder, refundOrder],
  timeout: '30s',
  maxTurns: 10,
});

const HandleSupport = workflow({
  name: 'HandleSupport',
  input: z.object({ msg: z.string() }),
  handler: async (ctx) => await ctx.ask(SupportBot, ctx.input.msg),
});
```

25 lines for a production-ready support agent with tool access, type safety, and streaming.

## Structured Data Extraction

Extract entities with strict type validation and self-correcting retry.

```typescript
const UserProfile = z.object({
  name: z.string(),
  age: z.number().int().positive(),
  email: z.string().email().optional(),
});

const Extractor = agent({
  model: 'openai-responses:gpt-5.4',
  system: 'Extract structured user profile data from the given text.',
  temperature: 0.1,
});

const GenerateProfile = workflow({
  name: 'GenerateProfile',
  input: z.object({ desc: z.string() }),
  output: UserProfile,
  handler: async (ctx) => {
    return await ctx.ask(Extractor, ctx.input.desc, {
      schema: UserProfile,
      retries: 3,
    });
  },
});
```

## Validated Data Extraction

When extracted data must satisfy business rules beyond what a Zod schema can express (cross-field relationships, computed values, referential integrity), use `validate` on `ctx.ask()`. The LLM gets accumulating feedback about what's wrong and can self-correct.

### Basic: LLM with business rule validation

```typescript
const OrderSchema = z.object({
  items: z.array(z.object({
    productId: z.string(),
    quantity: z.number(),
    unitPrice: z.number(),
  })),
  total: z.number(),
  currency: z.enum(['USD', 'EUR', 'GBP']),
});

const order = await ctx.ask(extractAgent, 'Extract the order from this email', {
  schema: OrderSchema,
  validate: (order) => {
    // Zod ensures the right fields and types — validate checks business rules
    const computedTotal = order.items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
    if (Math.abs(computedTotal - order.total) > 0.01) {
      return { valid: false, reason: `Total ${order.total} doesn't match computed ${computedTotal}` };
    }
    if (order.items.some(i => i.quantity <= 0)) {
      return { valid: false, reason: 'Item quantities must be positive' };
    }
    return { valid: true };
  },
  validateRetries: 3,
});
```

If the LLM produces `{ items: [{productId: "A1", quantity: 2, unitPrice: 10}], total: 25, currency: "USD" }`, validate rejects it with "Total 25 doesn't match computed 20." The LLM sees this feedback with all previous attempts and can self-correct.

### Verify: retrying a non-LLM data source

When the data comes from an API instead of an LLM, use `ctx.verify()`. The `retry.parsed` field lets you distinguish schema failures (malformed response) from validate failures (structurally valid but business-invalid), and repair the data programmatically:

```typescript
const PricingSchema = z.object({
  productId: z.string(),
  cost: z.number(),
  price: z.number(),
  currency: z.enum(['USD', 'EUR', 'GBP']),
});

const pricing = await ctx.verify(
  async (retry) => {
    if (retry?.parsed) {
      // Validate failed — data is structurally valid but breaks business rules.
      // Repair: enforce 20% minimum margin by adjusting the price.
      const minPrice = retry.parsed.cost * 1.2;
      return { ...retry.parsed, price: Math.max(retry.parsed.price, minPrice) };
    }
    // First call or schema failure — fetch from pricing API
    if (retry) console.log(`Bad API response: ${retry.error}`);
    const res = await fetch(`https://pricing.internal/${productId}`);
    return res.json();
  },
  PricingSchema,
  {
    retries: 3,
    validate: (pricing) => {
      const margin = (pricing.price - pricing.cost) / pricing.price;
      if (margin < 0.2) {
        return { valid: false, reason: `Margin ${(margin * 100).toFixed(1)}% is below 20% minimum` };
      }
      return { valid: true };
    },
  },
);
```

If the API returns `{ cost: 10, price: 11 }` (9% margin), validate rejects it. On retry, `retry.parsed` contains the typed object, so `fn` repairs it directly — clamping the price to `cost * 1.2 = 12`.

### Advanced: LLM-first with programmatic repair fallback

The most powerful pattern composes `ctx.ask()` inside `ctx.verify()`. The LLM gets multiple attempts with accumulating context. If it still can't satisfy the business rules, `ctx.verify()` catches the `ValidationError` and gives you the typed object to repair programmatically:

```typescript
const OrderSchema = z.object({
  items: z.array(z.object({ sku: z.string(), qty: z.number() })),
  shipping: z.enum(['standard', 'express']),
});

const orderValidator = (order: z.infer<typeof OrderSchema>) => {
  if (order.items.some(i => i.qty <= 0)) {
    return { valid: false, reason: 'All quantities must be positive' } as const;
  }
  return { valid: true } as const;
};

// ctx.ask() retries internally (schema: 3, validate: 2 by default).
// If it still fails, ctx.verify() catches the error and provides retry.parsed.
const order = await ctx.verify(
  async (retry) => {
    if (retry?.parsed) {
      // LLM couldn't get it right — repair programmatically
      return { ...retry.parsed, items: retry.parsed.items.filter(i => i.qty > 0) };
    }
    return ctx.ask(extractAgent, 'Extract the order from this email', {
      schema: OrderSchema,
      validate: orderValidator,
    });
  },
  OrderSchema,
  { retries: 1, validate: orderValidator },
);
```

This gives you the best of both worlds: the LLM tries to get it right with accumulating feedback (`ctx.ask` retries), and if it can't, you have a typed object to repair programmatically (`ctx.verify` retry).

See the [API reference](api-reference.md#validate) for the full type signatures, output pipeline, and retry mechanics.

## Human-in-the-Loop

High-stakes actions (e.g., refunding > $500) require human approval. The workflow suspends, persists state, and resumes after review.

```typescript
const SafeRefund = workflow({
  name: 'SafeRefund',
  input: z.object({ orderId: z.string() }),
  handler: async (ctx) => {
    const order = await getOrder.run(ctx, { orderId: ctx.input.orderId });

    if (order.amount > 500) {
      const decision = await ctx.awaitHuman({
        channel: 'manager_approval',
        prompt: `Refund of $${order.amount} for order ${order.id} requires approval`,
      });

      if (decision.approved) {
        await refundOrder.run(ctx, { orderId: order.id });
        return `Refund of $${order.amount} approved and processed.`;
      } else {
        return `Refund denied: ${decision.reason}`;
      }
    }

    await refundOrder.run(ctx, { orderId: order.id });
    return `Refund of $${order.amount} processed.`;
  },
});
```

## Multi-Agent Consensus

Three independent LLM calls review the same document. `spawn` runs them in parallel, `vote` picks a winner from the results — no LLM is involved in the voting itself, it's pure aggregation over the structured outputs.

```typescript
const ReviewScore = z.object({
  score: z.number().int().min(1).max(10),
  reasoning: z.string(),
});

const Reviewer = agent({
  model: 'openai-responses:gpt-5.4',
  system: 'Review the document and provide a score from 1-10 with reasoning.',
  temperature: 0.7,  // some randomness so each call produces a different review
});

const PeerReview = workflow({
  name: 'PeerReview',
  input: z.object({ doc: z.string() }),
  output: ReviewScore,
  handler: async (ctx) => {
    // Spawn 3 concurrent LLM calls to the same agent.
    // quorum: 2 means resolve as soon as 2 succeed — the 3rd is cancelled.
    // This saves cost when you don't need all results.
    const reviews = await ctx.spawn(
      3,
      (i) => ctx.ask(Reviewer, ctx.input.doc, { schema: ReviewScore }),
      { quorum: 2 },
    );
    // vote picks the result with the highest 'score' field.
    // No LLM call here — it just compares the numeric values.
    return await ctx.vote(reviews, { strategy: 'highest', key: 'score' });
  },
});
```

### Vote Strategy Reference

`vote()` operates on the array of results from `spawn` or `map`. All built-in strategies are deterministic — no LLM involved. Use `scorer` or `reducer` callbacks when you need LLM-as-judge or custom logic (see variants below).

| Strategy | What it does | Options |
|---|---|---|
| `majority` | Picks the value that appeared most often | `key` — compare by a specific field |
| `unanimous` | Returns the value if all agree; throws `NoConsensus` if they differ | `key` — compare by a specific field |
| `highest` | Picks the candidate with the highest numeric value | `key` — compare by a field, or `scorer` — score each candidate with an async function |
| `lowest` | Picks the candidate with the lowest numeric value | `key` — compare by a field, or `scorer` — score each candidate with an async function |
| `mean` | Computes the arithmetic mean across all values | Values must be numbers |
| `median` | Computes the median across all values | Values must be numbers |
| `custom` | Delegates entirely to your function | `reducer(values) => result` — receives all successful values, returns the winner |

**Note:** `scorer` only works with `highest` and `lowest`. Other strategies ignore it. `reducer` only works with `custom`.

**How `quorum` works:** Without `quorum`, `spawn` waits for all N tasks to finish. With `quorum: K`, it resolves as soon as K tasks succeed and cancels the rest (via AbortController). This is useful when you want redundancy without paying for all N completions. If fewer than K succeed, it throws `QuorumNotMet`.

### Variant: Multi-Model Consensus

Use different models as reviewers to reduce correlated errors:

```typescript
const ReviewerGPT = agent({ model: 'openai-responses:gpt-5.4', system: 'Review the document...', temperature: 0.7 });
const ReviewerClaude = agent({ model: 'anthropic:claude-sonnet-4-6', system: 'Review the document...', temperature: 0.7 });
const ReviewerGemini = agent({ model: 'google:gemini-3.1-pro-preview', system: 'Review the document...', temperature: 0.7 });

const reviewers = [ReviewerGPT, ReviewerClaude, ReviewerGemini];

const CrossModelReview = workflow({
  name: 'CrossModelReview',
  input: z.object({ doc: z.string() }),
  output: ReviewScore,
  handler: async (ctx) => {
    // Each spawn index maps to a different model — GPT, Claude, Gemini
    const reviews = await ctx.spawn(
      3,
      (i) => ctx.ask(reviewers[i], ctx.input.doc, { schema: ReviewScore }),
      { quorum: 2 },  // succeed when any 2 models respond
    );
    return await ctx.vote(reviews, { strategy: 'highest', key: 'score' });
  },
});
```

### Variant: LLM-as-Judge with `scorer`

Use `scorer` to have an LLM evaluate each candidate. The scorer runs on every result and returns a numeric score — `highest`/`lowest` picks the winner.

```typescript
const Judge = agent({
  model: 'anthropic:claude-sonnet-4-6',
  system: 'You are an expert writing evaluator. Score the given text on clarity, depth, and accuracy.',
  temperature: 0.1,
});

const JudgeScore = z.object({
  score: z.number().min(0).max(1),
  reasoning: z.string(),
});

const BestDraft = workflow({
  name: 'BestDraft',
  input: z.object({ topic: z.string() }),
  handler: async (ctx) => {
    const drafts = await ctx.spawn(
      3,
      () => ctx.ask(Writer, `Write about: ${ctx.input.topic}`),
    );

    // Each draft is scored by the Judge agent.
    // scorer is called once per successful result — here, up to 3 LLM calls.
    return await ctx.vote(drafts, {
      strategy: 'highest',
      scorer: async (draft) => {
        const result = await ctx.ask(Judge, `Score this text:\n\n${draft}`, {
          schema: JudgeScore,
        });
        return result.score;
      },
    });
  },
});
```

The `scorer` callback receives each candidate value and returns a number. It can do anything — call an LLM, query a database, run a heuristic. `vote` just picks the candidate with the highest (or lowest) score.

### Variant: Custom Aggregation with `reducer`

Use `reducer` with `strategy: 'custom'` for full control over how results are combined. The reducer receives all successful values and returns the final result.

```typescript
const MergedResearch = workflow({
  name: 'MergedResearch',
  input: z.object({ topic: z.string() }),
  handler: async (ctx) => {
    const findings = await ctx.spawn(
      3,
      (i) => ctx.ask(Researcher, `Research aspect ${i + 1} of: ${ctx.input.topic}`),
    );

    // Combine all findings into a single summary using an LLM.
    // The reducer receives the array of successful values.
    return await ctx.vote(findings, {
      strategy: 'custom',
      reducer: async (allFindings) => {
        return ctx.ask(
          Summarizer,
          `Merge these research findings into a cohesive summary:\n\n${allFindings.join('\n\n---\n\n')}`,
        );
      },
    });
  },
});
```

Unlike `scorer` (which evaluates candidates independently), `reducer` sees all candidates at once — useful for merging, synthesizing, or applying custom selection logic.

## Budget-Capped Research

Deep research task that could consume unlimited tokens, capped at a fixed cost. See [API Reference > `ctx.budget()`](./api-reference.md#ctxbudgetoptions-fn) for all `onExceed` policies.

```typescript
const Researcher = agent({
  model: 'openai-responses:gpt-5.4',
  system: 'Research the given topic thoroughly.',
  tools: [webSearch, readUrl],
  maxTurns: 20,
});

const Summarizer = agent({
  model: 'anthropic:claude-sonnet-4-6',
  system: 'Summarize the research into a concise brief.',
  temperature: 0.3,
});

const ResearchTopic = workflow({
  name: 'ResearchTopic',
  input: z.object({ topic: z.string() }),
  handler: async (ctx) => {
    const result = await ctx.budget({ cost: '$5.00', onExceed: 'finish_and_stop' }, async () => {
      const research = await ctx.ask(Researcher, ctx.input.topic);
      const summary = await ctx.ask(Summarizer, `Summarize: ${research}`);
      return summary;
    });
    return result.value ?? 'Research exceeded budget before producing a summary.';
  },
});
```

## Multi-Turn Support Chat (Sessions)

A customer chats back and forth with a support agent. Axl maintains conversation history across HTTP requests.

```typescript
const SupportBot = agent({
  model: 'openai-responses:gpt-5.4',
  system: 'You are a helpful support agent. Be concise and friendly.',
  tools: [getOrder, getCustomer, refundOrder],
  maxTurns: 10,
});

const HandleSupport = workflow({
  name: 'HandleSupport',
  input: z.object({ msg: z.string() }),
  handler: async (ctx) => await ctx.ask(SupportBot, ctx.input.msg),
});
```

```typescript
// Host App (Express)
app.post('/api/chat/:sessionId', async (req, res) => {
  const session = runtime.session(req.params.sessionId);
  const stream = await session.stream('HandleSupport', { msg: req.body.msg });
  stream.pipe(res);
});
```

## Model Fallback with Race

Try multiple models in parallel, take the first valid response:

```typescript
const FastModel = agent({ model: 'openai-responses:gpt-5-mini', system: 'Answer the question concisely.' });
const SmartModel = agent({ model: 'anthropic:claude-sonnet-4-6', system: 'Answer the question concisely.' });

const QuickAnswer = workflow({
  name: 'QuickAnswer',
  input: z.object({ question: z.string() }),
  handler: async (ctx) => {
    return await ctx.race([
      () => ctx.ask(FastModel, ctx.input.question),
      () => ctx.ask(SmartModel, ctx.input.question),
    ]);
  },
});
```

## Agent Triage with Handoffs

A triage agent routes to specialist agents. Each specialist has its own scoped tool set.

```typescript
const BillingBot = agent({
  model: 'openai-responses:gpt-5.4',
  system: 'You handle billing and payment questions.',
  tools: [getInvoice, processPayment, applyCredit],
});

const ShippingBot = agent({
  model: 'openai-responses:gpt-5.4',
  system: 'You handle shipping and delivery questions.',
  tools: [trackPackage, updateAddress, scheduleRedelivery],
});

const TriageBot = agent({
  model: 'openai-responses:gpt-5-mini',  // Cheap model for routing
  system: `Route the customer to the right specialist:
- BillingBot: billing, payments, invoices, credits
- ShippingBot: shipping, delivery, tracking, addresses`,
  tools: [getOrder],
  handoffs: [{ agent: BillingBot }, { agent: ShippingBot }],
});

const CustomerSupport = workflow({
  name: 'CustomerSupport',
  input: z.object({ msg: z.string() }),
  handler: async (ctx) => await ctx.ask(TriageBot, ctx.input.msg),
});
```

The triage agent uses a cheap model just for routing. Each specialist only has access to its own tools — ShippingBot cannot call `processPayment`. See [API Reference > `HandoffDescriptor`](./api-reference.md#handoffdescriptor) for handoff modes.

## MCP-Powered Development Assistant

A coding assistant that uses tools from external MCP servers alongside local tools:

```typescript
const DevAssistant = agent({
  model: 'anthropic:claude-sonnet-4-6',
  system: 'You are a senior developer assistant.',
  mcp: ['github', 'linear'],
  tools: [readFile, writeFile, runTests],
});

const CodeReview = workflow({
  name: 'CodeReview',
  input: z.object({ prNumber: z.number() }),
  handler: async (ctx) => {
    return await ctx.ask(DevAssistant,
      `Review PR #${ctx.input.prNumber}. Check for bugs, style issues, and missing tests.`
    );
  },
});
```

## Batch Processing with Map

Analyze 200 customer reviews with bounded concurrency and a cost cap:

```typescript
const SentimentScore = z.object({
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
});

const Analyst = agent({
  model: 'openai-responses:gpt-5-mini',
  system: 'Analyze the sentiment of the given customer review.',
  temperature: 0.1,
});

const BatchAnalysis = workflow({
  name: 'BatchAnalysis',
  input: z.object({ reviews: z.array(z.string()) }),
  handler: async (ctx) => {
    const result = await ctx.budget({ cost: '$10.00' }, async () => {
      const analyses = await ctx.map(ctx.input.reviews, async (review) => {
        return await ctx.ask(Analyst, review, { schema: SentimentScore });
      }, { concurrency: 10 });

      const scores = analyses
        .filter((r) => r.ok)
        .map(r => r.value);

      return {
        total: scores.length,
        positive: scores.filter(s => s.sentiment === 'positive').length,
        negative: scores.filter(s => s.sentiment === 'negative').length,
        neutral: scores.filter(s => s.sentiment === 'neutral').length,
      };
    });

    return result.value ?? { total: 0, positive: 0, negative: 0, neutral: 0 };
  },
});
```

This processes 200 reviews with at most 10 concurrent LLM calls, capped at $10.00 total. See [API Reference > `ctx.map()`](./api-reference.md#ctxmapitems-fn-options) for all options.

## Eval-Driven Prompt Iteration

Define a dataset, score outputs across multiple dimensions, and compare prompt versions to catch regressions.

```typescript
import { agent, workflow } from '@axlsdk/axl';
import { dataset, scorer, llmScorer, defineEval } from '@axlsdk/eval';

// The workflow under evaluation — this is what we're iterating on
const FitnessCoach = agent({
  model: 'openai-responses:gpt-5.4',
  system: 'You are a certified personal trainer. Generate a workout plan for the given profile.',
});

const GenerateWorkoutPlan = workflow({
  name: 'GenerateWorkoutPlan',
  input: z.object({
    age: z.number(),
    fitnessLevel: z.enum(['beginner', 'intermediate', 'advanced']),
    goal: z.string(),
    daysPerWeek: z.number(),
  }),
  handler: async (ctx) => await ctx.ask(FitnessCoach, JSON.stringify(ctx.input)),
});

const workoutProfiles = dataset({
  name: 'workout-profiles',
  schema: z.object({
    age: z.number(),
    fitnessLevel: z.enum(['beginner', 'intermediate', 'advanced']),
    goal: z.string(),
    daysPerWeek: z.number(),
  }),
  annotations: z.object({
    minExercises: z.number(),
    shouldIncludeRest: z.boolean(),
  }),
  file: './datasets/workout-profiles.json',
});

// Deterministic scorer
const structuralValidity = scorer({
  name: 'structural-validity',
  score: (output) => {
    let score = 0;
    if (output.exercises?.length > 0) score += 0.25;
    if (output.warmup) score += 0.25;
    if (output.cooldown) score += 0.25;
    if (output.schedule?.length > 0) score += 0.25;
    return score;
  },
});

// LLM-as-judge scorer
const planQuality = llmScorer({
  name: 'plan-quality',
  model: 'openai-responses:gpt-5.4',
  system: 'You are an expert fitness coach evaluating workout plans. Rate on a 0-1 scale.',
  schema: z.object({ score: z.number().min(0).max(1), reasoning: z.string() }),
});

export default defineEval({
  workflow: 'GenerateWorkoutPlan',  // references the workflow defined above — stored in results for comparison
  dataset: workoutProfiles,
  scorers: [structuralValidity, planQuality],
  concurrency: 3,
  budget: '$20.00',
});
```

```bash
# Run baseline eval
npx axl-eval ./evals/workout-plan.ts --output results/baseline.json

# Edit the agent's system prompt...

# Run candidate eval
npx axl-eval ./evals/workout-plan.ts --output results/candidate.json

# Compare — catch regressions before deploying
npx axl-eval compare results/baseline.json results/candidate.json
```
