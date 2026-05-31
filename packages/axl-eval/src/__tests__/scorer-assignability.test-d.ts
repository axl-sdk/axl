/**
 * Compile-time guard for scorer generic-erasure assignability.
 *
 * `EvalConfig.scorers` (and `scoreItem`/`rescore`) erase the scorer generics to
 * `Scorer<unknown, unknown, unknown>`. For that erasure to type-check under
 * `strictFunctionTypes`, EVERY function-typed member on `Scorer` must use
 * **method syntax** (parameters checked bivariantly), not a function-valued
 * property (parameters checked contravariantly). A property-style `applies`
 * regressed exactly this in 0.18.1: a `Scorer<…, ConcreteAnnotations>` stopped
 * being assignable to `Scorer<…, unknown>`, so every typed scorer passed to
 * `defineEval` failed to compile.
 *
 * This file is type-checked by `pnpm typecheck` (`tsc --noEmit`) — the eval
 * tsconfig includes the whole `src` tree and excludes only the runtime test
 * glob (`.test.ts`), so a `.test-d.ts` file IS compiled. There is no runtime
 * assertion; vitest's test glob never executes it. If a future function member
 * on these types reverts to property syntax, these assignments stop compiling
 * and CI's typecheck gate fails.
 */
import { scorer } from '../scorer.js';
import type { Scorer } from '../scorer.js';

type ConcreteAnnotations = { expected: string };
type ConcreteInput = { question: string };

// A scorer built with concrete generics (the type-safe-callback common case)…
const typed = scorer<unknown, ConcreteInput, ConcreteAnnotations>({
  name: 'demo',
  description: 'demo',
  score: (_o, _i, a) => (a?.expected ? 1 : 0),
  applies: (_o, _i, a) => !!a?.expected,
});

// …must remain assignable to the erased element type of `EvalConfig.scorers`
// (`Scorer<unknown, unknown, unknown>[]`). This is the exact assignment that
// `defineEval({ scorers: [typed] })` performs. It compiles only while every
// function-typed member of `Scorer` — `score` AND `applies` — uses method
// syntax. (Note: the input `ScorerConfig` is intentionally NOT guarded here —
// its `score` is a `ScorerFn` property, so it is non-erasable by design, and it
// is only ever used as a contextually-typed literal argument to `scorer()`,
// never stored in an erased collection.)
const erased: Scorer<unknown, unknown, unknown>[] = [typed];
void erased;
