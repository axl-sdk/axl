---
paths:
  - "packages/axl-studio/**"
---

# Studio (`packages/axl-studio`)

A Hono server (`server/`) + React SPA (`client/`) wrapping an `AxlRuntime`. Ships two ways:
standalone CLI (`axl-studio`) and embeddable middleware (`createStudioMiddleware()` from
`@axlsdk/studio/middleware`). Both share the server app, REST routes (`server/routes/`), the
WS protocol (`server/ws/protocol.ts`), and four time-windowed aggregators
(`server/aggregates/`).

## Conventions
- **The server is a thin shell over the runtime** — introspection + REST/WS only. Business
  logic belongs in the core SDK, not here.
- **`readOnly` gates mutating endpoints** via route regexes. Compare is pure computation and
  is *allowed*; import / run / rescore / delete are blocked. Keep the allow/block lists
  precise when adding routes.
- **Redaction happens at the boundary** — `server/redact.ts` for REST, the WS broadcaster
  for sockets — both delegating to core `redactEvent()`. Never serialize raw events when
  `config.trace.redact` is on.
- **Keep WS/REST payloads small**: compare and the streaming-run `done` event are
  ID/pointer-based so they don't hit the WS frame cap or host body-parser limits.
  `POST /api/evals/import` is the one intentionally-large body.
- **Aggregators** rebuild from StateStore history on startup, fold live events, and
  subscribe to `execution_deleted` / `eval_deleted` for immediate eviction. Reducers are
  pure (`server/aggregates/reducers.ts`).
- **Client**: TanStack Query + a WS singleton; panels under `client/panels/`, shared
  primitives under `client/components/shared/`. React component tests opt into jsdom per-file
  (`// @vitest-environment jsdom`).

The `axl-studio` CLI auto-detects a config and accepts `--conditions` for monorepo source
exports — which is **ESM-only** (transitive CJS `require()` bypasses the resolve hook; see
`docs/studio-api.md`).

REST/WS/middleware reference: `docs/studio-api.md`. Build: `pnpm --filter @axlsdk/studio
build` (client via Vite + server via tsup); `pnpm --filter @axlsdk/studio dev` for both.
