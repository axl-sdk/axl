import { describe, it, expect } from 'vitest';
import { createTestServer } from '../helpers/setup.js';

describe('Studio API: Costs', () => {
  it('GET /api/costs returns initial cost data with zero totals', async () => {
    const { app } = createTestServer();
    const res = await app.request('/api/costs');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.totalCost).toBe(0);
    expect(body.data.totalTokens).toBeDefined();
    expect(body.data.totalTokens.input).toBe(0);
    expect(body.data.totalTokens.output).toBe(0);
  });

  it('POST /api/costs/reset resets the cost aggregator', async () => {
    const { app, costAggregator } = createTestServer();

    // Manually feed a trace to accumulate some cost
    costAggregator.onTrace({
      type: 'agent_call',
      agent: 'test-agent',
      model: 'mock:test',
      cost: 0.05,
      tokens: { input: 100, output: 50 },
    });

    // Verify cost was accumulated
    const before = await app.request('/api/costs');
    const beforeBody = await before.json();
    expect(beforeBody.data.totalCost).toBeCloseTo(0.05);

    // Reset
    const res = await app.request('/api/costs/reset', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.reset).toBe(true);

    // Verify cost is zeroed
    const after = await app.request('/api/costs');
    const afterBody = await after.json();
    expect(afterBody.data.totalCost).toBe(0);
  });
});
