/**
 * Hierarchical live tree view of an execution's ask graph.
 *
 * Takes an `AxlEvent[]`, groups events by `askId`, parent-links via
 * `parentAskId`, and renders each ask as a node indented by `depth`. Per
 * spec/16 §5.9.
 *
 * Status tags:
 *   - `running`    — ask_start seen, no ask_end yet
 *   - `retrying`   — latest pipeline event is `status: 'failed'`
 *   - `completed`  — ask_end with outcome.ok === true
 *   - `failed`     — ask_end with outcome.ok === false
 *   - `discarded`  — ask completed but marked discarded by a surrounding
 *                    ctx.race / ctx.parallel primitive (via a `log` event
 *                    with data.event === 'ask_discarded'). Visually
 *                    dimmed; cost still shown per spec decision.
 *
 * Pure component — no WS subscription, no data fetching. The calling
 * panel supplies the event stream.
 */
import { useMemo, type ReactElement } from 'react';
import { ChevronDown, ChevronRight, ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { CostBadge } from './CostBadge';
import { DurationBadge } from './DurationBadge';
import { RetryIndicator } from './RetryIndicator';
import { cn } from '../../lib/utils';
import type { AxlEvent } from '../../lib/types';

export type AskTreeProps = {
  events: AxlEvent[];
  /** If set, highlight this ask and scroll it into focus. */
  selectedAskId?: string;
  onSelectAsk?: (askId: string) => void;
  /** Collapse partial_object renderers by default. Set false for detail panels. */
  showPartialObjects?: boolean;
};

type AskStatus = 'running' | 'retrying' | 'completed' | 'failed' | 'discarded';

type AskNode = {
  askId: string;
  parentAskId?: string;
  depth: number;
  agent?: string;
  model?: string;
  startedAt?: number;
  endedAt?: number;
  cost: number;
  status: AskStatus;
  outcomeResult?: unknown;
  outcomeError?: string;
  lastPipeline?: { status: string; stage?: string; attempt?: number; maxAttempts?: number };
  /** Events that originated in this ask, in arrival order. */
  events: AxlEvent[];
  children: AskNode[];
  /** Handoffs emitted from this ask, as {toAskId, target}. */
  handoffsOut: Array<{ toAskId: string; target: string }>;
};

/**
 * Build the ask tree from a flat event stream. Single pass: collect
 * per-ask data, then resolve parent-child links in a second pass.
 */
function buildAskTree(events: AxlEvent[]): AskNode[] {
  const nodes = new Map<string, AskNode>();
  const discardedAskIds = new Set<string>();

  for (const ev of events) {
    // `log` event carrying ask_discarded (spec §5.5).
    if (ev.type === 'log') {
      const d = ev.data as { event?: string; askId?: string } | undefined;
      if (d?.event === 'ask_discarded' && typeof d.askId === 'string') {
        discardedAskIds.add(d.askId);
      }
    }

    // `handoff` spans two asks — attribute the handoff to `fromAskId`,
    // and stub a target node so the tree still renders a row for the
    // target even if it aborts before emitting any of its own events.
    // Review UX-9: an orphan handoff (target produced nothing) used to
    // disappear entirely from the tree; now we show it with a placeholder
    // node that later events overwrite naturally if they arrive.
    if (ev.type === 'handoff' && ev.fromAskId) {
      const node = nodes.get(ev.fromAskId);
      const target = (ev.data as { target?: string } | undefined)?.target ?? ev.toAskId ?? '';
      if (node && ev.toAskId) {
        node.handoffsOut.push({ toAskId: ev.toAskId, target });
        if (!nodes.has(ev.toAskId)) {
          nodes.set(ev.toAskId, {
            askId: ev.toAskId,
            parentAskId: ev.fromAskId,
            depth:
              typeof ev.targetDepth === 'number' ? ev.targetDepth : (ev.depth ?? node.depth) + 1,
            agent: target || undefined,
            cost: 0,
            // Status stays 'running' until a real ask_start/end for
            // this frame arrives; if none ever does (true orphan), the
            // UI renders it indefinitely — a deliberate hint that the
            // handoff target never reported back.
            status: 'running',
            events: [],
            children: [],
            handoffsOut: [],
          });
        }
      }
      continue;
    }

    if (!ev.askId) continue;
    let node = nodes.get(ev.askId);
    if (!node) {
      node = {
        askId: ev.askId,
        parentAskId: ev.parentAskId,
        depth: ev.depth ?? 0,
        agent: ev.agent,
        cost: 0,
        status: 'running',
        events: [],
        children: [],
        handoffsOut: [],
      };
      nodes.set(ev.askId, node);
    }
    node.events.push(ev);

    switch (ev.type) {
      case 'ask_start':
        node.startedAt = ev.timestamp;
        node.agent = node.agent ?? ev.agent;
        break;
      case 'ask_end':
        node.endedAt = ev.timestamp;
        // ask_end.cost is the authoritative per-ask rollup (decision 10).
        if (typeof ev.cost === 'number') node.cost = ev.cost;
        if (ev.outcome?.ok) {
          node.status = 'completed';
          node.outcomeResult = ev.outcome.result;
        } else if (ev.outcome) {
          node.status = 'failed';
          node.outcomeError = ev.outcome.error;
        }
        break;
      case 'agent_call_start':
        node.model = node.model ?? ev.model;
        break;
      case 'agent_call_end':
        // Fallback when ask_end hasn't fired yet — accumulate from
        // leaf events so in-flight asks show running cost.
        if (node.status === 'running' && typeof ev.cost === 'number') {
          node.cost += ev.cost;
        }
        break;
      case 'tool_call_end':
        if (node.status === 'running' && typeof ev.cost === 'number') {
          node.cost += ev.cost;
        }
        break;
      case 'pipeline':
        node.lastPipeline = {
          status: ev.status ?? 'start',
          stage: ev.stage,
          attempt: ev.attempt,
          maxAttempts: ev.maxAttempts,
        };
        if (ev.status === 'failed' && node.status === 'running') {
          node.status = 'retrying';
        } else if (ev.status === 'start' && node.status === 'retrying') {
          // We've re-entered the loop for the retry turn; stay as
          // 'running' until the next ask_end or failed.
          node.status = 'running';
        }
        break;
    }
  }

  // Overlay discarded marker (race/parallel losers).
  for (const id of discardedAskIds) {
    const node = nodes.get(id);
    if (node && node.status === 'completed') {
      node.status = 'discarded';
    }
  }

  // Resolve parent-child links. Missing parents are promoted to roots so
  // orphan events (e.g., if parent events were filtered out) still render.
  const roots: AskNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentAskId ? nodes.get(node.parentAskId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  // Stable sort each level by start timestamp so the tree renders in
  // temporal order (oldest ask first).
  const sortByStart = (a: AskNode, b: AskNode) => (a.startedAt ?? 0) - (b.startedAt ?? 0);
  const sortTree = (list: AskNode[]): void => {
    list.sort(sortByStart);
    for (const n of list) sortTree(n.children);
  };
  sortTree(roots);

  return roots;
}

// ── Status presentation ────────────────────────────────────────────

function statusTone(status: AskStatus): string {
  switch (status) {
    case 'running':
      return 'bg-sky-100 text-sky-900 dark:bg-sky-900/30 dark:text-sky-200';
    case 'retrying':
      return 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200';
    case 'completed':
      return 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200';
    case 'failed':
      return 'bg-red-100 text-red-900 dark:bg-red-900/30 dark:text-red-200';
    case 'discarded':
      return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400';
  }
}

// ── Node row ───────────────────────────────────────────────────────

function AskNodeRow(props: {
  node: AskNode;
  selectedAskId?: string;
  onSelectAsk?: (askId: string) => void;
}): ReactElement {
  const { node, selectedAskId, onSelectAsk } = props;
  const selected = selectedAskId === node.askId;
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  const duration =
    node.startedAt !== undefined && node.endedAt !== undefined
      ? node.endedAt - node.startedAt
      : undefined;

  return (
    <div
      className={cn('select-none', node.status === 'discarded' && 'opacity-60')}
      data-ask-id={node.askId}
      data-status={node.status}
    >
      <div
        data-testid="ask-node"
        role="button"
        tabIndex={0}
        onClick={() => onSelectAsk?.(node.askId)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelectAsk?.(node.askId);
          }
        }}
        className={cn(
          'flex items-center gap-2 rounded px-2 py-1 text-sm cursor-pointer',
          'hover:bg-slate-50 dark:hover:bg-slate-800/50',
          selected && 'bg-sky-50 ring-1 ring-sky-300 dark:bg-sky-900/20 dark:ring-sky-700',
        )}
        style={{ paddingLeft: `${node.depth * 16 + 8}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={expanded ? 'Collapse' : 'Expand'}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            className="text-slate-500"
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span className="w-3.5" />
        )}
        <span
          className={cn(
            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
            statusTone(node.status),
          )}
        >
          {node.status}
        </span>
        <span className="font-medium truncate" title={node.askId}>
          {node.agent ?? '<unknown>'}
        </span>
        {node.model && (
          <span className="text-xs text-slate-500 font-mono truncate">{node.model}</span>
        )}
        <span className="text-xs text-slate-400 font-mono truncate" title={node.askId}>
          {node.askId.slice(0, 8)}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {node.lastPipeline && node.status === 'retrying' && (
            <RetryIndicator
              stage={
                (node.lastPipeline.stage ?? 'initial') as Parameters<
                  typeof RetryIndicator
                >[0]['stage']
              }
              attempt={node.lastPipeline.attempt ?? 1}
              maxAttempts={node.lastPipeline.maxAttempts ?? 1}
              status="failed"
            />
          )}
          {duration !== undefined && <DurationBadge ms={duration} />}
          <CostBadge cost={node.cost} />
        </span>
      </div>
      {node.handoffsOut.length > 0 && (
        <div
          className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300 mt-0.5"
          style={{ paddingLeft: `${node.depth * 16 + 32}px` }}
        >
          {node.handoffsOut.map((h, i) => (
            <span key={i} className="inline-flex items-center gap-1">
              <ArrowRight className="h-3 w-3" />
              handoff → {h.target}
              <span className="font-mono text-slate-400">({h.toAskId.slice(0, 8)})</span>
            </span>
          ))}
        </div>
      )}
      {expanded &&
        node.children.map((child) => (
          <AskNodeRow
            key={child.askId}
            node={child}
            selectedAskId={selectedAskId}
            onSelectAsk={onSelectAsk}
          />
        ))}
    </div>
  );
}

// ── Root component ─────────────────────────────────────────────────

export function AskTree(props: AskTreeProps): ReactElement {
  const { events, selectedAskId, onSelectAsk } = props;
  const tree = useMemo(() => buildAskTree(events), [events]);

  if (tree.length === 0) {
    return (
      <div className="text-sm text-slate-500 py-4 text-center">
        No asks recorded yet. Events will appear here as `ctx.ask()` calls fire.
      </div>
    );
  }

  return (
    <div data-testid="ask-tree" className="space-y-0.5">
      {tree.map((root) => (
        <AskNodeRow
          key={root.askId}
          node={root}
          selectedAskId={selectedAskId}
          onSelectAsk={onSelectAsk}
        />
      ))}
    </div>
  );
}

/** Exported for tests + panels that want to render a subset. */
export { buildAskTree };
export type { AskNode, AskStatus };
