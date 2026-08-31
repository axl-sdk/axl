import { describe, expect, it } from 'vitest';
import { agent, InvalidModelInputError, UnsupportedModelInputError, workflow } from '@axlsdk/axl';
import { z } from 'zod';
import { AxlTestRuntime, MockProvider } from '../index.js';

const ImageAgent = agent({
  name: 'image-test-agent',
  model: 'mock:vision-test',
  system: 'Describe the supplied image.',
});

const RichInputWorkflow = workflow({
  name: 'rich-input-workflow',
  input: z.object({}).strict(),
  handler: async (ctx) =>
    ctx.ask(ImageAgent, [
      { type: 'text', text: 'before' },
      {
        type: 'image',
        source: { type: 'bytes', data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' },
        label: 'receipt',
      },
      { type: 'text', text: 'after' },
    ]),
});

describe('AxlTestRuntime rich image input', () => {
  it('routes ordered parts through MockProvider and records descriptor-only traces and accounting', async () => {
    const runtime = new AxlTestRuntime({ config: { trace: { level: 'full' } } });
    const provider = MockProvider.echo();
    runtime.register(RichInputWorkflow);
    runtime.mockProvider('mock', provider);

    await expect(runtime.execute(RichInputWorkflow.name, {})).resolves.toBe('before\nafter');

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].messages.at(-1)?.content).toEqual([
      { type: 'text', text: 'before' },
      {
        type: 'image',
        source: { type: 'bytes', data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' },
        label: 'receipt',
      },
      { type: 'text', text: 'after' },
    ]);
    expect(runtime.totalCost()).toBe(0);
    expect(runtime.agentCalls()[0]).toMatchObject({
      agent: 'image-test-agent',
      prompt: 'before\nafter',
      input: {
        parts: [
          { type: 'text', characters: 6 },
          { type: 'image', source: 'bytes', mediaType: 'image/png', bytes: 3, label: 'receipt' },
          { type: 'text', characters: 5 },
        ],
      },
    });

    const trace = JSON.stringify(runtime.traceLog());
    expect(trace).not.toContain('AQID');
    expect(trace).not.toContain('[1,2,3]');
  });

  it('fails unsupported rich input before MockProvider dispatch', async () => {
    const runtime = new AxlTestRuntime();
    const provider = MockProvider.echo();
    Object.defineProperty(provider, 'validateInput', { value: undefined });
    runtime.register(RichInputWorkflow);
    runtime.mockProvider('mock', provider);

    await expect(runtime.execute(RichInputWorkflow.name, {})).rejects.toBeInstanceOf(
      UnsupportedModelInputError,
    );
    expect(provider.calls).toHaveLength(0);
  });

  it('fails malformed rich input before MockProvider dispatch', async () => {
    const malformedWorkflow = workflow({
      name: 'malformed-rich-input-workflow',
      input: z.object({}).strict(),
      handler: async (ctx) =>
        ctx.ask(ImageAgent, [
          { type: 'image', source: { type: 'base64', data: 'not base64', mediaType: 'image/png' } },
        ] as never),
    });
    const runtime = new AxlTestRuntime();
    const provider = MockProvider.echo();
    runtime.register(malformedWorkflow);
    runtime.mockProvider('mock', provider);

    await expect(runtime.execute(malformedWorkflow.name, {})).rejects.toBeInstanceOf(
      InvalidModelInputError,
    );
    expect(provider.calls).toHaveLength(0);
  });
});
