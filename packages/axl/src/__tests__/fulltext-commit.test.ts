import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { workflow } from '../workflow.js';
import { agent } from '../agent.js';
import { AxlRuntime } from '../runtime.js';
import { MockProvider } from '../../../axl-testing/src/mock-provider.js';

/**
 * AxlStream.fullText commit-on-pipeline-committed (spec/16 §4.3).
 *
 * In 0.15.x, retried attempts' tokens leaked into `fullText` — the chat
 * UI rendered garbled output across schema/validate/guardrail retries.
 *
 * 0.16.x splits the buffer into in-progress and committed halves;
 * `pipeline(committed)` flushes in-progress to committed; `pipeline(failed)`
 * discards in-progress. `fullText` returns committed + in-progress so
 * mid-attempt reads are sane and post-`done` reads are canonical.
 */
describe('AxlStream.fullText — commit-on-pipeline-committed', () => {
  it('discards retried attempt tokens; only the winning attempt appears in fullText', async () => {
    // Schema retry: first attempt returns garbled text, second returns
    // valid JSON. Only the winning JSON should appear in fullText.
    const provider = MockProvider.sequence([
      { content: 'garbled-attempt-one', chunks: ['gar', 'bled-', 'attempt-one'] },
      { content: '{"x":42}', chunks: ['{"x":', '42}'] },
    ]);
    const runtime = new AxlRuntime({ defaultProvider: 'mock' });
    runtime.registerProvider('mock', provider);
    const a = agent({ name: 'retry-stream', model: 'mock:test', system: 'test' });
    const wf = workflow({
      name: 'retry-stream-wf',
      input: z.object({}),
      handler: async (ctx) => ctx.ask(a, 'q', { schema: z.object({ x: z.number() }), retries: 3 }),
    });
    runtime.register(wf);

    const stream = runtime.stream('retry-stream-wf', {});
    for await (const event of stream) {
      if (event.type === 'done') break;
    }

    // The garbled first attempt is gone; only the winning '{"x":42}' is
    // committed to fullText.
    expect(stream.fullText).toBe('{"x":42}');
    expect(stream.fullText).not.toContain('garbled');
  });

  it('on success path (no retries), fullText equals the single attempt content', async () => {
    const provider = MockProvider.sequence([
      { content: 'Hello world', chunks: ['Hello ', 'world'] },
    ]);
    const runtime = new AxlRuntime({ defaultProvider: 'mock' });
    runtime.registerProvider('mock', provider);
    const a = agent({ name: 'happy-stream', model: 'mock:test', system: 'test' });
    const wf = workflow({
      name: 'happy-stream-wf',
      input: z.object({}),
      handler: async (ctx) => ctx.ask(a, 'q'),
    });
    runtime.register(wf);

    const stream = runtime.stream('happy-stream-wf', {});
    for await (const event of stream) {
      if (event.type === 'done') break;
    }

    expect(stream.fullText).toBe('Hello world');
  });

  it('does not leak tokens across asks when an ask throws terminally (ask_end(ok:false) resets buffer)', async () => {
    // Reviewer bug B2: ctx.ask() terminal-throw paths (max-turns,
    // guardrail exhaustion, verify-throw, validate-throw) do NOT emit
    // `pipeline(failed)`. Without the ask_end(ok:false) reset trigger,
    // the failed ask's `currentAttemptTokens` would leak into the NEXT
    // ask's `pipeline(committed)` and corrupt `fullText`.
    //
    // Build a workflow that attempts an ask whose schema never parses
    // (exhausts retries → throws `VerifyError`), catches the error, and
    // runs a second successful ask. `fullText` must reflect only the
    // second ask's content.
    const provider = MockProvider.sequence([
      // First ask: 3 attempts of invalid JSON (exhausts retries=2 → terminal throw)
      { content: 'fail-one', chunks: ['fail-', 'one'] },
      { content: 'fail-two', chunks: ['fail-', 'two'] },
      { content: 'fail-three', chunks: ['fail-', 'three'] },
      // Second ask: succeeds
      { content: 'winner', chunks: ['win', 'ner'] },
    ]);
    const runtime = new AxlRuntime({ defaultProvider: 'mock' });
    runtime.registerProvider('mock', provider);
    const a = agent({ name: 'leak-test', model: 'mock:test', system: 'test' });
    const wf = workflow({
      name: 'cross-ask-leak-wf',
      input: z.object({}),
      handler: async (ctx) => {
        try {
          await ctx.ask(a, 'q1', { schema: z.object({ x: z.number() }), retries: 2 });
        } catch {
          // Swallow the terminal VerifyError; the second ask should
          // start with a clean `currentAttemptTokens` buffer.
        }
        return ctx.ask(a, 'q2');
      },
    });
    runtime.register(wf);

    const stream = runtime.stream('cross-ask-leak-wf', {});
    for await (const event of stream) {
      if (event.type === 'done') break;
    }

    // The failed ask's tokens MUST NOT appear in fullText.
    expect(stream.fullText).not.toContain('fail-');
    expect(stream.fullText).toBe('winner');
  });

  /**
   * FOLLOWUPS P1 — RESOLVED: `fullText` per-askId scoping.
   *
   * Pre-fix behavior (0.16.0): `currentAttemptTokens` was a single
   * shared buffer. Under `ctx.parallel()` / `ctx.spawn()` / `ctx.map()`,
   * concurrent root-level asks contended on the buffer — chunks
   * interleaved at push-order boundaries, and a `pipeline(failed)` on
   * one branch discarded sibling branches' in-progress tokens.
   *
   * Post-fix: `attemptByAsk: Map<askId, string[]>` and
   * `committedByAsk: Map<askId, string>` scope buffers per ask. Each
   * branch's chunks stay contiguous in `fullText` (in the order the
   * branch first emitted), and a failure on one branch only discards
   * THAT branch's buffer.
   *
   * Two tests pin the post-fix invariants:
   *   1. concurrent successful asks → each branch contiguous, both
   *      original strings recoverable.
   *   2. one branch fails (pipeline(failed) or ask_end({ok:false})),
   *      other branch unaffected.
   */
  it('parallel root-level asks: each branch stays contiguous in fullText (per-askId scoping)', async () => {
    // Two ctx.parallel branches, each making a root-level ctx.ask. Both
    // emit tokens concurrently. Per-ask scoping ensures each branch's
    // chunks recombine cleanly without interleaving the other.
    const provider = MockProvider.sequence([
      { content: 'branchA-content', chunks: ['branchA-', 'content'] },
      { content: 'branchB-content', chunks: ['branchB-', 'content'] },
    ]);
    const runtime = new AxlRuntime({ defaultProvider: 'mock' });
    runtime.registerProvider('mock', provider);
    const a = agent({ name: 'parallel-asks', model: 'mock:test', system: 'test' });
    const wf = workflow({
      name: 'parallel-asks-wf',
      input: z.object({}),
      handler: async (ctx) => {
        const [r1, r2] = await ctx.parallel([() => ctx.ask(a, 'q1'), () => ctx.ask(a, 'q2')]);
        return { r1, r2 };
      },
    });
    runtime.register(wf);

    const stream = runtime.stream('parallel-asks-wf', {});
    for await (const event of stream) {
      if (event.type === 'done') break;
    }

    // Post-fix invariants:
    //   1. Both original strings appear contiguously (chunks recombine).
    //   2. Total length equals the sum of all chunks (no de-dup).
    //   3. Order of branches in fullText reflects insertion order (which
    //      ask emitted its first token first) — non-deterministic across
    //      runs but consistent within a run.
    const fullText = stream.fullText;
    expect(fullText).toContain('branchA-content');
    expect(fullText).toContain('branchB-content');
    const expectedTotal = 'branchA-content'.length + 'branchB-content'.length;
    expect(fullText.length).toBe(expectedTotal);
    // The two branches together must equal fullText (no extra characters,
    // no missing characters, no interleave at chunk boundaries).
    expect(
      fullText === 'branchA-contentbranchB-content' ||
        fullText === 'branchB-contentbranchA-content',
    ).toBe(true);
  });

  it('parallel asks: one branch failing does NOT discard the sibling branch (per-askId failure isolation)', async () => {
    // Two parallel ctx.ask calls where one fails terminally
    // (ask_end({ok:false}) via verify-throw / max-turns / etc) and the
    // other succeeds. Pre-fix, the failure discarded the shared buffer
    // and corrupted the survivor's fullText. Post-fix, only the failing
    // branch's tokens are dropped.
    //
    // Strategy: agent A succeeds normally; agent B exhausts its turn
    // budget and throws (the workflow catches the throw to exercise the
    // ask_end({ok:false}) path without failing the workflow).
    const provider = MockProvider.fn(async (messages) => {
      const last = messages[messages.length - 1];
      const content = typeof last?.content === 'string' ? last.content : '';
      if (content.includes('q-success')) {
        return { content: 'success-text', chunks: ['success', '-', 'text'] };
      }
      // Fail branch: emit one streamed chunk before throwing on next turn
      // by always returning a tool_call so the loop hits maxTurns: 1.
      return {
        content: '',
        toolCalls: [{ id: 'tc1', name: 'noop', arguments: '{}' }],
        chunks: ['fail-text-'],
      };
    });

    const runtime = new AxlRuntime({ defaultProvider: 'mock' });
    runtime.registerProvider('mock', provider);
    const successAgent = agent({ name: 'success', model: 'mock:test', system: 'a' });
    const failAgent = agent({
      name: 'fail',
      model: 'mock:test',
      system: 'b',
      maxTurns: 1,
      tools: [
        // Inline throwaway tool so the agent has something to "call"
        // and trigger maxTurns exhaustion.
        {
          _name: 'noop',
          _description: 'noop',
          _inputSchema: z.object({}),
          _retry: undefined,
          _hooks: undefined,
          _sensitive: false,
          _requireApproval: false,
          run: async () => ({ ok: true }),
        } as never,
      ],
    });
    const wf = workflow({
      name: 'isolate-failure-wf',
      input: z.object({}),
      handler: async (ctx) => {
        const [r1, r2] = await ctx.parallel([
          () => ctx.ask(successAgent, 'q-success'),
          async () => {
            try {
              return await ctx.ask(failAgent, 'q-fail');
            } catch {
              return 'CAUGHT';
            }
          },
        ]);
        return { r1, r2 };
      },
    });
    runtime.register(wf);

    const stream = runtime.stream('isolate-failure-wf', {});
    for await (const event of stream) {
      if (event.type === 'done') break;
    }

    // Survivor's tokens recombine correctly. Failure branch's partial
    // 'fail-text-' was discarded by ask_end({ok:false}) per the
    // per-ask scoping rule. fullText contains ONLY the success
    // branch's content, no leakage from the failed branch.
    const fullText = stream.fullText;
    expect(fullText).toContain('success-text');
    expect(fullText).not.toContain('fail-text');
  });

  it('parallel asks: 3 branches with one failing — survivors fully present, failed branch absent', async () => {
    // Defense-in-depth for the per-askId scoping invariant: the existing
    // 2-branch test only proves "success doesn't lose to failure" with a
    // single survivor. With 3 branches (two successes A & C plus one
    // failure B), a future regression in the per-ask Map (e.g., clearing
    // the wrong entry on concurrent failure) would corrupt one of A or C
    // — the 2-branch case can't catch that.
    const provider = MockProvider.fn(async (messages) => {
      const last = messages[messages.length - 1];
      const content = typeof last?.content === 'string' ? last.content : '';
      if (content.includes('q-a')) {
        return { content: 'AAAAA', chunks: ['AA', 'AAA'] };
      }
      if (content.includes('q-c')) {
        return { content: 'CCCCC', chunks: ['CC', 'CCC'] };
      }
      // q-b: emit one streamed chunk then drive maxTurns: 1 exhaustion.
      return {
        content: '',
        toolCalls: [{ id: 'tc1', name: 'noop', arguments: '{}' }],
        chunks: ['BBBBB'],
      };
    });

    const runtime = new AxlRuntime({ defaultProvider: 'mock' });
    runtime.registerProvider('mock', provider);
    const aAgent = agent({ name: 'a-agent', model: 'mock:test', system: 'a' });
    const cAgent = agent({ name: 'c-agent', model: 'mock:test', system: 'c' });
    const bFailAgent = agent({
      name: 'b-agent',
      model: 'mock:test',
      system: 'b',
      maxTurns: 1,
      tools: [
        {
          _name: 'noop',
          _description: 'noop',
          _inputSchema: z.object({}),
          _retry: undefined,
          _hooks: undefined,
          _sensitive: false,
          _requireApproval: false,
          run: async () => ({ ok: true }),
        } as never,
      ],
    });

    const wf = workflow({
      name: 'three-branch-wf',
      input: z.object({}),
      handler: async (ctx) => {
        const [rA, rB, rC] = await ctx.parallel([
          () => ctx.ask(aAgent, 'q-a'),
          async () => {
            try {
              return await ctx.ask(bFailAgent, 'q-b');
            } catch {
              return 'CAUGHT';
            }
          },
          () => ctx.ask(cAgent, 'q-c'),
        ]);
        return { rA, rB, rC };
      },
    });
    runtime.register(wf);

    const stream = runtime.stream('three-branch-wf', {});
    for await (const event of stream) {
      if (event.type === 'done') break;
    }

    const fullText = stream.fullText;
    // Both surviving branches' content appears unmolested.
    expect(fullText).toContain('AAAAA');
    expect(fullText).toContain('CCCCC');
    // The failed branch's partial chunk was discarded.
    expect(fullText).not.toContain('BBBBB');
    // Total length equals the sum of survivor lengths exactly — no
    // leakage from the failed branch and no missing characters from the
    // survivors (which would happen if the wrong Map entry got cleared).
    expect(fullText.length).toBe('AAAAA'.length + 'CCCCC'.length);
  });

  it('mid-attempt fullText reflects in-progress tokens until pipeline(committed) commits them', async () => {
    const provider = MockProvider.sequence([
      { content: 'one two three', chunks: ['one ', 'two ', 'three'] },
    ]);
    const runtime = new AxlRuntime({ defaultProvider: 'mock' });
    runtime.registerProvider('mock', provider);
    const a = agent({ name: 'mid-stream', model: 'mock:test', system: 'test' });
    const wf = workflow({
      name: 'mid-stream-wf',
      input: z.object({}),
      handler: async (ctx) => ctx.ask(a, 'q'),
    });
    runtime.register(wf);

    const stream = runtime.stream('mid-stream-wf', {});
    let midAttemptText = '';
    let postCommitText = '';
    for await (const event of stream) {
      if (event.type === 'token') {
        midAttemptText = stream.fullText; // in-progress at this point
      }
      if (event.type === 'pipeline' && event.status === 'committed') {
        postCommitText = stream.fullText;
      }
      if (event.type === 'done') break;
    }

    // Mid-attempt reads see the growing in-progress buffer.
    expect(midAttemptText.length).toBeGreaterThan(0);
    // Post-commit text equals the canonical winning attempt.
    expect(postCommitText).toBe('one two three');
    expect(stream.fullText).toBe('one two three');
  });
});
