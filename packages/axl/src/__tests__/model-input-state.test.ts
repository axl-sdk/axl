import { describe, expect, it } from 'vitest';
import { InvalidModelInputError } from '../errors.js';
import { MemoryStore } from '../state/memory.js';
import { SQLiteStore } from '../state/sqlite.js';
import type { ChatMessage } from '../types.js';

const serializableRichHistory: ChatMessage[] = [
  {
    role: 'user',
    content: [
      {
        type: 'image',
        source: { type: 'url', url: 'https://example.test/a.png', mediaType: 'image/png' },
      },
      { type: 'image', source: { type: 'base64', data: 'AQID', mediaType: 'image/png' } },
      { type: 'image', source: { type: 'provider-file', provider: 'test', reference: 'file_123' } },
      { type: 'text', text: 'inspect' },
    ],
  },
];

describe('rich session history persistence', () => {
  it('round-trips JSON-compatible rich history in MemoryStore and SQLiteStore', async () => {
    const stores = [new MemoryStore(), new SQLiteStore(':memory:')];
    for (const store of stores) {
      await store.saveSession('rich', serializableRichHistory);
      expect(await store.getSession('rich')).toEqual(serializableRichHistory);
    }
  });

  it('rejects Uint8Array rich history before a store can serialize it', async () => {
    const history: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'bytes', data: new Uint8Array([1]), mediaType: 'image/png' },
          },
        ],
      },
    ];
    for (const store of [new MemoryStore(), new SQLiteStore(':memory:')]) {
      await expect(store.saveSession('bytes', history)).rejects.toBeInstanceOf(
        InvalidModelInputError,
      );
      expect(await store.getSession('bytes')).toEqual([]);
    }
  });
});
