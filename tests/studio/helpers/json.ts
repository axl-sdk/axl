/**
 * Typed helper for `await res.json()` in Studio API tests.
 *
 * The Fetch API's `Response.json()` returns `Promise<unknown>` (TS lib), which
 * means every `body.ok`, `body.data`, and `body.error` access in our 1000+
 * `await app.request().json()` call sites errors with TS18046 (body is unknown).
 *
 * Two options:
 *   1. Cast at every site (`(await res.json()) as ApiResponse<unknown>`) —
 *      noisy and easy to forget.
 *   2. Use this helper and forget about it.
 *
 * The body shape is loose on purpose: tests already navigate dynamic API
 * payloads (`body.data.items[0].scores['always-pass']`) and the cost of
 * encoding every endpoint's response shape into a discriminated union here
 * isn't worth it for tests. The envelope (`ok`/`data`/`error`) is what
 * matters; the inner shape stays `any` so existing assertions compile.
 */

/** Loose API envelope used by Studio test assertions. Matches the shape of
 *  `ApiResponse<T>` from `@axlsdk/studio/server/types` but keeps `data` /
 *  `error` typed as `any` so existing test idioms compile without per-site
 *  casts (e.g. `body.data.items[0].scores['always-pass']`). */
export type TestApiBody = {
  ok: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error?: any;
};

/** Read and type-cast a fetch response body for Studio API tests. */
export async function readJson(res: Response): Promise<TestApiBody> {
  return (await res.json()) as TestApiBody;
}
