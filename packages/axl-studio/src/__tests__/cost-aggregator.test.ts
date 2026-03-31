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
      type: 'agent_call',
      agent: 'test-agent',
      model: 'gpt-4',
      workflow: 'test-wf',
      cost: 0.05,
      tokens: { input: 100, output: 50, reasoning: 10 },
    });
    aggregator.onTrace({
      type: 'agent_call',
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
      type: 'agent_call',
      agent: 'agent-a',
      model: 'model-x',
      workflow: 'wf-1',
      cost: 0.01,
      tokens: { input: 10, output: 5 },
    });
    aggregator.onTrace({
      type: 'agent_call',
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

  it('reset zeroes all counters', () => {
    aggregator.onTrace({
      type: 'agent_call',
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
  });

  it('processes events with cost: 0 and does not skip them', () => {
    aggregator.onTrace({
      type: 'agent_call',
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
});
