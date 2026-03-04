export type ScorerFn<TOutput, TInput, TAnnotations> = (
  output: TOutput,
  input: TInput,
  annotations?: TAnnotations,
) => number;

export type ScorerConfig<TOutput = unknown, TInput = unknown, TAnnotations = unknown> = {
  name: string;
  description: string;
  score: ScorerFn<TOutput, TInput, TAnnotations>;
};

export type Scorer<TOutput = unknown, TInput = unknown, TAnnotations = unknown> = {
  readonly name: string;
  readonly description: string;
  readonly isLlm: boolean;
  score(output: TOutput, input: TInput, annotations?: TAnnotations): number | Promise<number>;
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
