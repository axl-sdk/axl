import type { z } from 'zod';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

export type DatasetItem<TInput, TAnnotations = undefined> = {
  input: TInput;
  annotations?: TAnnotations;
};

/**
 * What to do when a dataset item's `annotations` contain keys that are absent
 * from the `annotations` schema.
 *
 * Zod object schemas strip unknown keys by default, so an annotation field
 * that isn't declared in the schema is silently dropped before it ever reaches
 * a scorer. A scorer that reads such a field sees `undefined` and quietly
 * degrades to a no-op — the eval still "passes", so the bug is invisible. This
 * is especially easy to hit with file-based datasets, where the JSON is never
 * type-checked.
 *
 * - `'warn'` (default) — log a single `console.warn` per dataset listing the
 *   dropped key paths. Non-breaking; surfaces the contract violation.
 * - `'error'` — throw, listing the dropped key paths. The strict path for CI.
 * - `'ignore'` — preserve the silent-strip behavior (skips detection entirely).
 *
 * Only `annotations` are checked, not `input`: stripped input fields flow to
 * the workflow where they surface, whereas stripped annotations vanish into a
 * silent scorer.
 */
export type ExtraKeyPolicy = 'warn' | 'error' | 'ignore';

export type DatasetConfig<TInput extends z.ZodType, TAnnotations extends z.ZodType = z.ZodType> = {
  name: string;
  schema: TInput;
  annotations?: TAnnotations;
  items?: DatasetItem<z.infer<TInput>, z.infer<TAnnotations>>[];
  file?: string;
  /** Base directory for resolving relative file paths. Defaults to cwd. */
  basePath?: string;
  /**
   * How to handle annotation keys not present in the `annotations` schema
   * (Zod strips them by default). Defaults to `'warn'`. See {@link ExtraKeyPolicy}.
   */
  onExtraAnnotationKeys?: ExtraKeyPolicy;
};

export type Dataset<TInput = unknown, TAnnotations = unknown> = {
  readonly name: string;
  readonly schema: z.ZodType;
  readonly annotationsSchema?: z.ZodType;
  /**
   * Annotation key paths the schema dropped during the most recent
   * `getItems()` call (empty when none were dropped, or when
   * `onExtraAnnotationKeys: 'ignore'`). Populated as a side effect of
   * `getItems()` — read it only after awaiting. The eval runner surfaces this
   * into `EvalResult.metadata.droppedAnnotationKeys` so tooling (e.g. Studio)
   * can show the warning the same way the CLI logs it. Optional so hand-rolled
   * `Dataset`-shaped objects (test harnesses) remain valid.
   */
  readonly droppedAnnotationKeys?: readonly string[];
  getItems(): Promise<DatasetItem<TInput, TAnnotations>[]>;
};

/** True for `{}`-style plain objects only — excludes arrays, null, Date, Map, class instances. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively collect key paths present in `raw` but absent from `parsed`
 * (i.e. stripped by the schema). Walks plain objects and arrays; anything else
 * is a leaf. Paths use dot/bracket notation: `persona.tone`, `tags[0].label`.
 * Mode-independent — works whether the schema strips, is strict (which throws
 * before we get here), or is loose (nothing dropped).
 */
function collectDroppedKeys(raw: unknown, parsed: unknown, prefix = ''): string[] {
  if (Array.isArray(raw) && Array.isArray(parsed)) {
    const dropped: string[] = [];
    const n = Math.min(raw.length, parsed.length);
    for (let i = 0; i < n; i++) {
      dropped.push(...collectDroppedKeys(raw[i], parsed[i], `${prefix}[${i}]`));
    }
    return dropped;
  }
  if (isPlainObject(raw) && isPlainObject(parsed)) {
    const dropped: string[] = [];
    for (const key of Object.keys(raw)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!(key in parsed)) {
        dropped.push(path);
      } else {
        dropped.push(...collectDroppedKeys(raw[key], parsed[key], path));
      }
    }
    return dropped;
  }
  return [];
}

export function dataset<TInput extends z.ZodType, TAnnotations extends z.ZodType>(
  config: DatasetConfig<TInput, TAnnotations>,
): Dataset<z.infer<TInput>, z.infer<TAnnotations>> {
  const policy: ExtraKeyPolicy = config.onExtraAnnotationKeys ?? 'warn';

  /**
   * Parse one item's input + annotations, recording any annotation keys the
   * schema dropped into `droppedAcc` (deduped across the whole dataset so we
   * emit a single warning rather than one per item).
   */
  function parseItem(
    item: DatasetItem<z.infer<TInput>, z.infer<TAnnotations>>,
    droppedAcc: Set<string>,
  ): DatasetItem<z.infer<TInput>, z.infer<TAnnotations>> {
    const input = config.schema.parse(item.input);
    if (item.annotations == null || !config.annotations) {
      return { input, annotations: item.annotations };
    }
    const annotations = config.annotations.parse(item.annotations);
    if (policy !== 'ignore') {
      for (const p of collectDroppedKeys(item.annotations, annotations)) droppedAcc.add(p);
    }
    return { input, annotations };
  }

  /** Emit the consolidated warning or throw, once per `getItems()` call. */
  function reportDropped(dropped: Set<string>): void {
    if (dropped.size === 0) return;
    const keys = [...dropped].join(', ');
    if (policy === 'error') {
      throw new Error(
        `Dataset "${config.name}": annotation key(s) dropped by schema: ${keys}. ` +
          `These keys are not declared in the annotations schema, so they were stripped and ` +
          `will never reach scorers. Add them to the schema, or set ` +
          `onExtraAnnotationKeys: 'ignore' to allow stripping.`,
      );
    }
    console.warn(
      `[axl-eval] Dataset "${config.name}": annotation key(s) dropped by schema: ${keys}. ` +
        `These keys are not declared in the annotations schema, so they were stripped and ` +
        `will not reach scorers (a common cause of no-op scorers). Add them to the schema, ` +
        `set onExtraAnnotationKeys: 'error' to fail, or 'ignore' to silence this warning.`,
    );
  }

  // Captured from the most recent getItems() so the runner can surface it
  // structurally (in addition to the console.warn) without re-deriving it.
  let lastDroppedAnnotationKeys: string[] = [];

  return {
    name: config.name,
    schema: config.schema,
    annotationsSchema: config.annotations,
    get droppedAnnotationKeys() {
      return lastDroppedAnnotationKeys;
    },
    async getItems() {
      if (config.items && config.file) {
        throw new Error('Dataset config error: "items" and "file" are mutually exclusive');
      }
      if (!config.items && !config.file) {
        throw new Error('Dataset config error: either "items" or "file" must be provided');
      }

      let rawItems: DatasetItem<z.infer<TInput>, z.infer<TAnnotations>>[];
      if (config.items) {
        rawItems = config.items;
      } else {
        const resolvedPath = path.resolve(config.basePath ?? process.cwd(), config.file!);
        const content = await readFile(resolvedPath, 'utf-8');
        rawItems = JSON.parse(content) as DatasetItem<z.infer<TInput>, z.infer<TAnnotations>>[];
      }

      const dropped = new Set<string>();
      const parsed = rawItems.map((item) => parseItem(item, dropped));
      lastDroppedAnnotationKeys = [...dropped];
      reportDropped(dropped);
      return parsed;
    },
  };
}
