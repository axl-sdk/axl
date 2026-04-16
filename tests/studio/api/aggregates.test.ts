import { describe, it, expect } from 'vitest';
import { createTestServer } from '../helpers/setup.js';

describe('Studio API: Aggregate Endpoints', () => {
  // ── Cost endpoint ──────────────────────────────────────────

  describe('GET /api/costs', () => {
    it('returns CostData for default window (7d)', async () => {
      const { app } = createTestServer();
      const res = await app.request('/api/costs');
      expect(res.status).toBe(200);

      const body = (await res.json()) as { ok: boolean; data: Record<string, unknown> };
      expect(body.ok).toBe(true);
      expect(body.data.totalCost).toBe(0);
      expect(body.data.totalTokens).toBeDefined();
    });

    it('accepts window=24h query param', async () => {
      const { app } = createTestServer();
      const res = await app.request('/api/costs?window=24h');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; data: Record<string, unknown> };
      expect(body.ok).toBe(true);
      expect(body.data.totalCost).toBe(0);
    });

    it('accepts window=all query param', async () => {
      const { app } = createTestServer();
      const res = await app.request('/api/costs?window=all');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; data: Record<string, unknown> };
      expect(body.ok).toBe(true);
    });

    it('falls back to 7d for invalid window param', async () => {
      const { app } = createTestServer();
      const res = await app.request('/api/costs?window=bogus');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; data: Record<string, unknown> };
      expect(body.ok).toBe(true);
    });

    it('returns all windows with windows=all', async () => {
      const { app } = createTestServer();
      const res = await app.request('/api/costs?windows=all');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; data: Record<string, unknown> };
      expect(body.ok).toBe(true);
      expect(body.data['24h']).toBeDefined();
      expect(body.data['7d']).toBeDefined();
      expect(body.data['30d']).toBeDefined();
      expect(body.data['all']).toBeDefined();
    });

    it('POST /api/costs/reset returns 404', async () => {
      const { app } = createTestServer();
      const res = await app.request('/api/costs/reset', { method: 'POST' });
      expect(res.status).toBe(404);
    });
  });

  // ── Eval trends endpoint ───────────────────────────────────

  describe('GET /api/eval-trends', () => {
    it('returns EvalTrendData with zero totals', async () => {
      const { app } = createTestServer();
      const res = await app.request('/api/eval-trends');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        data: { totalRuns: number; totalCost: number; byEval: Record<string, unknown> };
      };
      expect(body.ok).toBe(true);
      expect(body.data.totalRuns).toBe(0);
      expect(body.data.totalCost).toBe(0);
      expect(body.data.byEval).toBeDefined();
    });

    it('accepts window param', async () => {
      const { app } = createTestServer();
      const res = await app.request('/api/eval-trends?window=30d');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });
  });

  // ── Workflow stats endpoint ────────────────────────────────

  describe('GET /api/workflow-stats', () => {
    it('returns WorkflowStatsData with zero totals', async () => {
      const { app } = createTestServer();
      const res = await app.request('/api/workflow-stats');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        data: {
          totalExecutions: number;
          failureRate: number;
          byWorkflow: Record<string, unknown>;
        };
      };
      expect(body.ok).toBe(true);
      expect(body.data.totalExecutions).toBe(0);
      expect(body.data.failureRate).toBe(0);
      expect(body.data.byWorkflow).toBeDefined();
    });

    it('accepts window param', async () => {
      const { app } = createTestServer();
      const res = await app.request('/api/workflow-stats?window=24h');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });
  });

  // ── Trace stats endpoint ───────────────────────────────────

  describe('GET /api/trace-stats', () => {
    it('returns TraceStatsData with zero totals', async () => {
      const { app } = createTestServer();
      const res = await app.request('/api/trace-stats');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        data: {
          totalEvents: number;
          eventTypeCounts: Record<string, number>;
          byTool: Record<string, unknown>;
          retryByAgent: Record<string, unknown>;
        };
      };
      expect(body.ok).toBe(true);
      expect(body.data.totalEvents).toBe(0);
      expect(body.data.eventTypeCounts).toBeDefined();
      expect(body.data.byTool).toBeDefined();
      expect(body.data.retryByAgent).toBeDefined();
    });

    it('accepts window param', async () => {
      const { app } = createTestServer();
      const res = await app.request('/api/trace-stats?window=all');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });
  });

  // ── Read-only mode ─────────────────────────────────────────

  describe('readOnly mode', () => {
    it('allows all aggregate GET endpoints in readOnly mode', async () => {
      const { app } = createTestServer(undefined, { readOnly: true });

      const costRes = await app.request('/api/costs?window=7d');
      expect(costRes.status).toBe(200);

      const evalRes = await app.request('/api/eval-trends?window=7d');
      expect(evalRes.status).toBe(200);

      const wfRes = await app.request('/api/workflow-stats?window=7d');
      expect(wfRes.status).toBe(200);

      const traceRes = await app.request('/api/trace-stats?window=7d');
      expect(traceRes.status).toBe(200);
    });
  });

  // ── Window consistency ─────────────────────────────────────

  describe('window consistency across endpoints', () => {
    it('all endpoints return data for the same window', async () => {
      const { app } = createTestServer();
      const windows = ['24h', '7d', '30d', 'all'];

      for (const w of windows) {
        const costRes = await app.request(`/api/costs?window=${w}`);
        const evalRes = await app.request(`/api/eval-trends?window=${w}`);
        const wfRes = await app.request(`/api/workflow-stats?window=${w}`);
        const traceRes = await app.request(`/api/trace-stats?window=${w}`);

        expect(costRes.status).toBe(200);
        expect(evalRes.status).toBe(200);
        expect(wfRes.status).toBe(200);
        expect(traceRes.status).toBe(200);
      }
    });
  });
});
