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
  '--concurrency',
  '--scorers',
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
]);

export type ParsedEvalArgs = {
  outputPath?: string;
  configArg?: string;
  conditions: string[];
  runs: number;
  captureTraces: boolean;
  /** Item-level concurrency override (flag value). Clamped to >= 1. */
  concurrency?: number;
  /** Scorer names from `--scorers` (deduped, in first-seen order). */
  scorerNames?: string[];
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

export function parseEvalArgs(args: string[]): ParsedEvalArgs {
  let outputPath: string | undefined;
  let configArg: string | undefined;
  let conditions: string[] = [];
  let runs = 1;
  let captureTraces = false;
  let concurrency: number | undefined;
  let scorerNames: string[] | undefined;
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
    concurrency,
    scorerNames,
    paths,
  };
}
