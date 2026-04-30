/**
 * CLI utilities for `axl-eval`.
 *
 * The actual implementations of the loader, glob, and config-detection
 * helpers live in `@axlsdk/axl`'s `cli-internals` so a fix to (e.g.) the
 * tsx loader registration applies to both axl-eval and axl-studio
 * atomically. This file is now a thin re-export plus the symmetric
 * module-resolution helpers from `@axlsdk/axl`.
 */

export {
  resolveRuntime,
  pickDefault,
  pickExport,
  CONFIG_CANDIDATES,
  findConfig,
  needsTsxLoader,
  importModule,
  expandGlob,
  registerConditions,
} from '@axlsdk/axl';
