import type { z } from 'zod';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

export type DatasetItem<TInput, TAnnotations = undefined> = {
  input: TInput;
  annotations?: TAnnotations;
};

export type DatasetConfig<
  TInput extends z.ZodTypeAny,
  TAnnotations extends z.ZodTypeAny = z.ZodTypeAny,
> = {
  name: string;
  schema: TInput;
  annotations?: TAnnotations;
  items?: DatasetItem<z.infer<TInput>, z.infer<TAnnotations>>[];
  file?: string;
  /** Base directory for resolving relative file paths. Defaults to cwd. */
  basePath?: string;
};

export type Dataset<TInput = unknown, TAnnotations = unknown> = {
  readonly name: string;
  readonly schema: z.ZodTypeAny;
  readonly annotationsSchema?: z.ZodTypeAny;
  getItems(): Promise<DatasetItem<TInput, TAnnotations>[]>;
};

export function dataset<TInput extends z.ZodTypeAny, TAnnotations extends z.ZodTypeAny>(
  config: DatasetConfig<TInput, TAnnotations>,
): Dataset<z.infer<TInput>, z.infer<TAnnotations>> {
  return {
    name: config.name,
    schema: config.schema,
    annotationsSchema: config.annotations,
    async getItems() {
      if (config.items && config.file) {
        throw new Error('Dataset config error: "items" and "file" are mutually exclusive');
      }
      if (!config.items && !config.file) {
        throw new Error('Dataset config error: either "items" or "file" must be provided');
      }
      if (config.items) {
        return config.items.map((item) => ({
          input: config.schema.parse(item.input),
          annotations:
            item.annotations && config.annotations
              ? config.annotations.parse(item.annotations)
              : item.annotations,
        }));
      }
      const resolvedPath = path.resolve(config.basePath ?? process.cwd(), config.file!);
      const content = await readFile(resolvedPath, 'utf-8');
      const items = JSON.parse(content) as DatasetItem<z.infer<TInput>, z.infer<TAnnotations>>[];
      return items.map((item) => ({
        input: config.schema.parse(item.input),
        annotations:
          item.annotations && config.annotations
            ? config.annotations.parse(item.annotations)
            : item.annotations,
      }));
    },
  };
}
