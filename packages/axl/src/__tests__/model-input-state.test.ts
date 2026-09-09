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
      { type: 'audio', source: { type: 'base64', data: 'AQID', mediaType: 'audio/wav' } },
      {
        type: 'audio',
        source: { type: 'provider-file', provider: 'test', reference: 'file_456' },
      },
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

  it.each([
    ['image', { type: 'bytes', data: new Uint8Array([1]), mediaType: 'image/png' }],
    ['audio', { type: 'bytes', data: new Uint8Array([1]), mediaType: 'audio/wav' }],
  ] as const)(
    'rejects Uint8Array %s history before a store can serialize it',
    async (type, source) => {
      const history: ChatMessage[] = [{ role: 'user', content: [{ type, source }] }];
      for (const store of [new MemoryStore(), new SQLiteStore(':memory:')]) {
        await expect(store.saveSession('bytes', history)).rejects.toThrow(
          'Uint8Array media input cannot be persisted in session history',
        );
        await expect(store.saveSession('bytes', history)).rejects.toBeInstanceOf(
          InvalidModelInputError,
        );
        expect(await store.getSession('bytes')).toEqual([]);
      }
    },
  );
});
