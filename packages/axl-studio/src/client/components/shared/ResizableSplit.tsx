import { useState, useRef, useCallback, useEffect, type ReactNode } from 'react';
import { cn } from '../../lib/utils';

type ResizableSplitProps = {
  left: ReactNode;
  right: ReactNode;
  defaultPercent?: number;
  minPercent?: number;
  maxPercent?: number;
  /** Pixel floor for either pane on narrow viewports — overrides minPercent
   *  when the container is small enough that minPercent% is unreadably tiny. */
  minPx?: number;
  /** When set, the resolved split is persisted to localStorage under
   *  `axl.studio.split.<storageKey>`. Without it, every page load resets. */
  storageKey?: string;
  className?: string;
};

const STORAGE_PREFIX = 'axl.studio.split.';
const ARROW_KEY_STEP = 2;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function ResizableSplit({
  left,
  right,
  defaultPercent = 50,
  minPercent = 20,
  maxPercent = 80,
  minPx = 200,
  storageKey,
  className,
}: ResizableSplitProps) {
  const [splitPercent, setSplitPercent] = useState(() => {
    if (!storageKey) return defaultPercent;
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + storageKey);
      if (!raw) return defaultPercent;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return defaultPercent;
      return clamp(parsed, minPercent, maxPercent);
    } catch {
      return defaultPercent;
    }
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const moveHandlerRef = useRef<((ev: MouseEvent | TouchEvent) => void) | null>(null);
  const upHandlerRef = useRef<(() => void) | null>(null);

  // Persist on change.
  useEffect(() => {
    if (!storageKey) return;
    try {
      localStorage.setItem(STORAGE_PREFIX + storageKey, String(splitPercent));
    } catch {
      // localStorage unavailable — ignore.
    }
  }, [storageKey, splitPercent]);

  // Compute container-aware bounds. minPx clamps so a 20% pane on a 600px
  // container doesn't collapse to 120px.
  const computeBounds = useCallback((): { min: number; max: number } => {
    const width = containerRef.current?.getBoundingClientRect().width ?? 0;
    if (!width || !Number.isFinite(width)) return { min: minPercent, max: maxPercent };
    const minPxPercent = (minPx / width) * 100;
    return {
      min: Math.max(minPercent, minPxPercent),
      max: Math.min(maxPercent, 100 - minPxPercent),
    };
  }, [minPercent, maxPercent, minPx]);

  // Final cleanup. Listeners are attached to `document` and `body.style` is
  // mutated on drag start; without this useEffect, an unmount mid-drag (route
  // change) leaves both leaked globally until next page load.
  useEffect(() => {
    return () => {
      if (moveHandlerRef.current) {
        document.removeEventListener('mousemove', moveHandlerRef.current as EventListener);
        document.removeEventListener('touchmove', moveHandlerRef.current as EventListener);
      }
      if (upHandlerRef.current) {
        document.removeEventListener('mouseup', upHandlerRef.current);
        document.removeEventListener('touchend', upHandlerRef.current);
        document.removeEventListener('touchcancel', upHandlerRef.current);
      }
      if (draggingRef.current) {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
  }, []);

  const startDrag = useCallback(
    (clientX: number) => {
      draggingRef.current = true;
      const startX = clientX;
      const container = containerRef.current;
      if (!container) return;
      const startWidth = container.getBoundingClientRect().width;
      const startPercent = splitPercent;

      const onMove = (ev: MouseEvent | TouchEvent) => {
        if (!draggingRef.current) return;
        // Re-read width per-move so window resize / DevTools toggling
        // mid-drag doesn't make the percent calc drift.
        const currentWidth = container.getBoundingClientRect().width || startWidth;
        const currentX =
          'touches' in ev ? (ev.touches[0]?.clientX ?? startX) : (ev as MouseEvent).clientX;
        const delta = currentX - startX;
        const pctDelta = (delta / currentWidth) * 100;
        const { min, max } = computeBounds();
        setSplitPercent(clamp(startPercent + pctDelta, min, max));
      };
      const onUp = () => {
        draggingRef.current = false;
        document.removeEventListener('mousemove', onMove as EventListener);
        document.removeEventListener('touchmove', onMove as EventListener);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchend', onUp);
        document.removeEventListener('touchcancel', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        moveHandlerRef.current = null;
        upHandlerRef.current = null;
      };
      moveHandlerRef.current = onMove;
      upHandlerRef.current = onUp;
      document.addEventListener('mousemove', onMove as EventListener);
      document.addEventListener('touchmove', onMove as EventListener, { passive: false });
      document.addEventListener('mouseup', onUp);
      document.addEventListener('touchend', onUp);
      document.addEventListener('touchcancel', onUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [splitPercent, computeBounds],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startDrag(e.clientX);
    },
    [startDrag],
  );

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      startDrag(t.clientX);
    },
    [startDrag],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      const step = e.shiftKey ? ARROW_KEY_STEP * 5 : ARROW_KEY_STEP;
      const { min, max } = computeBounds();
      setSplitPercent((p) => clamp(p + dir * step, min, max));
    },
    [computeBounds],
  );

  return (
    <div ref={containerRef} className={cn('flex min-h-0', className)}>
      <div className="min-h-0 min-w-0 flex flex-col" style={{ width: `${splitPercent}%` }}>
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={Math.round(splitPercent)}
        aria-valuemin={minPercent}
        aria-valuemax={maxPercent}
        tabIndex={0}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onKeyDown={handleKeyDown}
        className="w-1.5 shrink-0 cursor-col-resize bg-[hsl(var(--border))] hover:bg-[hsl(var(--ring))] focus:bg-[hsl(var(--ring))] focus:outline-none transition-colors"
      />
      <div className="min-h-0 min-w-0 flex flex-col" style={{ width: `${100 - splitPercent}%` }}>
        {right}
      </div>
    </div>
  );
}
