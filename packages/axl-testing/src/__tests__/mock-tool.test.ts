import { describe, it, expect } from 'vitest';
import { MockTool } from '../mock-tool.js';

describe('MockTool', () => {
  it('executes handler with input', async () => {
    const mock = new MockTool('greet', (input: { name: string }) => `Hello, ${input.name}!`);

    const result = await mock.execute({ name: 'Alice' });
    expect(result).toBe('Hello, Alice!');
  });

  it('records calls', async () => {
    const mock = new MockTool('add', (input: { a: number; b: number }) => input.a + input.b);

    expect(mock.calls).toHaveLength(0);

    await mock.execute({ a: 1, b: 2 });
    await mock.execute({ a: 10, b: 20 });

    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0].input).toEqual({ a: 1, b: 2 });
    expect(mock.calls[1].input).toEqual({ a: 10, b: 20 });
  });

  it('static create factory works', async () => {
    const mock = MockTool.create(
      'multiply',
      (input: { x: number; y: number }) => input.x * input.y,
    );

    expect(mock).toBeInstanceOf(MockTool);
    expect(mock.name).toBe('multiply');

    const result = await mock.execute({ x: 3, y: 4 });
    expect(result).toBe(12);
    expect(mock.calls).toHaveLength(1);
  });

  it('async handlers work', async () => {
    const mock = new MockTool('async_fetch', async (input: { url: string }) => {
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { data: `fetched from ${input.url}` };
    });

    const result = await mock.execute({ url: 'https://example.com' });
    expect(result).toEqual({ data: 'fetched from https://example.com' });
    expect(mock.calls).toHaveLength(1);
  });

  it('preserves the name property', () => {
    const mock = new MockTool('my_tool', () => 'ok');
    expect(mock.name).toBe('my_tool');
  });

  it('records input even when handler throws', async () => {
    const mock = new MockTool('fail', () => {
      throw new Error('boom');
    });

    await expect(mock.execute({ x: 1 })).rejects.toThrow('boom');
    // The call was recorded before the handler threw (push happens first)
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].input).toEqual({ x: 1 });
  });

  it('handles returning undefined', async () => {
    const mock = new MockTool('void_tool', () => undefined);

    const result = await mock.execute({});
    expect(result).toBeUndefined();
    expect(mock.calls).toHaveLength(1);
  });

  it('handles returning complex objects', async () => {
    const complex = {
      nested: { deep: { value: [1, 2, 3] } },
      flag: true,
      count: 99,
    };
    const mock = MockTool.create('complex', () => complex);

    const result = await mock.execute({});
    expect(result).toEqual(complex);
  });

  it('tracks separate calls independently', async () => {
    const mock = MockTool.create('counter', (input: { n: number }) => input.n * 2);

    await mock.execute({ n: 1 });
    await mock.execute({ n: 2 });
    await mock.execute({ n: 3 });

    expect(mock.calls).toHaveLength(3);
    expect(mock.calls.map((c) => c.input)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });
});
