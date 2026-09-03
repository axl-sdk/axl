/**
 * Per-model token density, calibrated from what providers actually bill.
 *
 * Context-window management needs to know how many tokens a stretch of text
 * will occupy before sending it. A fixed chars-per-token constant cannot answer
 * that: real workload text ranges from about 4 characters per token for English
 * prose down to 1-2 for minified JSON, source code, or CJK, and the ratio also
 * shifts when a provider ships a new tokenizer — Claude Opus 4.7 and later
 * produce roughly 30% more tokens for the same text than earlier Claude models.
 * A single constant is therefore wrong in a direction that changes per workload,
 * and under-estimating is the dangerous direction: history stays unsummarized
 * until the provider rejects the request for exceeding its context window.
 *
 * Providers already report the ground truth in `usage.prompt_tokens`. So rather
 * than guessing per model, observe: compare the characters actually sent against
 * the prompt tokens billed for them, and fold the result into a per-model
 * exponentially-weighted ratio that the next context-window check uses.
 *
 * This feeds the compaction threshold only. Cost is always computed from
 * provider-reported token counts, never from an estimate.
 */

/**
 * Tokens per character assumed before any measurement lands. The historical
 * ~4-chars-per-token heuristic, kept as the cold-start value: the first turn of
 * a run has nothing to calibrate against, and compaction only matters once a
 * history has accumulated over several turns, by which point real samples exist.
 */
export const FALLBACK_TOKENS_PER_CHAR = 1 / 4;

/**
 * Ratios outside this band are not plausible text-token densities. A sample can
 * land outside it when the prompt contained billed content with no character
 * footprint (images, audio, cached-media references) or when a provider reports
 * usage on a different basis than the request we measured. Such a sample is
 * discarded rather than allowed to skew the threshold.
 */
const MIN_TOKENS_PER_CHAR = 1 / 10;
const MAX_TOKENS_PER_CHAR = 1;

/**
 * Weight given to each new observation. Low enough that one atypical turn
 * cannot swing the threshold, high enough to converge within a few turns.
 */
const SMOOTHING = 0.3;

/**
 * Samples below this many characters carry too little signal: per-message
 * overhead and the fixed tool-definition preamble dominate, so the implied
 * ratio says more about the envelope than about the content.
 */
const MIN_SAMPLE_CHARS = 200;

/**
 * Tracks observed token density per model. Scoped to a single
 * `WorkflowContext`, matching the scope of the history it informs — a run's own
 * traffic is the best available predictor of its next turn, and nothing is
 * shared across runs.
 */
export class TokenRatioCalibrator {
  private readonly ratios = new Map<string, number>();

  /**
   * Record one text-only turn: `chars` is the character count of the prompt
   * content measured the same way the estimator measures it, and `promptTokens`
   * is the provider's billed input count for that prompt.
   *
   * Callers must skip turns whose prompt carried media — those tokens have no
   * character footprint and would inflate the ratio for later text-only turns.
   */
  observe(model: string, chars: number, promptTokens: number): void {
    if (!Number.isFinite(chars) || chars < MIN_SAMPLE_CHARS) return;
    if (!Number.isFinite(promptTokens) || promptTokens <= 0) return;

    const observed = promptTokens / chars;
    if (observed < MIN_TOKENS_PER_CHAR || observed > MAX_TOKENS_PER_CHAR) return;

    const previous = this.ratios.get(model);
    this.ratios.set(
      model,
      previous === undefined ? observed : previous + SMOOTHING * (observed - previous),
    );
  }

  /**
   * Tokens per character to use for `model`, or the cold-start fallback when
   * this run has not yet measured a usable sample for it.
   */
  tokensPerChar(model: string): number {
    return this.ratios.get(model) ?? FALLBACK_TOKENS_PER_CHAR;
  }

  /** Observed ratio for `model`, or `undefined` when still uncalibrated. */
  observedTokensPerChar(model: string): number | undefined {
    return this.ratios.get(model);
  }
}
