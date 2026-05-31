import { z } from 'zod';
import type { Scorer, ScorerApplies, ScorerContext, ScorerResult } from './scorer.js';
import { attachScorerErrorCost } from './scorer.js';
import { extractJson, zodToJsonSchema } from '@axlsdk/axl';
import type { Effort } from '@axlsdk/axl';

export type LlmScorerConfig = {
  name: string;
  description: string;
  model: string;
  system: string;
  schema?: z.ZodType<{ score: number; [key: string]: unknown }>;
  /** Sampling temperature. Default: 0.2 for deterministic judging. */
  temperature?: number;
  /** Cap on response tokens. Falls back to provider default if unset. */
  maxTokens?: number;
  /** Reasoning effort — `'high'` or `'max'` materially improves judge calibration on
   *  reasoning-capable models (gpt-5.x, Opus 4.6+, Gemini 3.x). See `Effort` for
   *  provider-specific mapping. */
  effort?: Effort;
  /** Precise thinking-token budget override. See `ChatOptions.thinkingBudget`. */
  thinkingBudget?: number;
  /** Surface reasoning summaries in the judge's response (Gemini + OpenAI Responses). */
  includeThoughts?: boolean;
  /** Stop sequences forwarded to the provider. */
  stop?: string[];
  /** Provider-specific escape hatch — merged last into the raw API request. */
  providerOptions?: Record<string, unknown>;
  /** Optional applicability predicate — see {@link ScorerApplies}. When it
   *  returns `false`, the judge is skipped for that item and NO provider call is
   *  made (the conditional-LLM-judge cost/rate-limit win). The item counts as
   *  neither scored nor failed. */
  applies?: ScorerApplies<unknown, unknown, unknown>;
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
    applies: config.applies,
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

      // Field-by-field forwarding (deliberately NOT spreading `config`):
      // `LlmScorerConfig` has scorer-specific fields (`name`, `description`,
      // `schema`, `system`, `model` — the URI, not the chat-options `model`
      // which is the post-resolveProvider stripped form) that must not leak
      // into ChatOptions. A spread would silently pass them through to
      // provider.chat and either be ignored or, worse, override our hardcoded
      // `responseFormat`. Keep this explicit.
      const response = await provider.chat(
        [
          { role: 'system', content: config.system },
          { role: 'user', content: prompt },
        ],
        {
          model,
          temperature: config.temperature ?? 0.2,
          maxTokens: config.maxTokens,
          effort: config.effort,
          thinkingBudget: config.thinkingBudget,
          includeThoughts: config.includeThoughts,
          stop: config.stop,
          providerOptions: config.providerOptions,
          responseFormat: { type: 'json_object' },
          signal: context.signal,
        },
      );

      const responseCost = response.cost;

      let validated: { score: number; [key: string]: unknown };
      try {
        const parsed = JSON.parse(extractJson(response.content));
        validated = schema.parse(parsed) as { score: number; [key: string]: unknown };
      } catch (err) {
        // Attach cost to all errors so the runner can capture it even on failure.
        attachScorerErrorCost(err, responseCost);
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
          attachScorerErrorCost(error, responseCost);
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
