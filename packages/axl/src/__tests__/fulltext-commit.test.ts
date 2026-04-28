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
   * FOLLOWUPS P1: `fullText` interleaves concurrent root-level asks
   * (`packages/axl/src/stream.ts:222-239`).
   *
   * `AxlStream.currentAttemptTokens` is a single shared buffer. Under
   * `ctx.parallel()` / `ctx.spawn()` / `ctx.map()`, multiple root-level
   * asks emit tokens concurrently (all `depth: 0`). Their tokens
   * interleave, and a `pipeline(failed)` from one concurrent branch can
   * discard another branch's successful in-progress tokens.
   *
   * This test PINS the current (limited) behavior — `fullText` contains
   * BOTH branches' content concatenated in arrival order, with no
   * per-askId scoping. If a future fix scopes the buffer per-askId,
   * this test will fail and force a documented decision (either update
   * the assertion to reflect scoped behavior, or keep the current
   * concatenation as the documented contract).
   *
   * See FOLLOWUPS.md §"`fullText` interleaves concurrent root-level asks"
   * for the architectural choice between (a) document-only — tell
   * parallel-ask consumers to use `.textByAsk` — and (b) scope the
   * buffer per-askId. Today's behavior is option (a) silently in effect.
   */
  it('parallel root-level asks: fullText concatenates both branches (FOLLOWUPS P1, current behavior)', async () => {
    // Two ctx.parallel branches, each making a root-level ctx.ask. Both
    // emit tokens concurrently (depth=0 for both — they share a stream
    // and a buffer). Pin that fullText contains BOTH branches' content.
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

    // Current behavior: BOTH branches' chunks appear in fullText, but
    // INTERLEAVED at chunk boundaries (push-order across the shared
    // buffer, not askId-scoped). The chunks ['branchA-', 'content'] from
    // one branch and ['branchB-', 'content'] from the other arrive in
    // some interleaved order — we don't pin exact order (parallel
    // scheduling is non-deterministic across runs) but we pin the
    // INVARIANTS:
    //
    //   1. Every chunk from both branches is present in fullText (no
    //      tokens are lost).
    //   2. Total length equals the sum of all chunks (no de-dup).
    //   3. The chunks may NOT recombine into the original strings
    //      ('branchA-content', 'branchB-content') because of the
    //      interleave — this is the LIMITATION the FOLLOWUPS item
    //      describes. If you want clean per-branch streams, use
    //      `.textByAsk`.
    const fullText = stream.fullText;
    // Every chunk substring is present (push order may interleave).
    expect(fullText).toContain('branchA-');
    expect(fullText).toContain('branchB-');
    // 'content' appears twice (once per branch).
    const contentMatches = fullText.match(/content/g);
    expect(contentMatches?.length).toBe(2);

    // Total length: 'branchA-' + 'content' + 'branchB-' + 'content' = sum.
    const expectedTotal =
      'branchA-'.length + 'content'.length + 'branchB-'.length + 'content'.length;
    expect(fullText.length).toBe(expectedTotal);
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
