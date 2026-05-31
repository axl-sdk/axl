---
paths:
  - "packages/axl-eval/**"
---

# Evals (`packages/axl-eval`)

`dataset()` + `scorer()` / `llmScorer()` feed `runEval()`; `axl-eval` is the CLI.

```
src/
  dataset.ts        dataset() + extra-annotation-key detection
  scorer.ts llm-scorer.ts   scorer factories (+ optional `applies` predicate)
  score-item.ts     scoreItem(): the ONE per-item scoring loop (runEval + rescore share it)
  runner.ts         runEval() — concurrent items AND scorers (mapWithConcurrency)
  compare.ts bootstrap.ts    evalCompare() + paired bootstrap CI
  rescore.ts multi-run.ts    re-score saved outputs / aggregate runs
  cli*.ts           CLI entry, arg parsing, validation, loader utils
```

## Conventions & footguns
- **Function-typed members of `Scorer` use METHOD syntax, never a function-valued property.**
  `EvalConfig.scorers` erases the generics to `Scorer<unknown, unknown, unknown>[]`, so a
  concretely-typed scorer must stay assignable to that. Under `strictFunctionTypes`, method
  params are bivariant (assignable) but property params are contravariant (NOT assignable) —
  so `applies?(o, i, a): boolean` is correct and `applies?: (o, i, a) => boolean` silently
  breaks every typed scorer passed to `defineEval` (the 0.18.1 regression). Same rule for any
  future member on `Scorer`. The `scorer-assignability.test-d.ts` guard locks it in and is
  compiled by the `typecheck` gate (`.test-d.ts` is *not* excluded by tsconfig; `.test.ts` is).
- **`scoreItem()` is the single source of truth** for scoring — both `runEval` and
  `rescore` call it. Don't fork the loop.
- **Cost-folding bug**: write `const c = await scoreItem(...); total += c;` — NEVER
  `total += await scoreItem(...)` (the read of `total` is captured before the await
  suspends → lost updates under concurrency).
- **Three terminal scorer states**: `scored`; `failed` (ran and threw → has a `duration`);
  `skipped` (`applies` returned `false` → `{ score: null, skipped: true }`, no `duration`).
  Skipped items are excluded from the mean **and** the failure-rate denominator. Scope a
  scorer to a subset with `applies` — **not** a `NaN`/out-of-range sentinel (the
  failure-rate gate correctly treats `NaN` as a real failure).
- **Failure-rate gates** are opt-in and type-aware (deterministic = 0 tolerance, since a
  deterministic throw is a bug; LLM = configured rate): source-side
  `EvalConfig.failOnScorerErrorRate` sets `summary.degraded` and **never throws**;
  gate-side `compare --max-scorer-error-rate` refuses to certify. Shared arithmetic lives in
  `evaluateScorerTolerance` / `evaluateScorerErrorRateGate` — reuse, don't reimplement.
- **Concurrency**: item `concurrency` and `scorerConcurrency` share a default (see
  `runner.ts`); worst-case scorer calls = their product. `mapWithConcurrency` coerces/clamps
  bad values in one place — keep it there.
- **CLI** resolves the runtime three ways (`--config` → auto-detect `axl.config.*` → bare
  runtime) and shares loader internals with Studio via `@axlsdk/axl`'s `cli-internals`. A
  total workflow wipeout (every item errored) always exits non-zero. Read `cli-args.ts` for
  the current flag set rather than trusting a copied list. **`--conditions` is ESM-only —
  transitive CJS `require()` chains bypass the resolve hook (see `cli-internals.ts`).**

`docs/testing.md` covers scorer basics. The gates, conditional scorers, and full CLI flag
set are under-documented — deepen the docs when you extend them (see
`.claude/rules/documentation.md`).
