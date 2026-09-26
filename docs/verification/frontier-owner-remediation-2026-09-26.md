# Frontier owner remediation live verification

**Date:** 2026-09-26  
**Scope:** the two live rows left open by the owner remediation of the
frontier model refresh: GPT-6 portable-temperature handling under default
effort, and Opus 5.5 reuse of a persisted per-agent ask-summary boundary
across two session executions.  
**Command:** `vitest run --config vitest.frontier-integration.config.ts
src/__tests__/integration-latest-models.test.ts -t "strips a portable
temperature|reuses a persisted ask-summary boundary"` in `packages/axl`.

## Rows

| Row | Provider / model | Scenario and assertion | Result |
| --- | --- | --- | --- |
| GPT-6 sampling | `openai:` and `openai-responses:` × `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna` | A portable `temperature: 0.2` with no explicit effort. The captured wire body has no `temperature` or `top_p` and no explicit effort; the provider returns a metered answer with usage and a static cost estimate. | 6 of 6 passed. |
| Opus boundary reuse | `anthropic:claude-opus-5-5`, `effort: 'max'`, `maxContext: 3400` | 40 stored turns plus a reasoning question in execution one, which summarizes and produces signed thinking on its final answer. Execution two on the same session makes no summary call, sends the identical summary system prefix, replays the kept thinking block by signature under `drop_block`, and emits no `reasoning_context_reset` from Axl or Anthropic. | Passed with 3 metered calls, 0 unpriced, usage-based estimate $0.072540. |

## Limits

- The Opus row proves reuse across two in-process executions with the default
  in-memory store. SQLite and Redis round trips of the `askSummary:*` record are
  covered by deterministic key-reordering tests, not live.
- If the model returns no signed thinking on the first execution, the test
  fails with a named reason rather than passing vacuously; this run produced
  one.
- Cost figures are Axl's usage-based estimates, not invoice audits. OpenAI
  cache-write and long-context billing remain unverified live, as recorded in
  `frontier-model-refresh-2026-09-25.md`.
