import { describe, it, expect, beforeEach } from 'vitest';
import { CostAggregator } from '../server/cost-aggregator.js';
import { ConnectionManager } from '../server/ws/connection-manager.js';

describe('CostAggregator', () => {
  let connMgr: ConnectionManager;
  let aggregator: CostAggregator;

  beforeEach(() => {
    connMgr = new ConnectionManager();
    aggregator = new CostAggregator(connMgr);
  });

  it('onTrace with cost accumulates totals', () => {
    aggregator.onTrace({
      type: 'agent_call_end',
      agent: 'test-agent',
      model: 'gpt-4',
      workflow: 'test-wf',
      cost: 0.05,
      tokens: { input: 100, output: 50, reasoning: 10 },
    });
    aggregator.onTrace({
      type: 'agent_call_end',
      agent: 'test-agent',
      model: 'gpt-4',
      cost: 0.03,
      tokens: { input: 80, output: 40 },
    });

    const data = aggregator.getData();
    expect(data.totalCost).toBeCloseTo(0.08);
    expect(data.totalTokens.input).toBe(180);
    expect(data.totalTokens.output).toBe(90);
    expect(data.totalTokens.reasoning).toBe(10);
  });

  it('getData returns breakdown by agent, model, and workflow', () => {
    aggregator.onTrace({
      type: 'agent_call_end',
      agent: 'agent-a',
      model: 'model-x',
      workflow: 'wf-1',
      cost: 0.01,
      tokens: { input: 10, output: 5 },
    });
    aggregator.onTrace({
      type: 'agent_call_end',
      agent: 'agent-b',
      model: 'model-y',
      workflow: 'wf-2',
      cost: 0.02,
      tokens: { input: 20, output: 10 },
    });

    const data = aggregator.getData();
    expect(data.byAgent['agent-a']).toEqual({ cost: 0.01, calls: 1 });
    expect(data.byAgent['agent-b']).toEqual({ cost: 0.02, calls: 1 });
    expect(data.byModel['model-x'].cost).toBe(0.01);
    expect(data.byModel['model-y'].cost).toBe(0.02);
    expect(data.byWorkflow['wf-1']).toBeDefined();
    expect(data.byWorkflow['wf-2']).toBeDefined();
  });

  it('increments byWorkflow.executions on workflow_start events (no cost/tokens)', () => {
    // Regression: workflow_start events have neither cost nor tokens, so
    // the onTrace early-return previously short-circuited them and the
    // per-workflow executions counter stayed at 0 in production. The
    // test fixtures masked this by passing explicit `workflow:` on
    // agent_call events, but `entry.executions` was never incremented.
    aggregator.onTrace({ type: 'workflow_start', workflow: 'wf-exec' });
    aggregator.onTrace({ type: 'workflow_start', workflow: 'wf-exec' });
    aggregator.onTrace({ type: 'workflow_start', workflow: 'wf-exec' });
    // Cost-bearing events between executions still aggregate correctly.
    aggregator.onTrace({
      type: 'agent_call_end',
      agent: 'a',
      model: 'm',
      workflow: 'wf-exec',
      cost: 0.05,
      tokens: { input: 10, output: 5 },
    });

    const data = aggregator.getData();
    expect(data.byWorkflow['wf-exec']).toEqual({ cost: 0.05, executions: 3 });
  });

  it('reset zeroes all counters', () => {
    aggregator.onTrace({
      type: 'agent_call_end',
      agent: 'test',
      cost: 0.1,
      tokens: { input: 50, output: 25 },
    });

    aggregator.reset();
    const data = aggregator.getData();
    expect(data.totalCost).toBe(0);
    expect(data.totalTokens.input).toBe(0);
    expect(data.totalTokens.output).toBe(0);
    expect(data.totalTokens.reasoning).toBe(0);
    expect(Object.keys(data.byAgent)).toHaveLength(0);
    expect(Object.keys(data.byModel)).toHaveLength(0);
    expect(Object.keys(data.byWorkflow)).toHaveLength(0);
    expect(Object.keys(data.byEmbedder)).toHaveLength(0);
  });

  it('processes events with cost: 0 and does not skip them', () => {
    aggregator.onTrace({
      type: 'agent_call_end',
      agent: 'test',
      cost: 0,
      tokens: { input: 10, output: 5 },
    });

    const data = aggregator.getData();
    expect(data.totalCost).toBe(0);
    expect(data.totalTokens.input).toBe(10);
    expect(data.totalTokens.output).toBe(5);
    expect(data.byAgent['test']).toBeDefined();
    expect(data.byAgent['test'].calls).toBe(1);
    expect(data.byAgent['test'].cost).toBe(0);
  });

  describe('retry cost decomposition', () => {
    it('buckets primary vs retry-triggered agent_call cost by retryReason', () => {
      // Turn 1: primary call
      aggregator.onTrace({
        type: 'agent_call_end',
        agent: 'a',
        cost: 0.05,
        data: {},
      });
      // Turn 2: schema retry
      aggregator.onTrace({
        type: 'agent_call_end',
        agent: 'a',
        cost: 0.05,
        data: { retryReason: 'schema' },
      });
      // Turn 3: validate retry
      aggregator.onTrace({
        type: 'agent_call_end',
        agent: 'a',
        cost: 0.05,
        data: { retryReason: 'validate' },
      });
      // Turn 4: guardrail retry
      aggregator.onTrace({
        type: 'agent_call_end',
        agent: 'a',
        cost: 0.05,
        data: { retryReason: 'guardrail' },
      });

      const data = aggregator.getData();
      expect(data.retry.primary).toBeCloseTo(0.05);
      expect(data.retry.schema).toBeCloseTo(0.05);
      expect(data.retry.validate).toBeCloseTo(0.05);
      expect(data.retry.guardrail).toBeCloseTo(0.05);
      expect(data.retry.retryCalls).toBe(3);
      // Primary + retries should sum to total
      const retrySum =
        data.retry.primary + data.retry.schema + data.retry.validate + data.retry.guardrail;
      expect(retrySum).toBeCloseTo(data.totalCost);
    });

    it('retry bucket is untouched by non-agent_call events', () => {
      aggregator.onTrace({
        type: 'tool_call_end',
        agent: 'a',
        cost: 0.03,
      });
      aggregator.onTrace({
        type: 'workflow_end',
        workflow: 'w',
        cost: 0,
      });

      const data = aggregator.getData();
      expect(data.retry.primary).toBe(0);
      expect(data.retry.schema).toBe(0);
      expect(data.retry.retryCalls).toBe(0);
    });

    it('reset clears the retry bucket', () => {
      aggregator.onTrace({
        type: 'agent_call_end',
        agent: 'a',
        cost: 0.1,
        data: { retryReason: 'schema' },
      });
      aggregator.reset();
      const data = aggregator.getData();
      expect(data.retry).toEqual({
        primary: 0,
        primaryCalls: 0,
        schema: 0,
        schemaCalls: 0,
        validate: 0,
        validateCalls: 0,
        guardrail: 0,
        guardrailCalls: 0,
        retryCalls: 0,
      });
    });

    it('tracks per-reason call counts alongside cost', () => {
      // 2 primary calls
      aggregator.onTrace({ type: 'agent_call_end', agent: 'a', cost: 0.01, data: {} });
      aggregator.onTrace({ type: 'agent_call_end', agent: 'a', cost: 0.02, data: {} });
      // 3 schema retries
      aggregator.onTrace({
        type: 'agent_call_end',
        agent: 'a',
        cost: 0.01,
        data: { retryReason: 'schema' },
      });
      aggregator.onTrace({
        type: 'agent_call_end',
        agent: 'a',
        cost: 0.01,
        data: { retryReason: 'schema' },
      });
      aggregator.onTrace({
        type: 'agent_call_end',
        agent: 'a',
        cost: 0.01,
        data: { retryReason: 'schema' },
      });
      // 1 validate retry
      aggregator.onTrace({
        type: 'agent_call_end',
        agent: 'a',
        cost: 0.02,
        data: { retryReason: 'validate' },
      });
      // 1 guardrail retry
      aggregator.onTrace({
        type: 'agent_call_end',
        agent: 'a',
        cost: 0.02,
        data: { retryReason: 'guardrail' },
      });

      const data = aggregator.getData();
      expect(data.retry.primaryCalls).toBe(2);
      expect(data.retry.schemaCalls).toBe(3);
      expect(data.retry.validateCalls).toBe(1);
      expect(data.retry.guardrailCalls).toBe(1);
      expect(data.retry.retryCalls).toBe(5); // schema+validate+guardrail
    });
  });

  describe('embedder cost bucketing', () => {
    it('buckets memory_remember/memory_recall cost by embedder model', () => {
      aggregator.onTrace({
        type: 'memory_remember',
        cost: 0.000005,
        tokens: { input: 10 },
        data: {
          key: 'pet',
          scope: 'session',
          usage: { cost: 0.000005, tokens: 10, model: 'text-embedding-3-small' },
        },
      });
      aggregator.onTrace({
        type: 'memory_recall',
        cost: 0.000003,
        tokens: { input: 6 },
        data: {
          key: 'pet',
          scope: 'session',
          usage: { cost: 0.000003, tokens: 6, model: 'text-embedding-3-small' },
        },
      });
      aggregator.onTrace({
        type: 'memory_remember',
        cost: 0.0001,
        tokens: { input: 100 },
        data: {
          key: 'doc',
          scope: 'session',
          usage: { cost: 0.0001, tokens: 100, model: 'text-embedding-3-large' },
        },
      });

      const data = aggregator.getData();
      // Small model: 2 calls, sum of costs + tokens
      expect(data.byEmbedder['text-embedding-3-small']).toEqual({
        cost: 0.000005 + 0.000003,
        calls: 2,
        tokens: 16,
      });
      // Large model: 1 call
      expect(data.byEmbedder['text-embedding-3-large']).toEqual({
        cost: 0.0001,
        calls: 1,
        tokens: 100,
      });
      // Total cost still includes embedder cost (rides the same rail)
      expect(data.totalCost).toBeCloseTo(0.000108, 9);
      // Embedder tokens must NOT be counted in totalTokens — those are
      // scoped to agent prompt/completion/reasoning by design.
      expect(data.totalTokens.input).toBe(0);
      // Retry buckets must not be touched by log events
      expect(data.retry.primary).toBe(0);
      expect(data.retry.retryCalls).toBe(0);
    });

    it('buckets calls that report tokens but no cost (unknown pricing)', () => {
      // Local embedders, Azure proxies, and any model not in the OpenAI
      // pricing table report tokens but no cost. Previously the aggregator's
      // early-return gate (`cost == null && !tokens`) would silently drop
      // these events — a data loss bug for anyone using a non-OpenAI
      // embedder. Context.ts now mirrors `usage.tokens` to top-level
      // `event.tokens.input` so the gate allows the event through.
      aggregator.onTrace({
        type: 'memory_remember',
        // NB: no top-level cost
        tokens: { input: 50 },
        data: {
          key: 'pet',
          scope: 'session',
          // no cost in usage either — local embedder
          usage: { tokens: 50, model: 'local-embedder' },
        },
      });

      const data = aggregator.getData();
      expect(data.byEmbedder['local-embedder']).toEqual({
        cost: 0,
        calls: 1,
        tokens: 50,
      });
      // CRITICAL: memory tokens must NOT conflate with agent prompt tokens
      // in the totalTokens summary — that's a separate semantic.
      expect(data.totalTokens.input).toBe(0);
      expect(data.totalCost).toBe(0);
    });

    it('uses "unknown" key when embedder does not report a model', () => {
      aggregator.onTrace({
        type: 'memory_remember',
        cost: 0.000002,
        data: {
          key: 'x',
          scope: 'session',
          // no usage.model field
          usage: { cost: 0.000002, tokens: 4 },
        },
      });

      const data = aggregator.getData();
      expect(data.byEmbedder['unknown']).toEqual({
        cost: 0.000002,
        calls: 1,
        tokens: 4,
      });
    });

    it('ignores non-memory events (no byEmbedder bucket touched)', () => {
      // `log` events don't carry memory shape anymore — they're free-form
      // `ctx.log()` calls. A `log` with a top-level cost should still land
      // in totalCost but must NOT touch `byEmbedder`.
      aggregator.onTrace({
        type: 'log',
        cost: 0.01,
        data: { event: 'workflow_start' },
      });
      aggregator.onTrace({
        type: 'log',
        cost: 0.02,
        data: { event: 'budget_exceeded' },
      });

      const data = aggregator.getData();
      expect(Object.keys(data.byEmbedder)).toHaveLength(0);
      // But the cost is still counted in totalCost via the main path
      expect(data.totalCost).toBeCloseTo(0.03);
    });

    it('memory events without top-level cost still skip byEmbedder bucketing', () => {
      // Key-value (non-semantic) recall has no embedder call, so no cost.
      // The early-return in onTrace should prevent us from ever reaching
      // the embedder bucket path for this event.
      aggregator.onTrace({
        type: 'memory_recall',
        data: { key: 'name', scope: 'session', semantic: false, hit: true },
      });

      const data = aggregator.getData();
      expect(Object.keys(data.byEmbedder)).toHaveLength(0);
    });

    it('reset clears byEmbedder', () => {
      aggregator.onTrace({
        type: 'memory_remember',
        cost: 0.000005,
        data: {
          key: 'x',
          scope: 'session',
          usage: { cost: 0.000005, tokens: 10, model: 'text-embedding-3-small' },
        },
      });
      aggregator.reset();
      const data = aggregator.getData();
      expect(data.byEmbedder).toEqual({});
    });
  });
});
