/**
 * Standalone tool definitions used by the dev fixtures.
 *
 * The `call-sub-researcher` tool lives in `agents.mts` because its
 * handler closes over the sub-researcher agent — colocating them
 * keeps the coupling visible.
 */
import { tool } from '@axlsdk/axl';
import { z } from 'zod';

export const lookupTool = tool({
  name: 'lookup',
  description: 'Look up information about a topic',
  input: z.object({ query: z.string() }),
  handler: (input) => `Found information about: ${input.query}`,
});

export const calculatorTool = tool({
  name: 'calculator',
  description: 'Perform arithmetic calculations',
  input: z.object({
    expression: z.string().describe('Math expression to evaluate'),
    precision: z.number().optional().describe('Decimal places'),
  }),
  handler: (input) => ({
    result: 42,
    expression: input.expression,
    precision: input.precision ?? 2,
  }),
});

export const searchTool = tool({
  name: 'web-search',
  description: 'Search the web for information',
  input: z.object({
    query: z.string(),
    maxResults: z.number().default(5),
    filters: z
      .object({
        dateRange: z.enum(['day', 'week', 'month', 'year', 'all']).default('all'),
        language: z.string().default('en'),
      })
      .optional(),
  }),
  handler: (input) => ({
    results: [
      {
        title: `Result 1 for: ${input.query}`,
        url: 'https://example.com/1',
        snippet: 'This is a snippet...',
      },
      {
        title: `Result 2 for: ${input.query}`,
        url: 'https://example.com/2',
        snippet: 'Another result...',
      },
    ],
    totalResults: 42,
    query: input.query,
  }),
});
