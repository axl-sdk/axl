// @vitest-environment jsdom
/**
 * AskTree component tests. Exercises:
 * - `buildAskTree` pure reducer (group-by askId, parent-link,
 *   temporal sort, discarded overlay)
 * - Rendering: status badges, depth indent, retry indicator on
 *   retrying asks, handoff arrows
 * - Interaction: click to select, keyboard Enter/Space
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { AskTree, buildAskTree } from '../client/components/shared/AskTree';
import type { AxlEvent } from '../client/lib/types';

/** Build a minimal AxlEvent with the required base fields. */
let _step = 0;
function ev(partial: Record<string, unknown>): AxlEvent {
  return {
    executionId: 'e1',
    step: _step++,
    timestamp: _step,
    ...partial,
  } as AxlEvent;
}

// ── buildAskTree pure reducer ─────────────────────────────────────

describe('buildAskTree', () => {
  it('builds a single root from ask_start + ask_end', () => {
    const events: AxlEvent[] = [
      ev({ type: 'ask_start', askId: 'a', depth: 0, agent: 'root', prompt: 'hi' }),
      ev({
        type: 'ask_end',
        askId: 'a',
        depth: 0,
        agent: 'root',
        cost: 0.01,
        duration: 100,
        outcome: { ok: true, result: 'ok' },
      }),
    ];
    const tree = buildAskTree(events);
    expect(tree).toHaveLength(1);
    expect(tree[0].askId).toBe('a');
    expect(tree[0].status).toBe('completed');
    expect(tree[0].cost).toBe(0.01);
  });

  it('parent-links nested asks via parentAskId; depth preserved', () => {
    const events: AxlEvent[] = [
      ev({ type: 'ask_start', askId: 'outer', depth: 0, agent: 'outer' }),
      ev({ type: 'ask_start', askId: 'inner', depth: 1, parentAskId: 'outer', agent: 'inner' }),
      ev({
        type: 'ask_end',
        askId: 'inner',
        depth: 1,
        parentAskId: 'outer',
        agent: 'inner',
        cost: 0.005,
        duration: 50,
        outcome: { ok: true, result: 'i' },
      }),
      ev({
        type: 'ask_end',
        askId: 'outer',
        depth: 0,
        agent: 'outer',
        cost: 0.02,
        duration: 200,
        outcome: { ok: true, result: 'o' },
      }),
    ];
    const tree = buildAskTree(events);
    expect(tree).toHaveLength(1);
    expect(tree[0].askId).toBe('outer');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].askId).toBe('inner');
    expect(tree[0].children[0].depth).toBe(1);
    expect(tree[0].children[0].parentAskId).toBe('outer');
  });

  it('marks failed outcomes as status: failed', () => {
    const events: AxlEvent[] = [
      ev({ type: 'ask_start', askId: 'a', depth: 0, agent: 'x' }),
      ev({
        type: 'ask_end',
        askId: 'a',
        depth: 0,
        agent: 'x',
        cost: 0,
        duration: 10,
        outcome: { ok: false, error: 'nope' },
      }),
    ];
    const tree = buildAskTree(events);
    expect(tree[0].status).toBe('failed');
    expect(tree[0].outcomeError).toBe('nope');
  });

  it('marks retrying status when latest pipeline is failed', () => {
    const events: AxlEvent[] = [
      ev({ type: 'ask_start', askId: 'a', depth: 0, agent: 'x' }),
      ev({
        type: 'pipeline',
        askId: 'a',
        depth: 0,
        status: 'start',
        stage: 'initial',
        attempt: 1,
        maxAttempts: 1,
      }),
      ev({
        type: 'pipeline',
        askId: 'a',
        depth: 0,
        status: 'failed',
        stage: 'schema',
        attempt: 1,
        maxAttempts: 4,
        reason: 'bad json',
      }),
      // no ask_end yet → in-flight retry
    ];
    const tree = buildAskTree(events);
    expect(tree[0].status).toBe('retrying');
    expect(tree[0].lastPipeline?.status).toBe('failed');
    expect(tree[0].lastPipeline?.stage).toBe('schema');
  });

  it('accumulates cost from agent_call_end/tool_call_end while running', () => {
    const events: AxlEvent[] = [
      ev({ type: 'ask_start', askId: 'a', depth: 0, agent: 'x' }),
      ev({ type: 'agent_call_end', askId: 'a', depth: 0, agent: 'x', cost: 0.03 }),
      ev({ type: 'tool_call_end', askId: 'a', depth: 0, agent: 'x', cost: 0.002, tool: 't' }),
      // no ask_end yet
    ];
    const tree = buildAskTree(events);
    expect(tree[0].status).toBe('running');
    expect(tree[0].cost).toBeCloseTo(0.032);
  });

  it('ask_end.cost overrides the running accumulator', () => {
    const events: AxlEvent[] = [
      ev({ type: 'ask_start', askId: 'a', depth: 0, agent: 'x' }),
      ev({ type: 'agent_call_end', askId: 'a', depth: 0, agent: 'x', cost: 0.03 }),
      ev({
        type: 'ask_end',
        askId: 'a',
        depth: 0,
        agent: 'x',
        cost: 0.05, // authoritative per decision 10
        duration: 100,
        outcome: { ok: true, result: 'r' },
      }),
    ];
    const tree = buildAskTree(events);
    expect(tree[0].cost).toBe(0.05);
  });

  it('overlays discarded status from ask_discarded log event', () => {
    const events: AxlEvent[] = [
      ev({ type: 'ask_start', askId: 'a', depth: 0, agent: 'x' }),
      ev({
        type: 'ask_end',
        askId: 'a',
        depth: 0,
        agent: 'x',
        cost: 0.01,
        duration: 10,
        outcome: { ok: true, result: 'lost' },
      }),
      ev({ type: 'log', data: { event: 'ask_discarded', askId: 'a', reason: 'race_lost' } }),
    ];
    const tree = buildAskTree(events);
    expect(tree[0].status).toBe('discarded');
  });

  it('attributes handoff to the fromAskId node', () => {
    const events: AxlEvent[] = [
      ev({ type: 'ask_start', askId: 'src', depth: 0, agent: 's' }),
      ev({
        type: 'handoff_start',
        fromAskId: 'src',
        toAskId: 'dst',
        sourceDepth: 0,
        targetDepth: 1,
        data: { source: 's', target: 'd', mode: 'oneway' },
      }),
      ev({ type: 'ask_start', askId: 'dst', depth: 1, parentAskId: 'src', agent: 'd' }),
    ];
    const tree = buildAskTree(events);
    const src = tree.find((n) => n.askId === 'src');
    expect(src).toBeDefined();
    expect(src!.handoffsOut).toHaveLength(1);
    expect(src!.handoffsOut[0].toAskId).toBe('dst');
    expect(src!.handoffsOut[0].target).toBe('d');
  });

  it('temporal sort: older asks first at each level', () => {
    const now = Date.now();
    const events: AxlEvent[] = [
      {
        executionId: 'e',
        step: 1,
        timestamp: now + 2,
        type: 'ask_start',
        askId: 'b',
        depth: 0,
        agent: 'b',
      } as AxlEvent,
      {
        executionId: 'e',
        step: 2,
        timestamp: now,
        type: 'ask_start',
        askId: 'a',
        depth: 0,
        agent: 'a',
      } as AxlEvent,
      {
        executionId: 'e',
        step: 3,
        timestamp: now + 1,
        type: 'ask_start',
        askId: 'c',
        depth: 0,
        agent: 'c',
      } as AxlEvent,
    ];
    const tree = buildAskTree(events);
    expect(tree.map((n) => n.askId)).toEqual(['a', 'c', 'b']);
  });
});

// ── Rendering ──────────────────────────────────────────────────────

describe('<AskTree />', () => {
  it('renders a completed ask with status, agent name, and cost', () => {
    const events: AxlEvent[] = [
      ev({ type: 'ask_start', askId: 'a1', depth: 0, agent: 'coordinator' }),
      ev({
        type: 'ask_end',
        askId: 'a1',
        depth: 0,
        agent: 'coordinator',
        cost: 0.01,
        duration: 50,
        outcome: { ok: true, result: 'done' },
      }),
    ];
    render(<AskTree events={events} />);
    const node = screen.getByTestId('ask-node');
    expect(within(node).getByText('completed')).toBeInTheDocument();
    expect(within(node).getByText('coordinator')).toBeInTheDocument();
  });

  it('renders failed asks with the failed status badge', () => {
    const events: AxlEvent[] = [
      ev({ type: 'ask_start', askId: 'a1', depth: 0, agent: 'x' }),
      ev({
        type: 'ask_end',
        askId: 'a1',
        depth: 0,
        agent: 'x',
        cost: 0,
        duration: 10,
        outcome: { ok: false, error: 'boom' },
      }),
    ];
    render(<AskTree events={events} />);
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it('shows RetryIndicator when an ask is in retrying state', () => {
    const events: AxlEvent[] = [
      ev({ type: 'ask_start', askId: 'a1', depth: 0, agent: 'x' }),
      ev({
        type: 'pipeline',
        askId: 'a1',
        depth: 0,
        status: 'failed',
        stage: 'schema',
        attempt: 1,
        maxAttempts: 4,
        reason: 'bad',
      }),
    ];
    render(<AskTree events={events} />);
    const indicator = screen.getByTestId('retry-indicator');
    expect(indicator).toHaveAttribute('data-status', 'failed');
    expect(indicator).toHaveAttribute('data-stage', 'schema');
  });

  it('calls onSelectAsk when a node is clicked', () => {
    const events: AxlEvent[] = [ev({ type: 'ask_start', askId: 'a1', depth: 0, agent: 'x' })];
    const onSelectAsk = vi.fn();
    render(<AskTree events={events} onSelectAsk={onSelectAsk} />);
    fireEvent.click(screen.getByTestId('ask-node'));
    expect(onSelectAsk).toHaveBeenCalledWith('a1');
  });

  it('renders empty state when no asks present', () => {
    render(<AskTree events={[]} />);
    expect(screen.getByText(/No asks recorded yet/i)).toBeInTheDocument();
  });

  it('renders handoff arrows from the source ask', () => {
    const events: AxlEvent[] = [
      ev({ type: 'ask_start', askId: 'src', depth: 0, agent: 's' }),
      ev({
        type: 'handoff_start',
        fromAskId: 'src',
        toAskId: 'dst',
        sourceDepth: 0,
        targetDepth: 1,
        data: { source: 's', target: 'specialist', mode: 'oneway' },
      }),
    ];
    render(<AskTree events={events} />);
    expect(screen.getByText(/handoff → specialist/)).toBeInTheDocument();
  });

  // Orphan handoff: a `handoff` event names a `toAskId` for which no
  // `ask_start` ever arrives (target aborted / crashed / never reported back).
  // AskTree synthesizes a placeholder node so the target isn't invisible —
  // users can see the handoff happened and that the target never completed.
  // Without this placeholder the orphan would silently disappear from the UI
  // and the "target never responded" failure mode would be invisible.
  it('synthesizes a placeholder node for orphan handoff targets (no matching ask_start)', () => {
    const events: AxlEvent[] = [
      ev({ type: 'ask_start', askId: 'src', depth: 0, agent: 's' }),
      ev({
        type: 'handoff_start',
        fromAskId: 'src',
        toAskId: 'orphan-never-started',
        sourceDepth: 0,
        targetDepth: 1,
        data: { source: 's', target: 'lost-specialist', mode: 'oneway' },
      }),
      // NOTE: no ask_start for 'orphan-never-started' — the target frame never
      // reported back.
    ];
    render(<AskTree events={events} />);

    // Two nodes should render: the source (completed view is `running` here
    // since there's no ask_end either, which is fine) AND the synthetic orphan.
    const nodes = screen.getAllByTestId('ask-node');
    expect(nodes).toHaveLength(2);

    // Find the orphan by its data-ask-id attribute on the outer wrapper.
    const orphan = document.querySelector('[data-ask-id="orphan-never-started"]');
    expect(orphan).not.toBeNull();
    // Placeholder status stays `running` — deliberate signal that the handoff
    // target never reported back.
    expect(orphan!.getAttribute('data-status')).toBe('running');
    // Agent label falls back to the `target` field from the handoff data.
    expect(within(orphan as HTMLElement).getByText('lost-specialist')).toBeInTheDocument();
  });

  it('does NOT synthesize a placeholder when the target has a real ask_start', () => {
    // Comparison case: both source and target report in normally. We should
    // see exactly two nodes (one per real ask_start), and the target should
    // NOT be a synthetic placeholder — its status tracks the real ask_end.
    const events: AxlEvent[] = [
      ev({ type: 'ask_start', askId: 'src', depth: 0, agent: 's' }),
      ev({
        type: 'handoff_start',
        fromAskId: 'src',
        toAskId: 'dst',
        sourceDepth: 0,
        targetDepth: 1,
        data: { source: 's', target: 'specialist', mode: 'oneway' },
      }),
      ev({ type: 'ask_start', askId: 'dst', depth: 1, parentAskId: 'src', agent: 'specialist' }),
      ev({
        type: 'ask_end',
        askId: 'dst',
        depth: 1,
        parentAskId: 'src',
        agent: 'specialist',
        cost: 0.01,
        duration: 10,
        outcome: { ok: true, result: 'ok' },
      }),
    ];
    render(<AskTree events={events} />);
    const nodes = screen.getAllByTestId('ask-node');
    expect(nodes).toHaveLength(2);
    const dst = document.querySelector('[data-ask-id="dst"]');
    expect(dst).not.toBeNull();
    // The real ask_end fired → status resolves to `completed`, not the
    // placeholder's stuck `running`.
    expect(dst!.getAttribute('data-status')).toBe('completed');
  });
});
