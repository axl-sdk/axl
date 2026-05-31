import type { Provider } from '@axlsdk/axl';

/** Result from a scorer that includes metadata beyond the numeric score. */
export type ScorerResult = {
  score: number;
  metadata?: Record<string, unknown>;
  cost?: number;
};

/** Normalize a scorer return value to a ScorerResult. */
export function normalizeScorerResult(result: number | ScorerResult): ScorerResult {
  return typeof result === 'number' ? { score: result } : result;
}

/**
 * Cost contract for thrown scorer errors. A scorer (e.g. `llmScorer`) that
 * incurs provider cost *before* failing attaches that cost to the thrown error
 * via {@link attachScorerErrorCost} so the eval runner still bills it. The
 * cost rides as an enumerable `cost` property (a small, stable public contract
 * custom scorers can also use). These helpers replace scattered `(err as any).cost`
 * reads/writes with one typed, finite-guarded surface.
 */
export function attachScorerErrorCost(err: unknown, cost: number | undefined): void {
  if (
    err &&
    typeof err === 'object' &&
    typeof cost === 'number' &&
    Number.isFinite(cost) &&
    cost >= 0
  ) {
    (err as { cost?: number }).cost = cost;
  }
}

/** Read a non-negative finite cost off a thrown scorer error, or `undefined`. */
export function extractScorerErrorCost(err: unknown): number | undefined {
  const v = err && typeof err === 'object' ? (err as { cost?: unknown }).cost : undefined;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Context passed to scorers by the eval runner. */
export type ScorerContext = {
  /** Resolve a provider:model URI to a provider instance and model name. */
  resolveProvider: (modelUri: string) => { provider: Provider; model: string };
  /** Abort signal forwarded from the eval runner; scorers should pass it into provider calls. */
  signal?: AbortSignal;
};

export type ScorerFn<TOutput, TInput, TAnnotations> = (
  output: TOutput,
  input: TInput,
  annotations?: TAnnotations,
) => number | ScorerResult;

/**
 * Applicability predicate for a conditional scorer. Returns `true` if this
 * scorer should run for the given item, `false` to skip it.
 *
 * The eval runner runs every scorer against every item, so a scorer that only
 * applies to a subset (a refusal judge for refusal-expected items, a constraint
 * judge for constrained items, …) declares its scope here. A skipped item is
 * counted as NEITHER `scored` NOR `failed` — it's excluded from the mean AND
 * from the failure-rate denominator, so a conditional scorer stays honest to
 * both. The predicate runs BEFORE the scorer body, so an inapplicable
 * `llmScorer` never makes its provider call.
 *
 * Signature mirrors {@link ScorerFn} (`output, input, annotations`). Applicability
 * usually keys off `input`/`annotations` (e.g. a flag or exercise type), but
 * `output` is available too (e.g. "only score outputs that refused"). A
 * predicate that THROWS is a bug, not a skip — it's recorded as a scorer
 * failure, never silently swallowed.
 *
 * The contract is `=> boolean`: return `true` to run, `false` to skip. The
 * runtime is defensively lenient — it coerces with `!verdict`, so a stray falsy
 * value (a predicate that forgot to `return`) skips rather than crashes — but
 * authors should return a real boolean. When deriving from a truthy value,
 * coerce it yourself: `(o, i, a) => !!a.constraints?.length`, not
 * `=> a.constraints?.length` (which is `number | undefined`, a type error). A
 * predicate that accidentally never returns therefore skips EVERY item — but
 * that surfaces conspicuously as a non-zero `skipped` count (the Studio "N/A"
 * chip), not as a silently green mean.
 */
export type ScorerApplies<TOutput, TInput, TAnnotations> = (
  output: TOutput,
  input: TInput,
  annotations?: TAnnotations,
) => boolean;

export type ScorerConfig<TOutput = unknown, TInput = unknown, TAnnotations = unknown> = {
  name: string;
  description: string;
  score: ScorerFn<TOutput, TInput, TAnnotations>;
  /** Optional applicability predicate — see {@link ScorerApplies}. When it
   *  returns `false`, the scorer is skipped for that item (counted as neither
   *  scored nor failed). Omit to run on every item (the default).
   *
   *  Declared with **method syntax** (not a function-valued property) for parity
   *  with {@link Scorer.applies}, where the syntax is load-bearing: see the note
   *  there and `__tests__/scorer-assignability.test-d.ts`. */
  applies?(output: TOutput, input: TInput, annotations?: TAnnotations): boolean;
};

export type Scorer<TOutput = unknown, TInput = unknown, TAnnotations = unknown> = {
  readonly name: string;
  readonly description: string;
  readonly isLlm: boolean;
  score(
    output: TOutput,
    input: TInput,
    annotations?: TAnnotations,
    context?: ScorerContext,
  ): number | ScorerResult | Promise<number | ScorerResult>;
  /** See {@link ScorerApplies}. Evaluated by the runner before {@link score}.
   *
   *  Declared with **method syntax** (not a function-valued `ScorerApplies`
   *  property) so its parameters are checked bivariantly, exactly like
   *  {@link score}. `EvalConfig.scorers` erases the generics to
   *  `Scorer<unknown, unknown, unknown>[]`; under `strictFunctionTypes` a
   *  property would make those params contravariant, so a concretely-typed
   *  `Scorer<…, TInput, TAnnotations>` would no longer be assignable to that
   *  array (the 0.18.1 regression). `__tests__/scorer-assignability.test-d.ts`
   *  locks this in and is compiled by the `typecheck` gate. */
  applies?(output: TOutput, input: TInput, annotations?: TAnnotations): boolean;
};

export function scorer<TOutput = unknown, TInput = unknown, TAnnotations = unknown>(
  config: ScorerConfig<TOutput, TInput, TAnnotations>,
): Scorer<TOutput, TInput, TAnnotations> {
  return {
    name: config.name,
    description: config.description,
    isLlm: false,
    score: config.score,
    applies: config.applies,
  };
}
