/**
 * Client-local mirror of `@axlsdk/axl#eventCostContribution`.
 *
 * We can't import from `@axlsdk/axl` directly in client code because
 * that package uses Node's `AsyncLocalStorage` (`node:async_hooks`)
 * for ALS-backed ask correlation — not browser-safe. Vite externalizes
 * `async_hooks` with a runtime-error stub, so any client module that
 * pulls in the core package crashes on first load ("Module 'async_hooks'
 * has been externalized for browser compatibility").
 *
 * This is a trivial 5-line helper; duplication is the pragmatic choice.
 * The invariant — skip `ask_end` rollups (spec/16 §10), guard against
 * NaN/Infinity/negative costs — is simple enough that drift is unlikely.
 * Server-side code imports the real `eventCostContribution` from
 * `@axlsdk/axl`; anything in `src/client/` uses this local copy.
 *
 * Tracked in `.internal/FOLLOWUPS.md` P1: "Studio client `AxlEvent`
 * loose-type duplication" — same root cause, same fix path (bundle an
 * event-utils entry point or make the core browser-safe).
 */
import type { AxlEvent } from './types.js';

export function eventCostContribution(event: AxlEvent): number {
  if (event.type === 'ask_end') return 0;
  const c = event.cost;
  return typeof c === 'number' && Number.isFinite(c) && c >= 0 ? c : 0;
}
