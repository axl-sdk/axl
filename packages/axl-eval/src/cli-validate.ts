import type { EvalConfig } from './types.js';

/**
 * Validate an eval config's required fields and produce a diagnostic string
 * if invalid. Returns `undefined` when the config passes.
 *
 * Returns a single-line message tail (caller prepends the file path) so the
 * full error reads like: `Error: <file> <message>`.
 *
 * Goes beyond a falsy check to:
 *   - catch `scorers: []` which previously silently ran with no scorers
 *   - reject scorers arrays that contain non-callable entries (e.g. typo
 *     `scorers: [null, undefined]` would crash deep inside `runEval`)
 *   - reject non-string `workflow` (downstream `runtime.getWorkflow(...)`
 *     would silently miss it)
 *   - reject non-object `dataset` (must be a `dataset()` factory result)
 *   - provide a `Got: { keys: [...] }` hint so users can spot typos like
 *     `scorerS` vs `scorers` immediately
 *
 * Lives in its own module so unit tests can import it without triggering
 * `cli.ts`'s `main()` at module load time.
 */
export function validateEvalConfig(cfg: unknown): string | undefined {
  if (!cfg || typeof cfg !== 'object') {
    return `does not export a valid eval config — got ${cfg === null ? 'null' : typeof cfg}.`;
  }
  const c = cfg as Partial<EvalConfig>;
  const missing: string[] = [];
  if (!c.workflow) missing.push('workflow');
  if (!c.dataset) missing.push('dataset');
  if (!c.scorers) missing.push('scorers');

  if (missing.length > 0) {
    const keys = Object.keys(c as object).slice(0, 10);
    const got = keys.length > 0 ? ` Got: { ${keys.join(', ')} }.` : '';
    return `does not export a valid eval config (missing ${missing.join(', ')}).${got}`;
  }

  if (typeof c.workflow !== 'string') {
    return `exports a non-string workflow (got ${typeof c.workflow}) — workflow must be the registered workflow name.`;
  }
  if (typeof c.dataset !== 'object' || Array.isArray(c.dataset)) {
    return `exports a non-object dataset (got ${Array.isArray(c.dataset) ? 'array' : typeof c.dataset}) — use the dataset() factory.`;
  }
  if (typeof (c.dataset as { getItems?: unknown }).getItems !== 'function') {
    return `exports a dataset without a getItems() method — use the dataset() factory.`;
  }
  if (!Array.isArray(c.scorers) || c.scorers.length === 0) {
    return `exports an empty scorers array — at least one scorer is required.`;
  }
  const badScorerIdx = c.scorers.findIndex(
    (s) => !s || typeof (s as { score?: unknown }).score !== 'function',
  );
  if (badScorerIdx !== -1) {
    return `exports a scorers array with a non-scorer entry at index ${badScorerIdx} — each scorer must have a score() method (use the scorer() factory).`;
  }
  // Concurrency knobs must be positive integers when present. The worker pool
  // defensively clamps non-positive/non-finite values to 1 at runtime, but a
  // config that wrote `concurrency: 0` (or NaN via `Number(env)`) almost
  // certainly has a bug — surface it loudly, matching the `--concurrency` flag.
  for (const key of ['concurrency', 'scorerConcurrency'] as const) {
    const v = (c as Record<string, unknown>)[key];
    if (v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || v < 1)) {
      return `exports an invalid ${key} (${typeof v === 'number' ? v : typeof v}) — must be a positive integer.`;
    }
  }
  // The failure-rate gate must fail loud on a bad value, symmetric with the
  // `--max-scorer-error-rate` flag. Without this, a typo (e.g. `5` meaning "5%")
  // only `console.warn`s at runtime and silently disables the gate the user
  // explicitly opted into — the exact silent-no-op the feature exists to catch.
  {
    const v = (c as Record<string, unknown>).failOnScorerErrorRate;
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)) {
      return `exports an invalid failOnScorerErrorRate (${typeof v === 'number' ? v : typeof v}) — must be a number between 0 and 1.`;
    }
  }
  return undefined;
}
