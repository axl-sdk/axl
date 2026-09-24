/**
 * Argument parsing for the `axl-eval` CLI, factored out of `cli.ts` so it can be
 * unit-tested without importing `cli.ts` (whose module body runs `main()` on
 * import).
 */

export const KNOWN_FLAGS = new Set([
  '--output',
  '--config',
  '--conditions',
  '--fail-on-regression',
  '--threshold',
  '--runs',
  '--capture-traces',
  '--capture-requests',
  '--concurrency',
  '--scorers',
  '--budget',
  '--max-item-error-rate',
]);

/**
 * The subset of flags `parseEvalArgs` consumes a following value for. NOT every
 * value-taking flag in the CLI: `--threshold` takes a value too but is parsed
 * by `runCompare`'s own parser, not here. Every entry MUST also be in
 * {@link KNOWN_FLAGS} — a value-flag missing from KNOWN_FLAGS would be rejected
 * as "unknown", and one missing from VALUE_FLAGS would silently swallow its
 * value into `paths`. A test asserts `VALUE_FLAGS ⊆ KNOWN_FLAGS`.
 */
export const VALUE_FLAGS = new Set([
  '--output',
  '--config',
  '--conditions',
  '--runs',
  '--concurrency',
  '--scorers',
  '--budget',
  '--max-item-error-rate',
]);

export type ParsedEvalArgs = {
  outputPath?: string;
  configArg?: string;
  conditions: string[];
  runs: number;
  captureTraces: boolean;
  /**
   * `--capture-requests`. Requires `config.diagnostics.artifacts` on the
   * resolved runtime; `runEval` raises `DIAGNOSTICS_UNAVAILABLE` before any work
   * when it is missing, rather than after the run has spent money.
   */
  captureRequests: boolean;
  /** Item-level concurrency override (flag value). Clamped to >= 1. */
  concurrency?: number;
  /** Scorer names from `--scorers` (deduped, in first-seen order). */
  scorerNames?: string[];
  /**
   * Raw `--budget` value, forwarded unparsed. Parsing and validation belong to
   * `runEval`/`rescore`, which raise `AxlError('INVALID_BUDGET')` before any
   * work — duplicating the parse here would let the two disagree.
   */
  budget?: string;
  /**
   * `--max-item-error-rate <0..1>`: overrides the eval file's
   * `failOnItemErrorRate` (default `0.05`); `1` disables the gate.
   */
  maxItemErrorRate?: number;
  paths: string[];
};

/**
 * Read a positive integer from an environment variable. Returns `undefined`
 * when the var is absent, non-numeric, or `<= 0`, so a malformed value falls
 * through to the next precedence tier rather than poisoning the run.
 */
export function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw == null || raw === '') return undefined;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

/**
 * Parse an error-rate flag value strictly, exiting non-zero on anything that is
 * not a clean decimal in `[0, 1]`. `parseFloat('0.5abc')` is `0.5` and
 * `parseFloat('5')` is a 500% limit — either would silently change what a gate
 * enforces, so neither is accepted.
 */
export function parseErrorRateFlag(flag: string, raw: string): number {
  const n = /^\d*\.?\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    console.error(`Error: ${flag} must be a number in [0, 1], got "${raw}"`);
    process.exit(1);
  }
  return n;
}

export function parseEvalArgs(args: string[]): ParsedEvalArgs {
  let outputPath: string | undefined;
  let configArg: string | undefined;
  let conditions: string[] = [];
  let runs = 1;
  let captureTraces = false;
  let captureRequests = false;
  let concurrency: number | undefined;
  let scorerNames: string[] | undefined;
  let budget: string | undefined;
  let maxItemErrorRate: number | undefined;
  const paths: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (VALUE_FLAGS.has(arg)) {
      if (i + 1 >= args.length) {
        console.error(`Error: ${arg} requires a value`);
        process.exit(1);
      }
      const value = args[++i];
      if (arg === '--output') outputPath = value;
      else if (arg === '--config') configArg = value;
      else if (arg === '--runs') runs = Math.max(1, parseInt(value, 10) || 1);
      else if (arg === '--concurrency') {
        // Clamp to a floor of 1 with a warning (matches `--runs`' clamp ethos
        // but surfaces the typo). A `0` here would otherwise spawn zero workers.
        // Note the intentional asymmetry with `envInt` above: an explicit flag
        // typo is worth a warning, whereas a malformed ambient env var falls
        // through silently to the next precedence tier.
        const n = parseInt(value, 10);
        if (!Number.isFinite(n) || n <= 0) {
          console.error(`[axl-eval] Ignoring invalid --concurrency "${value}"; using 1.`);
          concurrency = 1;
        } else {
          concurrency = n;
        }
      } else if (arg === '--budget') {
        budget = value;
      } else if (arg === '--max-item-error-rate') {
        maxItemErrorRate = parseErrorRateFlag(arg, value);
      } else if (arg === '--scorers') {
        scorerNames = [
          ...new Set(
            value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          ),
        ];
      } else {
        conditions = value
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean);
      }
    } else if (arg === '--capture-traces') {
      // Boolean flag — no value consumed.
      captureTraces = true;
    } else if (arg === '--capture-requests') {
      // Boolean flag — no value consumed. Byte bounds are not exposed as flags;
      // the defaults are product limits and a CLI user who needs to change them
      // is already writing a config.
      captureRequests = true;
    } else if (arg.startsWith('--')) {
      if (!KNOWN_FLAGS.has(arg)) {
        console.error(`Unknown flag: ${arg}`);
        process.exit(1);
      }
    } else {
      paths.push(arg);
    }
  }

  return {
    outputPath,
    configArg,
    conditions,
    runs,
    captureTraces,
    captureRequests,
    concurrency,
    scorerNames,
    budget,
    maxItemErrorRate,
    paths,
  };
}
