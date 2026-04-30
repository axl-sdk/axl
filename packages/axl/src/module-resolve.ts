/**
 * Module-export resolution helpers for dynamically-imported user modules.
 *
 * Walks the ESM/CJS interop chain so consumers see the same shape regardless
 * of how Node loaded the file. The original motivating bug: `axl-eval` looked
 * up `executeWorkflow` as `mod.executeWorkflow` only, but tsx-loading a `.ts`
 * file in a CJS package puts named exports on `mod.default.executeWorkflow`,
 * so the lookup silently fell back to identity passthrough — producing
 * all-zero scores in CI.
 *
 * Use these helpers (not hand-rolled `mod.default ?? mod` walks) at every
 * dynamic-import call site to keep default and named lookups symmetric.
 *
 * @internal Not part of the public SDK surface — exported only so the eval
 * CLI and Studio middleware can share one implementation.
 */

/**
 * Resolve the AxlRuntime from a dynamically imported config module.
 * Handles ESM default exports, CJS-to-ESM interop wrapping, and named exports.
 *
 * Module shapes handled:
 * - ESM `export default runtime` → `mod.default` is the runtime
 * - CJS compiled from `export default runtime` → `mod.default.default` is the runtime
 * - CJS `module.exports = runtime` → `mod.default` is the runtime
 * - Named `export { runtime }` → `mod.runtime` is the runtime
 *
 * @internal
 */
export function resolveRuntime(mod: Record<string, unknown>): unknown {
  const def = mod.default as Record<string, unknown> | undefined;
  return def?.default ?? def ?? mod.runtime;
}

/**
 * Look up the default-ish export from a dynamically imported module. Walks
 * the ESM/CJS interop chain plus a `config` named-export fallback that some
 * eval modules use.
 *
 * Module shapes handled:
 * - ESM `export default cfg`:          `mod.default`
 * - CJS-wrapped-as-ESM:                `mod.default.default`
 * - Named `export const config = cfg`: `mod.config`
 * - Bare module value:                 `mod`
 *
 * Mirrors the chain `pickExport()` walks for named exports — keep them in
 * sync so resolution is symmetric.
 *
 * @internal
 */
export function pickDefault<T>(mod: Record<string, unknown>): T {
  const def = mod.default as Record<string, unknown> | undefined;
  return (def?.default ?? def ?? mod.config ?? mod) as T;
}

/**
 * Look up a named export from a dynamically imported module, walking the
 * ESM/CJS interop chain symmetrically with `resolveRuntime` and `pickDefault`.
 *
 * Module shapes handled:
 * - ESM:                   `mod[key]`
 * - CJS-wrapped-as-ESM:    `mod.default[key]`         (tsx/ts compiled to CJS)
 * - CJS double-wrap:       `mod.default.default[key]` (rare interop edge)
 *
 * Without this helper, named exports would be silently invisible whenever the
 * module loads as CJS (e.g. a `.ts` file in a package without `"type": "module"`),
 * even though the default export resolves correctly via the chain walk.
 *
 * `null`-valued exports are treated as "absent" (the `??` chain falls through),
 * matching how a missing export presents at the language level. Callers that
 * need to distinguish "explicitly null" from "missing" should not use this helper.
 *
 * @internal
 */
export function pickExport<T>(mod: Record<string, unknown>, key: string): T | undefined {
  const def = mod.default as Record<string, unknown> | undefined;
  return (mod[key] ??
    def?.[key] ??
    (def?.default as Record<string, unknown> | undefined)?.[key]) as T | undefined;
}
