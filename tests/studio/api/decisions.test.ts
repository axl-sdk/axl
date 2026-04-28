import { describe, it, expect, afterEach } from 'vitest';
import { createTestServer } from '../helpers/setup.js';
import { readJson } from '../helpers/json.js';

describe('Studio API: Decisions', () => {
  // MemoryStore persists pending decisions to a temp file
  // (`<tmpdir>/axl-memory-store/await-human-state.json`) so human-in-the-
  // loop workflows can survive Node restarts. That means a decision
  // seeded in one test leaks into the next unless we explicitly resolve
  // it, since each new `MemoryStore()` loads from the same temp file.
  // Resolve any decisions seeded during a test so the file gets cleaned.
  afterEach(async () => {
    const { runtime } = createTestServer();
    const decisions = await runtime.getPendingDecisions();
    for (const d of decisions) {
      await runtime.getStateStore().resolveDecision(d.executionId, { approved: true });
    }
  });

  it('GET /api/decisions returns empty list initially', async () => {
    const { app } = createTestServer();
    const res = await app.request('/api/decisions');
    expect(res.status).toBe(200);

    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([]);
  });

  it('POST /api/decisions/:executionId/resolve returns resolved confirmation', async () => {
    const { app } = createTestServer();

    const res = await app.request('/api/decisions/exec-123/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true, reason: 'Looks good' }),
    });
    expect(res.status).toBe(200);

    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data.resolved).toBe(true);
  });

  it('GET /api/decisions scrubs prompt when trace.redact is on', async () => {
    const { app, runtime } = createTestServer(undefined, { redact: true });
    // Seed a pending decision directly via the state store. We can't use
    // the Studio REST surface to create one (await_human is workflow-side),
    // but the route reads through runtime.getPendingDecisions() which
    // consults the store.
    await runtime.getStateStore().savePendingDecision('exec-1', {
      executionId: 'exec-1',
      channel: 'approval',
      prompt: 'Approve sending email to user@acme.com with body: <secret>',
      metadata: { userId: '42' },
      createdAt: new Date().toISOString(),
    });

    const res = await app.request('/api/decisions');
    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data.length).toBe(1);
    // Prompt scrubbed
    expect(body.data[0].prompt).toBe('[redacted]');
    // Metadata replaced with sentinel marker
    expect(body.data[0].metadata).toEqual({ redacted: true });
    // Structural fields preserved
    expect(body.data[0].executionId).toBe('exec-1');
    expect(body.data[0].channel).toBe('approval');
    expect(typeof body.data[0].createdAt).toBe('string');
  });

  it('GET /api/decisions returns raw prompt when trace.redact is off', async () => {
    const { app, runtime } = createTestServer(undefined, { redact: false });
    await runtime.getStateStore().savePendingDecision('exec-2', {
      executionId: 'exec-2',
      channel: 'approval',
      prompt: 'Approve X?',
      createdAt: new Date().toISOString(),
    });

    const res = await app.request('/api/decisions');
    const body = await readJson(res);
    expect(body.data[0].prompt).toBe('Approve X?');
  });
});
