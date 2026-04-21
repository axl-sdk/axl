import { describe, it, expect } from 'vitest';
import { MockProvider } from '../mock-provider.js';

describe('MockProvider — chunks (spec/16 §4.5)', () => {
  it('sequence(): when `chunks` is set, stream() yields one text_delta per chunk', async () => {
    const provider = MockProvider.sequence([
      {
        content: '{"name":"Alice","age":30}',
        chunks: ['{"name":"Al', 'ice","age":', '30}'],
      },
    ]);

    const chunks: string[] = [];
    for await (const chunk of provider.stream([], {} as never)) {
      if (chunk.type === 'text_delta') chunks.push(chunk.content);
    }

    expect(chunks).toEqual(['{"name":"Al', 'ice","age":', '30}']);
    expect(chunks.join('')).toBe('{"name":"Alice","age":30}');
  });

  it('sequence(): without `chunks`, stream() yields a single text_delta with full content (back-compat)', async () => {
    const provider = MockProvider.sequence([{ content: 'hello world' }]);

    const chunks: string[] = [];
    for await (const chunk of provider.stream([], {} as never)) {
      if (chunk.type === 'text_delta') chunks.push(chunk.content);
    }

    expect(chunks).toEqual(['hello world']);
  });

  it('sequence(): mismatched chunks/content throws at stream() time', async () => {
    const provider = MockProvider.sequence([
      {
        content: 'hello world',
        chunks: ['hel', 'lo!'], // joins to 'hello!' not 'hello world'
      },
    ]);

    await expect(async () => {
      for await (const _ of provider.stream([], {} as never)) {
        void _;
      }
    }).rejects.toThrow(/chunks.join.*!== content/);
  });

  it('chunked(): splits content into fixed-size chunks', async () => {
    const provider = MockProvider.chunked(['HelloWorld'], 3);

    const chunks: string[] = [];
    for await (const chunk of provider.stream([], {} as never)) {
      if (chunk.type === 'text_delta') chunks.push(chunk.content);
    }

    // 10 chars / 3 = ['Hel', 'loW', 'orl', 'd']
    expect(chunks).toEqual(['Hel', 'loW', 'orl', 'd']);
    expect(chunks.join('')).toBe('HelloWorld');
  });

  it('chunked(): default chunkSize is 4', async () => {
    const provider = MockProvider.chunked(['ABCDEFGHIJ']);

    const chunks: string[] = [];
    for await (const chunk of provider.stream([], {} as never)) {
      if (chunk.type === 'text_delta') chunks.push(chunk.content);
    }

    expect(chunks).toEqual(['ABCD', 'EFGH', 'IJ']);
  });

  it('chunked(): supports a sequence of responses', async () => {
    const provider = MockProvider.chunked(['first', 'second'], 2);

    const allChunks: string[][] = [];
    for (let i = 0; i < 2; i++) {
      const chunks: string[] = [];
      for await (const chunk of provider.stream([], {} as never)) {
        if (chunk.type === 'text_delta') chunks.push(chunk.content);
      }
      allChunks.push(chunks);
    }

    expect(allChunks[0]).toEqual(['fi', 'rs', 't']);
    expect(allChunks[1]).toEqual(['se', 'co', 'nd']);
  });
});
