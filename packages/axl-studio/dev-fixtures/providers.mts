/**
 * Mock providers for the dev fixtures.
 *
 * These are `MockProvider`s — no network, no API keys. `index.mts` registers
 * them under the REAL provider scheme names (so the Studio UI shows production-
 * realistic `provider:model` labels and a multi-provider cost breakdown), but
 * the behavior is 100% local. The scheme each is registered under is noted below.
 *
 * Four providers, each with a clear purpose:
 *
 *   realisticEchoProvider  (scheme: openai-responses) — realistic echo with
 *                       token + cost telemetry. Used by most "ordinary" demo
 *                       workflows (qa, research, etc).
 *   jsonProvider           (scheme: openai) — always returns a structured-
 *                       output JSON shape.
 *   schemaRetryProvider    (scheme: anthropic) — first turn malformed JSON,
 *                       second turn valid; used by the schema-retry feedback eval.
 *   mockTaggedProvider     (scheme: google) — dispatches on a `[#tag]` token at
 *                       the start of the agent's system prompt. Routes to per-
 *                       scenario behaviors (handoffs, partial_object chunks,
 *                       always-fail, parallel branches, etc) without the
 *                       fragile "match a phrase in the system prompt" hack.
 *
 * Helper `chunkingFnProvider(fn)`: like `MockProvider.fn()` but the
 * `stream()` method honors the `chunks` field returned by `fn`. Without
 * it, the schema pipeline can't emit `partial_object` events (it needs
 * incremental text_deltas to walk past structural boundaries).
 */
import type {
  ChatMessage,
  ChatOptions,
  Provider,
  ProviderResponse,
  StreamChunk,
} from '@axlsdk/axl';
import { inputText } from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';

// ── chunkingFnProvider helper ─────────────────────────────────────────

type ChunkingFnResponse = {
  content: string;
  chunks?: string[];
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  cost?: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  /** Optional ms delay between chunks during `stream()`. Useful for
   *  visual demos of the typewriter UX — without this, mock chunks fire
   *  synchronously and the entire stream completes in microseconds,
   *  invisible to a human watching the Playground panel. The Playground's
   *  spec/17 typewriter rendering is well-tested mechanically; this delay
   *  exists so a human can SEE it work end-to-end. */
  chunkDelayMs?: number;
};

export function chunkingFnProvider(
  fn: (messages: ChatMessage[]) => ChunkingFnResponse,
): Provider {
  const fallbackUsage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 };
  return {
    name: 'chunking-fn',
    async chat(messages: ChatMessage[], _options: ChatOptions): Promise<ProviderResponse> {
      const r = fn(messages);
      return {
        content: r.content,
        tool_calls: r.tool_calls,
        usage: { ...fallbackUsage, ...(r.usage ?? {}) },
        cost: r.cost ?? 0,
      };
    },
    async *stream(messages: ChatMessage[], _options: ChatOptions): AsyncGenerator<StreamChunk> {
      const r = fn(messages);
      const chunks = r.chunks && r.chunks.length > 0 ? r.chunks : [r.content];
      const delay = r.chunkDelayMs ?? 0;
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        if (c) yield { type: 'text_delta', content: c };
        if (delay > 0 && i < chunks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      if (r.tool_calls) {
        for (const tc of r.tool_calls) {
          yield {
            type: 'tool_call_delta',
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          };
        }
      }
      yield {
        type: 'done',
        usage: { ...fallbackUsage, ...(r.usage ?? {}) },
      };
    },
  };
}

// ── mock (realistic echo) ─────────────────────────────────────────────
//
// The 400-800ms delay per call makes eval runs take long enough to observe
// streaming progress, test navigate-away-and-back, and exercise cancel.
export const realisticEchoProvider = MockProvider.fn(async (messages) => {
  await new Promise((resolve) => setTimeout(resolve, 400 + Math.floor(Math.random() * 400)));
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const promptTokens = 120 + Math.floor(Math.random() * 80);
  const completionTokens = 200 + Math.floor(Math.random() * 150);
  // ~$3/M input, ~$15/M output (gpt-4o-like pricing)
  const cost = promptTokens * 0.000003 + completionTokens * 0.000015;
  return {
    content: lastUser ? inputText(lastUser.content) : '',
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
    cost: Math.round(cost * 1_000_000) / 1_000_000,
  };
});

// ── mock-json (structured-output JSON) ────────────────────────────────

export const jsonProvider = MockProvider.fn((messages) => {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const question = lastUser?.content ?? '';
  return {
    content: JSON.stringify({
      answer: question,
      confidence: 0.92,
      sources: ['MDN Web Docs', 'TypeScript Handbook'],
      related_topics: ['generics', 'type inference', 'interfaces'],
    }),
    usage: { prompt_tokens: 50, completion_tokens: 120, total_tokens: 170 },
    cost: 0.002,
  };
});

// ── mock-schema-retry (specific schema-feedback eval) ─────────────────

export const schemaRetryProvider = MockProvider.fn(async (messages) => {
  await new Promise((resolve) => setTimeout(resolve, 200));
  // Base (no retry feedback): 2 messages. After retry: 4+ (assistant +
  // corrective system injected by the retry-push mechanism).
  const isRetry = messages.length > 3;
  const content = isRetry
    ? JSON.stringify({ answer: 'valid after retry', score: 0.8 })
    : '{ "answer": incomplete'; // deliberately malformed
  return {
    content,
    usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 },
    cost: 0.001,
  };
});

// ── mock-tagged ([#tag]-routed dispatcher) ────────────────────────────
//
// Each agent that uses this provider leads its system prompt with a
// `[#tag]` token. The dispatcher picks the branch by exact tag, which
// is more robust than substring-matching the prompt's prose (an early
// version matched the orchestrator's prompt against the sub-researcher
// branch because the orchestrator's prompt mentions the tool name
// `call-sub-researcher`).
//
// Tags exercised:
//   sub-researcher       — depth=1 child-ask demo (called via tool)
//   orchestrator         — depth=0 parent that calls call-sub-researcher
//   always-fail          — never returns valid JSON (terminal schema exhaust)
//   chunked-structured   — chunked JSON, exercises partial_object emission
//   generalist           — handoff source (calls auto-generated handoff tool)
//   specialist           — handoff target
//   verbose-demo         — short response; prompt is huge (truncation cap test)
//   parallel-branch-<n>  — sibling root-level asks under ctx.parallel
//
// (The pipeline failed→committed retry path is covered by the dedicated
//  `mock-schema-retry` provider + `schema-retry-workflow`; no tag here.)
export const mockTaggedProvider = chunkingFnProvider((messages) => {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';
  const systemMsg = messages.find((m) => m.role === 'system');
  const systemText = typeof systemMsg?.content === 'string' ? systemMsg.content : '';

  const hasToolResult = messages.some((m) => m.role === 'tool');
  const assistantTurns = messages.filter((m) => m.role === 'assistant').length;
  const tagMatch = systemText.match(/^\[#([\w-]+)\]/);
  const tag = tagMatch ? tagMatch[1] : '';

  switch (tag) {
    case 'sub-researcher': {
      const content = `Sub-finding for "${userText.slice(0, 60)}": three load-bearing observations.`;
      return { content, chunks: content.match(/.{1,6}/g) ?? [content], cost: 0.0008 };
    }

    case 'orchestrator': {
      // Turn 1 → call the sub-researcher tool. Turn 2 → synthesize.
      if (!hasToolResult) {
        return {
          content: '',
          tool_calls: [
            {
              id: `tc-orch-${assistantTurns}`,
              type: 'function' as const,
              function: {
                name: 'call-sub-researcher',
                arguments: JSON.stringify({ subQuestion: userText.slice(0, 80) }),
              },
            },
          ],
          cost: 0.001,
        };
      }
      const toolMsg = [...messages].reverse().find((m) => m.role === 'tool');
      const subResult = typeof toolMsg?.content === 'string' ? toolMsg.content : '(no result)';
      const content = `Orchestrator synthesis: ${subResult.slice(0, 120)}`;
      return { content, chunks: content.match(/.{1,5}/g) ?? [content], cost: 0.002 };
    }

    case 'always-fail':
      return { content: 'not-json-at-all', chunks: ['not-json', '-at-all'], cost: 0.001 };

    case 'chunked-structured': {
      // Long summary so the typewriter UX in the Playground is visible
      // to a human (without ~2s of stream time, the entire response
      // completes in a few render frames and the in-flight bubble
      // never shows). Each chunk delays 60ms — short enough that the
      // demo doesn't feel slow, long enough that the structured-output
      // bubble + typewriter line have time to render frame-by-frame.
      const content = JSON.stringify(
        {
          title: 'Market Analysis Q3',
          summary:
            'The AI sector outlook for Q3 2026 shows continued momentum across infrastructure ' +
            'and applications layers. Capex commitments from hyperscalers remain elevated, ' +
            'with three load-bearing drivers stabilizing the medium-term thesis: regulatory ' +
            'clarity in major markets, deeper enterprise adoption beyond pilots, and a ' +
            'tightening compute supply that benefits incumbents with reserved capacity.',
          bulletPoints: [
            'Hyperscaler capex remains elevated through 2026',
            'Enterprise adoption shifts from pilot to production',
            'Compute supply tightens; capacity reservations matter',
            'Regulatory clarity in EU/US reduces tail risk',
          ],
          confidence: 0.78,
        },
        null,
        2,
      );
      const chunks = content.match(/.{1,8}/g) ?? [content];
      return { content, chunks, cost: 0.005, chunkDelayMs: 60 };
    }

    case 'generalist': {
      // Emit a handoff tool call on the first turn. The runtime auto-
      // generates `handoff_to_<targetAgent.name>` as a tool name.
      if (!hasToolResult) {
        return {
          content: '',
          tool_calls: [
            {
              id: `tc-handoff-${assistantTurns}`,
              type: 'function' as const,
              function: {
                name: 'handoff_to_specialist-agent',
                arguments: JSON.stringify({}),
              },
            },
          ],
          cost: 0.001,
        };
      }
      const content = 'Handoff complete; specialist will respond.';
      return { content, cost: 0.0005 };
    }

    case 'specialist': {
      const content = `Specialist response: ${userText.slice(0, 60)}. Detailed answer follows.`;
      return { content, chunks: content.match(/.{1,5}/g) ?? [content], cost: 0.002 };
    }

    case 'verbose-demo':
      return { content: 'Acknowledged large payload.', cost: 0.001 };

    default: {
      // Parallel-branch tag is dynamic: `[#parallel-branch-<n>]`.
      const branchMatch = tag.match(/^parallel-branch-(\d+)$/);
      if (branchMatch) {
        const content = `Branch ${branchMatch[1]}: finished analyzing ${userText.slice(0, 40)}.`;
        return { content, chunks: content.match(/.{1,6}/g) ?? [content], cost: 0.001 };
      }
      const content = `[mock-tagged/untagged] ${userText.slice(0, 60)}`;
      return { content, cost: 0.0005 };
    }
  }
});
