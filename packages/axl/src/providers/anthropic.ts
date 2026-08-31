import type {
  Provider,
  ChatOptions,
  ChatMessage,
  Effort,
  ProviderResponse,
  StreamChunk,
  ToolDefinition,
  ToolCallMessage,
  ProviderInputValidationRequest,
  ProviderInputValidationResult,
} from './types.js';
import { resolveThinkingOptions, resolveApiKey, type ApiKeySource } from './types.js';
import { fetchWithRetry } from './retry.js';
import { buildProviderError } from './errors.js';
import { RateLimiter, type RateLimitConfig } from './rate-limiter.js';
import { assertSafeProviderBaseUrl } from '../http-transport.js';
import type { InputContentPart, InputMediaSource } from '../input.js';
import { UnsupportedModelInputError } from '../errors.js';

function anthropicBase64(source: Extract<InputMediaSource, { type: 'bytes' | 'base64' }>): string {
  return source.type === 'base64'
    ? source.data
    : Buffer.from(source.data.buffer, source.data.byteOffset, source.data.byteLength).toString(
        'base64',
      );
}

function anthropicImageBlocks(parts: readonly InputContentPart[]): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text });
      continue;
    }
    const { source } = part;
    if (source.type === 'provider-file') {
      if (source.provider !== 'anthropic') {
        throw new UnsupportedModelInputError({
          provider: 'anthropic',
          model: 'unknown',
          modality: 'image',
          source: 'provider-file',
        });
      }
      blocks.push({ type: 'image', source: { type: 'file', file_id: source.reference } });
    } else if (source.type === 'url') {
      blocks.push({ type: 'image', source: { type: 'url', url: source.url } });
    } else {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: source.mediaType, data: anthropicBase64(source) },
      });
    }
    if (part.label) blocks.push({ type: 'text', text: `[Image: ${part.label}]` });
  }
  return blocks;
}

const ANTHROPIC_API_VERSION = '2023-06-01';

const ANTHROPIC_IMAGE_MODELS = new Set(['claude-sonnet-4-5', 'claude-opus-4-8']);

// ---------------------------------------------------------------------------
// Exact Anthropic model capabilities and Standard text pricing. Reviewed
// 2026-08-03 against https://platform.claude.com/docs/en/about-claude/pricing.
//
// Modern IDs intentionally use exact matching. A future sibling can still pass
// through to Anthropic, but it must not inherit request semantics or a price.
// ---------------------------------------------------------------------------

type ClaudeThinkingMode =
  | 'legacy-manual'
  | 'effort-only'
  | 'adaptive-optional'
  | 'adaptive-default-on'
  | 'adaptive-always-on';

type ClaudeCapability = {
  thinking: ClaudeThinkingMode;
  effortLevels?: readonly Exclude<Effort, 'none'>[];
  manualBudget: boolean;
  stripTemperature?: boolean;
  disableAt?: Exclude<Effort, 'none'>;
};

const CLAUDE_CAPABILITIES: Record<string, ClaudeCapability> = {
  'claude-fable-5': {
    thinking: 'adaptive-always-on',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    manualBudget: false,
    stripTemperature: true,
  },
  'claude-opus-5': {
    thinking: 'adaptive-default-on',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    manualBudget: false,
    stripTemperature: true,
    disableAt: 'high',
  },
  'claude-sonnet-5': {
    thinking: 'adaptive-default-on',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    manualBudget: false,
    stripTemperature: true,
    disableAt: 'max',
  },
  'claude-opus-4-8': {
    thinking: 'adaptive-optional',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    manualBudget: false,
    stripTemperature: true,
  },
  'claude-opus-4-7': {
    thinking: 'adaptive-optional',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    manualBudget: false,
    stripTemperature: true,
  },
  'claude-opus-4-6': {
    thinking: 'adaptive-optional',
    effortLevels: ['low', 'medium', 'high', 'max'],
    manualBudget: true,
  },
  'claude-sonnet-4-6': {
    thinking: 'adaptive-optional',
    effortLevels: ['low', 'medium', 'high', 'max'],
    manualBudget: true,
  },
  'claude-opus-4-5': {
    thinking: 'effort-only',
    effortLevels: ['low', 'medium', 'high'],
    manualBudget: true,
  },
  'claude-opus-4-5-20251101': {
    thinking: 'effort-only',
    effortLevels: ['low', 'medium', 'high'],
    manualBudget: true,
  },
};

const LEGACY_CLAUDE_CAPABILITY: ClaudeCapability = {
  thinking: 'legacy-manual',
  manualBudget: true,
};

/** Exact legacy IDs retain the established manual-thinking fallback. */
const LEGACY_CLAUDE_MODELS = new Set([
  'claude-opus-4-1',
  'claude-opus-4-1-20250805',
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4',
  'claude-sonnet-4-20250514',
  'claude-opus-4',
  'claude-opus-4-20250514',
  'claude-3-7-sonnet',
  'claude-3-7-sonnet-20250219',
  'claude-3-5-sonnet',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-sonnet-20240620',
  'claude-3-5-haiku',
  'claude-3-5-haiku-20241022',
  'claude-3-opus',
  'claude-3-opus-20240229',
  'claude-3-sonnet',
  'claude-3-sonnet-20240229',
  'claude-3-haiku',
  'claude-3-haiku-20240307',
]);

/** Exact known models predating first-party inference_geo request support. */
const PRE_INFERENCE_GEO_MODELS = new Set([
  ...LEGACY_CLAUDE_MODELS,
  'claude-opus-4-5',
  'claude-opus-4-5-20251101',
]);

function resolveClaudeCapability(model: string): ClaudeCapability | undefined {
  return (
    CLAUDE_CAPABILITIES[model] ??
    (LEGACY_CLAUDE_MODELS.has(model) ? LEGACY_CLAUDE_CAPABILITY : undefined)
  );
}

type AnthropicRate = { input: number; output: number; sonnet5Intro?: boolean };

const ANTHROPIC_RATES: Record<string, AnthropicRate> = {
  'claude-fable-5': { input: 10e-6, output: 50e-6 },
  'claude-opus-5': { input: 5e-6, output: 25e-6 },
  'claude-sonnet-5': { input: 3e-6, output: 15e-6, sonnet5Intro: true },
  'claude-opus-4-8': { input: 5e-6, output: 25e-6 },
  'claude-opus-4-7': { input: 5e-6, output: 25e-6 },
  'claude-opus-4-6': { input: 5e-6, output: 25e-6 },
  'claude-sonnet-4-6': { input: 3e-6, output: 15e-6 },
  'claude-opus-4-5': { input: 5e-6, output: 25e-6 },
  'claude-opus-4-5-20251101': { input: 5e-6, output: 25e-6 },
  'claude-opus-4-1': { input: 15e-6, output: 75e-6 },
  'claude-opus-4-1-20250805': { input: 15e-6, output: 75e-6 },
  'claude-sonnet-4-5': { input: 3e-6, output: 15e-6 },
  'claude-sonnet-4-5-20250929': { input: 3e-6, output: 15e-6 },
  'claude-haiku-4-5': { input: 1e-6, output: 5e-6 },
  'claude-haiku-4-5-20251001': { input: 1e-6, output: 5e-6 },
};

export type AnthropicPriceUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  /** Aggregate-only cache creation is intentionally unpriced. */
  aggregateCacheWriteTokens?: number;
};

function isValidTokenCount(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Price an observable Standard Anthropic text call. `now` is injectable so
 * Sonnet 5's announced rate transition is deterministic in pure tests.
 */
export function estimateAnthropicCost(
  model: string | undefined,
  usage: AnthropicPriceUsage,
  now: Date = new Date(),
): number | undefined {
  if (!model || !isValidTokenCount(usage.inputTokens) || !isValidTokenCount(usage.outputTokens)) {
    return undefined;
  }
  const rate = ANTHROPIC_RATES[model];
  if (!rate) return undefined;

  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite5m = usage.cacheWrite5mTokens ?? 0;
  const cacheWrite1h = usage.cacheWrite1hTokens ?? 0;
  if (
    !isValidTokenCount(cacheRead) ||
    !isValidTokenCount(cacheWrite5m) ||
    !isValidTokenCount(cacheWrite1h)
  ) {
    return undefined;
  }

  const cacheWriteTotal = safeTokenSum(cacheWrite5m, cacheWrite1h);
  if (
    cacheWriteTotal === undefined ||
    safeTokenSum(usage.inputTokens, cacheRead, cacheWriteTotal) === undefined
  ) {
    return undefined;
  }
  if (
    usage.aggregateCacheWriteTokens !== undefined &&
    (!isValidTokenCount(usage.aggregateCacheWriteTokens) ||
      usage.aggregateCacheWriteTokens !== cacheWriteTotal)
  ) {
    return undefined;
  }

  const { input, output } =
    rate.sonnet5Intro && now < new Date('2026-09-01T00:00:00Z')
      ? { input: 2e-6, output: 10e-6 }
      : rate;
  return (
    usage.inputTokens * input +
    cacheRead * input * 0.1 +
    cacheWrite5m * input * 1.25 +
    cacheWrite1h * input * 2 +
    usage.outputTokens * output
  );
}

/** Default thinking budget tokens for each effort level (manual mode fallback). */
const THINKING_BUDGETS: Record<string, number> = {
  low: 1024,
  medium: 5000,
  high: 10000,
  xhigh: 20000,
  // 30000 (not 32000) to stay under the 32K max_tokens limit on Opus 4/4.1.
  // With auto-bump (+1024), max_tokens becomes 31024 which fits all models.
  max: 30000,
};

function clampAnthropicEffort(
  capability: ClaudeCapability,
  effort: Exclude<Effort, 'none'>,
): Exclude<Effort, 'none'> {
  const levels = capability.effortLevels;
  if (!levels) return effort === 'max' || effort === 'xhigh' ? 'high' : effort;
  if (levels.includes(effort)) return effort;
  return 'high';
}

function budgetToClaudeEffort(budget: number): Exclude<Effort, 'none'> {
  if (budget <= THINKING_BUDGETS.low) return 'low';
  if (budget <= THINKING_BUDGETS.medium) return 'medium';
  if (budget <= THINKING_BUDGETS.high) return 'high';
  if (budget <= THINKING_BUDGETS.xhigh) return 'xhigh';
  return 'max';
}

const warnedFableDisable = new Set<string>();
function warnFableDisable(model: string): void {
  if (warnedFableDisable.has(model)) return;
  warnedFableDisable.add(model);
  console.warn(
    `[axl] thinking cannot be disabled on Anthropic ${model}; using adaptive thinking at effort 'low'.`,
  );
}

type ClaudeThinkingConfig = {
  thinking?: Record<string, unknown>;
  outputConfig?: Record<string, unknown>;
  manualBudget?: number;
  stripTemperature: boolean;
};

/** Resolve every portable thinking control to one valid Anthropic request shape. */
function resolveClaudeThinking(
  model: string,
  resolved: ReturnType<typeof resolveThinkingOptions>,
): ClaudeThinkingConfig {
  const capability = resolveClaudeCapability(model);
  // Unknown IDs pass through without a synthesized capability field. This
  // avoids accidentally sending a newly introduced control to a future model.
  if (!capability) return { stripTemperature: false };
  const activeEffort = resolved.activeEffort
    ? clampAnthropicEffort(capability, resolved.activeEffort)
    : undefined;
  const isClaude5 =
    capability.thinking === 'adaptive-default-on' || capability.thinking === 'adaptive-always-on';

  if (isClaude5) {
    if (resolved.hasBudgetOverride) {
      const effort = clampAnthropicEffort(
        capability,
        budgetToClaudeEffort(resolved.thinkingBudget!),
      );
      return {
        thinking: { type: 'adaptive' },
        outputConfig: { effort },
        stripTemperature: true,
      };
    }

    if (resolved.thinkingDisabled) {
      if (capability.thinking === 'adaptive-always-on') {
        warnFableDisable(model);
        return {
          thinking: { type: 'adaptive' },
          outputConfig: { effort: 'low' },
          stripTemperature: true,
        };
      }
      if (
        activeEffort &&
        capability.disableAt &&
        !isEffortAtOrBelow(activeEffort, capability.disableAt)
      ) {
        return {
          thinking: { type: 'adaptive' },
          outputConfig: { effort: activeEffort },
          stripTemperature: true,
        };
      }
      return {
        thinking: { type: 'disabled' },
        outputConfig: activeEffort ? { effort: activeEffort } : undefined,
        stripTemperature: true,
      };
    }

    return activeEffort
      ? {
          thinking: { type: 'adaptive' },
          outputConfig: { effort: activeEffort },
          stripTemperature: true,
        }
      : { stripTemperature: true };
  }

  if (resolved.hasBudgetOverride) {
    if (!capability.manualBudget) {
      const effort = clampAnthropicEffort(
        capability,
        budgetToClaudeEffort(resolved.thinkingBudget!),
      );
      return capability.thinking === 'adaptive-optional'
        ? {
            thinking: { type: 'adaptive' },
            outputConfig: { effort },
            stripTemperature: capability.stripTemperature ?? true,
          }
        : { outputConfig: { effort }, stripTemperature: capability.stripTemperature ?? false };
    }
    return {
      thinking: { type: 'enabled', budget_tokens: resolved.thinkingBudget! },
      outputConfig: activeEffort && capability.effortLevels ? { effort: activeEffort } : undefined,
      manualBudget: resolved.thinkingBudget,
      stripTemperature: capability.stripTemperature ?? true,
    };
  }
  if (resolved.thinkingDisabled) {
    return {
      outputConfig: activeEffort && capability.effortLevels ? { effort: activeEffort } : undefined,
      stripTemperature: capability.stripTemperature ?? false,
    };
  }
  if (activeEffort && capability.thinking === 'adaptive-optional') {
    return {
      thinking: { type: 'adaptive' },
      outputConfig: { effort: activeEffort },
      stripTemperature: capability.stripTemperature ?? true,
    };
  }
  if (activeEffort && capability.thinking === 'effort-only') {
    return { outputConfig: { effort: activeEffort }, stripTemperature: false };
  }
  if (activeEffort) {
    const budget = THINKING_BUDGETS[activeEffort] ?? THINKING_BUDGETS.medium;
    return {
      thinking: { type: 'enabled', budget_tokens: budget },
      manualBudget: budget,
      stripTemperature: true,
    };
  }
  return { stripTemperature: capability.stripTemperature ?? false };
}

function isEffortAtOrBelow(
  effort: Exclude<Effort, 'none'>,
  ceiling: Exclude<Effort, 'none'>,
): boolean {
  const levels: Exclude<Effort, 'none'>[] = ['low', 'medium', 'high', 'xhigh', 'max'];
  return levels.indexOf(effort) <= levels.indexOf(ceiling);
}

type AnthropicPricingContext = {
  model?: string;
  unpricedModifier: boolean;
  hasRichInput: boolean;
};

function pricingContextFromBody(body: Record<string, unknown>): AnthropicPricingContext {
  return {
    model: typeof body.model === 'string' ? body.model : undefined,
    hasRichInput:
      Array.isArray(body.messages) &&
      body.messages.some(
        (message) =>
          message !== null &&
          typeof message === 'object' &&
          Array.isArray((message as { content?: unknown }).content) &&
          (message as { content: unknown[] }).content.some(
            (part) =>
              part !== null &&
              typeof part === 'object' &&
              (part as { type?: unknown }).type === 'image',
          ),
      ),
    unpricedModifier:
      isAnthropicModifier('inference_geo', body.inference_geo) ||
      isAnthropicModifier('speed', body.speed) ||
      hasAnthropicServerTool(body.tools) ||
      body.fallbacks !== undefined,
  };
}

function isModifiedAnthropicResponse(
  json: AnthropicMessageResponse,
  model: string | undefined,
): boolean {
  return (
    isAnthropicResponseModifier('inference_geo', json.inference_geo, model) ||
    isAnthropicResponseModifier('speed', json.speed, model) ||
    isAnthropicResponseModifier('inference_geo', json.usage?.inference_geo, model) ||
    isAnthropicResponseModifier('speed', json.usage?.speed, model) ||
    hasBilledUnmodeledUsage(json.usage?.server_tool_use) ||
    hasUnmodeledIterations(json.usage?.iterations)
  );
}

function isAnthropicModifier(kind: 'inference_geo' | 'speed', value: unknown): boolean {
  if (value === undefined) return false;
  return kind === 'speed' ? value !== 'standard' : value !== 'global';
}

function isAnthropicResponseModifier(
  kind: 'inference_geo' | 'speed',
  value: unknown,
  model: string | undefined,
): boolean {
  if (value === undefined) return false;
  if (kind === 'speed') return value !== 'standard';
  if (value === 'global') return false;
  return value !== 'not_available' || model === undefined || !PRE_INFERENCE_GEO_MODELS.has(model);
}

function hasAnthropicServerTool(tools: unknown): boolean {
  return (
    Array.isArray(tools) &&
    tools.some(
      (tool) =>
        tool !== null &&
        typeof tool === 'object' &&
        typeof (tool as { type?: unknown }).type === 'string',
    )
  );
}

function hasBilledUnmodeledUsage(value: unknown): boolean {
  return value !== undefined && value !== 0;
}

function hasUnmodeledIterations(value: unknown): boolean {
  return value !== undefined;
}

function hasFallbackIteration(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some(
      (iteration) =>
        iteration !== null &&
        typeof iteration === 'object' &&
        (iteration as { type?: unknown }).type === 'fallback_message',
    )
  );
}

type NormalizedAnthropicUsage = {
  usage: NonNullable<ProviderResponse['usage']>;
  pricingUsage: AnthropicPriceUsage;
};

function safeTokenSum(...values: number[]): number | undefined {
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : undefined;
}

function normalizeAnthropicUsage(raw: AnthropicUsage): NormalizedAnthropicUsage | undefined {
  const inputTokens = raw.input_tokens;
  const outputTokens = raw.output_tokens;
  const cacheReadTokens = raw.cache_read_input_tokens ?? 0;
  const cacheWrite5mTokens = raw.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const cacheWrite1hTokens = raw.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  if (
    !isValidTokenCount(inputTokens) ||
    !isValidTokenCount(outputTokens) ||
    !isValidTokenCount(cacheReadTokens) ||
    !isValidTokenCount(cacheWrite5mTokens) ||
    !isValidTokenCount(cacheWrite1hTokens)
  ) {
    return undefined;
  }
  const hasTtlBreakdown =
    raw.cache_creation?.ephemeral_5m_input_tokens !== undefined ||
    raw.cache_creation?.ephemeral_1h_input_tokens !== undefined;
  const aggregateCacheWriteTokens = raw.cache_creation_input_tokens;
  const normalizedCacheWrite = hasTtlBreakdown
    ? safeTokenSum(cacheWrite5mTokens, cacheWrite1hTokens)
    : undefined;
  if (hasTtlBreakdown && normalizedCacheWrite === undefined) return undefined;
  const promptCacheWrite = aggregateCacheWriteTokens ?? normalizedCacheWrite ?? 0;
  if (!isValidTokenCount(promptCacheWrite)) return undefined;
  const promptTokens = safeTokenSum(inputTokens, cacheReadTokens, promptCacheWrite);
  if (promptTokens === undefined) return undefined;
  const totalTokens = safeTokenSum(promptTokens, outputTokens);
  if (totalTokens === undefined) return undefined;
  return {
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: outputTokens,
      total_tokens: totalTokens,
      cached_tokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
      // The aggregate is still useful public usage telemetry even though it
      // cannot be priced without the 5m/1h split. Keep pricingUsage separate
      // so estimateAnthropicCost continues to fail closed in that case.
      cache_write_tokens:
        (normalizedCacheWrite ?? aggregateCacheWriteTokens ?? 0) > 0
          ? (normalizedCacheWrite ?? aggregateCacheWriteTokens)
          : undefined,
    },
    pricingUsage: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWrite5mTokens,
      cacheWrite1hTokens,
      aggregateCacheWriteTokens,
    },
  };
}

/** Terminal Anthropic stream usage is cumulative; preserve omitted start fields. */
function mergeAnthropicUsage(
  initial: AnthropicUsage | undefined,
  update: AnthropicUsage,
): AnthropicUsage {
  return {
    input_tokens: update.input_tokens ?? initial?.input_tokens,
    output_tokens: update.output_tokens ?? initial?.output_tokens,
    cache_read_input_tokens: update.cache_read_input_tokens ?? initial?.cache_read_input_tokens,
    cache_creation_input_tokens:
      update.cache_creation_input_tokens ?? initial?.cache_creation_input_tokens,
    cache_creation: {
      ephemeral_5m_input_tokens:
        update.cache_creation?.ephemeral_5m_input_tokens ??
        initial?.cache_creation?.ephemeral_5m_input_tokens,
      ephemeral_1h_input_tokens:
        update.cache_creation?.ephemeral_1h_input_tokens ??
        initial?.cache_creation?.ephemeral_1h_input_tokens,
    },
    speed: update.speed ?? initial?.speed,
    inference_geo: update.inference_geo ?? initial?.inference_geo,
    iterations: update.iterations ?? initial?.iterations,
    server_tool_use: update.server_tool_use ?? initial?.server_tool_use,
  };
}

/**
 * Anthropic provider using raw fetch (no SDK dependency).
 *
 * Supports:
 * - Chat completions via /v1/messages
 * - Tool calling (tool_use / tool_result content blocks)
 * - Streaming via SSE
 *
 * Message mapping:
 * - "system" role messages are extracted and sent as the top-level `system` param
 * - "tool" role messages are mapped to user messages with tool_result content blocks
 * - "assistant" messages with tool_calls are mapped to tool_use content blocks
 */
export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';

  inputCapabilities(model: string): { image?: { sources: readonly InputMediaSource['type'][] } } {
    return ANTHROPIC_IMAGE_MODELS.has(model)
      ? { image: { sources: ['url', 'bytes', 'base64', 'provider-file'] } }
      : {};
  }

  validateInput(request: ProviderInputValidationRequest): ProviderInputValidationResult {
    const effectiveModel =
      typeof request.providerOptions?.model === 'string'
        ? request.providerOptions.model
        : request.model;
    const fail = (source?: string, feature?: string): never => {
      throw new UnsupportedModelInputError({
        provider: this.name,
        model: effectiveModel || request.model,
        modality: 'image',
        ...(source ? { source } : {}),
        ...(feature ? { feature } : {}),
      });
    };
    if (!ANTHROPIC_IMAGE_MODELS.has(effectiveModel)) {
      fail(undefined, 'image input for this model');
    }
    if (request.providerOptions && 'messages' in request.providerOptions) {
      fail(undefined, 'raw messages providerOptions');
    }
    for (const message of request.history) {
      if (!Array.isArray(message.content)) continue;
      if (message.role !== 'user') fail(undefined, 'rich non-user history');
      for (const part of message.content) {
        if (
          part.type === 'image' &&
          part.source.type === 'provider-file' &&
          part.source.provider !== this.name
        ) {
          fail('provider-file');
        }
      }
    }
    if (Array.isArray(request.input)) {
      for (const part of request.input) {
        if (
          part.type === 'image' &&
          part.source.type === 'provider-file' &&
          part.source.provider !== this.name
        ) {
          fail('provider-file');
        }
      }
    }
    return { effectiveModel };
  }

  /** Anthropic ignores native `json_schema` structurally — Axl uses a system
   *  prompt JSON instruction + client-side Zod validation (see buildRequest). */
  nativeStructuredOutputSupport(): 'unsupported' {
    return 'unsupported';
  }

  private baseUrl: string;
  private apiKeySource: ApiKeySource;
  private governor?: RateLimiter;

  constructor(
    options: {
      apiKey?: ApiKeySource;
      baseUrl?: string;
      dangerouslyAllowInsecureHttp?: boolean;
      rateLimit?: RateLimitConfig;
    } = {},
  ) {
    this.apiKeySource = options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    this.baseUrl = (options.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/$/, '');
    assertSafeProviderBaseUrl(
      this.baseUrl,
      'Anthropic provider',
      options.dangerouslyAllowInsecureHttp,
    );
    this.governor = options.rateLimit ? new RateLimiter(options.rateLimit) : undefined;

    // Eager validation for the string case; a function source is validated per
    // request in resolveKey().
    if (typeof this.apiKeySource === 'string' && !this.apiKeySource) {
      throw new Error(
        'Anthropic API key is required. Set ANTHROPIC_API_KEY or pass apiKey in options.',
      );
    }
  }

  /** Resolve the API key for one request (supports an expiring-token callback). */
  private async resolveKey(): Promise<string> {
    const key = await resolveApiKey(this.apiKeySource);
    if (!key) {
      throw new Error(
        'Anthropic API key is required. Set ANTHROPIC_API_KEY or pass apiKey in options.',
      );
    }
    return key;
  }

  // ---------------------------------------------------------------------------
  // chat - non-streaming completion
  // ---------------------------------------------------------------------------

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ProviderResponse> {
    const headers = this.buildHeaders(await this.resolveKey());
    const body = this.buildRequestBody(messages, options, false);
    const pricingContext = pricingContextFromBody(body);

    const res = await fetchWithRetry(
      `${this.baseUrl}/messages`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      },
      { governor: this.governor, provider: this.name },
    );

    if (!res.ok) {
      const errorBody = await res.text();
      const message = this.extractErrorMessage(errorBody, res.status);
      throw buildProviderError({
        provider: this.name,
        status: res.status,
        headers: res.headers,
        message,
        body: errorBody,
      });
    }

    const json = (await res.json()) as AnthropicMessageResponse;
    return this.parseResponse(json, pricingContext);
  }

  // ---------------------------------------------------------------------------
  // stream - SSE streaming completion
  // ---------------------------------------------------------------------------

  async *stream(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    const headers = this.buildHeaders(await this.resolveKey());
    const body = this.buildRequestBody(messages, options, true);
    const pricingContext = pricingContextFromBody(body);

    const res = await fetchWithRetry(
      `${this.baseUrl}/messages`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      },
      { governor: this.governor, provider: this.name },
    );

    if (!res.ok) {
      const errorBody = await res.text();
      const message = this.extractErrorMessage(errorBody, res.status);
      throw buildProviderError({
        provider: this.name,
        status: res.status,
        headers: res.headers,
        message,
        body: errorBody,
      });
    }

    if (!res.body) {
      throw new Error('Anthropic stream response has no body');
    }

    yield* this.parseSSEStream(res.body, pricingContext);
  }

  // ---------------------------------------------------------------------------
  // Internal: request building
  // ---------------------------------------------------------------------------

  private buildHeaders(apiKey: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
    };
  }

  /** Extract a human-readable message from an API error response body. */
  private extractErrorMessage(body: string, status: number): string {
    try {
      const json = JSON.parse(body) as { error?: { message?: string; type?: string } };
      if (json.error?.message) {
        return `Anthropic API error (${status}): ${json.error.message}`;
      }
    } catch {
      // Not JSON, use raw body
    }
    return `Anthropic API error (${status}): ${body}`;
  }

  private buildRequestBody(
    messages: ChatMessage[],
    options: ChatOptions,
    stream: boolean,
  ): Record<string, unknown> {
    // providerOptions is merged last, so its string model override determines
    // the portable thinking and temperature transformations. Its native fields
    // continue to be the final explicit request overrides below.
    const effectiveModel =
      typeof options.providerOptions?.model === 'string'
        ? options.providerOptions.model
        : options.model;
    // Extract system messages into a single system parameter
    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');
    const systemText = systemMessages.map((m) => m.content).join('\n\n');

    const body: Record<string, unknown> = {
      model: effectiveModel,
      messages: this.mapMessages(nonSystemMessages),
      max_tokens: options.maxTokens ?? 4096,
      stream,
    };

    if (systemText) {
      body.system = systemText;
    }

    if (options.stop) {
      body.stop_sequences = options.stop;
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t) => this.mapToolDefinition(t));
    }

    if (options.toolChoice !== undefined) {
      body.tool_choice = this.mapToolChoice(options.toolChoice);
    }

    const thinking = resolveClaudeThinking(effectiveModel, resolveThinkingOptions(options));
    if (thinking.thinking) body.thinking = thinking.thinking;
    if (thinking.outputConfig) body.output_config = thinking.outputConfig;
    if (thinking.manualBudget) {
      const currentMax = body.max_tokens as number;
      if (currentMax < thinking.manualBudget + 1024) {
        body.max_tokens = thinking.manualBudget + 1024;
      }
    }

    // Temperature is invalid for Claude 5 and Opus 4.7/4.8 even without an
    // explicit thinking control. providerOptions remains the native escape hatch.
    if (options.temperature !== undefined && !thinking.stripTemperature) {
      body.temperature = options.temperature;
    }

    // Anthropic's native structured outputs (output_config.format) use constrained
    // decoding which can degrade quality and may reject complex schemas. Instead, we
    // use a system prompt instruction for all JSON modes and rely on client-side
    // validation (extractJson + Zod).
    if (options.responseFormat && options.responseFormat.type !== 'text') {
      const jsonInstruction =
        'You must respond with valid JSON only. No markdown fences, no extra text.';
      body.system = body.system ? `${body.system}\n\n${jsonInstruction}` : jsonInstruction;
    }

    if (options.providerOptions) {
      Object.assign(body, options.providerOptions);
    }

    return body;
  }

  /**
   * Map OpenAI-format ChatMessages to Anthropic message format.
   *
   * Key transformations:
   * - assistant messages with tool_calls -> assistant with tool_use content blocks
   * - tool messages (tool results) -> user messages with tool_result content blocks
   */
  private mapMessages(messages: ChatMessage[]): AnthropicMessage[] {
    const result: AnthropicMessage[] = [];

    for (const msg of messages) {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (msg.role === 'assistant') {
        const replayedThinking = this.getReplayedThinkingBlocks(msg);
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // Assistant message with tool calls
          const content: AnthropicContentBlock[] = [...replayedThinking];

          // Include text content if present
          if (text) {
            content.push({ type: 'text', text });
          }

          // Map each tool call to a tool_use block
          for (const tc of msg.tool_calls) {
            let parsedArgs: unknown;
            try {
              parsedArgs = JSON.parse(tc.function.arguments);
            } catch {
              parsedArgs = {};
            }
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: parsedArgs,
            });
          }

          result.push({ role: 'assistant', content });
        } else if (replayedThinking.length > 0) {
          // Claude 5 requires the opaque thinking/signature blocks from the
          // preceding turn before any replayed text or tool-use content.
          const content: AnthropicContentBlock[] = [...replayedThinking];
          if (text) content.push({ type: 'text', text });
          result.push({ role: 'assistant', content });
        } else {
          result.push({ role: 'assistant', content: text });
        }
      } else if (msg.role === 'tool') {
        // Tool result messages become user messages with tool_result content blocks.
        // Anthropic requires tool results in a user-role message.
        result.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.tool_call_id!,
              content: text,
            },
          ],
        });
      } else if (msg.role === 'user') {
        result.push({
          role: 'user',
          content:
            typeof msg.content === 'string' ? msg.content : anthropicImageBlocks(msg.content),
        });
      }
      // system messages already handled at top level
    }

    // Anthropic requires alternating user/assistant turns.
    // Merge consecutive same-role messages if necessary.
    return this.mergeConsecutiveRoles(result);
  }

  private getReplayedThinkingBlocks(msg: ChatMessage): AnthropicContentBlock[] {
    const blocks = msg.providerMetadata?.anthropicThinkingBlocks;
    if (!Array.isArray(blocks)) return [];
    return blocks.filter(
      (block): block is AnthropicOpaqueThinkingBlock =>
        block !== null &&
        typeof block === 'object' &&
        ((block as { type?: unknown }).type === 'thinking' ||
          (block as { type?: unknown }).type === 'redacted_thinking'),
    );
  }

  /**
   * Merge consecutive messages with the same role into a single message.
   * This handles cases where multiple tool_result blocks need to be in one user message.
   */
  private mergeConsecutiveRoles(messages: AnthropicMessage[]): AnthropicMessage[] {
    if (messages.length === 0) return messages;

    const merged: AnthropicMessage[] = [messages[0]];

    for (let i = 1; i < messages.length; i++) {
      const prev = merged[merged.length - 1];
      const curr = messages[i];

      if (prev.role === curr.role) {
        // Merge: convert both to content-block arrays and concatenate
        const prevBlocks = this.toContentBlocks(prev.content);
        const currBlocks = this.toContentBlocks(curr.content);
        prev.content = [...prevBlocks, ...currBlocks];
      } else {
        merged.push(curr);
      }
    }

    return merged;
  }

  private toContentBlocks(content: string | AnthropicContentBlock[]): AnthropicContentBlock[] {
    if (typeof content === 'string') {
      return [{ type: 'text', text: content }];
    }
    return content;
  }

  /**
   * Map an OpenAI-format ToolDefinition to Anthropic's tool format.
   */
  private mapToolDefinition(tool: ToolDefinition): AnthropicToolDef {
    return {
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters as Record<string, unknown>,
    };
  }

  /**
   * Map Axl's ToolChoice to Anthropic's tool_choice format.
   *
   * Axl (OpenAI format)          → Anthropic format
   * 'auto'                       → { type: 'auto' }
   * 'none'                       → { type: 'none' }
   * 'required'                   → { type: 'any' }
   * { type:'function', function: { name } } → { type: 'tool', name }
   */
  private mapToolChoice(choice: NonNullable<ChatOptions['toolChoice']>): Record<string, unknown> {
    if (typeof choice === 'string') {
      if (choice === 'required') return { type: 'any' };
      return { type: choice };
    }
    // Specific function: { type: 'function', function: { name } } → { type: 'tool', name }
    return { type: 'tool', name: choice.function.name };
  }

  // ---------------------------------------------------------------------------
  // Internal: response parsing
  // ---------------------------------------------------------------------------

  private parseResponse(
    json: AnthropicMessageResponse,
    pricingContext: AnthropicPricingContext,
  ): ProviderResponse {
    let content = '';
    let thinkingContent = '';
    const toolCalls: ToolCallMessage[] = [];
    const thinkingBlocks: AnthropicOpaqueThinkingBlock[] = [];
    const fallbackIndex = lastFallbackIndex(json.content);
    const hasFallbackBoundary = fallbackIndex >= 0 || hasFallbackIteration(json.usage?.iterations);
    let refused = json.stop_reason === 'refusal';

    for (const [index, block] of json.content.entries()) {
      if (block.type === 'thinking') {
        thinkingContent += block.thinking;
        thinkingBlocks.push(block);
      } else if (block.type === 'redacted_thinking') {
        thinkingBlocks.push(block);
      } else if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        if (fallbackIndex >= 0 && index < fallbackIndex) continue;
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      } else if (block.type === 'fallback') {
        // The response is rejected below before it can enter conversation history.
      } else if (block.type === 'refusal') {
        refused = true;
      }
    }

    const normalized = json.usage ? normalizeAnthropicUsage(json.usage) : undefined;
    const effectiveModel = typeof json.model === 'string' ? json.model : pricingContext.model;
    if (hasFallbackBoundary) {
      throw new Error(
        'Anthropic fallback responses cannot be continued safely; retry without fallbacks.',
      );
    }
    const cost =
      normalized &&
      !pricingContext.hasRichInput &&
      !pricingContext.unpricedModifier &&
      !isModifiedAnthropicResponse(json, effectiveModel) &&
      !hasFallbackBoundary &&
      !refused
        ? estimateAnthropicCost(effectiveModel, normalized.pricingUsage)
        : undefined;

    return {
      content,
      thinking_content: thinkingContent || undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: normalized?.usage,
      cost,
      providerMetadata:
        thinkingBlocks.length > 0 && !hasFallbackBoundary
          ? { anthropicThinkingBlocks: thinkingBlocks }
          : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal: SSE stream parsing
  // ---------------------------------------------------------------------------

  private async *parseSSEStream(
    body: ReadableStream<Uint8Array>,
    pricingContext: AnthropicPricingContext,
  ): AsyncGenerator<StreamChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Track current content block type being streamed
    let currentToolId = '';
    let currentToolName = '';
    let usage: NormalizedAnthropicUsage['usage'] | undefined;
    let pricingUsage: AnthropicPriceUsage | undefined;
    let rawUsage: AnthropicUsage | undefined;
    const thinkingBlocks: AnthropicOpaqueThinkingBlock[] = [];
    let currentThinkingBlock: AnthropicOpaqueThinkingBlock | undefined;
    let effectiveModel = pricingContext.model;
    let unpricedModifier = pricingContext.unpricedModifier;
    let hasFallbackBoundary = false;
    let hasFallbackIterationSignal = false;
    let refused = false;

    const finalizeUsage = () => {
      const normalized = rawUsage ? normalizeAnthropicUsage(rawUsage) : undefined;
      usage = normalized?.usage;
      pricingUsage = normalized?.pricingUsage;
    };

    const doneChunk = (): Extract<StreamChunk, { type: 'done' }> => ({
      type: 'done',
      usage,
      cost:
        pricingUsage &&
        !pricingContext.hasRichInput &&
        !unpricedModifier &&
        !hasFallbackBoundary &&
        !refused
          ? estimateAnthropicCost(effectiveModel, pricingUsage)
          : undefined,
      providerMetadata:
        thinkingBlocks.length > 0 && !hasFallbackBoundary && !hasFallbackIterationSignal
          ? { anthropicThinkingBlocks: thinkingBlocks }
          : undefined,
    });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;

          if (!trimmed.startsWith('data: ')) continue;

          const jsonStr = trimmed.slice(6);
          let event: AnthropicStreamEvent;
          try {
            event = JSON.parse(jsonStr) as AnthropicStreamEvent;
          } catch {
            continue;
          }

          switch (event.type) {
            case 'content_block_start': {
              const block = event.content_block;
              if (block?.type === 'tool_use') {
                currentToolId = block.id ?? '';
                currentToolName = block.name ?? '';
                // Emit the start of a tool call
                yield {
                  type: 'tool_call_delta',
                  id: currentToolId,
                  name: currentToolName,
                  arguments: '',
                };
              } else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
                currentThinkingBlock = {
                  ...block,
                  type: block.type,
                } as AnthropicOpaqueThinkingBlock;
              } else if (block?.type === 'fallback') {
                hasFallbackBoundary = true;
              } else if (block?.type === 'refusal') {
                refused = true;
              }
              break;
            }

            case 'content_block_delta': {
              const delta = event.delta;
              if (delta?.type === 'thinking_delta' && delta.thinking) {
                if (currentThinkingBlock?.type === 'thinking') {
                  const current = currentThinkingBlock.thinking;
                  currentThinkingBlock.thinking = `${typeof current === 'string' ? current : ''}${delta.thinking}`;
                }
                yield { type: 'thinking_delta', content: delta.thinking };
              } else if (delta?.type === 'signature_delta' && delta.signature) {
                if (currentThinkingBlock) {
                  const current = currentThinkingBlock.signature;
                  currentThinkingBlock.signature = `${typeof current === 'string' ? current : ''}${delta.signature}`;
                }
              } else if (delta?.type === 'text_delta' && delta.text) {
                yield { type: 'text_delta', content: delta.text };
              } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
                yield {
                  type: 'tool_call_delta',
                  id: currentToolId,
                  arguments: delta.partial_json,
                };
              }
              break;
            }

            case 'content_block_stop': {
              if (currentThinkingBlock) {
                thinkingBlocks.push(currentThinkingBlock);
                currentThinkingBlock = undefined;
              }
              // Reset block tracking
              currentToolId = '';
              currentToolName = '';
              break;
            }

            case 'message_start': {
              // message_start arrives first in the SSE stream with input token counts
              if (event.message?.usage) {
                rawUsage = mergeAnthropicUsage(rawUsage, event.message.usage);
              }
              if (typeof event.message?.model === 'string') effectiveModel = event.message.model;
              const messageFallback = hasFallbackIteration(event.message?.usage?.iterations);
              if (
                isAnthropicResponseModifier(
                  'inference_geo',
                  event.message?.inference_geo,
                  effectiveModel,
                ) ||
                isAnthropicResponseModifier('speed', event.message?.speed, effectiveModel) ||
                isAnthropicResponseModifier(
                  'inference_geo',
                  event.message?.usage?.inference_geo,
                  effectiveModel,
                ) ||
                isAnthropicResponseModifier('speed', event.message?.usage?.speed, effectiveModel) ||
                hasBilledUnmodeledUsage(event.message?.usage?.server_tool_use) ||
                hasUnmodeledIterations(event.message?.usage?.iterations)
              ) {
                unpricedModifier = true;
              }
              if (messageFallback) hasFallbackIterationSignal = true;
              break;
            }

            case 'message_delta': {
              // message_delta arrives near the end with output token counts
              if (event.usage) {
                rawUsage = mergeAnthropicUsage(rawUsage, event.usage);
                finalizeUsage();
                const terminalFallback = hasFallbackIteration(event.usage.iterations);
                if (
                  isAnthropicResponseModifier('speed', event.usage.speed, effectiveModel) ||
                  isAnthropicResponseModifier(
                    'inference_geo',
                    event.usage.inference_geo,
                    effectiveModel,
                  ) ||
                  hasBilledUnmodeledUsage(event.usage.server_tool_use) ||
                  hasUnmodeledIterations(event.usage.iterations)
                ) {
                  unpricedModifier = true;
                }
                if (terminalFallback) hasFallbackIterationSignal = true;
              }
              if (event.delta?.stop_reason === 'refusal') refused = true;
              break;
            }

            case 'message_stop': {
              finalizeUsage();
              if (hasFallbackBoundary || hasFallbackIterationSignal) {
                throw new Error(
                  'Anthropic fallback streams cannot be continued safely; retry without fallbacks.',
                );
              }
              yield doneChunk();
              return;
            }
          }
        }
      }

      // If we exit without a message_stop, still emit done
      finalizeUsage();
      if (hasFallbackBoundary || hasFallbackIterationSignal) {
        throw new Error(
          'Anthropic fallback streams cannot be continued safely; retry without fallbacks.',
        );
      }
      yield doneChunk();
    } finally {
      reader.releaseLock();
    }
  }
}

// ---------------------------------------------------------------------------
// Anthropic API types (internal)
// ---------------------------------------------------------------------------

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source:
        | { type: 'base64'; media_type: string; data: string }
        | { type: 'url'; url: string }
        | { type: 'file'; file_id: string };
    }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | AnthropicOpaqueThinkingBlock
  | { type: 'fallback'; [key: string]: unknown }
  | { type: 'refusal'; [key: string]: unknown };

function lastFallbackIndex(blocks: Array<{ type: string }>): number {
  for (let index = blocks.length - 1; index >= 0; index--) {
    if (blocks[index].type === 'fallback') return index;
  }
  return -1;
}

type AnthropicOpaqueThinkingBlock = Record<string, unknown> & {
  type: 'thinking' | 'redacted_thinking';
};

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
};

type AnthropicToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

type AnthropicMessageResponse = {
  id: string;
  type: 'message';
  role: 'assistant';
  model?: string;
  speed?: string;
  inference_geo?: string;
  content: Array<
    | (AnthropicOpaqueThinkingBlock & { type: 'thinking'; thinking: string })
    | AnthropicOpaqueThinkingBlock
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'fallback'; [key: string]: unknown }
    | { type: 'refusal'; [key: string]: unknown }
  >;
  stop_reason: string | null;
  usage: AnthropicUsage;
};

type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  speed?: string;
  inference_geo?: string;
  server_tool_use?: number;
  iterations?: Array<{
    type?: 'message' | 'fallback_message';
    model?: string;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  }>;
};

type AnthropicStreamEvent = {
  type:
    | 'message_start'
    | 'content_block_start'
    | 'content_block_delta'
    | 'content_block_stop'
    | 'message_delta'
    | 'message_stop'
    | 'ping';
  message?: {
    model?: string;
    speed?: string;
    inference_geo?: string;
    usage?: AnthropicUsage;
  };
  content_block?: {
    type?: 'text' | 'thinking' | 'redacted_thinking' | 'tool_use' | 'fallback' | 'refusal';
    id?: string;
    name?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    data?: string;
    [key: string]: unknown;
  };
  delta?: {
    type?: 'text_delta' | 'thinking_delta' | 'signature_delta' | 'input_json_delta';
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: AnthropicUsage;
};
