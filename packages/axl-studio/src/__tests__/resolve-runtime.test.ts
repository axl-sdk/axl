import { describe, it, expect } from 'vitest';
import { resolveRuntime } from '../resolve-runtime.js';

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
