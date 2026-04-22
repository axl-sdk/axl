/**
 * Mock embedder used by memory demos.
 *
 * Reports realistic usage so the Cost Dashboard's "Memory (Embedder)"
 * section has data to render. Cost mirrors OpenAI text-embedding-3-small
 * pricing ($0.02/1M tokens). The model name is tagged with `mock:` so
 * it's obviously synthetic.
 */
import type { Embedder, EmbedResult } from '@axlsdk/axl';

export class MockEmbedder implements Embedder {
  readonly dimensions = 3;

  async embed(texts: string[], signal?: AbortSignal): Promise<EmbedResult> {
    if (signal?.aborted) throw new Error('Aborted');
    // Deterministic vectors from a simple hash — good enough for semantic
    // similarity between overlapping-keyword queries in the demo.
    const vectors = texts.map((text) => {
      let h = 0;
      for (let i = 0; i < text.length; i++) {
        h = ((h << 5) - h + text.charCodeAt(i)) | 0;
      }
      return [Math.sin(h), Math.cos(h), Math.sin(h * 2)];
    });
    // ~1 token per 4 chars, minimum 1.
    const tokens = texts.reduce((sum, t) => sum + Math.max(1, Math.ceil(t.length / 4)), 0);
    const cost = (tokens / 1_000_000) * 0.02;
    return {
      vectors,
      usage: {
        tokens,
        cost,
        model: 'mock:text-embedding-3-small',
      },
    };
  }
}
