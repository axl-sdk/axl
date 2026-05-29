/**
 * Quickstart — the smallest useful Axl program.
 *
 * An agent with one tool. The agent receives a question, decides to call the
 * calculator, gets the result, and answers in natural language. Axl runs the
 * tool-calling loop, validates the tool input with Zod, and parses the response.
 *
 *   OPENAI_API_KEY=sk-... npx tsx quickstart.ts
 */
import { tool, agent, workflow, AxlRuntime } from '@axlsdk/axl';
import { z } from 'zod';

// 1. A tool is a typed function the agent can call. Input is validated with Zod.
const calculator = tool({
  name: 'calculator',
  description: 'Evaluate a math expression',
  input: z.object({ expression: z.string() }),
  handler: ({ expression }) => ({ result: new Function(`return (${expression})`)() }),
});

// 2. An agent is an LLM config: a model, a system prompt, and a set of tools.
//    Model format is `provider:model`. Swap in any model/provider you have a key for.
const mathAgent = agent({
  name: 'math',
  model: 'openai-responses:gpt-5.5',
  system: 'You are a math assistant. Use the calculator for all arithmetic.',
  tools: [calculator],
});

// 3. A workflow orchestrates agents through `ctx`.
const solve = workflow({
  name: 'solve',
  input: z.object({ question: z.string() }),
  handler: async (ctx) => ctx.ask(mathAgent, ctx.input.question),
});

// 4. Register the workflow on a runtime and run it.
const runtime = new AxlRuntime();
runtime.register(solve);

const answer = await runtime.execute('solve', { question: 'What is 42 * 17?' });
console.log(answer);

await runtime.shutdown();
