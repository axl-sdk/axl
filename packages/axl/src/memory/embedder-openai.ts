import type { Embedder, EmbedResult } from './types.js';
import { fetchWithRetry } from '../providers/retry.js';

/**
 * Per-million-token USD pricing for OpenAI embedding models.
 *
 * These values are hardcoded because (a) there's no pricing endpoint on
 * the OpenAI API and (b) the alternative is asking users to pass a
 * pricing table into every MemoryManager. Accept drift as a maintenance
 * cost — pricing changes ~yearly and we update this table in the same
 * commit as any rename/deprecation.
 *
 * Source: https://openai.com/api/pricing/ (embeddings section)
 * Last verified: April 2026.
 */
const EMBEDDING_PRICE_PER_1M_TOKENS: Record<string, number> = {
  'text-embedding-3-small': 0.02,
  'text-embedding-3-large': 0.13,
  'text-embedding-ada-002': 0.1,
};

/**
 * Compute USD cost for a given model + token count.
 * Returns undefined for unknown models — we don't guess pricing, and a
 * missing cost is strictly better than a wrong cost in downstream math.
 */
function computeCost(model: string, tokens: number): number | undefined {
  const pricePerMillion = EMBEDDING_PRICE_PER_1M_TOKENS[model];
  if (pricePerMillion == null) return undefined;
  return (tokens / 1_000_000) * pricePerMillion;
}

/**
 * OpenAI embeddings via raw fetch (zero SDK dependency).
 * Uses the /v1/embeddings endpoint.
 */
export class OpenAIEmbedder implements Embedder {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  readonly dimensions: number;

  constructor(
    options: {
      apiKey?: string;
      model?: string;
      baseUrl?: string;
      dimensions?: number;
    } = {},
  ) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    if (!this.apiKey) {
      throw new Error('OpenAI API key is required for OpenAIEmbedder');
    }
    this.model = options.model ?? 'text-embedding-3-small';
    this.baseUrl = options.baseUrl ?? 'https://api.openai.com';
    this.dimensions = options.dimensions ?? 1536;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<EmbedResult> {
    // Use `fetchWithRetry` for consistency with the core provider adapters
    // (`openai`, `openai-responses`, `anthropic`, `gemini`) — transient
    // 429/503/529 responses get exponential-backoff retry with Retry-After
    // support. Without this, a rate-limited embed() call tanked the parent
    // `ctx.remember({embed:true})` and cost attribution silently lost the
    // call from observability.
    const response = await fetchWithRetry(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        dimensions: this.dimensions,
      }),
      signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI embeddings API error (${response.status}): ${body}`);
    }

    const json = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
      usage?: { prompt_tokens?: number; total_tokens?: number };
    };

    // Sort by index to maintain input order
    const vectors = json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);

    // OpenAI's embeddings endpoint bills on prompt tokens; total_tokens
    // equals prompt_tokens for this endpoint but prefer the explicit field.
    const tokens = json.usage?.prompt_tokens ?? json.usage?.total_tokens;
    const cost = tokens != null ? computeCost(this.model, tokens) : undefined;

    // Only emit `usage` when the API actually reported something useful.
    // A bare `{ model }` with no tokens/cost would trigger downstream
    // byEmbedder bucketing that records zero-everything entries —
    // misleading at best. If neither tokens nor cost are available
    // (Azure proxy without a usage block, compat mode), omit `usage`
    // entirely and the cost/observability path short-circuits cleanly.
    if (tokens == null && cost == null) {
      return { vectors };
    }

    return {
      vectors,
      usage: {
        ...(tokens != null ? { tokens } : {}),
        ...(cost != null ? { cost } : {}),
        model: this.model,
      },
    };
  }
}
