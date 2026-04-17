import { cn } from '../../lib/utils';
import type { WindowId } from '../../lib/types';

const WINDOWS: { id: WindowId; label: string }[] = [
  { id: '24h', label: '24h' },
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
  { id: 'all', label: 'All' },
];

const STORAGE_KEY = 'axl.studio.window';

export function getStoredWindow(): WindowId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && WINDOWS.some((w) => w.id === stored)) return stored as WindowId;
  } catch {
    // localStorage unavailable
  }
  return '7d';
}

export function setStoredWindow(window: WindowId): void {
  try {
    localStorage.setItem(STORAGE_KEY, window);
  } catch {
    // localStorage unavailable
  }
}

export function WindowSelector({
  value,
  onChange,
}: {
  value: WindowId;
  onChange: (window: WindowId) => void;
}) {
  return (
    <div
      className="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-[hsl(var(--muted))]"
      role="radiogroup"
      aria-label="Time window"
    >
      {WINDOWS.map((w) => (
        <button
          key={w.id}
          type="button"
          role="radio"
          aria-checked={value === w.id}
          aria-label={`Window: ${w.label}`}
          onClick={() => onChange(w.id)}
          className={cn(
            'px-2.5 py-1 text-xs font-medium rounded-md transition-all cursor-pointer',
            value === w.id
              ? 'bg-[hsl(var(--background))] text-[hsl(var(--foreground))] shadow-sm'
              : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]',
          )}
        >
          {w.label}
        </button>
      ))}
    </div>
  );
}
