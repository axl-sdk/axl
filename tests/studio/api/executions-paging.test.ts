import { describe, it, expect } from 'vitest';
import { MemoryStore } from '@axlsdk/axl';
import type { HistoricalExecutionInfo } from '@axlsdk/axl';
import { createTestServer } from '../helpers/setup.js';
import { readJson } from '../helpers/json.js';

const BASE_TIME = 1_700_000_000_000;

/**
 * A stored v2 run. Every 7 consecutive runs share a start time, so page
 * boundaries (10, 100) fall inside tie groups.
 */
function storedRun(i: number): HistoricalExecutionInfo {
  const executionId = `run-${String(i).padStart(4, '0')}`;
  const startedAt = BASE_TIME + Math.floor(i / 7) * 1000;
  return {
    eventSchemaVersion: 2,
    executionId,
    workflow: 'seeded-wf',
    status: 'completed',
    totalCost: 0.01,
    startedAt,
    completedAt: startedAt + 5,
    duration: 5,
    result: `result-${i}`,
    metadata: { userId: `user-${i}` },
    events: [1, 2, 3].map((step) => ({
      schemaVersion: 2,
      type: 'log',
      executionId,
      step,
      timestamp: startedAt + step,
      data: { event: 'seed', secret: `payload-${i}` },
    })),
  } as unknown as HistoricalExecutionInfo;
}

async function seededServer(count: number, options?: { redact?: boolean; readOnly?: boolean }) {
  const stateStore = new MemoryStore();
  for (let i = 0; i < count; i++) await stateStore.saveExecution!(storedRun(i));
  return createTestServer(undefined, { stateStore, ...options });
}

describe('Studio API: paged executions', () => {
  it('returns one page of 100 summaries without events (AC4.1)', async () => {
    const { app } = await seededServer(1000);

    const res = await app.request('/api/executions');
    expect(res.status).toBe(200);
    const body = await readJson(res);

    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(100);
    for (const item of body.data) {
      expect(item).not.toHaveProperty('events');
      expect(item.eventCount).toBe(3);
      expect(item.workflow).toBe('seeded-wf');
      expect(item.status).toBe('completed');
      expect(item.totalCost).toBe(0.01);
    }
    expect(typeof (body as { nextCursor?: unknown }).nextCursor).toBe('string');
  });

  it('visits every run exactly once, including tie groups at page boundaries', async () => {
    const { app } = await seededServer(1000);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/api/executions?limit=10${cursor ? `&cursor=${cursor}` : ''}`;
      const body = (await readJson(await app.request(url))) as {
        data: Array<{ executionId: string }>;
        nextCursor: string | null;
      };
      seen.push(...body.data.map((item) => item.executionId));
      cursor = body.nextCursor;
      pages++;
    } while (cursor);

    expect(pages).toBe(100);
    expect(seen).toHaveLength(1000);
    expect(new Set(seen).size).toBe(1000);
    // Newest first: start time descending, then id descending.
    const expected = Array.from({ length: 1000 }, (_, i) => storedRun(i))
      .sort((a, b) => b.startedAt - a.startedAt || (a.executionId < b.executionId ? 1 : -1))
      .map((r) => r.executionId);
    expect(seen).toEqual(expected);
  });

  it('reports nextCursor null when the last page is exactly full', async () => {
    const { app } = await seededServer(20);

    const first = (await readJson(await app.request('/api/executions?limit=10'))) as {
      nextCursor: string | null;
    };
    expect(first.nextCursor).not.toBeNull();
    const second = (await readJson(
      await app.request(`/api/executions?limit=10&cursor=${first.nextCursor}`),
    )) as { data: unknown[]; nextCursor: string | null };
    expect(second.data).toHaveLength(10);
    expect(second.nextCursor).toBeNull();
  });

  it('accepts the maximum limit and rejects anything above it', async () => {
    const { app } = await seededServer(3);
    expect((await app.request('/api/executions?limit=500')).status).toBe(200);
    const res = await app.request('/api/executions?limit=501');
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.ok).toBe(false);
    expect(body.error.param).toBe('limit');
  });

  it.each([['0'], ['-5'], ['abc'], ['1.5'], [''], ['Infinity']])(
    'rejects limit=%s with 400',
    async (limit) => {
      const { app } = await seededServer(3);
      const res = await app.request(`/api/executions?limit=${limit}`);
      expect(res.status).toBe(400);
      const body = await readJson(res);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('INVALID_PARAM');
      expect(body.error.param).toBe('limit');
    },
  );

  it.each([
    ['not base64url json', '!!!'],
    ['base64url of non-json', Buffer.from('hello').toString('base64url')],
    [
      'json of the wrong shape',
      Buffer.from(JSON.stringify({ startedAt: 'x' })).toString('base64url'),
    ],
    [
      'an empty execution id',
      Buffer.from(JSON.stringify({ startedAt: 1, executionId: '' })).toString('base64url'),
    ],
  ])('rejects a malformed cursor (%s) with 400', async (_name, cursor) => {
    const { app } = await seededServer(3);
    const res = await app.request(`/api/executions?cursor=${encodeURIComponent(cursor)}`);
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.ok).toBe(false);
    expect(body.error.param).toBe('cursor');
  });

  it('scrubs summary fields when trace.redact is on, and still scrubs the detail', async () => {
    const { app } = await seededServer(3, { redact: true });

    const list = await readJson(await app.request('/api/executions'));
    expect(list.data).toHaveLength(3);
    for (const item of list.data) {
      expect(item.result).toBe('[redacted]');
      expect(item.metadata).toEqual({ redacted: true });
      expect(item).not.toHaveProperty('events');
    }
    expect(JSON.stringify(list)).not.toMatch(/result-\d|user-\d|payload-\d/);

    const detail = await readJson(await app.request(`/api/executions/${list.data[0].executionId}`));
    expect(detail.data.result).toBe('[redacted]');
    expect(detail.data.events).toHaveLength(3);
    expect(JSON.stringify(detail.data)).not.toMatch(/payload-\d/);
  });

  it('serves the full record, with events, from the detail route', async () => {
    const { app } = await seededServer(3);
    const list = await readJson(await app.request('/api/executions'));
    const id = list.data[0].executionId;

    const detail = await readJson(await app.request(`/api/executions/${id}`));
    expect(detail.data.events).toHaveLength(3);
    expect((await app.request('/api/executions/unknown-run')).status).toBe(404);
  });

  it('lists a running workflow as a summary', async () => {
    const { app, runtime } = await seededServer(2);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { workflow } = await import('@axlsdk/axl');
    const { z } = await import('zod');
    runtime.register(
      workflow({
        name: 'blocked-wf',
        input: z.string(),
        handler: async () => {
          await gate;
          return 'done';
        },
      }),
    );
    const running = runtime.execute('blocked-wf', 'go');
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const body = await readJson(await app.request('/api/executions'));
      const live = body.data.find((item: { workflow: string }) => item.workflow === 'blocked-wf');
      expect(live).toBeDefined();
      expect(live.status).toBe('running');
      expect(live).not.toHaveProperty('events');
    } finally {
      release();
      await running;
    }
  });

  it('allows paging in readOnly mode', async () => {
    const { app } = await seededServer(3, { readOnly: true });
    const res = await app.request('/api/executions?limit=2');
    expect(res.status).toBe(200);
    expect((await readJson(res)).data).toHaveLength(2);
  });
});
