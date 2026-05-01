import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { workflow } from '../workflow.js';
import { agent } from '../agent.js';
import { AxlRuntime } from '../runtime.js';
import { WorkflowContext } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { MemoryStore } from '../state/memory.js';
import { OpenAIProvider } from '../providers/openai.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { GeminiProvider } from '../providers/gemini.js';
import { OpenAIResponsesProvider } from '../providers/openai-responses.js';
import { MockProvider } from '../../../axl-testing/src/mock-provider.js';
import { randomUUID } from 'node:crypto';
import type { ChatMessage } from '../types.js';
import type { Provider, ProviderResponse, ToolCallMessage } from '../providers/types.js';

/**
 * Tests for the additive `ChatMessage.agent` attribution field (0.18.x).
 *
 * Phase 1 contract:
 * - `ctx.ask(agent)` stamps the committed assistant message with
 *   `agent: agent._name`.
 * - The field is observability metadata only — it does NOT alter how
 *   history is included in subsequent prompts. Filtering will land in
 *   phase 2 via `AgentConfig.sessionScope`.
 * - Providers must ignore the field; their wire payloads are unaffected.
 * - User messages and external assistant pushes (e.g., the `Session.send`
 *   fallback) leave `agent` undefined.
 */

function makeRuntime() {
  // Capture every messages[] the provider receives so we can inspect what
  // actually went on the wire — and feed back deterministic replies.
  const sentMessages: ChatMessage[][] = [];
  const provider = MockProvider.fn((messages) => {
    // Defensive copy — vitest's deep-equality assertions need a stable
    // snapshot, not a reference that may get mutated by callers.
    sentMessages.push(messages.map((m) => ({ ...m })));
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    return { content: `reply-to-${lastUser?.content ?? ''}` };
  });
  const runtime = new AxlRuntime({ defaultProvider: 'mock' });
  runtime.registerProvider('mock', provider);
  return { runtime, sentMessages };
}

describe('ChatMessage.agent — phase 1 attribution', () => {
  it('stamps the agent name on the assistant message committed by ctx.ask()', async () => {
    const { runtime } = makeRuntime();
    const triage = agent({ name: 'triage', model: 'mock:test', system: 'sys' });
    runtime.register(
      workflow({
        name: 'wf',
        input: z.string(),
        handler: async (ctx) => ctx.ask(triage, ctx.input as string),
      }),
    );

    const session = runtime.session('s1');
    await session.send('wf', 'hello');
    const history = await session.history();

    expect(history).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'reply-to-hello', agent: 'triage' },
    ]);
    await runtime.shutdown();
  });

  it('user messages do not carry an agent field', async () => {
    const { runtime } = makeRuntime();
    const a = agent({ name: 'a', model: 'mock:test', system: 'sys' });
    runtime.register(
      workflow({
        name: 'wf',
        input: z.string(),
        handler: async (ctx) => ctx.ask(a, ctx.input as string),
      }),
    );

    await runtime.session('s2').send('wf', 'x');
    const history = await runtime.session('s2').history();
    const userMsg = history.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg!.agent).toBeUndefined();
    await runtime.shutdown();
  });

  it('multi-agent: each assistant message is stamped with its own agent name', async () => {
    const { runtime, sentMessages } = makeRuntime();
    const a = agent({ name: 'specialist-a', model: 'mock:test', system: 'sys' });
    const b = agent({ name: 'specialist-b', model: 'mock:test', system: 'sys' });
    runtime.register(
      workflow({
        name: 'wf',
        input: z.string(),
        handler: async (ctx) => {
          await ctx.ask(a, 'turn-1');
          return ctx.ask(b, 'turn-2');
        },
      }),
    );

    const session = runtime.session('multi');
    await session.send('wf', 'kickoff');
    const history = await session.history();

    // history[0] is the session.send user msg. history[1] is agent A's
    // reply. ctx.ask(b, 'turn-2') runs on the *same* WorkflowContext, so
    // its ask appends another user/assistant pair into sessionHistory.
    // The fallback assistant push in Session.send may add an extra
    // assistant entry mirroring the workflow result if needed; just
    // assert the agent stamps are correct on the committed assistant
    // entries we own.
    const assistantMsgs = history.filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(2);
    const stamps = assistantMsgs.map((m) => m.agent).filter(Boolean);
    // Both agent names must appear.
    expect(stamps).toContain('specialist-a');
    expect(stamps).toContain('specialist-b');

    // The provider must have received the prior assistant message back
    // through messages[] on the second ask — verify that an
    // agent-attributed assistant message round-tripped through the
    // provider without error.
    expect(sentMessages.length).toBeGreaterThanOrEqual(2);
    const secondCallMsgs = sentMessages[sentMessages.length - 1];
    expect(secondCallMsgs.some((m) => m.role === 'assistant' && m.agent === 'specialist-a')).toBe(
      true,
    );
    await runtime.shutdown();
  });

  it("provider tripwire: an inbound message carrying agent: 'x' does not crash any built-in provider's serializer", async () => {
    // Drive a single call through a provider with a pre-attributed
    // assistant message in the history. If a provider naively spread a
    // message object (or rejected unknown keys), this would crash.
    // MockProvider here exercises the same pattern axl uses internally.
    const { runtime, sentMessages } = makeRuntime();
    const a = agent({ name: 'tripwire-agent', model: 'mock:test', system: 'sys' });
    runtime.register(
      workflow({
        name: 'wf',
        input: z.string(),
        handler: async (ctx) => ctx.ask(a, ctx.input as string),
      }),
    );

    // Pre-seed history with an attributed assistant message via the
    // session metadata path (mirrors what stream/send do internally).
    const session = runtime.session('tripwire');
    await session.send('wf', 'first');
    // Second send replays the prior assistant turn (with agent stamp) on
    // the wire to the provider.
    const result = await session.send('wf', 'second');
    expect(result).toBe('reply-to-second');

    // Verify the second wire call DID receive the attributed message
    // and produced a reply — the call would have rejected if the field
    // were unsafe.
    const second = sentMessages[sentMessages.length - 1];
    expect(second.find((m) => m.role === 'assistant' && m.agent === 'tripwire-agent')).toBeTruthy();
    await runtime.shutdown();
  });

  it('Session.send fallback assistant push leaves agent undefined', async () => {
    // The fallback push in Session.send fires when the workflow returns a
    // result string but the inner ctx.ask never pushed an assistant
    // message (e.g., a workflow that returns a literal). Such a message
    // has no agent context, so `agent` must be absent.
    const { runtime } = makeRuntime();
    runtime.register(
      workflow({
        name: 'wf-no-ask',
        input: z.string(),
        handler: async (_ctx) => 'static-result',
      }),
    );

    const session = runtime.session('no-ask');
    await session.send('wf-no-ask', 'whatever');
    const history = await session.history();

    expect(history).toEqual([
      { role: 'user', content: 'whatever' },
      { role: 'assistant', content: 'static-result' },
    ]);
    // The assistant message has no agent field — explicit check.
    expect((history[1] as ChatMessage).agent).toBeUndefined();
    await runtime.shutdown();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial scenarios — try to break the contract.
// ─────────────────────────────────────────────────────────────────────────────

/** Build a sequence-driven raw `Provider` (mirrors handoff-improvements.test). */
function createSequenceProvider(
  responses: Array<string | { content?: string; tool_calls: ToolCallMessage[] }>,
): Provider {
  let callIndex = 0;
  return {
    name: 'mock',
    chat: async () => {
      const item = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      if (typeof item === 'string') {
        return {
          content: item,
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          cost: 0,
        } as ProviderResponse;
      }
      return {
        content: item.content ?? '',
        tool_calls: item.tool_calls,
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        cost: 0,
      } as ProviderResponse;
    },
    stream: async function* () {
      yield {
        type: 'done' as const,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    },
  };
}

describe('ChatMessage.agent — adversarial: provider wire payload tripwire', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.GOOGLE_API_KEY = 'test-key';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    vi.restoreAllMocks();
  });

  function installFetchMock(jsonResponse: unknown) {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.resolve(jsonResponse),
      text: () => Promise.resolve(''),
      body: undefined,
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  function getRequestBody(): Record<string, unknown> {
    const calls = fetchMock.mock.calls as unknown as Array<[unknown, { body: string }]>;
    expect(calls.length).toBeGreaterThan(0);
    const last = calls[calls.length - 1];
    return JSON.parse(last[1].body);
  }

  /** A history with an attributed assistant message that the provider must NOT leak. */
  const attributedHistory: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'first turn' },
    { role: 'assistant', content: 'prior reply', agent: 'leak-canary' },
    { role: 'user', content: 'second turn' },
  ];

  it('OpenAIProvider.chat() does NOT include `agent` in the wire payload', async () => {
    installFetchMock({
      choices: [{ message: { content: 'ok', tool_calls: undefined } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const provider = new OpenAIProvider();
    await provider.chat(attributedHistory, { model: 'gpt-4o' });

    const body = getRequestBody();
    const sent = body.messages as Array<Record<string, unknown>>;
    expect(sent).toBeDefined();
    // No message on the wire may carry `agent`. Stringify-and-search is a
    // defense-in-depth check in case nested fields are added later.
    for (const m of sent) {
      expect(m).not.toHaveProperty('agent');
    }
    expect(JSON.stringify(body)).not.toContain('leak-canary');
  });

  it('AnthropicProvider.chat() does NOT include `agent` in the wire payload', async () => {
    installFetchMock({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'end_turn',
    });

    const provider = new AnthropicProvider({ apiKey: 'test-key' });
    await provider.chat(attributedHistory, { model: 'claude-sonnet-4-5' });

    const body = getRequestBody();
    const sent = body.messages as Array<Record<string, unknown>>;
    expect(sent).toBeDefined();
    for (const m of sent) {
      expect(m).not.toHaveProperty('agent');
    }
    expect(JSON.stringify(body)).not.toContain('leak-canary');
  });

  it('GeminiProvider.chat() does NOT include `agent` in the wire payload', async () => {
    installFetchMock({
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'ok' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    });

    const provider = new GeminiProvider({ apiKey: 'test-key' });
    await provider.chat(attributedHistory, { model: 'gemini-2.5-pro' });

    const body = getRequestBody();
    // Gemini uses `contents` (not `messages`); each entry has `role` + `parts`.
    const contents = body.contents as Array<Record<string, unknown>>;
    expect(contents).toBeDefined();
    for (const c of contents) {
      expect(c).not.toHaveProperty('agent');
    }
    expect(JSON.stringify(body)).not.toContain('leak-canary');
  });

  it('OpenAIResponsesProvider.chat() does NOT include `agent` in the wire payload', async () => {
    installFetchMock({
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok' }],
        },
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        output_tokens_details: { reasoning_tokens: 0 },
      },
    });

    const provider = new OpenAIResponsesProvider({ apiKey: 'test-key' });
    await provider.chat(attributedHistory, { model: 'gpt-5' });

    const body = getRequestBody();
    const input = body.input as Array<Record<string, unknown>>;
    expect(input).toBeDefined();
    for (const item of input) {
      expect(item).not.toHaveProperty('agent');
    }
    expect(JSON.stringify(body)).not.toContain('leak-canary');
  });

  it('OpenAI wire payload key set is restricted to OpenAI-known fields', async () => {
    installFetchMock({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    // Pre-seed extra fields that must be stripped by `formatMessage`.
    const overstuffed: ChatMessage[] = [
      {
        role: 'assistant',
        content: 'prior',
        agent: 'leak-canary',
        // providerMetadata is internal — must NOT round-trip onto the wire.
        providerMetadata: { secret: 'x' },
      },
      { role: 'user', content: 'next' },
    ];

    const provider = new OpenAIProvider();
    await provider.chat(overstuffed, { model: 'gpt-4o' });

    const body = getRequestBody();
    const allowed = new Set(['role', 'content', 'name', 'tool_calls', 'tool_call_id']);
    for (const m of (body.messages as Array<Record<string, unknown>>) ?? []) {
      for (const k of Object.keys(m)) {
        expect(allowed.has(k), `OpenAI message contained unexpected key "${k}"`).toBe(true);
      }
    }
    expect(JSON.stringify(body)).not.toContain('leak-canary');
    expect(JSON.stringify(body)).not.toContain('providerMetadata');
  });
});

describe('ChatMessage.agent — adversarial: persistence round-trip', () => {
  it('MemoryStore preserves `agent` through save/get (deep clone semantics)', async () => {
    const store = new MemoryStore();
    const sessionId = `persist-${randomUUID()}`;
    const original: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'a-reply', agent: 'alpha' },
      { role: 'assistant', content: 'b-reply', agent: 'bravo' },
    ];
    await store.saveSession(sessionId, original);
    const restored = await store.getSession(sessionId);

    expect(restored).toEqual(original);
    expect(restored[1].agent).toBe('alpha');
    expect(restored[2].agent).toBe('bravo');

    // Confirm deep clone — mutating the restored array doesn't affect storage.
    restored[1].agent = 'tampered';
    const restoredAgain = await store.getSession(sessionId);
    expect(restoredAgain[1].agent).toBe('alpha');
  });

  it('round-trips end-to-end: ctx.ask -> session.history() (MemoryStore default)', async () => {
    const provider = MockProvider.fn(() => ({ content: 'reply' }));
    const runtime = new AxlRuntime({ defaultProvider: 'mock' });
    runtime.registerProvider('mock', provider);
    const a = agent({ name: 'persisted-agent', model: 'mock:test', system: 'sys' });
    runtime.register(
      workflow({
        name: 'wf',
        input: z.string(),
        handler: async (ctx) => ctx.ask(a, ctx.input as string),
      }),
    );

    const sessionId = `e2e-${randomUUID()}`;
    await runtime.session(sessionId).send('wf', 'hello');

    // Re-read from a fresh Session handle to ensure we hit the StateStore.
    const history = await runtime.session(sessionId).history();
    const assistant = history.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant!.agent).toBe('persisted-agent');

    await runtime.shutdown();
  });

  it('SQLiteStore preserves `agent` through JSON serialization round-trip', async () => {
    const { SQLiteStore } = await import('../state/sqlite.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const dir = mkdtempSync(join(tmpdir(), 'axl-attr-sqlite-'));
    try {
      const store = new SQLiteStore(join(dir, 'state.sqlite'));
      const sessionId = `sqlite-${randomUUID()}`;
      const original: ChatMessage[] = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'a-reply', agent: 'alpha' },
        { role: 'user', content: 'follow-up' },
        { role: 'assistant', content: 'b-reply', agent: 'bravo' },
      ];
      await store.saveSession(sessionId, original);
      const restored = await store.getSession(sessionId);

      expect(restored).toEqual(original);
      expect(restored[1].agent).toBe('alpha');
      expect(restored[3].agent).toBe('bravo');
      // user messages have no agent
      expect((restored[0] as ChatMessage).agent).toBeUndefined();

      await store.close?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('SQLiteStore: pre-existing rows without `agent` deserialize cleanly (forward compat)', async () => {
    const { SQLiteStore } = await import('../state/sqlite.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const dir = mkdtempSync(join(tmpdir(), 'axl-attr-fwd-'));
    try {
      const store = new SQLiteStore(join(dir, 'state.sqlite'));
      const sessionId = `legacy-${randomUUID()}`;
      // Simulate a session saved by an older axl version: no `agent` field.
      const legacy: ChatMessage[] = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'old-reply' },
      ];
      await store.saveSession(sessionId, legacy);
      const restored = await store.getSession(sessionId);
      expect(restored).toEqual(legacy);
      // The assistant message has no agent — must remain undefined, not
      // come back as null or empty string after the JSON round-trip.
      expect((restored[1] as ChatMessage).agent).toBeUndefined();

      await store.close?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ChatMessage.agent — adversarial: handoff attribution', () => {
  it('source and target agents each stamp their own committed assistant messages', async () => {
    const target = agent({
      name: 'target',
      model: 'mock:test',
      system: 'specialist',
    });
    const source = agent({
      name: 'source',
      model: 'mock:test',
      system: 'coordinator',
      handoffs: [{ agent: target }], // oneway
    });

    // Source: emits handoff_to_target (no text).
    // Target: returns final text — its assistant message is committed.
    const provider = createSequenceProvider([
      {
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: { name: 'handoff_to_target', arguments: '{}' },
          },
        ],
      },
      'target-final-answer',
    ]);

    const registry = new ProviderRegistry();
    registry.registerInstance('mock', provider);
    const sessionHistory: ChatMessage[] = [];
    const ctx = new WorkflowContext({
      input: 'go',
      executionId: randomUUID(),
      config: {},
      providerRegistry: registry,
      sessionHistory,
    });
    const result = await ctx.ask(source, 'route this');
    expect(result).toBe('target-final-answer');

    // Target's reply is the one committed to session history (oneway: target
    // is terminal). It must carry agent: 'target', not 'source'.
    const assistantMsgs = sessionHistory.filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
    const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
    expect(lastAssistant.agent).toBe('target');
    expect(lastAssistant.content).toBe('target-final-answer');
  });

  it('roundtrip handoff: target sees inbound messages with no mis-attribution', async () => {
    // Use the agent name as it appears in handoff tool name. Tool names
    // include the literal agent _name (handoff_to_<name>), so the agent
    // names here must match what the mock provider emits.
    const seenPerCall: ChatMessage[][] = [];
    const responses: Array<string | { content?: string; tool_calls: ToolCallMessage[] }> = [
      {
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: {
              name: 'handoff_to_target',
              arguments: '{"message":"please help"}',
            },
          },
        ],
      },
      'specialist-answer',
      'final: specialist-answer',
    ];
    let callIndex = 0;
    const provider: Provider = {
      name: 'mock',
      chat: async (messages) => {
        seenPerCall.push(messages.map((m) => ({ ...m })));
        const item = responses[callIndex] ?? responses[responses.length - 1];
        callIndex++;
        if (typeof item === 'string') {
          return {
            content: item,
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            cost: 0,
          } as ProviderResponse;
        }
        return {
          content: item.content ?? '',
          tool_calls: item.tool_calls,
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          cost: 0,
        } as ProviderResponse;
      },
      stream: async function* () {
        yield {
          type: 'done' as const,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      },
    };

    const target = agent({ name: 'target', model: 'mock:test', system: 'specialist' });
    const source = agent({
      name: 'source',
      model: 'mock:test',
      system: 'coordinator',
      handoffs: [{ agent: target, mode: 'roundtrip' }],
    });

    const registry = new ProviderRegistry();
    registry.registerInstance('mock', provider);
    const sessionHistory: ChatMessage[] = [];
    const ctx = new WorkflowContext({
      input: 'go',
      executionId: randomUUID(),
      config: {},
      providerRegistry: registry,
      sessionHistory,
    });
    const result = await ctx.ask(source, 'coordinate');
    expect(result).toBe('final: specialist-answer');

    // Three calls: source-1 (handoff), target, source-2 (final).
    expect(seenPerCall.length).toBe(3);

    // Target call window (callIndex 1) must not carry any mis-attributed
    // assistant message naming the target itself.
    const targetWindow = seenPerCall[1];
    for (const m of targetWindow) {
      if (m.role === 'assistant' && m.agent !== undefined) {
        expect(m.agent).not.toBe('target');
      }
    }

    // Roundtrip: control returned to source, which produced the final
    // committed assistant message. The committed entry in session history
    // must carry agent: 'source', not 'target'. (The source's first turn
    // emitted only a handoff tool call — no text — so no commit there.)
    const assistantMsgs = sessionHistory.filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
    const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
    expect(lastAssistant.agent).toBe('source');
    expect(lastAssistant.content).toBe('final: specialist-answer');
  });
});

describe('ChatMessage.agent — adversarial: child context isolation', () => {
  it('child context does not inherit parent sessionHistory; child stamps land only on child', async () => {
    const provider = MockProvider.fn(() => ({ content: 'reply' }));
    const registry = new ProviderRegistry();
    registry.registerInstance('mock', provider);

    const parentHistory: ChatMessage[] = [];
    const parentCtx = new WorkflowContext({
      input: 'parent',
      executionId: randomUUID(),
      config: {},
      providerRegistry: registry,
      metadata: { sessionHistory: parentHistory },
    });

    // Child context — no sessionHistory passed; per `createChildContext`
    // contract, it gets its own (empty) sessionHistory.
    const childCtx = parentCtx.createChildContext();

    const child = agent({ name: 'child-agent', model: 'mock:test', system: 'sys' });
    await childCtx.ask(child, 'isolated');

    // Parent's session history must not contain the child's stamped reply.
    expect(parentHistory.find((m) => m.agent === 'child-agent')).toBeUndefined();
    // (Since parent never had session history-driven ctx.ask, parentHistory
    // remains empty for assistant messages.)
    expect(parentHistory.filter((m) => m.role === 'assistant')).toEqual([]);
  });
});

describe('ChatMessage.agent — adversarial: session.fork preserves stamps', () => {
  it('fork() copies attributed history to the new session id', async () => {
    const provider = MockProvider.fn(() => ({ content: 'reply' }));
    const runtime = new AxlRuntime({ defaultProvider: 'mock' });
    runtime.registerProvider('mock', provider);
    const a = agent({ name: 'fork-source', model: 'mock:test', system: 'sys' });
    runtime.register(
      workflow({
        name: 'wf',
        input: z.string(),
        handler: async (ctx) => ctx.ask(a, ctx.input as string),
      }),
    );

    const original = runtime.session(`orig-${randomUUID()}`);
    await original.send('wf', 'hello');
    const forkedId = `forked-${randomUUID()}`;
    const forked = await original.fork(forkedId);

    const origHistory = await original.history();
    const forkedHistory = await forked.history();

    // Must be deep-equal (including `agent`) and reference-independent.
    expect(forkedHistory).toEqual(origHistory);
    const forkedAssistant = forkedHistory.find((m) => m.role === 'assistant');
    expect(forkedAssistant?.agent).toBe('fork-source');

    await runtime.shutdown();
  });
});

describe('ChatMessage.agent — adversarial: type contract', () => {
  it('agent is optional on ChatMessage (compile-time contract)', () => {
    // Compiles-without-error is the assertion. If `agent` were ever marked
    // required, this file would stop typechecking.
    const m: ChatMessage = { role: 'user', content: 'no-agent' };
    expect(m.agent).toBeUndefined();

    const stamped: ChatMessage = { role: 'assistant', content: 'r', agent: 'a' };
    expect(stamped.agent).toBe('a');
  });
});
