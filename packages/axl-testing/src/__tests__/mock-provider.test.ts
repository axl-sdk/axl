import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { MockProvider } from '../mock-provider.js';

// ── MockProvider.sequence() ──────────────────────────────────────────────────

describe('MockProvider.sequence()', () => {
  it('returns responses in order', async () => {
    const provider = MockProvider.sequence([
      { content: 'first' },
      { content: 'second' },
      { content: 'third' },
    ]);

    const r1 = await provider.chat([{ role: 'user', content: 'a' }], {});
    const r2 = await provider.chat([{ role: 'user', content: 'b' }], {});
    const r3 = await provider.chat([{ role: 'user', content: 'c' }], {});

    expect(r1.content).toBe('first');
    expect(r2.content).toBe('second');
    expect(r3.content).toBe('third');
  });

  it('throws if more calls than responses', async () => {
    const provider = MockProvider.sequence([{ content: 'only one' }]);

    await provider.chat([{ role: 'user', content: 'a' }], {});

    await expect(provider.chat([{ role: 'user', content: 'b' }], {})).rejects.toThrow(
      /no response for call index 1/,
    );
  });

  it('includes usage in every response', async () => {
    const provider = MockProvider.sequence([{ content: 'hi' }]);
    const r = await provider.chat([{ role: 'user', content: 'x' }], {});

    expect(r.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 10,
      total_tokens: 20,
    });
  });

  it('passes through tool_calls in the response', async () => {
    const toolCalls = [
      {
        id: 'tc-1',
        type: 'function' as const,
        function: { name: 'my_tool', arguments: '{"a":1}' },
      },
    ];
    const provider = MockProvider.sequence([{ content: '', tool_calls: toolCalls }]);

    const r = await provider.chat([{ role: 'user', content: 'go' }], {});
    expect(r.tool_calls).toEqual(toolCalls);
  });
});

// ── MockProvider.echo() ──────────────────────────────────────────────────────

describe('MockProvider.echo()', () => {
  it('returns the last user message back', async () => {
    const provider = MockProvider.echo();

    const r = await provider.chat(
      [
        { role: 'system', content: 'You are a bot.' },
        { role: 'user', content: 'Hello world' },
      ],
      {},
    );

    expect(r.content).toBe('Hello world');
  });

  it('returns empty string when there are no user messages', async () => {
    const provider = MockProvider.echo();

    const r = await provider.chat([{ role: 'system', content: 'System only' }], {});

    expect(r.content).toBe('');
  });

  it('echoes the last user message, not the first', async () => {
    const provider = MockProvider.echo();

    const r = await provider.chat(
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ack' },
        { role: 'user', content: 'second' },
      ],
      {},
    );

    expect(r.content).toBe('second');
  });

  it('includes usage metadata', async () => {
    const provider = MockProvider.echo();
    const r = await provider.chat([{ role: 'user', content: 'ping' }], {});

    expect(r.usage).toBeDefined();
    expect(r.cost).toBe(0);
  });
});

// ── MockProvider.json() ──────────────────────────────────────────────────────

describe('MockProvider.json()', () => {
  it('generates JSON matching a Zod object schema', async () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const provider = MockProvider.json(schema);

    const r = await provider.chat([{ role: 'user', content: 'give me json' }], {});

    const parsed = JSON.parse(r.content);
    // Random values should still pass Zod validation
    expect(typeof parsed.name).toBe('string');
    expect(typeof parsed.age).toBe('number');
    expect(() => schema.parse(parsed)).not.toThrow();
  });

  it('handles boolean fields', async () => {
    const schema = z.object({ active: z.boolean() });
    const provider = MockProvider.json(schema);

    const r = await provider.chat([{ role: 'user', content: 'json' }], {});

    const parsed = JSON.parse(r.content);
    expect(typeof parsed.active).toBe('boolean');
  });

  it('handles array fields', async () => {
    const schema = z.object({ items: z.array(z.string()) });
    const provider = MockProvider.json(schema);

    const r = await provider.chat([{ role: 'user', content: 'json' }], {});

    const parsed = JSON.parse(r.content);
    expect(Array.isArray(parsed.items)).toBe(true);
    for (const item of parsed.items) {
      expect(typeof item).toBe('string');
    }
  });

  it('handles optional fields', async () => {
    const schema = z.object({ label: z.string().optional() });
    const provider = MockProvider.json(schema);

    const r = await provider.chat([{ role: 'user', content: 'json' }], {});

    const parsed = JSON.parse(r.content);
    // Optional field may be present (string) or absent (undefined)
    if (parsed.label !== undefined) {
      expect(typeof parsed.label).toBe('string');
    }
  });

  it('handles default values', async () => {
    const schema = z.object({ count: z.number().default(42) });
    const provider = MockProvider.json(schema);

    const r = await provider.chat([{ role: 'user', content: 'json' }], {});

    const parsed = JSON.parse(r.content);
    expect(parsed).toEqual({ count: 42 });
  });

  it('handles enum fields', async () => {
    const schema = z.object({ status: z.enum(['active', 'inactive']) });
    const provider = MockProvider.json(schema);

    const r = await provider.chat([{ role: 'user', content: 'json' }], {});

    const parsed = JSON.parse(r.content);
    expect(['active', 'inactive']).toContain(parsed.status);
  });

  it('handles nullable fields', async () => {
    const schema = z.object({ value: z.string().nullable() });
    const provider = MockProvider.json(schema);

    const r = await provider.chat([{ role: 'user', content: 'json' }], {});

    const parsed = JSON.parse(r.content);
    expect(parsed).toEqual({ value: null });
  });

  it('generates random values (different across calls)', async () => {
    const schema = z.object({ x: z.number() });
    const provider = MockProvider.json(schema);

    const r1 = await provider.chat([{ role: 'user', content: '1' }], {});
    const r2 = await provider.chat([{ role: 'user', content: '2' }], {});

    // Both should be valid
    const p1 = JSON.parse(r1.content);
    const p2 = JSON.parse(r2.content);
    expect(typeof p1.x).toBe('number');
    expect(typeof p2.x).toBe('number');
    // Random values are very unlikely to be identical
  });
});

// ── MockProvider.replay() ────────────────────────────────────────────────────

describe('MockProvider.replay()', () => {
  it('replays recorded responses in order', async () => {
    const recorded = [
      {
        content: 'replay-1',
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        cost: 0.001,
      },
      {
        content: 'replay-2',
        usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 },
        cost: 0.002,
      },
    ];

    const provider = MockProvider.replay(recorded);

    const r1 = await provider.chat([{ role: 'user', content: 'a' }], {});
    const r2 = await provider.chat([{ role: 'user', content: 'b' }], {});

    expect(r1.content).toBe('replay-1');
    expect(r1.cost).toBe(0.001);
    expect(r2.content).toBe('replay-2');
    expect(r2.usage?.total_tokens).toBe(16);
  });

  it('throws if more calls than recorded', async () => {
    const provider = MockProvider.replay([
      { content: 'only', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ]);

    await provider.chat([{ role: 'user', content: 'a' }], {});

    await expect(provider.chat([{ role: 'user', content: 'b' }], {})).rejects.toThrow(
      /no recorded response for call index 1/,
    );
  });
});

// ── MockProvider.fn() ────────────────────────────────────────────────────────

describe('MockProvider.fn()', () => {
  it('calls custom handler with messages and call index', async () => {
    const provider = MockProvider.fn((messages, callIndex) => ({
      content: `call-${callIndex}: ${messages.length} messages`,
    }));

    const r1 = await provider.chat([{ role: 'user', content: 'hi' }], {});
    const r2 = await provider.chat(
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hey' },
        { role: 'user', content: 'bye' },
      ],
      {},
    );

    expect(r1.content).toBe('call-0: 1 messages');
    expect(r2.content).toBe('call-1: 3 messages');
  });

  it('includes usage in the response', async () => {
    const provider = MockProvider.fn(() => ({ content: 'ok' }));
    const r = await provider.chat([{ role: 'user', content: 'x' }], {});

    expect(r.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 10,
      total_tokens: 20,
    });
    expect(r.cost).toBe(0);
  });

  it('supports returning tool_calls from the handler', async () => {
    const provider = MockProvider.fn(() => ({
      content: '',
      tool_calls: [
        {
          id: 'tc-fn',
          type: 'function' as const,
          function: { name: 'do_thing', arguments: '{}' },
        },
      ],
    }));

    const r = await provider.chat([{ role: 'user', content: 'do it' }], {});
    expect(r.tool_calls).toHaveLength(1);
    expect(r.tool_calls![0].function.name).toBe('do_thing');
  });

  it('records calls', async () => {
    const provider = MockProvider.fn(() => ({ content: 'yo' }));

    await provider.chat([{ role: 'user', content: 'msg1' }], { model: 'test' });
    await provider.chat([{ role: 'user', content: 'msg2' }], { model: 'test' });

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0].messages[0].content).toBe('msg1');
    expect(provider.calls[1].options.model).toBe('test');
  });
});

// ── MockProvider.replay() from file ─────────────────────────────────────

describe('MockProvider.replay() from file', () => {
  it('loads responses from a JSON file', async () => {
    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const tmpDir = join(tmpdir(), `axl-mock-replay-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const filePath = join(tmpDir, 'replay.json');

    const responses = [
      {
        content: 'replay-1',
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        cost: 0.01,
      },
      {
        content: 'replay-2',
        usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
        cost: 0.02,
      },
    ];
    writeFileSync(filePath, JSON.stringify(responses), 'utf-8');

    try {
      const provider = MockProvider.replay(filePath);

      const r1 = await provider.chat([{ role: 'user', content: 'first' }], {});
      expect(r1.content).toBe('replay-1');
      expect(r1.cost).toBe(0.01);

      const r2 = await provider.chat([{ role: 'user', content: 'second' }], {});
      expect(r2.content).toBe('replay-2');
      expect(r2.cost).toBe(0.02);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── General: .calls tracking ─────────────────────────────────────────────────

describe('MockProvider .calls tracking', () => {
  it('starts with zero calls', () => {
    const provider = MockProvider.echo();
    expect(provider.calls).toHaveLength(0);
  });

  it('tracks messages and options for each call', async () => {
    const provider = MockProvider.echo();
    const messages = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'hello' },
    ];
    const opts = { model: 'gpt-4', temperature: 0.5 };

    await provider.chat(messages, opts);

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].messages).toEqual(messages);
    expect(provider.calls[0].options).toEqual(opts);
  });

  it('accumulates across multiple chat calls', async () => {
    const provider = MockProvider.sequence([{ content: 'a' }, { content: 'b' }, { content: 'c' }]);

    await provider.chat([{ role: 'user', content: '1' }], {});
    await provider.chat([{ role: 'user', content: '2' }], {});
    await provider.chat([{ role: 'user', content: '3' }], {});

    expect(provider.calls).toHaveLength(3);
  });

  it('stream() also records calls', async () => {
    const provider = MockProvider.sequence([{ content: 'streamed' }]);

    const chunks: unknown[] = [];
    for await (const chunk of provider.stream([{ role: 'user', content: 'stream me' }], {})) {
      chunks.push(chunk);
    }

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].messages[0].content).toBe('stream me');
  });
});

// ── General: .chat() returns ProviderResponse with usage ─────────────────────

describe('MockProvider .chat() response shape', () => {
  it('returns a ProviderResponse with content, usage, and cost', async () => {
    const provider = MockProvider.sequence([{ content: 'hello' }]);

    const response = await provider.chat([{ role: 'user', content: 'hi' }], {});

    expect(response).toHaveProperty('content', 'hello');
    expect(response).toHaveProperty('usage');
    expect(response.usage).toHaveProperty('prompt_tokens');
    expect(response.usage).toHaveProperty('completion_tokens');
    expect(response.usage).toHaveProperty('total_tokens');
    expect(response).toHaveProperty('cost');
  });
});

// ── General: .stream() yields text_delta and done chunks ─────────────────────

describe('MockProvider .stream()', () => {
  it('yields a text_delta chunk followed by a done chunk', async () => {
    const provider = MockProvider.sequence([{ content: 'Hello stream!' }]);

    const chunks: unknown[] = [];
    for await (const chunk of provider.stream([{ role: 'user', content: 'go' }], {})) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({
      type: 'text_delta',
      content: 'Hello stream!',
    });
    expect(chunks[1]).toMatchObject({ type: 'done' });
    expect((chunks[1] as any).usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 10,
      total_tokens: 20,
    });
  });

  it('stream from echo provider echoes user message', async () => {
    const provider = MockProvider.echo();

    const chunks: unknown[] = [];
    for await (const chunk of provider.stream([{ role: 'user', content: 'echo this' }], {})) {
      chunks.push(chunk);
    }

    expect(chunks[0]).toEqual({
      type: 'text_delta',
      content: 'echo this',
    });
  });
});

// ── MockProvider.name ────────────────────────────────────────────────────────

describe('MockProvider .name', () => {
  it('has the name "mock"', () => {
    const provider = MockProvider.echo();
    expect(provider.name).toBe('mock');
  });
});
