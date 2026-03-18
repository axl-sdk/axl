/**
 * Resolve the AxlRuntime from a dynamically imported config module.
 * Handles ESM default exports, CJS-to-ESM interop wrapping, and named exports.
 *
 * Module shapes handled:
 * - ESM `export default runtime` → mod.default is the runtime
 * - CJS compiled from `export default runtime` → mod.default.default is the runtime
 * - CJS `module.exports = runtime` → mod.default is the runtime
 * - Named `export { runtime }` → mod.runtime is the runtime
 */
export function resolveRuntime(mod: Record<string, unknown>): unknown {
  const def = mod.default as Record<string, unknown> | undefined;
  return def?.default ?? def ?? mod.runtime;
}
