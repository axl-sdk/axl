/**
 * Axl Studio dev config — exercises every new event type and feature
 * introduced by the unified event model (spec/16, 0.16.0).
 *
 * Workflows map 1:1 to the event shapes that need UI verification:
 *
 *   chat                  — baseline ctx.ask (single ask_start/ask_end pair)
 *   weather-lookup        — tool calls (tool_call_start/end, chunked tokens)
 *   research-with-subagent — nested ask via agent-as-tool (depth=1 correlation)
 *   structured-report     — schema-constrained output (partial_object + pipeline)
 *   retry-self-correct    — invalid-then-valid JSON (pipeline(failed) + (committed))
 *   handoff-demo          — one-way handoff (handoff event + target askId)
 *   parallel-research     — ctx.parallel (concurrent root-level asks, same depth)
 *   memory-chat           — memory_remember / memory_recall typed events
 *   ask-failure-demo      — terminal schema exhaustion → ask_end(ok:false)
 *
 * Run from repo root:
 *   pnpm dev:studio                 # uses this config via auto-detect (cwd=axl-studio)
 *   # or
 *   pnpm --filter @axlsdk/studio dev
 */
import { z } from 'zod';
import { tool, agent, workflow, AxlRuntime } from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';

// ── Tools ────────────────────────────────────────────────────────────

const getWeather = tool({
  name: 'get_weather',
  description: 'Get the current weather for a city',
  input: z.object({
    city: z.string().describe('The city name'),
  }),
  handler: async ({ city }) => {
    await new Promise((r) => setTimeout(r, 50));
    return {
      city,
      temperature: 68 + Math.floor(Math.random() * 20),
      condition: ['sunny', 'cloudy', 'rainy', 'windy'][Math.floor(Math.random() * 4)],
      humidity: 40 + Math.floor(Math.random() * 40),
    };
  },
});

const searchKnowledge = tool({
  name: 'search_knowledge',
  description: 'Search the knowledge base for relevant information',
  input: z.object({
    query: z.string().describe('The search query'),
    limit: z.number().optional().default(3).describe('Max results'),
  }),
  handler: async ({ query, limit }) => {
    await new Promise((r) => setTimeout(r, 80));
    return {
      query,
      results: Array.from({ length: limit }, (_, i) => ({
        id: `doc-${i + 1}`,
        title: `Result ${i + 1} for "${query}"`,
        snippet: `Mock result about ${query}; ranked #${i + 1}.`,
        score: Math.round((1 - i * 0.15) * 100) / 100,
      })),
    };
  },
});

// ── Mock provider — content-aware responses ──────────────────────────
//
// `MockProvider.fn` lets us return different shapes based on what the
// agent is asking. Far richer than `MockProvider.echo()` — it lets the
// same provider serve every workflow in this file by dispatching on
// the agent's system prompt and the last user message.

const mockProvider = MockProvider.fn((messages) => {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';
  const systemMsg = messages.find((m) => m.role === 'system');
  const systemText = typeof systemMsg?.content === 'string' ? systemMsg.content : '';

  const hasToolResult = messages.some((m) => m.role === 'tool');
  const weatherMention = /weather/i.test(systemText);
  const searchMention = /research|search|knowledge/i.test(systemText);
  // Handoff source must match BEFORE the specialist clause — the
  // generalist's system prompt contains the word "specialist".
  const isGeneralist = /generalist|hands off/i.test(systemText);
  const isSpecialist = !isGeneralist && /specialist|follow-up|handoff-target/i.test(systemText);
  // Count prior assistant turns to detect retry cycles. `callIndex` on
  // the provider is global across all executions that share this mock;
  // conversation-based detection is execution-scoped and correct.
  const assistantTurns = messages.filter((m) => m.role === 'assistant').length;

  // retry-self-correct: first attempt invalid JSON, retry attempt valid.
  // Exercises pipeline(start → failed → start → committed) + fullText
  // commit-on-success discard-on-retry behavior.
  if (/self-correct|retry/i.test(systemText)) {
    if (assistantTurns === 0) {
      return {
        content: '{not valid json}',
        chunks: ['{not ', 'valid ', 'json}'],
        cost: 0.001,
      };
    }
    return {
      content: '{"summary":"Retry succeeded","confidence":0.88}',
      chunks: ['{"sum', 'mary":"Ret', 'ry succ', 'eeded","co', 'nfidence":0.88}'],
      cost: 0.002,
    };
  }

  // ask-failure-demo: always invalid so schema exhausts → ask_end(ok:false).
  if (/always-fail/i.test(systemText)) {
    return {
      content: 'not-json-at-all',
      chunks: ['not-json', '-at-all'],
      cost: 0.001,
    };
  }

  // Weather agent: turn 1 calls get_weather, turn 2 summarizes.
  if (weatherMention && !hasToolResult) {
    const cityMatch = userText.match(/(?:in|for|about)\s+([A-Za-z ]+?)(?:\?|$|\.)/i);
    const city = cityMatch?.[1]?.trim() ?? 'San Francisco';
    return {
      content: '',
      tool_calls: [
        {
          id: `tc-${assistantTurns}`,
          type: 'function' as const,
          function: { name: 'get_weather', arguments: JSON.stringify({ city }) },
        },
      ],
      cost: 0.003,
    };
  }
  if (weatherMention && hasToolResult) {
    const toolMsg = [...messages].reverse().find((m) => m.role === 'tool');
    let temp = 72;
    let condition = 'sunny';
    let city = 'the city';
    try {
      const data = JSON.parse(typeof toolMsg?.content === 'string' ? toolMsg.content : '{}');
      temp = data.temperature ?? temp;
      condition = data.condition ?? condition;
      city = data.city ?? city;
    } catch {
      // fall through
    }
    const content = `Currently in ${city}: ${temp}°F and ${condition}. A nice day for a walk!`;
    return {
      content,
      chunks: content.match(/.{1,6}/g) ?? [content],
      cost: 0.004,
    };
  }

  // Research subagent: calls search_knowledge, then summarizes.
  if (searchMention && !hasToolResult) {
    return {
      content: '',
      tool_calls: [
        {
          id: `tc-${assistantTurns}`,
          type: 'function' as const,
          function: {
            name: 'search_knowledge',
            arguments: JSON.stringify({ query: userText.slice(0, 80), limit: 3 }),
          },
        },
      ],
      cost: 0.002,
    };
  }
  if (searchMention && hasToolResult) {
    const content = `Based on 3 sources, ${userText.slice(0, 60)} is well-documented. Key points: architecture, trade-offs, use cases.`;
    return {
      content,
      chunks: content.match(/.{1,8}/g) ?? [content],
      cost: 0.003,
    };
  }

  // structured-report: JSON output, chunked to exercise partial_object.
  if (/structured|report|json output/i.test(systemText)) {
    const content = JSON.stringify(
      {
        title: 'Market Analysis',
        summary:
          'The market shows resilience despite short-term volatility. Three drivers stand out.',
        bulletPoints: ['Strong fundamentals', 'Sector rotation underway', 'Policy tailwind'],
        confidence: 0.82,
      },
      null,
      2,
    );
    const chunks = content.match(/.{1,4}/g) ?? [content];
    return { content, chunks, cost: 0.005 };
  }

  // handoff source (generalist) — emit a handoff tool call on turn 1.
  // Must come BEFORE the specialist clause because the generalist's
  // prompt says "hands off ... to a specialist" which would otherwise
  // match the specialist pattern.
  if (isGeneralist && !hasToolResult) {
    return {
      content: '',
      tool_calls: [
        {
          id: `tc-handoff-${assistantTurns}`,
          type: 'function' as const,
          function: {
            name: 'handoff_to_specialist-agent',
            arguments: JSON.stringify({}),
          },
        },
      ],
      cost: 0.001,
    };
  }

  // handoff target (specialist) — echoes a "specialist" response.
  if (isSpecialist) {
    const content = `Specialist response: ${userText.slice(0, 60)}. Here is the detailed answer you asked for.`;
    return { content, chunks: content.match(/.{1,5}/g) ?? [content], cost: 0.002 };
  }

  // parallel-research branches: distinct answer per branch.
  if (/parallel-branch/i.test(systemText)) {
    const branchMatch = systemText.match(/parallel-branch-(\d+)/);
    const branch = branchMatch ? branchMatch[1] : '?';
    const content = `Branch ${branch}: finished analyzing ${userText.slice(0, 40)}.`;
    return { content, chunks: content.match(/.{1,6}/g) ?? [content], cost: 0.001 };
  }

  // Default chat: friendly echo.
  const content = `Thanks for your message. You said: "${userText.slice(0, 80)}"`;
  return {
    content,
    chunks: content.match(/.{1,5}/g) ?? [content],
    cost: 0.001,
  };
});

// ── Agents ───────────────────────────────────────────────────────────

const chatAgent = agent({
  name: 'chat-agent',
  model: 'mock:default',
  system: 'You are a helpful, concise assistant.',
  maxTurns: 2,
});

const weatherAgent = agent({
  name: 'weather-agent',
  model: 'mock:default',
  system: 'You are a weather assistant. Use get_weather to answer weather questions.',
  tools: [getWeather],
  maxTurns: 3,
});

const researchAgent = agent({
  name: 'research-agent',
  model: 'mock:default',
  system: 'You are a research assistant. Use search_knowledge to answer queries.',
  tools: [searchKnowledge],
  maxTurns: 3,
});

const structuredAgent = agent({
  name: 'structured-agent',
  model: 'mock:default',
  system: 'You produce structured JSON reports. Always output valid JSON matching the schema.',
  maxTurns: 2,
});

const selfCorrectAgent = agent({
  name: 'self-correct-agent',
  model: 'mock:default',
  system: 'You demonstrate self-correction: first attempt invalid, retry produces valid.',
  maxTurns: 3,
});

const alwaysFailAgent = agent({
  name: 'always-fail-agent',
  model: 'mock:default',
  system: 'You always produce invalid output to demonstrate always-fail terminal schema errors.',
  maxTurns: 2,
});

const specialistAgent = agent({
  name: 'specialist-agent',
  model: 'mock:default',
  system: 'You are a handoff-target specialist.',
  maxTurns: 2,
});

const generalistAgent = agent({
  name: 'generalist-agent',
  model: 'mock:default',
  system: 'You are a generalist who hands off complex queries to a specialist.',
  handoffs: [{ agent: specialistAgent, mode: 'oneway' }],
  maxTurns: 3,
});

// ── Workflows ────────────────────────────────────────────────────────

const chat = workflow({
  name: 'chat',
  input: z.object({ message: z.string() }),
  handler: async (ctx) => ctx.ask(chatAgent, ctx.input.message),
});

const weatherLookup = workflow({
  name: 'weather-lookup',
  input: z.object({ city: z.string() }),
  handler: async (ctx) => ctx.ask(weatherAgent, `What's the weather in ${ctx.input.city}?`),
});

const researchWithSubagent = workflow({
  name: 'research-with-subagent',
  input: z.object({ topic: z.string() }),
  output: z.object({ finding: z.string(), subagent: z.string() }),
  handler: async (ctx) => {
    // Nested ask — emits events at depth=1 with parentAskId pointing at
    // the outer ask (there is no outer ask here, so depth stays 0 for
    // the research-agent call; nested asks happen when a tool handler
    // itself calls ctx.ask — see weather-in-tool below if added).
    const subFinding = await ctx.ask(researchAgent, `Research and summarize: ${ctx.input.topic}`);
    return {
      finding: String(subFinding),
      subagent: 'research-agent',
    };
  },
});

const structuredReport = workflow({
  name: 'structured-report',
  input: z.object({ subject: z.string() }),
  handler: async (ctx) => {
    // Schema + no tools = partial_object events emit on structural
    // boundaries as tokens arrive. Exercises the spec/16 progressive-
    // render pipeline end-to-end.
    return ctx.ask(structuredAgent, `Produce a structured report on: ${ctx.input.subject}`, {
      schema: z.object({
        title: z.string(),
        summary: z.string(),
        bulletPoints: z.array(z.string()),
        confidence: z.number().min(0).max(1),
      }),
    });
  },
});

const retrySelfCorrect = workflow({
  name: 'retry-self-correct',
  input: z.object({ question: z.string() }),
  handler: async (ctx) => {
    // retries=1 allows one retry on schema fail. First attempt returns
    // invalid JSON → pipeline(failed) → retry → pipeline(committed).
    // `stream.fullText` only reflects the committed (second) attempt.
    return ctx.ask(selfCorrectAgent, ctx.input.question, {
      schema: z.object({ summary: z.string(), confidence: z.number() }),
      retries: 1,
    });
  },
});

const askFailureDemo = workflow({
  name: 'ask-failure-demo',
  input: z.object({ question: z.string() }),
  handler: async (ctx) => {
    // Always-invalid JSON exhausts retries → throws VerifyError. Outer
    // try/catch lets the workflow return a fallback so `workflow_end`
    // is `completed`, but the ask_end event for the inner ask has
    // `outcome.ok: false` (spec §9).
    try {
      return await ctx.ask(alwaysFailAgent, ctx.input.question, {
        schema: z.object({ answer: z.string() }),
        retries: 1,
      });
    } catch (err) {
      return { fallback: true, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

const handoffDemo = workflow({
  name: 'handoff-demo',
  input: z.object({ query: z.string() }),
  handler: async (ctx) => {
    // Generalist routes to specialist via oneway handoff. `handoff`
    // event carries fromAskId/toAskId — AskTree should render the edge.
    return ctx.ask(generalistAgent, `A complex query that needs a specialist: ${ctx.input.query}`);
  },
});

const parallelResearch = workflow({
  name: 'parallel-research',
  input: z.object({ topics: z.array(z.string()).min(2).max(4) }),
  handler: async (ctx) => {
    // ctx.parallel runs branches concurrently via Promise.all on the
    // callbacks. Each branch's askId is unique, all at depth=0 (siblings
    // in the ask tree, not nested).
    const branchAgents = ctx.input.topics.map((_, i) =>
      agent({
        name: `branch-${i}-agent`,
        model: 'mock:default',
        system: `parallel-branch-${i}: analyst`,
      }),
    );
    const results = await ctx.parallel(
      ctx.input.topics.map((topic, i) => () => ctx.ask(branchAgents[i], topic)),
    );
    return { branches: results };
  },
});

const memoryChat = workflow({
  name: 'memory-chat',
  input: z.object({ sessionId: z.string(), message: z.string() }),
  handler: async (ctx) => {
    // Exercises memory_remember / memory_recall typed events. Key-only
    // path (no embedder) — no embedder cost, just audit events with
    // `hit`/`scope` fields.
    // `scope: 'global'` avoids the session-scoped sessionId requirement;
    // in a real app you'd pass `metadata: { sessionId }` when calling
    // `runtime.execute(...)` and use `scope: 'session'`.
    const profile = await ctx.recall('user-profile', { scope: 'global' });
    if (!profile) {
      await ctx.remember(
        'user-profile',
        { name: 'Alex', preferences: ['concise', 'technical'] },
        { scope: 'global' },
      );
    }
    return ctx.ask(
      chatAgent,
      `Given user ${JSON.stringify(profile ?? { name: 'new user' })}: ${ctx.input.message}`,
    );
  },
});

// ── Runtime ──────────────────────────────────────────────────────────

const runtime = new AxlRuntime({
  // Flip to 'full' to see verbose agent_call.data.messages snapshots in
  // the Trace Explorer.
  // trace: { level: 'full' },
  // `memory-chat` uses key-only ctx.recall / ctx.remember — these
  // require a MemoryManager to be constructed even on the key path.
  // An empty `memory: {}` creates a MemoryManager with no vector
  // store and no embedder, which is fine for key operations
  // (delegated to the StateStore).
  memory: {},
});

runtime.registerProvider('mock', mockProvider);

runtime.register(chat);
runtime.register(weatherLookup);
runtime.register(researchWithSubagent);
runtime.register(structuredReport);
runtime.register(retrySelfCorrect);
runtime.register(askFailureDemo);
runtime.register(handoffDemo);
runtime.register(parallelResearch);
runtime.register(memoryChat);

// Studio introspection — shows tools + agents in their respective panels.
runtime.registerTool(getWeather, searchKnowledge);
runtime.registerAgent(
  chatAgent,
  weatherAgent,
  researchAgent,
  structuredAgent,
  selfCorrectAgent,
  alwaysFailAgent,
  generalistAgent,
  specialistAgent,
);

export default runtime;
