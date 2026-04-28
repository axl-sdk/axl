import { describe, it, expect } from 'vitest';
import { agent } from '@axlsdk/axl';
import { createTestServer } from '../helpers/setup.js';
import { readJson } from '../helpers/json.js';

describe('Studio API: Agents', () => {
  it('GET /api/agents lists registered agents', async () => {
    const { app } = createTestServer();
    const res = await app.request('/api/agents');
    expect(res.status).toBe(200);

    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data.length).toBe(1);
    expect(body.data[0].name).toBe('test-agent');
    expect(body.data[0].model).toBe('mock:test');
  });

  it('GET /api/agents/nonexistent returns 404', async () => {
    const { app } = createTestServer();
    const res = await app.request('/api/agents/nonexistent');
    expect(res.status).toBe(404);

    const body = await readJson(res);
    expect(body.ok).toBe(false);
  });

  it('GET /api/agents lists dynamic handoffs as (dynamic)', async () => {
    const helperAgent = agent({
      name: 'helper',
      model: 'mock:test',
      system: 'A helper agent.',
    });

    const dynamicAgent = agent({
      name: 'dynamic-handoff-agent',
      model: 'mock:test',
      system: 'Routes dynamically.',
      handoffs: () => [{ agent: helperAgent, description: 'Help' }],
    });

    const { app, runtime } = createTestServer();
    runtime.registerAgent(dynamicAgent);

    const res = await app.request('/api/agents');
    expect(res.status).toBe(200);

    const body = await readJson(res);
    const entry = body.data.find(
      (a: Record<string, unknown>) => a.name === 'dynamic-handoff-agent',
    );
    expect(entry).toBeDefined();
    expect(entry.handoffs).toEqual(['(dynamic)']);
  });

  it('GET /api/agents/:name shows dynamic handoff detail', async () => {
    const helperAgent = agent({
      name: 'helper-detail',
      model: 'mock:test',
      system: 'A helper agent.',
    });

    const dynamicAgent = agent({
      name: 'dynamic-detail-agent',
      model: 'mock:test',
      system: 'Routes dynamically.',
      handoffs: () => [{ agent: helperAgent, description: 'Help' }],
    });

    const { app, runtime } = createTestServer();
    runtime.registerAgent(dynamicAgent);

    const res = await app.request('/api/agents/dynamic-detail-agent');
    expect(res.status).toBe(200);

    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data.handoffs).toEqual([
      {
        agent: '(dynamic)',
        description: 'Resolved at runtime from metadata',
        mode: 'oneway',
      },
    ]);
  });
});
