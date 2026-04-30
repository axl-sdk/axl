/**
 * Re-exports of module-resolution helpers from `@axlsdk/axl`.
 *
 * Studio used to keep its own copy of these (alongside the duplicated copy in
 * `@axlsdk/eval`'s cli-utils). They've been lifted to `@axlsdk/axl` so a fix
 * to the ESM/CJS chain walk applies to all three consumers atomically. Kept
 * as a re-export rather than a deletion so existing imports still work and
 * the test file at `__tests__/resolve-runtime.test.ts` continues to function
 * as a tripwire on this module's path.
 */
export { resolveRuntime, pickDefault, pickExport } from '@axlsdk/axl';
