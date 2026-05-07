/**
 * Browser-safe wire-side reconstructor for the `stringStream` view.
 *
 * Lives in its own module — separate from `event-stream.ts` which
 * imports `node:events`'s `EventEmitter` for `AxlEventBus` — so a
 * browser SPA importing only `stringStreamFromEvents` from
 * `@axlsdk/axl` cannot pull `EventEmitter` into the bundle even under
 * conservative bundler settings (webpack default is "assume side
 * effects unless `sideEffects: false` is set"). This is
 * defense-in-depth alongside `sideEffects: false` in `package.json`:
 * the module split guarantees tree-shaking at the *file* level (no
 * dead-code elimination required), so bundle size stays predictable
 * regardless of bundler configuration.
 *
 * All imports here are type-only (`import type`) and resolve against
 * `types.ts` and `event-stream.ts` — both erased at compile time, no
 * runtime edge.
 */
import type { AxlEvent } from './types.js';
import type { StringStreamEvent, StringStreamFilter } from './event-stream.js';

/**
 * Reconstruct a `stringStream`-shaped view from a raw `AxlEvent` source.
 *
 * Use this when consuming events on the wire (WebSocket / SSE) rather
 * than from a live `AxlStream` / `AxlEventBus` you own. The browser-side
 * SPA has no access to the bus's per-ask accumulator, so each
 * `string_delta` event arrives carrying only the new chars — without
 * the running text. This helper maintains the accumulator client-side,
 * yielding `StringStreamEvent`s with the same `{ delta, accumulated }`
 * shape the server-side `stringStream` view produces.
 *
 * Pure ECMAScript — zero Node dependencies. Safe to bundle for the
 * browser; lives in its own module so even bundlers that don't honor
 * `sideEffects: false` won't pull `node:events` from the AxlEventBus
 * file.
 *
 * Differences from the live-bus view:
 *
 *  - **No late-subscriber seeding.** The function starts accumulating
 *    when iteration begins; if the source has already produced
 *    `string_delta` events before then, those are missed. Server-side
 *    operators wanting cross-reconnect recovery should re-emit current
 *    state on subscribe (out of scope here — the wire transport is the
 *    caller's responsibility).
 *  - **No race-with-bus-iterator concern.** This is a stateless
 *    consumer of an iterable; iterating it twice on the same source
 *    consumes events twice (fork the source first if you need that).
 *  - **No retroactive pending-drop on retry.** The bus view splices
 *    pending events on `pipeline(failed)` to hide attempt-N text from
 *    a buffered consumer. The wire helper has no buffer, so attempt-N
 *    deltas that already yielded stay yielded. The accumulator clear
 *    on `pipeline(failed)` still fires, so the next yielded event has
 *    `accumulated === delta` — a UI re-rendering `event.accumulated`
 *    per yield naturally overwrites stale text in place. Customers
 *    appending `event.delta` to a manual buffer instead must reset the
 *    buffer when `attempt` increases.
 *
 * Same filter / clear semantics as the bus view:
 *
 *  - `opts.path` / `opts.askId` filter at yield time.
 *  - `pipeline(failed)` clears the per-ask accumulator (so
 *    attempt-N text never leaks into attempt-N+1).
 *  - `ask_end` clears the per-ask accumulator (memory hygiene).
 *
 * Example (browser, consuming Studio's WS firehose):
 *
 * ```ts
 * import { stringStreamFromEvents } from '@axlsdk/axl';
 *
 * async function* readWs(ws: WebSocket): AsyncIterable<AxlEvent> {
 *   const queue: AxlEvent[] = [];
 *   let resolver: (() => void) | null = null;
 *   ws.addEventListener('message', (m) => {
 *     queue.push(JSON.parse(m.data).data);
 *     resolver?.();
 *   });
 *   while (true) {
 *     while (queue.length) yield queue.shift()!;
 *     await new Promise<void>((r) => (resolver = r));
 *   }
 * }
 *
 * for await (const e of stringStreamFromEvents(readWs(ws), { path: '/summary' })) {
 *   setText(e.accumulated);
 * }
 * ```
 */
export async function* stringStreamFromEvents(
  source: AsyncIterable<AxlEvent>,
  opts?: StringStreamFilter,
): AsyncIterable<StringStreamEvent> {
  const filterPath = opts?.path;
  const filterAskId = opts?.askId;
  // Mirror `AxlEventBus.stringStream`'s path validation: walker emits
  // RFC 6901 paths (always leading `/`), so `path: 'summary'` is a typo
  // that would silently never match. Reject early with a clear error.
  if (filterPath !== undefined && filterPath !== '' && !filterPath.startsWith('/')) {
    throw new Error(
      `stringStreamFromEvents({ path }) — path must start with '/' (RFC 6901 JSON Pointer); got ${JSON.stringify(filterPath)}. ` +
        `Examples: '/summary', '/sources/0/title'.`,
    );
  }
  // Per-ask, per-path running accumulator. Mirrors the bus's
  // `stringStreamByAsk` field exactly so behaviour matches across
  // server and client for any consumer that compares the two.
  const acc = new Map<string, Map<string, { agent?: string; text: string; attempt: number }>>();

  for await (const event of source) {
    if (event.type === 'string_delta') {
      const askId = event.askId ?? '';
      let paths = acc.get(askId);
      if (!paths) {
        paths = new Map();
        acc.set(askId, paths);
      }
      const existing = paths.get(event.data.path);
      const accumulated = (existing?.text ?? '') + event.data.delta;
      paths.set(event.data.path, {
        agent: event.agent,
        text: accumulated,
        attempt: event.attempt,
      });
      // Filter at yield time (after accumulator update — non-matching
      // events still feed the accumulator so a later filter change /
      // wildcard subscribe sees consistent state).
      if (filterAskId !== undefined && askId !== filterAskId) continue;
      if (filterPath !== undefined && event.data.path !== filterPath) continue;
      yield {
        askId,
        agent: event.agent,
        path: event.data.path,
        delta: event.data.delta,
        accumulated,
        attempt: event.attempt,
      };
    } else if (event.type === 'pipeline' && event.status === 'failed') {
      // Discarded attempt — clear so attempt-N+1 starts fresh.
      acc.delete(event.askId ?? '');
    } else if (event.type === 'ask_end') {
      // Frees per-ask memory; mirrors bus accumulator's ask_end clear.
      acc.delete(event.askId ?? '');
    }
  }
}
