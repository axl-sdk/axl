import { z } from 'zod';
import type { Scorer, ScorerContext, ScorerResult } from './scorer.js';
import { extractJson, zodToJsonSchema } from '@axlsdk/axl';

export type LlmScorerConfig = {
  name: string;
  description: string;
  model: string;
  system: string;
  schema?: z.ZodType<{ score: number; [key: string]: unknown }>;
  temperature?: number;
};

export function llmScorer(config: LlmScorerConfig): Scorer {
  // Resolve schema and its JSON representation once at construction time —
  // both are fixed for the lifetime of this scorer instance.
  const schema: z.ZodType<{ score: number; [key: string]: unknown }> =
    config.schema ?? z.object({ score: z.number().min(0).max(1), reasoning: z.string() });
  const schemaJson = JSON.stringify(zodToJsonSchema(schema), null, 2);

  return {
    name: config.name,
    description: config.description,
    isLlm: true,
    async score(
      output: unknown,
      input: unknown,
      annotations?: unknown,
      context?: ScorerContext,
    ): Promise<ScorerResult> {
      if (!context?.resolveProvider) {
        throw new Error(
          `LLM scorer "${config.name}" has no provider. ` +
            `Ensure you are running via runEval() with a real AxlRuntime instance.`,
        );
      }

      const { provider, model } = context.resolveProvider(config.model);

      const prompt = [
        `Evaluate the following output.`,
        ``,
        `## Input`,
        `${JSON.stringify(input, null, 2)}`,
        annotations
          ? `\n## Annotations (Ground Truth)\n${JSON.stringify(annotations, null, 2)}`
          : '',
        ``,
        `## Output to Evaluate`,
        `${JSON.stringify(output, null, 2)}`,
        ``,
        `Respond with valid JSON matching this schema:`,
        schemaJson,
      ].join('\n');

      const response = await provider.chat(
        [
          { role: 'system', content: config.system },
          { role: 'user', content: prompt },
        ],
        { model, temperature: config.temperature ?? 0.2, responseFormat: { type: 'json_object' } },
      );

      const responseCost = response.cost;

      let validated: { score: number; [key: string]: unknown };
      try {
        const parsed = JSON.parse(extractJson(response.content));
        validated = schema.parse(parsed) as { score: number; [key: string]: unknown };
      } catch (err) {
        // Attach cost to all errors so the runner can capture it even on failure.
        if (err && typeof err === 'object') {
          (err as any).cost = responseCost;
        }
        // Duck-type check instead of instanceof to handle potential dual-instance
        // scenarios where two copies of zod are present in the dependency tree.
        if (
          err &&
          typeof err === 'object' &&
          'issues' in err &&
          Array.isArray((err as any).issues)
        ) {
          const issues = (err as any).issues as Array<{
            path: (string | number)[];
            message: string;
          }>;
          const messages = issues
            .map((i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`)
            .join('; ');
          const error = new Error(
            `LLM scorer "${config.name}" returned an invalid response: ${messages}`,
          );
          (error as any).cost = responseCost;
          throw error;
        }
        throw err;
      }

      const { score, ...rest } = validated;
      return {
        score,
        metadata: Object.keys(rest).length > 0 ? rest : undefined,
        cost: responseCost,
      };
    },
  };
}
