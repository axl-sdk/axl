/**
 * Agent and coupled-tool definitions.
 *
 * Agents that route through `mock-tagged` lead with a `[#tag]` token in
 * their system prompt — that's how the routed mock dispatcher picks the
 * per-scenario response. Pattern-matching the prose was fragile (an
 * orchestrator's prompt mentioning the sub-researcher's tool name made
 * the dispatcher route the orchestrator's call into the sub-researcher
 * branch).
 *
 * The `callSubResearcherTool` lives here, not in `tools.mts`, because
 * its handler closes over `subResearcherAgent`. Colocating them keeps
 * the cycle visible.
 */
import { agent, tool } from '@axlsdk/axl';
import { z } from 'zod';
import { lookupTool, calculatorTool, searchTool } from './tools.mjs';

// ── Base agents (use the `mock` echo provider) ───────────────────────

export const qaAgent = agent({
  name: 'qa-agent',
  model: 'mock:gpt-4o',
  system: 'You are a helpful QA assistant. Answer questions accurately and concisely.',
  tools: [lookupTool],
});

export const qaAgentUpgraded = agent({
  name: 'qa-agent-upgraded',
  model: 'mock:claude-sonnet-4-6',
  system: 'You are a helpful QA assistant. Answer questions accurately and concisely.',
  tools: [lookupTool],
});

export const researchAgent = agent({
  name: 'research-agent',
  model: 'mock:gpt-4o',
  system:
    'You are a research assistant. Find and synthesize information from multiple sources.',
  tools: [searchTool, lookupTool],
});

export const mathAgent = agent({
  name: 'math-agent',
  model: 'mock:gpt-4o-mini',
  system: 'You are a math tutor. Solve problems step by step.',
  tools: [calculatorTool],
});

export const structuredAgent = agent({
  name: 'structured-agent',
  model: 'mock-json:gpt-4o',
  system:
    'You return structured JSON responses with answer, confidence, sources, and related topics.',
});

export const schemaRetryAgent = agent({
  name: 'schema-retry-agent',
  model: 'mock-schema-retry:gpt-4o',
  system: 'Return structured JSON with `answer` (string) and `score` (0-1 number).',
});

// ── Tagged agents (use the `mock-tagged` routed dispatcher) ──────────
//
// Each leads with `[#tag]` so the provider's switch picks the right
// branch without ambiguity.

export const subResearcherAgent = agent({
  name: 'sub-researcher-agent',
  model: 'mock-tagged:gpt-4o-mini',
  system:
    '[#sub-researcher] You are a focused finding sub-researcher. Provide one tight observation per call.',
});

// Tool whose handler calls ctx.ask() on the sub-researcher — the
// agent-as-tool pattern that emits depth=1 AskScoped events with
// parentAskId stamped from the outer (orchestrator) ask.
export const callSubResearcherTool = tool({
  name: 'call-sub-researcher',
  description: 'Delegate a sub-question to a focused researcher subagent',
  input: z.object({ subQuestion: z.string() }),
  handler: async (input, ctx) => {
    const finding = await ctx.ask(subResearcherAgent, input.subQuestion);
    return { finding };
  },
});

export const orchestratorAgent = agent({
  name: 'orchestrator-agent',
  model: 'mock-tagged:gpt-4o',
  system:
    '[#orchestrator] You delegate complex questions by calling the call-sub-researcher tool, then synthesize the sub-finding into a final answer.',
  tools: [callSubResearcherTool],
  maxTurns: 3,
});

export const alwaysFailAgent = agent({
  name: 'always-fail-agent',
  model: 'mock-tagged:gpt-4o',
  system:
    '[#always-fail] Always returns invalid output so the schema gate exhausts retries.',
  maxTurns: 2,
});

export const streamingStructuredAgent = agent({
  name: 'streaming-structured-agent',
  model: 'mock-tagged:gpt-4o',
  system:
    '[#chunked-structured] Emits JSON in tiny chunks for the partial_object demo.',
  maxTurns: 2,
});

export const specialistAgent = agent({
  name: 'specialist-agent',
  model: 'mock-tagged:gpt-4o',
  system: '[#specialist] Handoff-target specialist. Answer in detail.',
  maxTurns: 2,
});

export const generalistAgent = agent({
  name: 'generalist-agent',
  model: 'mock-tagged:gpt-4o',
  system:
    '[#generalist] Hands off complex queries to the specialist via the auto-generated handoff tool.',
  handoffs: [{ agent: specialistAgent, mode: 'oneway' }],
  maxTurns: 3,
});

export const verboseDemoAgent = agent({
  name: 'verbose-demo-agent',
  model: 'mock-tagged:gpt-4o',
  system: '[#verbose-demo] Acknowledge large payloads tersely.',
  maxTurns: 1,
});

// Single list for `runtime.registerAgent(...)`.
export const allAgents = [
  qaAgent,
  qaAgentUpgraded,
  researchAgent,
  mathAgent,
  structuredAgent,
  schemaRetryAgent,
  orchestratorAgent,
  subResearcherAgent,
  generalistAgent,
  specialistAgent,
  alwaysFailAgent,
  streamingStructuredAgent,
  verboseDemoAgent,
];
