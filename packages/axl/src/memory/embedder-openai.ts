import type { Embedder } from './types.js';

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

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
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
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI embeddings API error (${response.status}): ${body}`);
    }

    const json = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // Sort by index to maintain input order
    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
