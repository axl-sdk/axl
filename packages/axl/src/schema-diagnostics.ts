import type { z } from 'zod';

/**
 * Schema-diagnostics helpers (spec 22, Problem E).
 *
 * Two responsibilities live here so `context.ts` stays focused on the ask
 * pipeline:
 *  1. `detectDroppedRefinements` — find `.refine()`/`.superRefine()` checks that
 *     `z.toJSONSchema` silently drops, so we can tell the user (the model never
 *     sees the rule, then `.parse` rejects → wasted retries).
 *  2. `warnDiagnosticOnce` (aliased `warnSchemaDiagnosticOnce`) — the
 *     process-level, deduped `console.warn` mirror of the shipped
 *     budget-unpriced precedent, so the high-value cliffs reach the median
 *     consumer (who never wires up `ctx.events` and runs with the trace console
 *     off by default). Shared with the runtime's `provider_diagnostic` warning.
 */

/** Default token threshold for the `prompt_schema_oversized` diagnostic.
 *  Measured with the same ~4-chars/token estimator used for context
 *  management. Config-overridable via `AxlConfig.diagnostics.schemaOversizedTokens`. */
export const DEFAULT_SCHEMA_OVERSIZED_TOKENS = 4000;

/** Result of scanning a schema tree for refinements JSON-Schema can't represent. */
export type DroppedRefinements = {
  /** Number of `.refine()`/`.superRefine()` checks found across the tree. */
  count: number;
  /** Dot/bracket paths of the schema nodes carrying at least one such check
   *  (`'<root>'` for a top-level refinement). De-duplicated; structural, not PII. */
  paths: string[];
};

// Memoize by schema identity — the tool-def path re-scans a stable
// `tool.inputSchema` every ask, and const/agent-config schemas are stable too.
const refinementCache = new WeakMap<z.ZodType, DroppedRefinements>();

/**
 * Recurse a Zod v4 schema tree and report `.refine()`/`.superRefine()` checks —
 * which Zod keeps as `check: 'custom'` entries in `_zod.def.checks` and which
 * `z.toJSONSchema` drops. Plain constraints (`.min()`, `.email()`, `.regex()`,
 * …) are NOT custom checks and ARE rendered, so they are not reported.
 *
 * Traversal is defensive: it reads documented-but-internal `_zod.def` shapes,
 * guards against cycles (recursive/`z.lazy` schemas) with a visited set, and
 * treats any unrecognized node as a leaf (checks-only). A structural miss
 * degrades to "no refinement reported", never a throw.
 */
export function detectDroppedRefinements(schema: z.ZodType): DroppedRefinements {
  const cached = refinementCache.get(schema);
  if (cached) return cached;

  const paths = new Set<string>();
  let count = 0;
  const visited = new WeakSet<object>();

  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object') return;
    if (visited.has(node)) return;
    visited.add(node);

    const def = (node as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
    if (!def) return;

    const here = () => paths.add(path === '' ? '<root>' : path);

    // 1a. `.refine()`/`.superRefine()` attach a `custom` CHECK to an otherwise
    //     normal node (e.g. a ZodObject with `checks: [{ check: 'custom' }]`).
    const checks = def.checks;
    if (Array.isArray(checks)) {
      for (const check of checks) {
        const kind = (check as { _zod?: { def?: { check?: string } } })?._zod?.def?.check;
        if (kind === 'custom') {
          count += 1;
          here();
        }
      }
    }
    // 1b. `z.custom()` / `z.instanceof()` are custom-TYPE nodes: the validator
    //     lives directly on the def (`def.type === 'custom'`, `def.check ===
    //     'custom'`, no `checks` array) and `z.toJSONSchema` renders them to a
    //     literally empty `{}` — the most opaque cliff, worse than a dropped
    //     `.refine()` (which at least renders the base type). Count it once.
    if (def.check === 'custom') {
      count += 1;
      here();
    }

    // 2. Recurse into children by container shape.
    const join = (child: string) => (path === '' ? child : `${path}.${child}`);

    // object: { shape: Record<string, ZodType> }
    const shape = def.shape as Record<string, unknown> | undefined;
    if (shape && typeof shape === 'object') {
      for (const [key, child] of Object.entries(shape)) walk(child, join(key));
    }
    // array: { element }
    if ('element' in def) walk(def.element, `${path}[]`);
    // union / discriminatedUnion: { options: ZodType[] } — arms share the path.
    if (Array.isArray(def.options)) {
      for (const opt of def.options) walk(opt, path);
    }
    // optional / nullable / default / catch / readonly / etc: { innerType }
    if ('innerType' in def) walk(def.innerType, path);
    // tuple: { items: ZodType[], rest? }
    if (Array.isArray(def.items)) {
      def.items.forEach((item, i) => walk(item, `${path}[${i}]`));
    }
    if ('rest' in def && def.rest) walk(def.rest, `${path}[]`);
    // object catchall: { catchall } — the value schema for extra keys.
    if ('catchall' in def && def.catchall) walk(def.catchall, `${path}[*]`);
    // record / map: { keyType, valueType } — refinements can live on the KEY too
    // (rendered as `propertyNames`, and a `.refine()` there is dropped).
    if ('keyType' in def) walk(def.keyType, `${path}[key]`);
    if ('valueType' in def) walk(def.valueType, `${path}[*]`);
    // pipe / transform: { in, out } — refinements can live on either side.
    if ('in' in def) walk(def.in, path);
    if ('out' in def) walk(def.out, path);
    // intersection: { left, right }
    if ('left' in def) walk(def.left, path);
    if ('right' in def) walk(def.right, path);
    // lazy: { getter() } — resolve once; the visited set stops infinite recursion.
    if (typeof def.getter === 'function') {
      try {
        walk((def.getter as () => unknown)(), path);
      } catch {
        // A getter that throws (unusual) simply contributes no refinement info.
      }
    }
  };

  walk(schema, '');
  const result: DroppedRefinements = { count, paths: [...paths] };
  refinementCache.set(schema, result);
  return result;
}

// ── One-time deduped console.warn (R8) ───────────────────────────────────────

const DOCS_URL = 'docs/observability.md#schema-diagnostics';
/** Cap so a process that mints dynamic agent names (e.g. `agent-<uuid>` per
 *  request/tenant) can't grow this Set without bound. On overflow we clear it —
 *  at worst a warning repeats after thousands of distinct cliffs, which is far
 *  better than an unbounded leak. */
const MAX_WARNED_KEYS = 2048;
const warnedDiagnosticKeys = new Set<string>();

/**
 * Emit a `console.warn` at most once per `key`, unless silenced. Mirrors the
 * budget-unpriced precedent (`context.ts`): the structured `schema_diagnostic`
 * event always fires; this is the extra push so a consumer who never subscribes
 * to `ctx.events` and runs with the trace console off still sees the cliff.
 *
 * `key` should encode agent + kind + a schema discriminator so the same cliff
 * on the same agent/schema warns once but distinct ones each get a voice.
 * Silenceable via `AxlConfig.diagnostics.silent` (passed as `silent`) or
 * `AXL_DIAGNOSTICS_SILENT=true`.
 */
export function warnDiagnosticOnce(
  key: string,
  message: string,
  silent?: boolean,
  docs: string = DOCS_URL,
): void {
  if (silent || process.env.AXL_DIAGNOSTICS_SILENT === 'true') return;
  if (warnedDiagnosticKeys.has(key)) return;
  if (warnedDiagnosticKeys.size >= MAX_WARNED_KEYS) warnedDiagnosticKeys.clear();
  warnedDiagnosticKeys.add(key);
  console.warn(`[axl] ${message} See ${docs}.`);
}

/** Historical name for {@link warnDiagnosticOnce}, kept so the schema-diagnostic
 *  call sites (and their tests) read the same as before. The memo is shared:
 *  every runtime diagnostic warning dedupes through the same key space. */
export const warnSchemaDiagnosticOnce = warnDiagnosticOnce;

/** Test-only: clear the one-time-warn memo so dedup behavior can be asserted in
 *  isolation. Not part of the public barrel. */
export function __resetSchemaDiagnosticWarnings(): void {
  warnedDiagnosticKeys.clear();
}

/** Test-only alias of {@link __resetSchemaDiagnosticWarnings} for callers that
 *  reset the shared memo for a non-schema diagnostic. Not part of the public
 *  barrel. */
export const __resetDiagnosticWarnings = __resetSchemaDiagnosticWarnings;
