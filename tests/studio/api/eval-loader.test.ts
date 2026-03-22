import { resolve, relative } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AxlRuntime } from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';
import { createStudioMiddleware } from '@axlsdk/studio/middleware';

const FIXTURES_DIR = resolve(import.meta.dirname!, '..', 'fixtures');
const PROJECT_ROOT = process.cwd();

/** Compute the expected eval name for a fixture file. */
function expectedName(absolutePath: string): string {
  return relative(PROJECT_ROOT, absolutePath).replace(/\.eval\.[mc]?[jt]sx?$/, '');
}

function createTestRuntime() {
  const runtime = new AxlRuntime();
  runtime.registerProvider('mock', MockProvider.echo());
  return runtime;
}

const EVAL_TEMPLATE = `export default {
  workflow: 'wf',
  dataset: { name: 'ds', getItems: async () => [{ input: {} }] },
  scorers: [{ name: 's', score: () => 1 }],
};
export async function executeWorkflow() { return { output: 'ok' }; }`;

describe('Studio Middleware: Lazy Eval Loading', () => {
  // Temp dirs created inside the project for cwd-relative naming to work
  const tempDirs: string[] = [];

  function createTempDir(): string {
    const dir = resolve(import.meta.dirname!, '..', `.tmp-eval-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('loads eval files from a glob pattern on first eval route access', async () => {
    const runtime = createTestRuntime();
    const studio = createStudioMiddleware({
      runtime,
      serveClient: false,
      evals: resolve(FIXTURES_DIR, '*.eval.mjs'),
    });

    // Before accessing evals — none registered (eval loader hasn't run yet)
    expect(runtime.getRegisteredEvals()).toEqual([]);

    // Accessing the eval route triggers lazy loading
    const res = await studio.app.request('/api/evals');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);

    // Both valid eval files should be registered (names are cwd-relative)
    const names = body.data.map((e: { name: string }) => e.name).sort();
    expect(names).toEqual([
      expectedName(resolve(FIXTURES_DIR, 'another.eval.mjs')),
      expectedName(resolve(FIXTURES_DIR, 'sample.eval.mjs')),
    ]);

    // Verify metadata extraction
    const sampleName = expectedName(resolve(FIXTURES_DIR, 'sample.eval.mjs'));
    const sample = body.data.find((e: { name: string }) => e.name === sampleName);
    expect(sample.workflow).toBe('sample-wf');
    expect(sample.dataset).toBe('sample-ds');
    expect(sample.scorers).toEqual(['length-check']);

    studio.close();
  });

  it('skips invalid eval files with a warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = createTestRuntime();
    const studio = createStudioMiddleware({
      runtime,
      serveClient: false,
      evals: resolve(FIXTURES_DIR, 'invalid.eval.mjs'),
    });

    const res = await studio.app.request('/api/evals');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual([]);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping'));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('missing workflow, dataset, or scorers'),
    );

    studio.close();
  });

  it('handles eval files that throw on import', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = createTestRuntime();
    const studio = createStudioMiddleware({
      runtime,
      serveClient: false,
      evals: [resolve(FIXTURES_DIR, 'throws.eval.mjs'), resolve(FIXTURES_DIR, 'sample.eval.mjs')],
    });

    const res = await studio.app.request('/api/evals');
    expect(res.status).toBe(200);

    const body = await res.json();
    // The throwing file is skipped, the valid file is still loaded
    expect(body.data.length).toBe(1);
    expect(body.data[0].name).toBe(expectedName(resolve(FIXTURES_DIR, 'sample.eval.mjs')));

    // Warning includes the error message
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('deliberate import failure'));

    studio.close();
  });

  it('loader is idempotent — only imports files once', async () => {
    const runtime = createTestRuntime();
    const registerSpy = vi.spyOn(runtime, 'registerEval');

    const studio = createStudioMiddleware({
      runtime,
      serveClient: false,
      evals: resolve(FIXTURES_DIR, 'sample.eval.mjs'),
    });

    await studio.app.request('/api/evals');
    const callsAfterFirst = registerSpy.mock.calls.length;
    expect(callsAfterFirst).toBe(1);

    await studio.app.request('/api/evals');
    expect(registerSpy.mock.calls.length).toBe(callsAfterFirst);

    studio.close();
  });

  it('POST /evals/:name/run triggers lazy loading and executes', async () => {
    const runtime = createTestRuntime();
    const studio = createStudioMiddleware({
      runtime,
      serveClient: false,
      evals: resolve(FIXTURES_DIR, 'sample.eval.mjs'),
    });

    expect(runtime.getRegisteredEvals()).toEqual([]);

    const name = expectedName(resolve(FIXTURES_DIR, 'sample.eval.mjs'));
    const res = await studio.app.request(`/api/evals/${encodeURIComponent(name)}/run`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.items.length).toBe(2);
    expect(body.data.items[0].output).toBe('result for hello');
    expect(body.data.items[0].scores['length-check']).toBe(1);

    studio.close();
  });

  it('concurrent requests share the same loading promise', async () => {
    const runtime = createTestRuntime();
    const registerSpy = vi.spyOn(runtime, 'registerEval');

    const studio = createStudioMiddleware({
      runtime,
      serveClient: false,
      evals: resolve(FIXTURES_DIR, 'sample.eval.mjs'),
    });

    const [res1, res2] = await Promise.all([
      studio.app.request('/api/evals'),
      studio.app.request('/api/evals'),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(registerSpy.mock.calls.length).toBe(1);

    const body1 = await res1.json();
    const body2 = await res2.json();
    expect(body1.data.length).toBe(1);
    expect(body2.data.length).toBe(1);

    studio.close();
  });

  it('accepts an array of explicit file paths', async () => {
    const runtime = createTestRuntime();
    const studio = createStudioMiddleware({
      runtime,
      serveClient: false,
      evals: [resolve(FIXTURES_DIR, 'sample.eval.mjs'), resolve(FIXTURES_DIR, 'another.eval.mjs')],
    });

    const res = await studio.app.request('/api/evals');
    const body = await res.json();
    const names = body.data.map((e: { name: string }) => e.name).sort();
    expect(names).toEqual([
      expectedName(resolve(FIXTURES_DIR, 'another.eval.mjs')),
      expectedName(resolve(FIXTURES_DIR, 'sample.eval.mjs')),
    ]);

    studio.close();
  });

  it('accepts object config with files field', async () => {
    const runtime = createTestRuntime();
    const studio = createStudioMiddleware({
      runtime,
      serveClient: false,
      evals: { files: resolve(FIXTURES_DIR, '*.eval.mjs') },
    });

    const res = await studio.app.request('/api/evals');
    const body = await res.json();
    const names = body.data.map((e: { name: string }) => e.name);
    expect(names).toContain(expectedName(resolve(FIXTURES_DIR, 'sample.eval.mjs')));
    expect(names).toContain(expectedName(resolve(FIXTURES_DIR, 'another.eval.mjs')));

    studio.close();
  });

  it('warns when no files match the pattern', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = createTestRuntime();
    const studio = createStudioMiddleware({
      runtime,
      serveClient: false,
      evals: '/nonexistent/path/*.eval.ts',
    });

    const res = await studio.app.request('/api/evals');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No eval files found'));

    studio.close();
  });

  it('names are cwd-relative and stable regardless of other patterns', async () => {
    const tempDir = createTempDir();
    const apiDir = resolve(tempDir, 'api');
    const searchDir = resolve(tempDir, 'search');
    mkdirSync(apiDir, { recursive: true });
    mkdirSync(searchDir, { recursive: true });

    writeFileSync(resolve(tempDir, 'root.eval.mjs'), EVAL_TEMPLATE);
    writeFileSync(resolve(apiDir, 'accuracy.eval.mjs'), EVAL_TEMPLATE);
    writeFileSync(resolve(searchDir, 'accuracy.eval.mjs'), EVAL_TEMPLATE);

    const runtime = createTestRuntime();
    const studio = createStudioMiddleware({
      runtime,
      serveClient: false,
      evals: resolve(tempDir, '**/*.eval.mjs'),
    });

    const res = await studio.app.request('/api/evals');
    const body = await res.json();
    const names = body.data.map((e: { name: string }) => e.name).sort();

    // Names are project-relative, not glob-relative
    expect(names).toEqual([
      expectedName(resolve(apiDir, 'accuracy.eval.mjs')),
      expectedName(resolve(tempDir, 'root.eval.mjs')),
      expectedName(resolve(searchDir, 'accuracy.eval.mjs')),
    ]);

    // All names are unique (no collision between api/accuracy and search/accuracy)
    expect(new Set(names).size).toBe(3);

    studio.close();
  });

  it('runs a nested eval by its cwd-relative name', async () => {
    const tempDir = createTempDir();
    const subDir = resolve(tempDir, 'sub');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(resolve(subDir, 'deep.eval.mjs'), EVAL_TEMPLATE);

    const runtime = createTestRuntime();
    const studio = createStudioMiddleware({
      runtime,
      serveClient: false,
      evals: resolve(subDir, 'deep.eval.mjs'),
    });

    const name = expectedName(resolve(subDir, 'deep.eval.mjs'));
    const res = await studio.app.request(`/api/evals/${encodeURIComponent(name)}/run`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.items[0].output).toBe('ok');

    studio.close();
  });

  it('name is stable when adding more patterns', async () => {
    const tempDir = createTempDir();
    const otherDir = resolve(tempDir, 'other');
    mkdirSync(otherDir, { recursive: true });

    writeFileSync(resolve(tempDir, 'first.eval.mjs'), EVAL_TEMPLATE);
    writeFileSync(resolve(otherDir, 'second.eval.mjs'), EVAL_TEMPLATE);

    // First: only one file
    const runtime1 = createTestRuntime();
    const studio1 = createStudioMiddleware({
      runtime: runtime1,
      serveClient: false,
      evals: resolve(tempDir, 'first.eval.mjs'),
    });

    const res1 = await studio1.app.request('/api/evals');
    const names1 = (await res1.json()).data.map((e: { name: string }) => e.name);
    studio1.close();

    // Second: both files
    const runtime2 = createTestRuntime();
    const studio2 = createStudioMiddleware({
      runtime: runtime2,
      serveClient: false,
      evals: [resolve(tempDir, 'first.eval.mjs'), resolve(otherDir, 'second.eval.mjs')],
    });

    const res2 = await studio2.app.request('/api/evals');
    const names2 = (await res2.json()).data.map((e: { name: string }) => e.name);
    studio2.close();

    // The first file's name should be identical in both configs
    expect(names1[0]).toBe(names2.find((n: string) => n.includes('first')));
  });

  it('pre-registered evals and lazy-loaded evals coexist', async () => {
    const runtime = createTestRuntime();

    runtime.registerEval('direct-eval', {
      workflow: 'direct-wf',
      dataset: { name: 'direct-ds', getItems: async () => [] },
      scorers: [{ name: 'noop', score: () => 1 }],
    });

    const studio = createStudioMiddleware({
      runtime,
      serveClient: false,
      evals: resolve(FIXTURES_DIR, 'sample.eval.mjs'),
    });

    const res = await studio.app.request('/api/evals');
    const body = await res.json();
    const names = body.data.map((e: { name: string }) => e.name).sort();
    expect(names).toContain('direct-eval');
    expect(names).toContain(expectedName(resolve(FIXTURES_DIR, 'sample.eval.mjs')));
    expect(names.length).toBe(2);

    studio.close();
  });

  it('evals not loaded when evals option is omitted', async () => {
    const runtime = createTestRuntime();
    const studio = createStudioMiddleware({ runtime, serveClient: false });

    const res = await studio.app.request('/api/evals');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);

    studio.close();
  });
});
