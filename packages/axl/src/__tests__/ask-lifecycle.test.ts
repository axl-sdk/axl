import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { tool } from '../tool.js';
import { workflow } from '../workflow.js';
import { AxlRuntime } from '../runtime.js';
import { createTestCtx, createSequenceProvider } from './helpers.js';
import { GuardrailError, ValidationError, BudgetExceededError } from '../errors.js';
import type { AxlEvent, AskScoped } from '../types.js';

describe('ask_start / ask_end lifecycle (spec/16 §3.8)', () => {
  it('emits exactly one ask_start and one ask_end per ctx.ask() on the success path', async () => {
    const a = agent({ name: 'lifecycle', model: 'mock:test', system: 'system' });
    const { ctx, traces } = createTestCtx();

    await ctx.ask(a, 'hello');

    const starts = traces.filter((t) => t.type === 'ask_start');
    const ends = traces.filter((t) => t.type === 'ask_end');
    expect(starts.length).toBe(1);
    expect(ends.length).toBe(1);

    // ask_start carries the prompt; ask_end carries outcome.ok=true with result.
    const start = starts[0] as AxlEvent & AskScoped & { type: 'ask_start'; prompt: string };
    const end = ends[0] as AxlEvent &
      AskScoped & {
        type: 'ask_end';
        outcome: { ok: true; result: unknown } | { ok: false; error: string };
        cost: number;
        duration: number;
      };
    expect(start.prompt).toBe('hello');
    expect(end.outcome.ok).toBe(true);
    if (end.outcome.ok) {
      expect(end.outcome.result).toBe('Done');
    }
    expect(typeof end.cost).toBe('number');
    expect(typeof end.duration).toBe('number');
    expect(end.askId).toBe(start.askId);
  });

  it('emits ask_end with outcome.ok=false when the LLM call throws (e.g., schema retries exhausted)', async () => {
    const a = agent({ name: 'fail', model: 'mock:test', system: 'system' });
    // The default test provider returns "Done" — pair it with a strict
    // schema that the response can't satisfy. Schema retries exhaust and
    // ctx.ask() throws VerifyError, which the ask body catches in finally.
    const { ctx, traces } = createTestCtx();

    await expect(
      ctx.ask(a, 'expect failure', {
        schema: z.object({ shouldNotMatch: z.literal('value') }),
        retries: 0,
      }),
    ).rejects.toThrow();

    const ends = traces.filter((t) => t.type === 'ask_end');
    expect(ends.length).toBe(1);
    const end = ends[0] as AxlEvent & {
      outcome: { ok: true; result: unknown } | { ok: false; error: string };
    };
    expect(end.outcome.ok).toBe(false);
    if (!end.outcome.ok) {
      expect(typeof end.outcome.error).toBe('string');
    }
  });

  it('ask_end.cost rolls up agent_call_end + tool_call_end WITHIN the ask, excluding nested asks (spec decision 10)', async () => {
    // Setup: outer agent calls a tool that invokes an inner agent. The inner
    // ask has its own ask_end with its own cost. The outer ask_end MUST NOT
    // double-count the inner cost — only its own agent_call_end events.
    const inner = agent({ name: 'inner', model: 'mock:test', system: 'inner' });
    const callInner = tool({
      name: 'call_inner',
      description: 'Call inner',
      input: z.object({}),
      handler: async (_input, ctx) => ctx.ask(inner, 'q'),
    });
    const outer = agent({
      name: 'outer',
      model: 'mock:test',
      system: 'outer',
      tools: [callInner],
    });

    // Each chat call costs $0.001 (createSequenceProvider default).
    const provider = createSequenceProvider([
      {
        tool_calls: [
          {
            id: 'c1',
            type: 'function' as const,
            function: { name: 'call_inner', arguments: '{}' },
          },
        ],
      },
      'INNER',
      'OUTER',
    ]);
    const { ctx, traces } = createTestCtx({ provider });

    await ctx.ask(outer, 'go');

    const askEnds = traces.filter((t) => t.type === 'ask_end') as Array<
      AxlEvent & AskScoped & { type: 'ask_end'; cost: number }
    >;
    expect(askEnds.length).toBe(2);

    const innerEnd = askEnds.find((e) => (e as AxlEvent & { agent?: string }).agent === 'inner')!;
    const outerEnd = askEnds.find((e) => (e as AxlEvent & { agent?: string }).agent === 'outer')!;

    // Inner ask: 1 chat call → $0.001.
    expect(innerEnd.cost).toBeCloseTo(0.001, 5);
    // Outer ask: 2 chat calls (turn 1 with tool_call + turn 2 final) → $0.002.
    // The inner ask's $0.001 does NOT roll up here.
    expect(outerEnd.cost).toBeCloseTo(0.002, 5);
  });

  it('does NOT emit a workflow-level error event for ask-internal throws (spec decision 9)', async () => {
    // A workflow whose handler throws via ctx.ask() — the ask emits
    // ask_end(ok:false) and the throw propagates to runtime.execute which
    // emits workflow_end(status: 'failed'). No `error` event should fire
    // because ask_end is the authoritative failure record.
    const a = agent({ name: 'wfail', model: 'mock:test', system: 'system' });
    const wf = workflow({
      name: 'ask-fail-wf',
      input: z.object({}),
      handler: async (ctx) => {
        return ctx.ask(a, 'fail', {
          schema: z.object({ never: z.literal('matches') }),
          retries: 0,
        });
      },
    });

    const runtime = new AxlRuntime({ defaultProvider: 'mock' });
    runtime.registerProvider('mock', {
      name: 'mock',
      chat: async () => ({
        content: 'plain text',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        cost: 0.001,
      }),
      stream: async function* () {
        yield {
          type: 'done' as const,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      },
    });
    runtime.register(wf);

    const collected: AxlEvent[] = [];
    runtime.on('trace', (event: AxlEvent) => collected.push(event));

    await expect(runtime.execute('ask-fail-wf', {})).rejects.toThrow();

    const askEnds = collected.filter((e) => e.type === 'ask_end');
    const errorEvents = collected.filter((e) => e.type === 'error');
    expect(askEnds.length).toBeGreaterThan(0);
    expect(
      askEnds.every((e) => (e as AxlEvent & { outcome?: { ok?: boolean } }).outcome?.ok === false),
    ).toBe(true);
    // Workflow lifecycle still emits workflow_end(failed); the workflow-level
    // `error` discriminant is reserved for failures with no ask_end available.
    expect(errorEvents.length).toBe(0);
  });

  // ── Recoverable ask failure modes (spec §9) ───────────────────────────
  //
  // These invariants extend the one above to every recoverable ask failure:
  // any throw propagating out of `ctx.ask()` catch-block must surface as
  // `ask_end(ok:false)` and MUST NOT emit a workflow-level `error` event.
  // The existing test above covers schema exhaustion; these cover guardrail
  // exhaustion, validate exhaustion, and mid-ask BudgetExceededError.

  it('guardrail exhaustion surfaces via ask_end(ok:false), not a workflow `error` event', async () => {
    // Output guardrail that always blocks with retry policy — after
    // `maxRetries` the code path throws GuardrailError, which the ask catch
    // block turns into ask_end(ok:false) before re-throwing.
    const a = agent({
      name: 'guarded',
      model: 'mock:test',
      system: 'system',
      guardrails: {
        output: async () => ({ block: true, reason: 'always blocked' }),
        onBlock: 'retry',
        maxRetries: 1,
      },
    });
    const wf = workflow({
      name: 'guardrail-exhaust-wf',
      input: z.object({}),
      handler: async (ctx) => ctx.ask(a, 'hi'),
    });

    const runtime = new AxlRuntime({ defaultProvider: 'mock' });
    runtime.registerProvider('mock', {
      name: 'mock',
      chat: async () => ({
        content: 'any output',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        cost: 0.001,
      }),
      stream: async function* () {
        yield {
          type: 'done' as const,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      },
    });
    runtime.register(wf);

    const collected: AxlEvent[] = [];
    runtime.on('trace', (event: AxlEvent) => collected.push(event));

    await expect(runtime.execute('guardrail-exhaust-wf', {})).rejects.toThrow(GuardrailError);

    const askEnds = collected.filter((e) => e.type === 'ask_end');
    const errorEvents = collected.filter((e) => e.type === 'error');
    const workflowEnds = collected.filter((e) => e.type === 'workflow_end');

    expect(askEnds.length).toBe(1);
    const end = askEnds[0] as AxlEvent & {
      outcome: { ok: true; result: unknown } | { ok: false; error: string };
    };
    expect(end.outcome.ok).toBe(false);
    if (!end.outcome.ok) {
      // GuardrailError's message should flow into ask_end.outcome.error.
      expect(end.outcome.error.length).toBeGreaterThan(0);
    }

    // workflow_end fires with status 'failed'; no `error` discriminant event.
    expect(workflowEnds.length).toBe(1);
    expect((workflowEnds[0].data as { status: string }).status).toBe('failed');
    expect(errorEvents.length).toBe(0);
  });

  it('validate exhaustion surfaces via ask_end(ok:false), not a workflow `error` event', async () => {
    // Validate fn that always reports invalid — after `validateRetries`
    // exhausts, ValidationError is thrown. Same invariant: the ask catch
    // block converts it into ask_end(ok:false).
    const a = agent({ name: 'valid-fail', model: 'mock:test', system: 'system' });
    const wf = workflow({
      name: 'validate-exhaust-wf',
      input: z.object({}),
      handler: async (ctx) =>
        ctx.ask(a, 'hi', {
          schema: z.object({ n: z.number() }),
          validate: () => ({ valid: false, reason: 'never-valid' }),
          validateRetries: 1,
        }),
    });

    const runtime = new AxlRuntime({ defaultProvider: 'mock' });
    runtime.registerProvider('mock', {
      name: 'mock',
      // Returns valid JSON matching the schema so the validate fn runs
      // (rather than schema parse failing first).
      chat: async () => ({
        content: JSON.stringify({ n: 1 }),
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        cost: 0.001,
      }),
      stream: async function* () {
        yield {
          type: 'done' as const,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      },
    });
    runtime.register(wf);

    const collected: AxlEvent[] = [];
    runtime.on('trace', (event: AxlEvent) => collected.push(event));

    await expect(runtime.execute('validate-exhaust-wf', {})).rejects.toThrow(ValidationError);

    const askEnds = collected.filter((e) => e.type === 'ask_end');
    const errorEvents = collected.filter((e) => e.type === 'error');
    const workflowEnds = collected.filter((e) => e.type === 'workflow_end');

    expect(askEnds.length).toBe(1);
    const end = askEnds[0] as AxlEvent & {
      outcome: { ok: true; result: unknown } | { ok: false; error: string };
    };
    expect(end.outcome.ok).toBe(false);

    expect(workflowEnds.length).toBe(1);
    expect((workflowEnds[0].data as { status: string }).status).toBe('failed');
    expect(errorEvents.length).toBe(0);
  });

  it('BudgetExceededError thrown mid-ask surfaces via ask_end(ok:false), not a workflow `error` event', async () => {
    // Pre-seed the budget context as already exceeded via `ctx.budget()` —
    // the second ctx.ask() inside the budget block trips the check at the
    // top of executeAgentCall and throws BudgetExceededError. The outer
    // catch block on the ask emits ask_end(ok:false) before re-throwing.
    //
    // ctx.budget() traps BudgetExceededError and returns a BudgetResult,
    // so the workflow itself does NOT fail — but the inner ask_end still
    // carries ok:false. That's the exact invariant we want: the ask-level
    // failure record lives on ask_end, separate from workflow-level status.
    const a = agent({ name: 'budget-ask', model: 'mock:test', system: 'system' });
    const wf = workflow({
      name: 'budget-exhaust-wf',
      input: z.object({}),
      handler: async (ctx) =>
        ctx.budget({ cost: '$0.0001', onExceed: 'finish_and_stop' }, async () => {
          // First ask completes and pushes totalCost over the limit;
          // second ask hits the exceeded check at the top of
          // executeAgentCall and throws BudgetExceededError.
          await ctx.ask(a, 'first');
          return ctx.ask(a, 'second');
        }),
    });

    const runtime = new AxlRuntime({ defaultProvider: 'mock' });
    runtime.registerProvider('mock', {
      name: 'mock',
      chat: async () => ({
        content: 'ok',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        cost: 0.01, // exceeds $0.0001 in a single call
      }),
      stream: async function* () {
        yield {
          type: 'done' as const,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      },
    });
    runtime.register(wf);

    const collected: AxlEvent[] = [];
    runtime.on('trace', (event: AxlEvent) => collected.push(event));

    const result = (await runtime.execute('budget-exhaust-wf', {})) as {
      value: unknown;
      budgetExceeded: boolean;
    };
    expect(result.budgetExceeded).toBe(true);

    const askEnds = collected.filter((e) => e.type === 'ask_end') as Array<
      AxlEvent &
        AskScoped & {
          outcome: { ok: true; result: unknown } | { ok: false; error: string };
        }
    >;

    // The first ask completed (ok:true); the second ask threw
    // BudgetExceededError → ask_end(ok:false).
    expect(askEnds.length).toBe(2);
    const failed = askEnds.find((e) => !e.outcome.ok);
    expect(failed).toBeDefined();
    // Sanity: the failure record is genuinely the budget error, not some
    // other throw — match on the error-name substring so we don't couple
    // to exact wording.
    if (failed && !failed.outcome.ok) {
      const stubError = new BudgetExceededError(0.0001, 0.01, 'finish_and_stop');
      expect(failed.outcome.error).toContain(stubError.message.split(':')[0]);
    }

    // Workflow-level: ctx.budget() traps the throw, so the workflow
    // itself completes successfully with a BudgetResult. No `error` event
    // is emitted regardless — the ask-level failure doesn't bubble out.
    const errorEvents = collected.filter((e) => e.type === 'error');
    expect(errorEvents.length).toBe(0);
    const workflowEnds = collected.filter((e) => e.type === 'workflow_end');
    expect(workflowEnds.length).toBe(1);
    expect((workflowEnds[0].data as { status: string }).status).toBe('completed');
  });
});

describe('ask-graph correlation across 3+ levels of nesting (spec/16 §3.1, §3.7)', () => {
  // Three-level ask graph: outer → middle (via call_middle tool) → inner
  // (via call_inner tool). Pins three invariants that two-level tests can't
  // cover:
  //
  //   1. parentAskId chains transitively — inner's parent is middle, middle's
  //      parent is outer. The single-shared `stepRef` in AsyncLocalStorage
  //      stamps the right ancestor on every event.
  //   2. ask_end.cost rolls up THIS ask's leaf cost only, excluding ALL
  //      descendants (not just direct children — middle must NOT include
  //      inner's cost; outer must NOT include middle's OR inner's).
  //   3. eventCostContribution() summed across info.events equals the
  //      sum of every leaf event's cost — independent of how deep the
  //      ask tree gets.
  //
  // Each chat call costs $0.001 (createSequenceProvider default). Setup:
  //   outer turn 1: call_middle tool       → 1 chat = $0.001
  //   outer turn 2: final answer           → 1 chat = $0.001
  //     middle turn 1: call_inner tool     → 1 chat = $0.001
  //     middle turn 2: final answer        → 1 chat = $0.001
  //       inner turn 1: final answer       → 1 chat = $0.001
  // Expected:
  //   inner.cost  = $0.001
  //   middle.cost = $0.002 (its own 2 turns; inner is NOT counted)
  //   outer.cost  = $0.002 (its own 2 turns; middle + inner NOT counted)
  //   total leaf  = $0.005

  it('parentAskId chains transitively through 3 levels and ask_end.cost excludes all descendants', async () => {
    const inner = agent({ name: 'inner', model: 'mock:test', system: 'inner' });
    const callInner = tool({
      name: 'call_inner',
      description: 'Call inner',
      input: z.object({}),
      handler: async (_input, ctx) => ctx.ask(inner, 'inner-q'),
    });
    const middle = agent({
      name: 'middle',
      model: 'mock:test',
      system: 'middle',
      tools: [callInner],
    });
    const callMiddle = tool({
      name: 'call_middle',
      description: 'Call middle',
      input: z.object({}),
      handler: async (_input, ctx) => ctx.ask(middle, 'middle-q'),
    });
    const outer = agent({
      name: 'outer',
      model: 'mock:test',
      system: 'outer',
      tools: [callMiddle],
    });

    // Sequence: outer-tool, outer-final, middle-tool, middle-final, inner-final.
    // The provider runs in call order, which is depth-first: outer makes its
    // first turn (returns call_middle), then its tool handler runs middle,
    // which does its first turn (call_inner), inner runs once, middle wraps
    // up, then outer wraps up.
    const provider = createSequenceProvider([
      // outer turn 1 → call_middle
      {
        tool_calls: [
          {
            id: 'om1',
            type: 'function' as const,
            function: { name: 'call_middle', arguments: '{}' },
          },
        ],
      },
      // middle turn 1 → call_inner
      {
        tool_calls: [
          {
            id: 'mi1',
            type: 'function' as const,
            function: { name: 'call_inner', arguments: '{}' },
          },
        ],
      },
      // inner turn 1 → final
      'INNER',
      // middle turn 2 → final
      'MIDDLE',
      // outer turn 2 → final
      'OUTER',
    ]);
    const { ctx, traces } = createTestCtx({ provider });

    await ctx.ask(outer, 'go');

    type AskEnd = AxlEvent &
      AskScoped & {
        type: 'ask_end';
        cost: number;
        agent?: string;
        outcome: { ok: true; result: unknown };
      };
    const askEnds = traces.filter((t): t is AskEnd => t.type === 'ask_end');
    expect(askEnds.length).toBe(3);

    const innerEnd = askEnds.find((e) => e.agent === 'inner');
    const middleEnd = askEnds.find((e) => e.agent === 'middle');
    const outerEnd = askEnds.find((e) => e.agent === 'outer');
    expect(innerEnd).toBeDefined();
    expect(middleEnd).toBeDefined();
    expect(outerEnd).toBeDefined();

    // (1) Parent-link transitivity: outer is root (no parentAskId);
    // middle's parent IS outer; inner's parent IS middle. NOT outer in
    // either case — the chain must be transitive, not flattened.
    expect(outerEnd!.parentAskId).toBeUndefined();
    expect(middleEnd!.parentAskId).toBe(outerEnd!.askId);
    expect(innerEnd!.parentAskId).toBe(middleEnd!.askId);
    // Negative check: inner.parentAskId is NOT outer (would indicate the
    // chain got flattened by a parent-walking bug).
    expect(innerEnd!.parentAskId).not.toBe(outerEnd!.askId);

    // (2) Depth invariant — root is 0, each level +1. Pins the AsyncLocalStorage
    // depth counter increments correctly through tool→ask transitions.
    expect(outerEnd!.depth).toBe(0);
    expect(middleEnd!.depth).toBe(1);
    expect(innerEnd!.depth).toBe(2);

    // (3) Cost rollup excludes ALL descendants (transitive), not just direct
    // children. Inner: 1 chat = $0.001. Middle: 2 chats = $0.002 (NOT $0.003
    // — inner is excluded). Outer: 2 chats = $0.002 (NOT $0.005 — middle and
    // inner both excluded).
    expect(innerEnd!.cost).toBeCloseTo(0.001, 5);
    expect(middleEnd!.cost).toBeCloseTo(0.002, 5);
    expect(outerEnd!.cost).toBeCloseTo(0.002, 5);
  });

  it('eventCostContribution sum across all events equals total leaf cost regardless of nesting depth', async () => {
    // Same 3-level setup. Verifies that the public cost-aggregation helper
    // gets the right answer when consumers iterate ExecutionInfo.events for
    // a deeply-nested execution.
    const { eventCostContribution } = await import('../event-utils.js');

    const inner = agent({ name: 'inner', model: 'mock:test', system: 'inner' });
    const callInner = tool({
      name: 'call_inner',
      description: 'Call inner',
      input: z.object({}),
      handler: async (_input, ctx) => ctx.ask(inner, 'inner-q'),
    });
    const middle = agent({
      name: 'middle',
      model: 'mock:test',
      system: 'middle',
      tools: [callInner],
    });
    const callMiddle = tool({
      name: 'call_middle',
      description: 'Call middle',
      input: z.object({}),
      handler: async (_input, ctx) => ctx.ask(middle, 'middle-q'),
    });
    const outer = agent({
      name: 'outer',
      model: 'mock:test',
      system: 'outer',
      tools: [callMiddle],
    });

    const provider = createSequenceProvider([
      {
        tool_calls: [
          {
            id: 'om1',
            type: 'function' as const,
            function: { name: 'call_middle', arguments: '{}' },
          },
        ],
      },
      {
        tool_calls: [
          {
            id: 'mi1',
            type: 'function' as const,
            function: { name: 'call_inner', arguments: '{}' },
          },
        ],
      },
      'INNER',
      'MIDDLE',
      'OUTER',
    ]);
    const { ctx, traces } = createTestCtx({ provider });
    await ctx.ask(outer, 'go');

    // 5 chat calls × $0.001 each = $0.005 total. The helper must skip
    // ask_end rollup events (which also carry a cost field) to avoid
    // double-counting the inner/middle/outer rollups on top of the leaves.
    const total = traces.reduce((sum, e) => sum + eventCostContribution(e), 0);
    expect(total).toBeCloseTo(0.005, 5);

    // Sanity: ask_end events carry non-zero `cost` (the rollup field that
    // the helper must skip). If we naively summed `event.cost`, we'd get
    // 0.005 (5 leaves) + 0.001 (inner) + 0.002 (middle) + 0.002 (outer)
    // = 0.010 — twice the truth. Pinning this prevents accidental
    // simplification of the helper that would lose the ask_end skip.
    const naiveSum = traces.reduce((sum, e) => {
      const c = (e as { cost?: unknown }).cost;
      return sum + (typeof c === 'number' && Number.isFinite(c) ? c : 0);
    }, 0);
    expect(naiveSum).toBeCloseTo(0.01, 5);
  });
});
