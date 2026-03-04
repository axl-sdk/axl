import type { z } from 'zod';
import type { Scorer } from './scorer.js';

/** Minimal provider interface for LLM scoring (avoids depending on core axl package). */
type LlmScorerProvider = {
  chat(
    messages: { role: string; content: string }[],
    options: { model: string; temperature?: number },
  ): Promise<{ content: string }>;
};

export type LlmScorerConfig = {
  name: string;
  description: string;
  model: string;
  system: string;
  schema: z.ZodType<{ score: number; [key: string]: unknown }>;
  temperature?: number;
};

export function llmScorer(config: LlmScorerConfig): Scorer {
  const scorerInstance: Scorer & { _provider?: LlmScorerProvider } = {
    name: config.name,
    description: config.description,
    isLlm: true,
    async score(output: unknown, input: unknown, annotations?: unknown): Promise<number> {
      const injectedProvider = scorerInstance._provider;
      if (!injectedProvider) {
        throw new Error(
          `LLM scorer "${config.name}" requires a provider. Run via axl.eval() or the CLI.`,
        );
      }

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

      const colonIdx = config.model.indexOf(':');
      const model = colonIdx > -1 ? config.model.slice(colonIdx + 1) : config.model;

      const response = await injectedProvider.chat(
        [
          { role: 'system', content: config.system },
          { role: 'user', content: prompt },
        ],
        { model, temperature: config.temperature ?? 0.2 },
      );

      const parsed = JSON.parse(response.content);
      const validated = config.schema.parse(parsed);
      return validated.score;
    },
  };

  return scorerInstance;
}
