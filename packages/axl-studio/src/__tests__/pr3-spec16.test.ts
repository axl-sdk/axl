/**
 * Tests for PR 3 of spec/16-streaming-wire-reliability — Studio adoption
 * of the unified event model.
 *
 * Coverage:
 *   1. Cost reducer skips `ask_end` rollup (decision 10) — no double-count.
 *   2. Full per-variant redaction table (spec §5.1) for all AxlEvent
 *      variants the wire carries.
 *   3. WS replay buffer excludes `token` and `partial_object` (spec §5.2).
 */
import { describe, it, expect } from 'vitest';
import type { AxlEvent } from '@axlsdk/axl';
import { reduceCost, emptyCostData } from '../server/aggregates/reducers.js';
import { redactStreamEvent } from '../server/redact.js';
import { ConnectionManager } from '../server/ws/connection-manager.js';

// ── 1. Cost reducer: ask_end skip guard ──────────────────────────────

describe('reduceCost — spec/16 decision 10 (skip ask_end rollup)', () => {
  it('does NOT double-count cost when both agent_call_end and ask_end fire', () => {
    let acc = emptyCostData();
    // Single agent_call_end with $0.05 cost.
    const agentCall: AxlEvent = {
      executionId: 'e1',
      step: 1,
      timestamp: 0,
      type: 'agent_call_end',
      agent: 'a',
      model: 'mock:test',
      cost: 0.05,
      duration: 100,
      askId: 'ask-1',
      depth: 0,
      data: { prompt: 'q', response: 'r' },
    } as unknown as AxlEvent;
    acc = reduceCost(acc, agentCall);
    expect(acc.byAgent['a'].cost).toBeCloseTo(0.05);

    // Then ask_end fires with the same $0.05 rolled up.
    const askEnd: AxlEvent = {
      executionId: 'e1',
      step: 2,
      timestamp: 1,
      type: 'ask_end',
      agent: 'a',
      askId: 'ask-1',
      depth: 0,
      cost: 0.05,
      duration: 100,
      outcome: { ok: true, result: 'r' },
    } as unknown as AxlEvent;
    acc = reduceCost(acc, askEnd);

    // Cost did NOT double — ask_end is a rollup, not a fresh charge.
    expect(acc.byAgent['a'].cost).toBeCloseTo(0.05);
    expect(acc.byAgent['a'].calls).toBe(1);
  });
});

// ── 2. Redaction: full per-variant coverage (spec §5.1) ──────────────

const baseFields = (type: string) => ({
  executionId: 'e1',
  step: 1,
  timestamp: 0,
  type,
});

const askScoped = { askId: 'ask-1', depth: 0 };
const REDACTED = '[redacted]';

describe('redactStreamEvent — spec §5.1 per-variant scrubbing', () => {
  it('passes through every event verbatim when redact=false', () => {
    const ev = {
      ...baseFields('token'),
      ...askScoped,
      data: 'sensitive',
    } as unknown as AxlEvent;
    expect(redactStreamEvent(ev, false)).toBe(ev);
  });

  it('token: data scrubbed; askId/depth preserved', () => {
    const ev = {
      ...baseFields('token'),
      ...askScoped,
      agent: 'a',
      data: 'secret',
    } as unknown as AxlEvent;
    const r = redactStreamEvent(ev, true) as { data: string; askId: string; depth: number };
    expect(r.data).toBe(REDACTED);
    expect(r.askId).toBe('ask-1');
    expect(r.depth).toBe(0);
  });

  it('tool_call_start: data.args scrubbed; tool/callId preserved', () => {
    const ev = {
      ...baseFields('tool_call_start'),
      ...askScoped,
      tool: 't1',
      callId: 'c1',
      data: { args: { ssn: '123' } },
    } as unknown as AxlEvent;
    const r = redactStreamEvent(ev, true) as {
      tool: string;
      callId: string;
      data: { args: string };
    };
    expect(r.tool).toBe('t1');
    expect(r.callId).toBe('c1');
    expect(r.data.args).toBe(REDACTED);
  });

  it('tool_call_end: args + result scrubbed; callId preserved', () => {
    const ev = {
      ...baseFields('tool_call_end'),
      ...askScoped,
      tool: 't1',
      callId: 'c1',
      duration: 5,
      data: { args: { ssn: '123' }, result: { id: 'u1' }, callId: 'c1' },
    } as unknown as AxlEvent;
    const r = redactStreamEvent(ev, true) as {
      data: { args: string; result: string; callId: string };
    };
    expect(r.data.args).toBe(REDACTED);
    expect(r.data.result).toBe(REDACTED);
    expect(r.data.callId).toBe('c1');
  });

  it('tool_approval: args + reason scrubbed; approved preserved', () => {
    const ev = {
      ...baseFields('tool_approval'),
      ...askScoped,
      tool: 't1',
      callId: 'c1',
      data: { approved: true, args: { secret: 'x' }, reason: 'ok' },
    } as unknown as AxlEvent;
    const r = redactStreamEvent(ev, true) as {
      data: { approved: boolean; args: string; reason: string };
    };
    expect(r.data.approved).toBe(true);
    expect(r.data.args).toBe(REDACTED);
    expect(r.data.reason).toBe(REDACTED);
  });

  it('tool_denied: args + reason scrubbed when present', () => {
    const ev = {
      ...baseFields('tool_denied'),
      ...askScoped,
      tool: 't1',
      data: { args: { x: 1 }, reason: 'sensitive' },
    } as unknown as AxlEvent;
    const r = redactStreamEvent(ev, true) as { data: { args: string; reason: string } };
    expect(r.data.args).toBe(REDACTED);
    expect(r.data.reason).toBe(REDACTED);
  });

  it('ask_start: prompt scrubbed; askId/agent/depth preserved', () => {
    const ev = {
      ...baseFields('ask_start'),
      ...askScoped,
      agent: 'a',
      prompt: 'sensitive prompt with PII',
    } as unknown as AxlEvent;
    const r = redactStreamEvent(ev, true) as { prompt: string; askId: string; agent: string };
    expect(r.prompt).toBe(REDACTED);
    expect(r.askId).toBe('ask-1');
    expect(r.agent).toBe('a');
  });

  it('ask_end: outcome.result scrubbed on success; outcome.ok preserved', () => {
    const ev = {
      ...baseFields('ask_end'),
      ...askScoped,
      cost: 0.01,
      duration: 1,
      outcome: { ok: true, result: { secret: 'y' } },
    } as unknown as AxlEvent;
    const r = redactStreamEvent(ev, true) as {
      outcome: { ok: boolean; result?: string; error?: string };
      cost: number;
    };
    expect(r.outcome.ok).toBe(true);
    expect(r.outcome.result).toBe(REDACTED);
    expect(r.cost).toBe(0.01); // numeric metric, NEVER scrubbed
  });

  it('ask_end: outcome.error scrubbed on failure; ok=false preserved', () => {
    const ev = {
      ...baseFields('ask_end'),
      ...askScoped,
      cost: 0.01,
      duration: 1,
      outcome: { ok: false, error: 'failed with PII john@x.com' },
    } as unknown as AxlEvent;
    const r = redactStreamEvent(ev, true) as {
      outcome: { ok: boolean; error?: string };
    };
    expect(r.outcome.ok).toBe(false);
    expect(r.outcome.error).toBe(REDACTED);
  });

  it('handoff: data.message scrubbed when present; structural fields preserved', () => {
    const ev = {
      ...baseFields('handoff'),
      fromAskId: 'a1',
      toAskId: 'a2',
      sourceDepth: 0,
      targetDepth: 1,
      data: {
        source: 's',
        target: 't',
        mode: 'roundtrip',
        duration: 1,
        message: 'why I delegated',
      },
    } as unknown as AxlEvent;
    const r = redactStreamEvent(ev, true) as {
      data: { source: string; target: string; mode: string; message: string };
      fromAskId: string;
    };
    expect(r.data.source).toBe('s');
    expect(r.data.target).toBe('t');
    expect(r.data.mode).toBe('roundtrip');
    expect(r.data.message).toBe(REDACTED);
    expect(r.fromAskId).toBe('a1');
  });

  it('partial_object: data.object scrubbed; attempt preserved', () => {
    const ev = {
      ...baseFields('partial_object'),
      ...askScoped,
      attempt: 1,
      data: { object: { name: 'Alice', ssn: '123-45-6789' } },
    } as unknown as AxlEvent;
    const r = redactStreamEvent(ev, true) as {
      attempt: number;
      data: { object: string };
    };
    expect(r.attempt).toBe(1);
    expect(r.data.object).toBe(REDACTED);
  });

  it('verify: data.lastError scrubbed when present; passed/attempts preserved', () => {
    const ev = {
      ...baseFields('verify'),
      ...askScoped,
      data: { passed: false, attempts: 3, lastError: 'value 9999 out of range' },
    } as unknown as AxlEvent;
    const r = redactStreamEvent(ev, true) as {
      data: { passed: boolean; attempts: number; lastError: string };
    };
    expect(r.data.passed).toBe(false);
    expect(r.data.attempts).toBe(3);
    expect(r.data.lastError).toBe(REDACTED);
  });

  it('memory_recall: data.key scrubbed; scope/count/cost preserved', () => {
    const ev = {
      ...baseFields('memory_recall'),
      data: { scope: 'session', key: 'user:john@x.com', count: 3, cost: 0.001 },
    } as unknown as AxlEvent;
    const r = redactStreamEvent(ev, true) as {
      data: { scope: string; key: string; count: number; cost: number };
    };
    expect(r.data.scope).toBe('session');
    expect(r.data.key).toBe(REDACTED);
    expect(r.data.count).toBe(3);
    expect(r.data.cost).toBe(0.001);
  });

  it('pipeline(failed): reason scrubbed; stage/status/attempt preserved', () => {
    const ev = {
      ...baseFields('pipeline'),
      ...askScoped,
      status: 'failed',
      stage: 'schema',
      attempt: 1,
      maxAttempts: 4,
      reason: 'expected number, got string "hello"',
    } as unknown as AxlEvent;
    const r = redactStreamEvent(ev, true) as {
      status: string;
      stage: string;
      attempt: number;
      reason: string;
    };
    expect(r.status).toBe('failed');
    expect(r.stage).toBe('schema');
    expect(r.attempt).toBe(1);
    expect(r.reason).toBe(REDACTED);
  });

  it('pipeline(start): no reason scrubbing — passes through', () => {
    const ev = {
      ...baseFields('pipeline'),
      ...askScoped,
      status: 'start',
      stage: 'initial',
      attempt: 1,
      maxAttempts: 1,
    } as unknown as AxlEvent;
    expect(redactStreamEvent(ev, true)).toBe(ev);
  });

  it('done: data.result scrubbed', () => {
    const ev = {
      ...baseFields('done'),
      data: { result: { secret: 'y' } },
    } as unknown as AxlEvent;
    const r = redactStreamEvent(ev, true) as { data: { result: string } };
    expect(r.data.result).toBe(REDACTED);
  });

  it('error: data.message scrubbed; data.name/code preserved', () => {
    const ev = {
      ...baseFields('error'),
      data: { message: 'bad input from john@x.com', name: 'ValidationError', code: 'E_VAL' },
    } as unknown as AxlEvent;
    const r = redactStreamEvent(ev, true) as {
      data: { message: string; name: string; code: string };
    };
    expect(r.data.message).toBe(REDACTED);
    expect(r.data.name).toBe('ValidationError');
    expect(r.data.code).toBe('E_VAL');
  });

  it('delegate: passes through (all fields are structural)', () => {
    const ev = {
      ...baseFields('delegate'),
      ...askScoped,
      data: { candidates: ['a', 'b'], reason: 'routed', selected: 'a' },
    } as unknown as AxlEvent;
    expect(redactStreamEvent(ev, true)).toBe(ev);
  });

  it('agent_call_end: passes through (core emitter scrubbed at emission)', () => {
    const ev = {
      ...baseFields('agent_call_end'),
      ...askScoped,
      agent: 'a',
      model: 'mock:test',
      cost: 0.01,
      duration: 5,
      data: { prompt: '[redacted]', response: '[redacted]' },
    } as unknown as AxlEvent;
    expect(redactStreamEvent(ev, true)).toBe(ev);
  });
});

// ── 3. WS buffer: high-volume types excluded ─────────────────────────

describe('ConnectionManager — spec §5.2 (exclude token + partial_object from buffer)', () => {
  it('does not buffer `token` events for late subscribers', () => {
    const mgr = new ConnectionManager();
    const channel = 'execution:test';

    // Pre-subscribe (no real WS) — broadcast 100 token events.
    for (let i = 0; i < 100; i++) {
      mgr.broadcast(channel, { type: 'token', data: `t${i}`, executionId: 'e1', step: i });
    }
    // Terminal event flushes the buffer to the late-subscriber path.
    mgr.broadcast(channel, { type: 'done', data: { result: 'ok' }, executionId: 'e1' });

    // Inspect the internal buffer — token events should NOT be retained.
    const internals = mgr as unknown as { buffers: Map<string, { events: unknown[] }> };
    const buf = internals.buffers.get(channel);
    expect(buf).toBeDefined();
    // Only the `done` event should have been buffered.
    const types = buf!.events.map((e) => (e as { data: { type: string } }).data.type);
    expect(types).not.toContain('token');
    expect(types).toContain('done');
  });

  it('does not buffer `partial_object` events', () => {
    const mgr = new ConnectionManager();
    const channel = 'execution:test2';

    for (let i = 0; i < 50; i++) {
      mgr.broadcast(channel, {
        type: 'partial_object',
        attempt: 1,
        data: { object: { x: i } },
        executionId: 'e2',
        step: i,
      });
    }
    mgr.broadcast(channel, { type: 'done', data: { result: 'ok' }, executionId: 'e2' });

    const internals = mgr as unknown as { buffers: Map<string, { events: unknown[] }> };
    const buf = internals.buffers.get(channel);
    const types = buf!.events.map((e) => (e as { data: { type: string } }).data.type);
    expect(types).not.toContain('partial_object');
    expect(types).toContain('done');
  });

  it('DOES buffer structural events (agent_call_end, ask_start, etc.)', () => {
    const mgr = new ConnectionManager();
    const channel = 'execution:test3';

    mgr.broadcast(channel, {
      type: 'ask_start',
      askId: 'a1',
      depth: 0,
      executionId: 'e3',
      step: 0,
    });
    mgr.broadcast(channel, {
      type: 'agent_call_end',
      agent: 'a',
      cost: 0.01,
      executionId: 'e3',
      step: 1,
    });
    mgr.broadcast(channel, { type: 'done', data: { result: 'ok' }, executionId: 'e3' });

    const internals = mgr as unknown as { buffers: Map<string, { events: unknown[] }> };
    const types = internals.buffers
      .get(channel)!
      .events.map((e) => (e as { data: { type: string } }).data.type);
    expect(types).toEqual(['ask_start', 'agent_call_end', 'done']);
  });
});
