import type { z } from 'zod';
import type { WorkflowContext } from './context.js';

/** Workflow configuration */
export type WorkflowConfig<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> = {
  name: string;
  input: TInput;
  output?: TOutput;
  handler: (ctx: WorkflowContext<z.infer<TInput>>) => Promise<z.infer<TOutput>>;
};

/** A defined workflow instance */
export type Workflow<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> = {
  readonly name: string;
  readonly inputSchema: TInput;
  readonly outputSchema: TOutput | undefined;
  readonly handler: (ctx: WorkflowContext<z.infer<TInput>>) => Promise<z.infer<TOutput>>;
};

/**
 * Define a named workflow with Zod-validated input/output and an async handler.
 * Register workflows with `AxlRuntime.register()` to execute them.
 * @param config - Workflow configuration: name, input schema, optional output schema, and async handler receiving a WorkflowContext.
 * @returns A Workflow instance ready to be registered with an AxlRuntime.
 */
export function workflow<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny = z.ZodTypeAny>(
  config: WorkflowConfig<TInput, TOutput>,
): Workflow<TInput, TOutput> {
  return {
    name: config.name,
    inputSchema: config.input,
    outputSchema: config.output,
    handler: config.handler,
  };
}
