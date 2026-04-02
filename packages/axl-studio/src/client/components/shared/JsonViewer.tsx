import { useState, useCallback, useEffect, useRef, memo } from 'react';
import { Copy, Check, ChevronRight, ChevronsUpDown, ChevronsDownUp } from 'lucide-react';
import { cn } from '../../lib/utils';

// ── Types ────────────────────────────────────────────────────

type ValueType = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

type JsonViewerProps = {
  data: unknown;
  /** Number of levels to expand by default. 0 = all collapsed, Infinity = all open. */
  defaultExpandDepth?: number;
  /** Max height of the scroll container. */
  maxHeight?: string;
  className?: string;
  /** Backwards-compatible shorthand: collapsed=true sets defaultExpandDepth=0. */
  collapsed?: boolean;
};

type TreeNodeProps = {
  value: unknown;
  label?: string | number;
  depth: number;
  expandDepth: number;
  isLast: boolean;
};

// ── Utilities ────────────────────────────────────────────────

function getValueType(value: unknown): ValueType {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'object') return 'object';
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  return 'string';
}

function getCollapsedPreview(value: unknown, type: ValueType): string {
  if (type === 'array') {
    const arr = value as unknown[];
    if (arr.length === 0) return '[]';
    return `[${arr.length}]`;
  }
  if (type === 'object') {
    const keys = Object.keys(value as object);
    if (keys.length === 0) return '{}';
    if (keys.length <= 4) return `{ ${keys.join(', ')} }`;
    return `{ ${keys.slice(0, 3).join(', ')}, \u2026${keys.length - 3} more }`;
  }
  return '';
}

function getEntries(value: unknown, type: ValueType): [string | number, unknown][] {
  if (type === 'array') return (value as unknown[]).map((v, i) => [i, v]);
  if (type === 'object') return Object.entries(value as object);
  return [];
}

// ── Syntax Colors ────────────────────────────────────────────

const SYNTAX = {
  key: 'text-[hsl(var(--foreground))]',
  string: 'text-emerald-700 dark:text-emerald-400',
  number: 'text-blue-600 dark:text-blue-400',
  boolean: 'text-amber-600 dark:text-amber-400',
  null: 'text-[hsl(var(--muted-foreground))] italic',
  punct: 'text-[hsl(var(--muted-foreground))]',
} as const;

// Shared gutter class: fixed-width column for the chevron
const GUTTER = 'w-3.5 shrink-0 flex items-center justify-center pt-0.5';

// ── CopyButton ───────────────────────────────────────────────

const TOOLBAR_BTN =
  'inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-md border border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors cursor-pointer';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      navigator.clipboard.writeText(text);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    },
    [text],
  );

  return (
    <button onClick={handleCopy} className={TOOLBAR_BTN}>
      {copied ? <Check size={10} className="text-emerald-500" /> : <Copy size={10} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

// ── ValueRenderer ────────────────────────────────────────────
// Renders a single leaf value with syntax coloring.

function ValueRenderer({ value, type }: { value: unknown; type: ValueType }) {
  if (type === 'null') return <span className={SYNTAX.null}>null</span>;
  if (type === 'boolean') return <span className={SYNTAX.boolean}>{String(value)}</span>;
  if (type === 'number') return <span className={SYNTAX.number}>{String(value)}</span>;
  if (type === 'string') {
    const str = value as string;
    if (str.includes('\n') && str.length > 80) {
      return <span className={SYNTAX.string}>&quot;{str}&quot;</span>;
    }
    return <span className={SYNTAX.string}>&quot;{str}&quot;</span>;
  }
  return null;
}

// ── TreeNode (recursive) ─────────────────────────────────────
// Renders one JSON node. Objects and arrays are collapsible;
// primitives are leaf nodes.
//
// Children are always mounted (hidden via CSS when collapsed)
// so their expand/collapse state is preserved across parent toggles.

const LARGE_COLLECTION_THRESHOLD = 100;

const TreeNode = memo(function TreeNode({
  value,
  label,
  depth,
  expandDepth,
  isLast,
}: TreeNodeProps) {
  const type = getValueType(value);
  const isContainer = type === 'object' || type === 'array';
  const [expanded, setExpanded] = useState(depth < expandDepth);
  const [showAll, setShowAll] = useState(false);

  const comma = isLast ? '' : ',';

  // ── Label (key or index) ────────────────
  const labelEl =
    label != null ? (
      typeof label === 'number' ? (
        <span className={SYNTAX.punct}>{label}: </span>
      ) : (
        <>
          <span className={SYNTAX.key}>&quot;{label}&quot;</span>
          <span className={SYNTAX.punct}>: </span>
        </>
      )
    ) : null;

  // ── Leaf node ───────────────────────────
  if (!isContainer) {
    return (
      <div className="flex items-start leading-relaxed hover:bg-[hsl(var(--accent))]/40 rounded">
        <span className={GUTTER} />
        <span>
          {labelEl}
          <ValueRenderer value={value} type={type} />
          <span className={SYNTAX.punct}>{comma}</span>
        </span>
      </div>
    );
  }

  // ── Container node (object / array) ─────
  const entries = getEntries(value, type);
  const open = type === 'array' ? '[' : '{';
  const close = type === 'array' ? ']' : '}';

  // Empty container — no chevron needed
  if (entries.length === 0) {
    return (
      <div className="flex items-start leading-relaxed">
        <span className={GUTTER} />
        <span>
          {labelEl}
          <span className={SYNTAX.punct}>
            {open}
            {close}
            {comma}
          </span>
        </span>
      </div>
    );
  }

  // Non-empty container: always render both collapsed preview and
  // expanded children; toggle visibility with CSS to preserve child state.
  return (
    <div>
      {/* ── Collapsed preview (visible when collapsed) ── */}
      <div
        className={cn(
          'flex items-start leading-relaxed hover:bg-[hsl(var(--accent))]/40 rounded cursor-pointer',
          expanded && 'hidden',
        )}
        onClick={() => setExpanded(true)}
      >
        <span className={GUTTER}>
          <ChevronRight size={10} className="text-[hsl(var(--muted-foreground))]" />
        </span>
        <span>
          {labelEl}
          <span className={SYNTAX.punct}>
            {getCollapsedPreview(value, type)}
            {comma}
          </span>
        </span>
      </div>

      {/* ── Expanded view (visible when expanded) ────── */}
      <div className={cn(!expanded && 'hidden')}>
        {/* Opening brace */}
        <div
          className="flex items-start leading-relaxed hover:bg-[hsl(var(--accent))]/40 rounded cursor-pointer"
          onClick={() => setExpanded(false)}
        >
          <span className={GUTTER}>
            <ChevronRight
              size={10}
              className="text-[hsl(var(--muted-foreground))] rotate-90 transition-transform"
            />
          </span>
          <span>
            {labelEl}
            <span className={SYNTAX.punct}>{open}</span>
          </span>
        </div>

        {/* Children */}
        <div className="pl-5 border-l border-[hsl(var(--border))]/40 ml-1.5">
          {(showAll ? entries : entries.slice(0, LARGE_COLLECTION_THRESHOLD)).map(
            ([key, val], i, visible) => (
              <TreeNode
                key={typeof key === 'number' ? key : String(key)}
                value={val}
                label={key}
                depth={depth + 1}
                expandDepth={expandDepth}
                isLast={
                  !showAll && entries.length > LARGE_COLLECTION_THRESHOLD
                    ? false
                    : i === visible.length - 1
                }
              />
            ),
          )}
          {!showAll && entries.length > LARGE_COLLECTION_THRESHOLD && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowAll(true);
              }}
              className="text-[10px] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] py-1 transition-colors"
            >
              Show all {entries.length} items ({entries.length - LARGE_COLLECTION_THRESHOLD} more)
            </button>
          )}
        </div>

        {/* Closing brace */}
        <div className="flex items-start leading-relaxed">
          <span className={GUTTER} />
          <span className={SYNTAX.punct}>
            {close}
            {comma}
          </span>
        </div>
      </div>
    </div>
  );
});

// ── JsonViewer (public API) ──────────────────────────────────
// Drop-in replacement for the previous flat JSON viewer.
// Renders an interactive collapsible tree with syntax coloring.
//
// - Per-node expand/collapse with state preserved across parent toggles
// - "Expand all" / "Collapse all" resets the tree to fully open or closed
// - Copy to clipboard on hover

export function JsonViewer({
  data,
  defaultExpandDepth,
  maxHeight,
  className,
  collapsed,
}: JsonViewerProps) {
  const depth = defaultExpandDepth ?? (collapsed ? 0 : 2);
  const height = maxHeight ?? '24rem';
  const serialized = JSON.stringify(data, null, 2);

  // Key-based reset: changing the key remounts the tree with a new expandDepth.
  // This is intentional — "expand all" means "reset all nodes to expanded".
  const [treeKey, setTreeKey] = useState(0);
  const [currentDepth, setCurrentDepth] = useState(depth);
  const isFullyExpanded = currentDepth === Infinity;

  const toggleExpandAll = useCallback(() => {
    setCurrentDepth((d) => (d === Infinity ? 0 : Infinity));
    setTreeKey((k) => k + 1);
  }, []);

  // Check if the data has nested containers (worth showing expand-all button)
  const type = getValueType(data);
  const hasNesting = type === 'object' || type === 'array';

  return (
    <div className={cn('relative group/json', className)}>
      {/* Toolbar: appears on hover */}
      <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover/json:opacity-100 transition-opacity z-10">
        {hasNesting && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleExpandAll();
            }}
            className={TOOLBAR_BTN}
          >
            {isFullyExpanded ? <ChevronsDownUp size={10} /> : <ChevronsUpDown size={10} />}
            {isFullyExpanded ? 'Collapse' : 'Expand'}
          </button>
        )}
        <CopyButton text={serialized} />
      </div>

      {/* Tree */}
      <div
        className="text-xs font-mono overflow-auto rounded-lg bg-[hsl(var(--secondary))] p-3"
        style={{ maxHeight: height }}
      >
        <TreeNode key={treeKey} value={data} depth={0} expandDepth={currentDepth} isLast />
      </div>
    </div>
  );
}
