/**
 * Example Axl Studio config for smoke testing.
 *
 * Uses MockProvider so no API keys are needed.
 * Run with: node packages/axl-studio/dist/cli.js --config examples/studio/axl.config.ts
 */
import { z } from 'zod';
import { tool, agent, workflow, AxlRuntime } from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';

// ── Tools ──────────────────────────────────────────────────────────

const getWeather = tool({
  name: 'get_weather',
  description: 'Get the current weather for a city',
  input: z.object({
    city: z.string().describe('The city name'),
  }),
  handler: async ({ city }) => ({
    city,
    temperature: Math.round(60 + Math.random() * 30),
    condition: ['sunny', 'cloudy', 'rainy', 'snowy'][Math.floor(Math.random() * 4)],
    humidity: Math.round(30 + Math.random() * 50),
  }),
});

const searchKnowledge = tool({
  name: 'search_knowledge',
  description: 'Search the knowledge base for relevant information',
  input: z.object({
    query: z.string().describe('The search query'),
    limit: z.number().optional().default(3).describe('Max results to return'),
  }),
  handler: async ({ query, limit }) => ({
    query,
    results: Array.from({ length: limit }, (_, i) => ({
      id: `doc-${i + 1}`,
      title: `Result ${i + 1} for "${query}"`,
      snippet: `This is a mock search result about ${query}. It contains relevant information.`,
      score: Math.round((1 - i * 0.15) * 100) / 100,
    })),
  }),
});

// ── Agents ─────────────────────────────────────────────────────────

const weatherAgent = agent({
  name: 'weather-agent',
  model: 'mock:default',
  system:
    'You are a helpful weather assistant. Use the get_weather tool to answer questions about weather.',
  tools: [getWeather],
  maxTurns: 3,
});

const researchAgent = agent({
  name: 'research-agent',
  model: 'mock:default',
  system: 'You are a research assistant. Use the search_knowledge tool to find information.',
  tools: [searchKnowledge],
  maxTurns: 5,
});

// ── Workflows ──────────────────────────────────────────────────────

const chatWorkflow = workflow({
  name: 'chat',
  input: z.object({
    message: z.string().describe('The user message'),
  }),
  handler: async (ctx) => {
    const result = await ctx.ask(weatherAgent, ctx.input.message);
    return result;
  },
});

const researchWorkflow = workflow({
  name: 'research',
  input: z.object({
    topic: z.string().describe('The research topic'),
    depth: z
      .enum(['shallow', 'deep'])
      .optional()
      .default('shallow')
      .describe('How deep to research'),
  }),
  output: z.object({
    summary: z.string(),
    sources: z.number(),
  }),
  handler: async (ctx) => {
    const result = await ctx.ask(researchAgent, `Research this topic: ${ctx.input.topic}`);
    return { summary: String(result), sources: 3 };
  },
});

// ── Runtime ────────────────────────────────────────────────────────

const runtime = new AxlRuntime();

// Register a mock provider that echoes the last user message
const mockProvider = MockProvider.echo();
runtime.registerProvider('mock', mockProvider);

// Register workflows
runtime.register(chatWorkflow);
runtime.register(researchWorkflow);

// Register standalone tools and agents for Studio introspection
runtime.registerTool(getWeather, searchKnowledge);
runtime.registerAgent(weatherAgent, researchAgent);

export default runtime;
