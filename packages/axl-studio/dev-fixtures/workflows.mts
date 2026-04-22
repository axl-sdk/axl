/**
 * All workflow definitions for the dev fixtures.
 *
 * Naming follows the workflow's *behavior*, not the spec version that
 * introduced the demo. Anyone reading the panel sidebar should be able
 * to guess what the workflow exercises from its name alone.
 *
 * Coverage by panel/feature:
 *
 *   qa, qa-upgraded, qa-multistep, research                  baseline
 *   structured                                                JSON output
 *   rag, memory-heavy                                         embedder + memory
 *   budget-demo                                               budget enforcement
 *   unreliable, flaky, schema-retry, leaky                    failures + retries
 *   nested-asks                                               depth=1 AskTree
 *   handoff                                                   handoff event
 *   parallel                                                  sibling depth=0 asks
 *   streaming-structured                                      partial_object events
 *   ask-failure                                               ask_end({ok:false}) recovered
 *   always-fail                                               workflow_end({status:failed})
 *   verbose-demo                                              >64KB messages truncation
 */
import { agent, workflow } from '@axlsdk/axl';
import type { VectorResult } from '@axlsdk/axl';
import { z } from 'zod';
import {
  qaAgent,
  qaAgentUpgraded,
  mathAgent,
  researchAgent,
  structuredAgent,
  schemaRetryAgent,
  orchestratorAgent,
  generalistAgent,
  alwaysFailAgent,
  streamingStructuredAgent,
  verboseDemoAgent,
} from './agents.mjs';

// ── Baseline ─────────────────────────────────────────────────────────

export const qaWorkflow = workflow({
  name: 'qa-workflow',
  input: z.object({ question: z.string() }),
  handler: async (ctx) => {
    const answer = await ctx.ask(qaAgent, ctx.input.question);
    // Generate a large result to test JsonViewer truncation.
    const searchResults = Array.from({ length: 150 }, (_, i) => ({
      rank: i + 1,
      title: `Result ${i + 1}: ${ctx.input.question}`,
      url: `https://example.com/result/${i + 1}`,
      score: Math.round((1 - i / 200) * 1000) / 1000,
      snippet: `This is a relevant snippet for result ${i + 1}...`,
    }));

    return {
      answer,
      metadata: {
        model: 'mock:test',
        confidence: 0.85,
        sources: [
          { title: 'MDN Web Docs', url: 'https://developer.mozilla.org', relevance: 0.92 },
          { title: 'TypeScript Handbook', url: 'https://www.typescriptlang.org/docs', relevance: 0.78 },
          { title: 'Stack Overflow', url: 'https://stackoverflow.com', relevance: 0.65 },
        ],
        tokens: { input: 150, output: 320, reasoning: 48, total: 518 },
        processingSteps: ['query_understanding', 'retrieval', 'generation', 'validation'],
        timing: { retrievalMs: 45, generationMs: 230, validationMs: 12 },
      },
      searchResults,
    };
  },
});

export const qaWorkflowUpgraded = workflow({
  name: 'qa-workflow-upgraded',
  input: z.object({ question: z.string() }),
  handler: async (ctx) => {
    const answer = await ctx.ask(qaAgentUpgraded, ctx.input.question);
    return { answer, metadata: { model: 'mock:claude-sonnet-4-6' } };
  },
});

// Two agent calls per item (different models) — used by eval cohort seed.
export const qaWorkflowMultistep = workflow({
  name: 'qa-workflow-multistep',
  input: z.object({ question: z.string() }),
  handler: async (ctx) => {
    const classification = await ctx.ask(mathAgent, `Classify this question: ${ctx.input.question}`);
    const answer = await ctx.ask(qaAgent, ctx.input.question);
    return { classification, answer };
  },
});

export const researchWorkflow = workflow({
  name: 'research-workflow',
  input: z.object({
    topic: z.string(),
    depth: z.enum(['shallow', 'deep']).default('shallow'),
  }),
  handler: async (ctx) => {
    const result = await ctx.ask(researchAgent, `Research: ${ctx.input.topic}`);
    return {
      topic: ctx.input.topic,
      summary: result,
      findings: [
        { source: 'Academic Papers', count: 12, relevance: 'high' },
        { source: 'Technical Blogs', count: 28, relevance: 'medium' },
        { source: 'Documentation', count: 8, relevance: 'high' },
      ],
    };
  },
});

export const structuredWorkflow = workflow({
  name: 'structured-workflow',
  input: z.object({ question: z.string() }),
  handler: async (ctx) => ctx.ask(structuredAgent, ctx.input.question),
});

// ── Memory + embedder ────────────────────────────────────────────────

export const ragWorkflow = workflow({
  name: 'rag-workflow',
  input: z.object({ question: z.string() }),
  handler: async (ctx) => {
    // Semantic search — triggers an embedder call with cost attribution.
    const related = (await ctx.recall('', {
      query: ctx.input.question,
      topK: 3,
      scope: 'global',
    })) as VectorResult[] | null;

    const contextBlock =
      Array.isArray(related) && related.length > 0
        ? `\n\nRelated context:\n${related.map((r, i) => `${i + 1}. ${r.content}`).join('\n')}`
        : '';
    const answer = await ctx.ask(qaAgent, ctx.input.question + contextBlock);

    return {
      answer,
      relatedFound: Array.isArray(related) ? related.length : 0,
      related: Array.isArray(related) ? related : [],
    };
  },
});

// 3 recalls + 1 write per run; populates the "Memory (Embedder)" bucket
// in the Cost Dashboard and attributes cost to byWorkflow.
export const memoryHeavyWorkflow = workflow({
  name: 'memory-heavy-workflow',
  input: z.object({ topic: z.string() }),
  handler: async (ctx) => {
    const q1 = (await ctx.recall('', {
      query: `${ctx.input.topic} basics`,
      topK: 2,
      scope: 'global',
    })) as VectorResult[] | null;
    const q2 = (await ctx.recall('', {
      query: `${ctx.input.topic} advanced`,
      topK: 2,
      scope: 'global',
    })) as VectorResult[] | null;
    const q3 = (await ctx.recall('', {
      query: `${ctx.input.topic} best practices`,
      topK: 2,
      scope: 'global',
    })) as VectorResult[] | null;

    await ctx.remember(
      `summary:${ctx.input.topic}:${Date.now()}`,
      `Summary of ${ctx.input.topic} gathered from prior sessions.`,
      { embed: true, scope: 'global' },
    );

    const hits = [q1, q2, q3].map((r) => (Array.isArray(r) ? r.length : 0));
    return {
      topic: ctx.input.topic,
      hitsPerQuery: hits,
      totalHits: hits.reduce((a, b) => a + b, 0),
    };
  },
});

// ── Budget enforcement ──────────────────────────────────────────────

export const budgetDemoWorkflow = workflow({
  name: 'budget-demo-workflow',
  input: z.object({
    // Default tuned to MockEmbedder cost (~$6e-8/call on short queries):
    // $1e-7 budget trips on the 2nd recall.
    budget: z.string().default('$0.0000001'),
    callCount: z.number().default(20),
  }),
  handler: async (ctx) => {
    const results: Array<{ i: number; ok: boolean; error?: string }> = [];
    const budgetResult = await ctx.budget(
      { cost: ctx.input.budget, onExceed: 'finish_and_stop' },
      async () => {
        for (let i = 0; i < ctx.input.callCount; i++) {
          try {
            await ctx.recall('', {
              query: `demo query ${i}`,
              scope: 'global',
              topK: 2,
            });
            results.push({ i, ok: true });
          } catch (err) {
            results.push({
              i,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
            throw err;
          }
        }
      },
    );
    const succeeded = results.filter((r) => r.ok).length;
    const firstFailure = results.find((r) => !r.ok);
    return {
      budgetApplied: ctx.input.budget,
      callsAttempted: ctx.input.callCount,
      callsCompleted: succeeded,
      budgetExceeded: budgetResult.budgetExceeded,
      totalSpent: budgetResult.totalCost,
      trippedAt: firstFailure?.i ?? null,
      tripError: firstFailure?.error ?? null,
      perCall: results,
    };
  },
});

// ── Failures + retries ──────────────────────────────────────────────

// ~50% throws — populates non-zero failure rate in Workflow Stats.
export const unreliableWorkflow = workflow({
  name: 'unreliable-workflow',
  input: z.object({ message: z.string() }),
  handler: async (ctx) => {
    if (Math.random() < 0.5) throw new Error('Simulated intermittent failure');
    return ctx.ask(qaAgent, ctx.input.message);
  },
});

// Deterministic failure on a sentinel input — exercises the eval runner's
// failure-path traces (axlCapturedTraces side-channel).
export const flakyWorkflow = workflow({
  name: 'flaky-workflow',
  input: z.object({ question: z.string() }),
  handler: async (ctx) => {
    const answer = await ctx.ask(qaAgent, ctx.input.question);
    if (ctx.input.question.startsWith('FAIL')) {
      throw new Error(`deliberate failure for question "${ctx.input.question}"`);
    }
    return { answer };
  },
});

// First LLM attempt malformed JSON, retry parses cleanly. Captured traces
// show: agent_call → failed schema_check (with feedbackMessage) → retry
// agent_call (retryReason: 'schema') → passing schema_check. Also emits
// pipeline events in failed → committed sequence — the canonical
// AxlEvent variant exercise for the retry pipeline.
export const schemaRetryWorkflow = workflow({
  name: 'schema-retry-workflow',
  input: z.object({ question: z.string() }),
  handler: async (ctx) =>
    ctx.ask(schemaRetryAgent, ctx.input.question, {
      schema: z.object({ answer: z.string(), score: z.number().min(0).max(1) }),
      retries: 2,
    }),
});

// Validate fn always rejects with the user's question echoed in the
// reason. Under AXL_DEV_REDACT=1 the REST envelope and WS error broadcast
// should scrub `ValidationError.message` via redactErrorMessage.
export const leakyWorkflow = workflow({
  name: 'leaky-workflow',
  input: z.object({ question: z.string() }),
  handler: async (ctx) =>
    ctx.ask(structuredAgent, ctx.input.question, {
      schema: z.object({ answer: z.string() }),
      validate: (parsed) => ({
        valid: false,
        reason: `rejecting output for user question "${ctx.input.question}" (answer was "${parsed.answer}")`,
      }),
      validateRetries: 0,
    }),
});

// ── Spec/16 unified-event-model coverage ────────────────────────────

// Outer ctx.ask → orchestrator agent → calls call-sub-researcher tool →
// tool handler does ctx.ask on subResearcherAgent → depth=1 events with
// parentAskId set. Subagents drawer in Playground auto-opens on the
// first depth>=1 event.
export const nestedAsksWorkflow = workflow({
  name: 'nested-asks-workflow',
  input: z.object({ topic: z.string() }),
  handler: async (ctx) =>
    ctx.ask(orchestratorAgent, `Investigate and report on: ${ctx.input.topic}`),
});

// Generalist routes to specialist via oneway handoff. `handoff` event
// carries fromAskId/toAskId — AskTree should render the edge.
export const handoffWorkflow = workflow({
  name: 'handoff-workflow',
  input: z.object({ query: z.string() }),
  handler: async (ctx) =>
    ctx.ask(
      generalistAgent,
      `A complex query that needs a specialist: ${ctx.input.query}`,
    ),
});

// Concurrent root-level asks via ctx.parallel. Each branch's askId is
// unique; all live at depth=0 (siblings, not nested).
export const parallelWorkflow = workflow({
  name: 'parallel-workflow',
  input: z.object({ topics: z.array(z.string()).min(2).max(4) }),
  handler: async (ctx) => {
    const branchAgents = ctx.input.topics.map((_, i) =>
      agent({
        name: `branch-${i}-agent`,
        model: 'mock-tagged:gpt-4o',
        system: `[#parallel-branch-${i}] Analyst for branch ${i}.`,
      }),
    );
    const results = await ctx.parallel(
      ctx.input.topics.map((topic, i) => () => ctx.ask(branchAgents[i], topic)),
    );
    return { branches: results };
  },
});

// Schema + chunked tokens → partial_object events emit at structural
// JSON boundaries. Streamed via runtime.stream() to observe them
// (partial_object is not persisted to ExecutionInfo.events).
export const streamingStructuredWorkflow = workflow({
  name: 'streaming-structured-workflow',
  input: z.object({ subject: z.string() }),
  handler: async (ctx) =>
    ctx.ask(streamingStructuredAgent, `Produce a structured report on: ${ctx.input.subject}`, {
      schema: z.object({
        title: z.string(),
        summary: z.string(),
        bulletPoints: z.array(z.string()),
        confidence: z.number().min(0).max(1),
      }),
    }),
});

// Caught failure: workflow returns a fallback so workflow_end is
// `completed`, but the inner ask emits ask_end({outcome.ok: false}).
export const askFailureWorkflow = workflow({
  name: 'ask-failure-workflow',
  input: z.object({ question: z.string() }),
  handler: async (ctx) => {
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

// Uncaught failure: agent runs (real ask in trace), then the workflow
// throws. Verifies the panel's `failed` status badge + red error banner.
// Deterministic counterpart to unreliableWorkflow.
export const alwaysFailWorkflow = workflow({
  name: 'always-fail-workflow',
  input: z.object({ message: z.string() }),
  handler: async (ctx) => {
    await ctx.ask(qaAgent, ctx.input.message);
    throw new Error('always-fail-workflow: deterministic uncaught failure');
  },
});

// 80KB prompt → with AXL_DEV_VERBOSE=1 (trace.level: 'full'), the
// captured agent_call_end.data.messages snapshot exceeds the 64KB WS
// soft cap and gets replaced by the truncation placeholder in the
// Trace Explorer.
export const verboseDemoWorkflow = workflow({
  name: 'verbose-demo-workflow',
  input: z.object({ size: z.number().default(80_000) }),
  handler: async (ctx) => {
    const huge = 'x'.repeat(Math.max(1, ctx.input.size));
    return ctx.ask(verboseDemoAgent, `Process this large payload: ${huge}`);
  },
});

// Single list for `runtime.register(...)`.
export const allWorkflows = [
  qaWorkflow,
  qaWorkflowUpgraded,
  qaWorkflowMultistep,
  researchWorkflow,
  structuredWorkflow,
  ragWorkflow,
  memoryHeavyWorkflow,
  budgetDemoWorkflow,
  unreliableWorkflow,
  flakyWorkflow,
  schemaRetryWorkflow,
  leakyWorkflow,
  nestedAsksWorkflow,
  handoffWorkflow,
  parallelWorkflow,
  streamingStructuredWorkflow,
  askFailureWorkflow,
  alwaysFailWorkflow,
  verboseDemoWorkflow,
];
