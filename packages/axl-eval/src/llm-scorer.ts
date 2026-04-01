import type { z } from 'zod';
import type { Scorer, ScorerContext } from './scorer.js';
import { extractJson } from '@axlsdk/axl';

export type LlmScorerConfig = {
  name: string;
  description: string;
  model: string;
  system: string;
  schema: z.ZodType<{ score: number; [key: string]: unknown }>;
  temperature?: number;
};

export function llmScorer(config: LlmScorerConfig): Scorer {
  const scorerInstance: Scorer & { _lastCost?: number } = {
    name: config.name,
    description: config.description,
    isLlm: true,
    async score(
      output: unknown,
      input: unknown,
      annotations?: unknown,
      context?: ScorerContext,
    ): Promise<number> {
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
        `Respond with valid JSON matching the required schema with a score field (0-1) and reasoning.`,
      ].join('\n');

      const response = await provider.chat(
        [
          { role: 'system', content: config.system },
          { role: 'user', content: prompt },
        ],
        { model, temperature: config.temperature ?? 0.2, responseFormat: { type: 'json_object' } },
      );

      scorerInstance._lastCost = response.cost;

      const parsed = JSON.parse(extractJson(response.content));
      const validated = config.schema.parse(parsed);
      return validated.score;
    },
  };

  return scorerInstance;
}
