import { useState } from 'react';

type Props = {
  data: unknown;
  collapsed?: boolean;
  className?: string;
};

export function JsonViewer({ data, collapsed = false, className }: Props) {
  const [isCollapsed, setIsCollapsed] = useState(collapsed);
  const formatted = JSON.stringify(data, null, 2);
  const isLong = formatted.length > 200;

  return (
    <div className={`relative ${className ?? ''}`}>
      {isLong && (
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] mb-1"
        >
          {isCollapsed ? 'Expand' : 'Collapse'}
        </button>
      )}
      <pre className="text-xs font-mono p-3 rounded-md bg-[hsl(var(--secondary))] overflow-auto max-h-96">
        {isCollapsed ? JSON.stringify(data) : formatted}
      </pre>
    </div>
  );
}
