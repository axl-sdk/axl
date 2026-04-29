import { useCallback, useEffect, useState } from 'react';
import { Sun, Moon, MonitorSmartphone } from 'lucide-react';
import {
  applyResolvedTheme,
  loadStoredMode,
  nextMode,
  resolveTheme,
  storeMode,
  subscribeToThemeChanges,
  type ThemeMode,
} from '../../lib/theme';
import { cn } from '../../lib/utils';

const MODE_META: Record<ThemeMode, { icon: typeof Sun; label: string; ariaLabel: string }> = {
  auto: {
    icon: MonitorSmartphone,
    label: 'System',
    ariaLabel: 'Theme: follow system. Click to switch to light mode.',
  },
  light: {
    icon: Sun,
    label: 'Light',
    ariaLabel: 'Theme: light. Click to switch to dark mode.',
  },
  dark: {
    icon: Moon,
    label: 'Dark',
    ariaLabel: 'Theme: dark. Click to switch to system mode.',
  },
};

type Props = {
  /** When true, render only the icon (used in the collapsed sidebar). */
  compact?: boolean;
};

export function ThemeToggle({ compact = false }: Props) {
  const [mode, setMode] = useState<ThemeMode>(() => loadStoredMode());

  // Re-render when OS preference flips while in auto mode, or when another
  // tab writes a new mode to localStorage. The lib re-applies the resolved
  // theme to <html> for us; we just need to keep the icon/label in sync.
  useEffect(() => {
    return subscribeToThemeChanges((nextMode) => {
      setMode(nextMode);
      applyResolvedTheme(resolveTheme(nextMode));
    });
  }, []);

  const cycle = useCallback(() => {
    setMode((current) => {
      const next = nextMode(current);
      storeMode(next);
      applyResolvedTheme(resolveTheme(next));
      return next;
    });
  }, []);

  const meta = MODE_META[mode];
  const Icon = meta.icon;

  return (
    <button
      type="button"
      onClick={cycle}
      title={meta.ariaLabel}
      aria-label={meta.ariaLabel}
      className={cn(
        'inline-flex items-center gap-2 rounded-md text-xs transition-colors',
        'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--accent-foreground))]',
        compact ? 'p-1.5 justify-center' : 'px-2 py-1.5',
      )}
    >
      <Icon size={14} />
      {!compact && <span>{meta.label}</span>}
    </button>
  );
}
