import { describe, it, expect } from 'vitest';
import { pickExport, resolveRuntime } from '../resolve-runtime.js';

const fakeRuntime = { execute: () => {}, name: 'test-runtime' };

describe('resolveRuntime', () => {
  it('resolves ESM default export', () => {
    // import() of an ESM module: mod.default is the exported value
    const mod = { default: fakeRuntime };
    expect(resolveRuntime(mod)).toBe(fakeRuntime);
  });

  it('resolves CJS-to-ESM interop (double-wrapped default)', () => {
    // CJS `module.exports = { default: runtime }` wrapped by ESM import():
    // mod.default = module.exports = { default: runtime }
    const mod = { default: { default: fakeRuntime } };
    expect(resolveRuntime(mod)).toBe(fakeRuntime);
  });

  it('resolves CJS module.exports = runtime (no .default on the value)', () => {
    // CJS `module.exports = runtime` wrapped by ESM import():
    // mod.default = runtime directly
    const mod = { default: fakeRuntime };
    expect(resolveRuntime(mod)).toBe(fakeRuntime);
  });

  it('resolves named export { runtime }', () => {
    const mod = { runtime: fakeRuntime };
    expect(resolveRuntime(mod)).toBe(fakeRuntime);
  });

  it('prefers default over named runtime export', () => {
    const otherRuntime = { execute: () => {}, name: 'other' };
    const mod = { default: fakeRuntime, runtime: otherRuntime };
    expect(resolveRuntime(mod)).toBe(fakeRuntime);
  });

  it('returns undefined when module has no recognizable export', () => {
    const mod = { something: 'else' };
    expect(resolveRuntime(mod)).toBeUndefined();
  });
});

describe('pickExport', () => {
  // Symmetric counterpart to resolveRuntime for named exports — keeps
  // executeWorkflow visible when tsx loads an eval module as CJS in a package
  // without "type": "module" (named exports end up under mod.default.<key>).
  const fn = () => 'sentinel';

  it('returns top-level export (ESM-shaped)', () => {
    expect(pickExport({ executeWorkflow: fn }, 'executeWorkflow')).toBe(fn);
  });

  it('returns mod.default.<key> when CJS-wrapped under default', () => {
    const mod = { default: { default: { workflow: 'x' }, executeWorkflow: fn } };
    expect(pickExport(mod, 'executeWorkflow')).toBe(fn);
  });

  it('returns mod.default.default.<key> on rare double-wrap', () => {
    const mod = { default: { default: { executeWorkflow: fn } } };
    expect(pickExport(mod, 'executeWorkflow')).toBe(fn);
  });

  it('prefers top-level over wrapped when both exist', () => {
    const top = () => 'top';
    const wrapped = () => 'wrapped';
    const mod = { executeWorkflow: top, default: { executeWorkflow: wrapped } };
    expect(pickExport(mod, 'executeWorkflow')).toBe(top);
  });

  it('returns undefined when absent at every level', () => {
    expect(pickExport({}, 'executeWorkflow')).toBeUndefined();
    expect(pickExport({ default: {} }, 'executeWorkflow')).toBeUndefined();
    expect(pickExport({ default: { default: {} } }, 'executeWorkflow')).toBeUndefined();
  });
});
