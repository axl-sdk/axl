import { Hono } from 'hono';
import type { StudioEnv } from '../types.js';
import { redactMemoryList, redactMemoryValue } from '../redact.js';

const app = new Hono<StudioEnv>();

// Get all memory entries for a scope
app.get('/memory/:scope', async (c) => {
  const runtime = c.get('runtime');
  const store = runtime.getStateStore();
  const scope = c.req.param('scope');

  if (!store.getAllMemory) {
    return c.json({ ok: true, data: [] });
  }

  const entries = await store.getAllMemory(scope);
  return c.json({ ok: true, data: redactMemoryList(entries, runtime.isRedactEnabled()) });
});

// Get a specific memory entry
app.get('/memory/:scope/:key', async (c) => {
  const runtime = c.get('runtime');
  const store = runtime.getStateStore();
  const scope = c.req.param('scope');
  const key = c.req.param('key');

  if (!store.getMemory) {
    return c.json(
      { ok: false, error: { code: 'NOT_SUPPORTED', message: 'Memory not supported' } },
      501,
    );
  }

  const value = await store.getMemory(scope, key);
  if (value === null) {
    return c.json(
      { ok: false, error: { code: 'NOT_FOUND', message: `Memory "${scope}/${key}" not found` } },
      404,
    );
  }

  return c.json({
    ok: true,
    data: { key, value: redactMemoryValue(value, runtime.isRedactEnabled()) },
  });
});

// Save a memory entry
app.put('/memory/:scope/:key', async (c) => {
  const runtime = c.get('runtime');
  const store = runtime.getStateStore();
  const scope = c.req.param('scope');
  const key = c.req.param('key');

  if (!store.saveMemory) {
    return c.json(
      { ok: false, error: { code: 'NOT_SUPPORTED', message: 'Memory not supported' } },
      501,
    );
  }

  const body = await c.req.json<{ value: unknown }>();
  await store.saveMemory(scope, key, body.value);
  return c.json({ ok: true, data: { saved: true } });
});

// Delete a memory entry
app.delete('/memory/:scope/:key', async (c) => {
  const runtime = c.get('runtime');
  const store = runtime.getStateStore();
  const scope = c.req.param('scope');
  const key = c.req.param('key');

  if (!store.deleteMemory) {
    return c.json(
      { ok: false, error: { code: 'NOT_SUPPORTED', message: 'Memory not supported' } },
      501,
    );
  }

  await store.deleteMemory(scope, key);
  return c.json({ ok: true, data: { deleted: true } });
});

// Semantic search
app.post('/memory/search', async (c) => {
  // TODO: Connect to MemoryManager's vector search once exposed
  return c.json({
    ok: true,
    data: { results: [], message: 'Semantic search requires MemoryManager with vector store' },
  });
});

export default app;
