/**
 * Concurrency + consensus — the thing most frameworks make you build by hand.
 *
 * Runs the same question through N agents in parallel, then takes a majority
 * vote on the structured answer. `spawn` returns a Result<T>[] (each ok/err);
 * `vote` extracts the successful values and picks the answer seen most often.
 *
 *   OPENAI_API_KEY=sk-... npx tsx consensus.ts
 */
import { agent, workflow, AxlRuntime } from '@axlsdk/axl';
import { z } from 'zod';

const answerSchema = z.object({
  answer: z.number().describe('The numeric answer'),
});

// A slightly nondeterministic prompt so the vote does real work.
const solver = agent({
  name: 'solver',
  model: 'openai-responses:gpt-5.5',
  system: 'Solve the problem. Reason briefly, then return the final numeric answer.',
});

const reliableMath = workflow({
  name: 'reliable-math',
  input: z.object({ question: z.string() }),
  // The output schema validates YOUR orchestration result — separate from the
  // ask schema, which instructs the LLM.
  output: answerSchema,
  handler: async (ctx) => {
    // Run 5 concurrent attempts.
    const results = await ctx.spawn(5, () =>
      ctx.ask(solver, ctx.input.question, { schema: answerSchema }),
    );

    // Pick the answer that appeared most often across the successful runs.
    return ctx.vote(results, { strategy: 'majority', key: 'answer' });
  },
});

const runtime = new AxlRuntime();
runtime.register(reliableMath);

const result = await runtime.execute('reliable-math', {
  question: 'A train travels 60 km in 45 minutes. What is its speed in km/h?',
});
console.log('Consensus answer:', result);

await runtime.shutdown();
