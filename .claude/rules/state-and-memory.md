---
paths:
  - "packages/axl/src/state/**"
  - "packages/axl/src/memory/**"
---

# State stores & memory

## State stores (`state/`)
`StateStore` (`state/types.ts`) is the persistence interface. Built-ins: `MemoryStore`
(in-memory), `SQLiteStore` (file), `RedisStore` (node-redis v5 peer dep).

- **`StateConfig.store` takes `'memory' | 'sqlite' | StateStore`.** `'redis'` is **not** a
  valid string — construct `await RedisStore.create(url | options)` and pass the instance
  (a private constructor enforces the async factory).
- **`deleteExecution` is a total sweep** (GDPR right-to-be-forgotten). A custom store's
  `deleteExecution` must drop the canonical row + indexes + checkpoints + suspended state +
  pending decisions + streaming buffer in one transaction. The runtime no longer calls
  separate cleanup methods.
- **Streaming persistence** (`state.persist: 'streaming'`) is implemented by `MemoryStore`
  and `RedisStore` but **not** `SQLiteStore` (it warns once — use `'terminal'`). High-volume
  `token`/`partial_object`/`string_delta` are never flushed (reconstructable from
  `agent_call_end`).
- History (executions, eval results) auto-persists and lazy-loads. RedisStore TTLs, window
  semantics, and crash recovery are the per-category contract in
  `docs/migration/state-store-durability.md` + `docs/integration.md` — read those rather
  than restating them here.

## Memory (`memory/`)
`MemoryManager` coordinates key-value (StateStore) + semantic (`VectorStore` + `Embedder`).
`ctx.remember` / `ctx.recall` / `ctx.forget` are the surface.

- **`Embedder.embed()` returns `{ vectors, usage? }`** — custom embedders must wrap
  `number[][]` in `{ vectors }`.
- **Embedder spend rides the same cost rail as provider spend** via the central budget
  accumulator — `ctx.budget()` enforces against memory ops too, and they throw
  `BudgetExceededError` *before* hitting the embedder once exceeded.
- Semantic recall filters vector hits by id prefix (the store lacks metadata filtering);
  `embed` is opt-in (`embed: true`). All save/get memory ops `structuredClone`.

Embedder pricing tables live in `embedder-openai.ts` — don't duplicate them.
