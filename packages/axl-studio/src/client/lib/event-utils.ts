/**
 * Client-local mirror of `@axlsdk/axl#eventCostContribution`.
 *
 * Why this mirror persists even after the strict-types migration:
 * `eventCostContribution` is a runtime VALUE, not a type. Importing it
 * from `@axlsdk/axl` would pull the package's main bundle (including
 * Node's `AsyncLocalStorage` from `node:async_hooks`) into the Vite SPA
 * bundle and crash with "Module 'async_hooks' has been externalized for
 * browser compatibility". The browser-compat tripwire enforces this.
 *
 * The TYPE side of the duplication WAS resolved — `AxlEvent` here is
 * imported via type-only re-export in `./types.ts` (safe, fully erased
 * under `verbatimModuleSyntax: true`). Only the runtime helper still
 * has to be mirrored. The two ways to eliminate this last duplication
 * are (a) ship a browser-safe `@axlsdk/axl/browser` subpath with the
 * pure helpers, or (b) extract `event-utils` into its own package with
 * no `async_hooks` dep. Both are out of scope here.
 *
 * The invariant is simple — skip `ask_end` rollups (spec/16 §10), guard
 * against NaN/Infinity/negative costs — so drift is unlikely. Pinning
 * test in `event-utils.test.ts` mirrors the SDK suite for parity.
 */
import type { AxlEvent } from './types.js';

export function eventCostContribution(event: AxlEvent): number {
  if (event.type === 'ask_end') return 0;
  const c = event.cost;
  return typeof c === 'number' && Number.isFinite(c) && c >= 0 ? c : 0;
}
