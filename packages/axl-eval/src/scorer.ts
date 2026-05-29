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

export type ScorerConfig<TOutput = unknown, TInput = unknown, TAnnotations = unknown> = {
  name: string;
  description: string;
  score: ScorerFn<TOutput, TInput, TAnnotations>;
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
};

export function scorer<TOutput = unknown, TInput = unknown, TAnnotations = unknown>(
  config: ScorerConfig<TOutput, TInput, TAnnotations>,
): Scorer<TOutput, TInput, TAnnotations> {
  return {
    name: config.name,
    description: config.description,
    isLlm: false,
    score: config.score,
  };
}
