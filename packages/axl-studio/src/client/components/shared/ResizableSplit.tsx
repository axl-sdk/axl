import { useState, useRef, useCallback, type ReactNode } from 'react';
import { cn } from '../../lib/utils';

type ResizableSplitProps = {
  left: ReactNode;
  right: ReactNode;
  defaultPercent?: number;
  minPercent?: number;
  maxPercent?: number;
  className?: string;
};

export function ResizableSplit({
  left,
  right,
  defaultPercent = 50,
  minPercent = 20,
  maxPercent = 80,
  className,
}: ResizableSplitProps) {
  const [splitPercent, setSplitPercent] = useState(defaultPercent);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      const startX = e.clientX;
      const container = containerRef.current;
      if (!container) return;
      const startWidth = container.getBoundingClientRect().width;
      const startPercent = splitPercent;

      const onMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        const delta = ev.clientX - startX;
        const pctDelta = (delta / startWidth) * 100;
        setSplitPercent(Math.min(maxPercent, Math.max(minPercent, startPercent + pctDelta)));
      };
      const onUp = () => {
        draggingRef.current = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [splitPercent, minPercent, maxPercent],
  );

  return (
    <div ref={containerRef} className={cn('flex min-h-0', className)}>
      <div className="min-h-0 min-w-0 flex flex-col" style={{ width: `${splitPercent}%` }}>
        {left}
      </div>
      <div
        onMouseDown={handleDragStart}
        className="w-1.5 shrink-0 cursor-col-resize bg-[hsl(var(--border))] hover:bg-[hsl(var(--ring))] transition-colors"
      />
      <div className="min-h-0 min-w-0 flex flex-col" style={{ width: `${100 - splitPercent}%` }}>
        {right}
      </div>
    </div>
  );
}
