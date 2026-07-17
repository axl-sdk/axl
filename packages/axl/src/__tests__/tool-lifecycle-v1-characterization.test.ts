import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { WorkflowContext } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { tool } from '../tool.js';
import type { Tool } from '../tool.js';
import type { AxlEvent, ChatMessage, HumanDecision } from '../types.js';
import { createSequenceProvider } from './helpers.js';

function setup(options: {
  configuredTool?: Tool;
  requestedTool?: string;
  arguments?: string;
  decision?: HumanDecision;
}) {
  const requestedTool = options.requestedTool ?? options.configuredTool?.name ?? 'missing';
  const provider = createSequenceProvider([
    {
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: requestedTool, arguments: options.arguments ?? '{}' },
        },
      ],
    },
    'done',
  ]);
  const registry = new ProviderRegistry();
  registry.registerInstance('mock', provider);
  const events: AxlEvent[] = [];
  const ctx = new WorkflowContext({
    input: 'test',
    executionId: randomUUID(),
    config: {},
    providerRegistry: registry,
    onTrace: (event) => events.push(event),
    ...(options.decision ? { awaitHumanHandler: () => options.decision! } : {}),
  });
  const testAgent = agent({
    name: 'v1-characterization',
    model: 'mock:model',
    system: 'test',
    ...(options.configuredTool ? { tools: [options.configuredTool] } : {}),
  });
  return { ctx, testAgent, provider, events };
}

function lifecycleTypes(events: AxlEvent[]): string[] {
  return events
    .filter((event) =>
      ['tool_call_start', 'tool_call_end', 'tool_approval', 'tool_denied'].includes(event.type),
    )
    .map((event) => event.type);
}

function providerToolMessage(provider: ReturnType<typeof createSequenceProvider>): ChatMessage {
  const message = (provider.calls[1].messages as ChatMessage[]).find(
    (candidate) => candidate.role === 'tool',
  );
  if (!message) throw new Error('Expected continued provider tool message');
  return message;
}

describe('v1 tool lifecycle characterization', () => {
  it('emits only tool_denied for an unavailable request', async () => {
    const harness = setup({ requestedTool: 'missing' });

    await expect(harness.ctx.ask(harness.testAgent, 'go')).resolves.toBe('done');

    expect(lifecycleTypes(harness.events)).toEqual(['tool_denied']);
    expect(providerToolMessage(harness.provider).content).toBe(
      'Tool "missing" is not available. Available tools: none',
    );
  });

  it('emits no tool lifecycle event for malformed JSON', async () => {
    const configuredTool = tool({
      name: 'parse_me',
      description: 'fixture',
      input: z.object({}),
      handler: () => 'unused',
    });
    const harness = setup({ configuredTool, arguments: '{bad' });

    await expect(harness.ctx.ask(harness.testAgent, 'go')).resolves.toBe('done');

    expect(lifecycleTypes(harness.events)).toEqual([]);
    expect(providerToolMessage(harness.provider).content).toBe(
      'Error: Invalid JSON in tool arguments. Please provide valid JSON.',
    );
  });

  it('leaves a started call without an end when approval is denied', async () => {
    const configuredTool = tool({
      name: 'approve_me',
      description: 'fixture',
      input: z.object({}),
      requireApproval: true,
      handler: () => 'unused',
    });
    const harness = setup({
      configuredTool,
      decision: { approved: false, reason: 'not now' },
    });

    await expect(harness.ctx.ask(harness.testAgent, 'go')).resolves.toBe('done');

    expect(lifecycleTypes(harness.events)).toEqual(['tool_call_start', 'tool_approval']);
    expect(providerToolMessage(harness.provider).content).toBe(
      '{"error":"Tool denied by human: not now"}',
    );
  });

  it('leaves a started call without an end when the before hook throws', async () => {
    const configuredTool = tool({
      name: 'before_failure',
      description: 'fixture',
      input: z.object({}),
      handler: () => 'unused',
      hooks: { before: () => Promise.reject(new Error('before failed')) },
    });
    const harness = setup({ configuredTool });

    await expect(harness.ctx.ask(harness.testAgent, 'go')).resolves.toBe('done');

    expect(lifecycleTypes(harness.events)).toEqual(['tool_call_start']);
    expect(providerToolMessage(harness.provider).content).toBe(
      '{"error":"Before hook error: before failed"}',
    );
  });

  it('pairs a started call after an after-hook failure and continues', async () => {
    const configuredTool = tool({
      name: 'after_failure',
      description: 'fixture',
      input: z.object({}),
      handler: () => ({ raw: true }),
      hooks: { after: () => Promise.reject(new Error('after failed')) },
    });
    const harness = setup({ configuredTool });

    await expect(harness.ctx.ask(harness.testAgent, 'go')).resolves.toBe('done');

    expect(lifecycleTypes(harness.events)).toEqual(['tool_call_start', 'tool_call_end']);
    expect(providerToolMessage(harness.provider).content).toBe(
      '{"error":"After hook error: after failed"}',
    );
  });
});
