/** Real published-format ESM+CJS loads, not two imports normalized by Vitest. */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import * as esm from '@axlsdk/axl';
import { dataset, runEval } from '@axlsdk/eval';

const cjs = createRequire(import.meta.url)('@axlsdk/axl') as typeof esm;
const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function paidRuntime(copy: typeof esm, cost = 0.5) {
  let calls = 0;
  const runtime = new copy.AxlRuntime({ defaultProvider: 'fixture' });
  runtime.registerProvider('fixture', {
    name: 'fixture',
    async chat() {
      calls++;
      return { content: 'ok', cost, usage };
    },
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error('unused');
    },
  });
  const asker = copy.agent({ name: 'a', model: 'fixture:m', system: 'fixture' });
  runtime.register(
    copy.workflow({
      name: 'ask',
      input: z.any(),
      handler: async (ctx) => ctx.ask(asker, 'go'),
    }),
  );
  return { runtime, calls: () => calls };
}

describe('two loaded builds share accounting', () => {
  it.each([
    ['ESM scope / CJS work', esm, cjs],
    ['CJS scope / ESM work', cjs, esm],
  ])('%s counts the ask and denies it under $0', async (_label, owner, worker) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const outer = new owner.AxlRuntime();
    const paid = paidRuntime(worker);

    const measured = await outer.trackOutcome(() => paid.runtime.execute('ask', {}));
    expect(measured.status).toBe('fulfilled');
    expect(measured.accounting).toMatchObject({
      knownCost: 0.5,
      completeness: 'complete',
      operations: { total: 1, settled: 1 },
    });

    const denied = await outer.trackOutcome(() => paid.runtime.execute('ask', {}), {
      admission: new owner.AdmissionController({ limit: 0 }),
    });
    expect(denied.status).toBe('rejected');
    if (denied.status === 'rejected') expect(owner.isAdmissionDeniedError(denied.error)).toBe(true);
    expect(paid.calls()).toBe(1);
    expect(denied.accounting.operations.denied).toBe(1);
    if (owner === esm) {
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(
        /index\.js.*v\d+\.\d+\.\d+.*index\.cjs.*v\d+\.\d+\.\d+|index\.cjs.*v\d+\.\d+\.\d+.*index\.js.*v\d+\.\d+\.\d+/,
      );
    } else {
      expect(warn).not.toHaveBeenCalled();
    }
  });

  it('folds nested scopes once and captures distinct cross-copy operations with correlation', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const outer = new cjs.AxlRuntime();
    const paidEsm = paidRuntime(esm);
    const paidCjs = paidRuntime(cjs);
    const lines: string[] = [];
    const capture = new cjs.RequestCaptureChannel({
      sink: {
        async append(line) {
          lines.push(line);
        },
      },
      redact: true,
    });
    const admission = new cjs.AdmissionController({ limit: 2 });

    const result = await outer.trackOutcome(
      async () => {
        await paidCjs.runtime.execute('ask', {});
        return paidEsm.runtime.trackOutcome(() => paidEsm.runtime.execute('ask', {}), {
          captureCorrelation: { caseIndex: 7 },
          admission,
        });
      },
      { capture, admission },
    );
    await capture.close();

    expect(result.accounting).toMatchObject({ knownCost: 1, operations: { total: 2, settled: 2 } });
    expect(admission.knownSpend).toBe(1);
    expect(result.status).toBe('fulfilled');
    if (result.status === 'fulfilled') {
      expect(result.value.accounting).toMatchObject({ knownCost: 0.5, operations: { total: 1 } });
    }
    const starts = lines
      .map(
        (line) =>
          JSON.parse(line) as {
            phase: string;
            operationId: string;
            caseIndex?: number;
            captured: { redacted: boolean };
          },
      )
      .filter((record) => record.phase === 'start');
    expect(starts).toHaveLength(2);
    expect(new Set(starts.map((record) => record.operationId)).size).toBe(2);
    expect(starts.find((record) => record.caseIndex === 7)).toBeDefined();
    expect(starts.every((record) => record.captured.redacted)).toBe(true);
  });

  it('keeps concurrent parent scopes isolated across copies', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const outer = new esm.AxlRuntime();
    const first = paidRuntime(cjs, 0.25);
    const second = paidRuntime(cjs, 0.75);
    const [a, b] = await Promise.all([
      outer.trackOutcome(() => first.runtime.execute('ask', {})),
      outer.trackOutcome(() => second.runtime.execute('ask', {})),
    ]);
    expect(a.accounting.knownCost).toBe(0.25);
    expect(b.accounting.knownCost).toBe(0.75);
    expect(a.accounting.operations.total).toBe(1);
    expect(b.accounting.operations.total).toBe(1);
  });

  it('does not retry a tool after a denial from the other copy', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const outer = new esm.AxlRuntime();
    const paid = paidRuntime(cjs);
    let attempts = 0;
    const retrying = esm.tool({
      name: 'retrying',
      description: 'Cross-copy denial regression',
      input: z.object({}),
      retry: { attempts: 3, backoff: 'none' },
      handler: async () => {
        attempts++;
        const inner = await paid.runtime.trackOutcome(() => paid.runtime.execute('ask', {}), {
          admission: new cjs.AdmissionController({ limit: 0 }),
        });
        if (inner.status === 'rejected') throw inner.error;
        return inner.value;
      },
    });
    const result = await outer.trackOutcome(() => retrying.run({ log() {} } as never, {}));
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(esm.isAdmissionDeniedError(result.error)).toBe(true);
    expect(attempts).toBe(1);
    expect(paid.calls()).toBe(0);
  });

  it('keeps compatible copies joined when another protocol loads first, and refuses a foreign active guard', () => {
    // The other protocol occupies its own slot. A synthetic foreign guard
    // models the actual boundary where an incompatible copy owns a scope.
    const script = `
      import { createRequire } from 'node:module';
      globalThis[Symbol.for('axl.accounting.context.v2')] = { protocol: 2 };
      const esm = await import('@axlsdk/axl');
      const cjs = createRequire(import.meta.url)('@axlsdk/axl');
      let calls = 0;
      const worker = new cjs.AxlRuntime({ defaultProvider: 'fixture' });
      worker.registerProvider('fixture', {
        name: 'fixture',
        async chat() { calls++; return { content: 'ok', cost: 0.5 }; },
        async *stream() { throw Error('unused'); }
      });
      const facade = worker.resolveProvider('fixture:m').provider;
      const outer = new esm.AxlRuntime();
      const joined = await outer.trackOutcome(() => facade.chat([], { model: 'm' }));
      const denied = await outer.trackOutcome(() => facade.chat([], { model: 'm' }), {
        admission: new esm.AdmissionController({ limit: 0 })
      });
      const storage = globalThis[Symbol.for('axl.accounting.scopeGuard')].storage;
      const foreign = (parent) => ({
        contextId: Symbol('protocol2'),
        owner: { path: '/fixture/protocol2/index.js', version: '2.0.0' },
        markUninstrumented: () => parent.markUninstrumented(),
        isActive: () => parent.isActive()
      });
      const direct = await outer.trackOutcome(() => {
        const parent = storage.getStore();
        return storage.run(foreign(parent), () => facade.chat([], { model: 'm' }));
      });
      const nested = await outer.trackOutcome(() => {
        const parent = storage.getStore();
        return storage.run(foreign(parent), () => worker.trackOutcome(() => facade.chat([], { model: 'm' })));
      });
      const afterChild = await outer.trackOutcome(async () => {
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        let late;
        await outer.trackOutcome(async () => {
          const parent = storage.getStore();
          late = storage.run(foreign(parent), async () => { await gate; return facade.chat([], { model: 'm' }); });
        });
        release();
        await late.catch(() => undefined);
      });
      let staleGuard;
      await outer.trackOutcome(async () => { staleGuard = foreign(storage.getStore()); });
      const afterAll = await storage.run(staleGuard, () => facade.chat([], { model: 'm' }));
      const newScope = await storage.run(staleGuard, () => worker.trackOutcome(() => facade.chat([], { model: 'm' })));
      console.log(JSON.stringify({ calls,
        joined: joined.accounting, denied: { status: denied.status, code: denied.error?.code },
        afterAll: afterAll.content, newScope: newScope.accounting,
        direct: { status: direct.status, code: direct.error?.code,
        accounting: direct.accounting }, nested: { status: nested.status,
        accounting: nested.accounting, inner: nested.value?.accounting, innerCode: nested.value?.error?.code },
        afterChild: afterChild.accounting }));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: join(import.meta.dirname, '../../'),
      encoding: 'utf8',
    });
    expect(child.status).toBe(0);
    const result = JSON.parse(child.stdout) as {
      calls: number;
      joined: { knownCost: number; completeness: string };
      denied: { status: string; code: string };
      afterAll: string;
      newScope: { knownCost: number; completeness: string };
      direct: {
        status: string;
        code: string;
        accounting: { completeness: string; reasons: { uninstrumented?: number } };
      };
      nested: {
        status: string;
        accounting: { completeness: string; reasons: { uninstrumented?: number } };
        inner: { completeness: string; reasons: { uninstrumented?: number } };
        innerCode: string;
      };
      afterChild: { completeness: string; reasons: { uninstrumented?: number } };
    };
    expect(result).toMatchObject({
      calls: 3,
      joined: { knownCost: 0.5, completeness: 'complete' },
      denied: { status: 'rejected', code: 'ADMISSION_DENIED' },
      afterAll: 'ok',
      newScope: { knownCost: 0.5, completeness: 'complete' },
      direct: {
        status: 'rejected',
        code: 'INCOMPATIBLE_ACCOUNTING_SCOPE',
        accounting: { completeness: 'incomplete', reasons: { uninstrumented: 1 } },
      },
      nested: {
        status: 'fulfilled',
        innerCode: 'INCOMPATIBLE_ACCOUNTING_SCOPE',
        accounting: { completeness: 'incomplete', reasons: { uninstrumented: 1 } },
        inner: { completeness: 'incomplete', reasons: { uninstrumented: 1 } },
      },
      afterChild: { completeness: 'incomplete', reasons: { uninstrumented: 1 } },
    });
    expect(child.stderr).toContain('/fixture/protocol2/index.js');
    expect(child.stderr).toContain('index.cjs');
  });

  it('charges an eval budget and captures a workflow using the other build', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const root = await mkdtemp(join(tmpdir(), 'axl-cross-copy-'));
    roots.push(root);
    const host = new cjs.AxlRuntime({ diagnostics: { artifacts: { root } } });
    const paid = paidRuntime(esm);
    const result = await runEval(
      {
        workflow: 'ask',
        dataset: dataset({
          name: 'two',
          schema: z.object({ q: z.string() }),
          items: [{ input: { q: '1' } }, { input: { q: '2' } }],
        }),
        scorers: [],
        budget: '0.5',
        concurrency: 1,
      },
      async (input) => ({ output: await paid.runtime.execute('ask', input) }),
      host,
      { captureRequests: true },
    );
    expect(paid.calls()).toBe(1);
    expect(result.accounting).toMatchObject({
      knownCost: 0.5,
      completeness: 'complete',
      budget: { status: 'closed', knownSpend: 0.5 },
    });
    expect(result.items.map((item) => item.outcome)).toEqual(['completed', 'budget_skipped']);
    expect(result.diagnostics?.records).toBeGreaterThan(0);
    expect(result.items[0].diagnostics?.operations).toHaveLength(1);
  });
});
