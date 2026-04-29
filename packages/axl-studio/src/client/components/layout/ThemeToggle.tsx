import { useCallback, useEffect, useState } from 'react';
import { Sun, Moon, MonitorSmartphone, type LucideIcon } from 'lucide-react';
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

const MODE_META: Record<ThemeMode, { icon: LucideIcon; label: string; ariaLabel: string }> = {
  auto: {
    icon: MonitorSmartphone,
    label: 'System',
    ariaLabel: 'Theme: follow system. Switch to light.',
  },
  light: {
    icon: Sun,
    label: 'Light',
    ariaLabel: 'Theme: light. Switch to dark.',
  },
  dark: {
    icon: Moon,
    label: 'Dark',
    ariaLabel: 'Theme: dark. Switch to system.',
  },
};

type Props = {
  /** When true, render only the icon (used in the collapsed sidebar). */
  compact?: boolean;
};

export function ThemeToggle({ compact = false }: Props) {
  const [mode, setMode] = useState<ThemeMode>(() => loadStoredMode());

  // The global apply lives in main.tsx via `startThemeAutoApply()`. This
  // subscription only exists to keep the toggle's icon/label in sync when
  // the OS preference flips while in `auto` mode, or another tab writes a
  // new mode to localStorage. The actual `<html>` class swap is handled
  // by the global subscriber, so we don't double-apply here.
  useEffect(() => {
    return subscribeToThemeChanges((next) => setMode(next));
  }, []);

  const cycle = useCallback(() => {
    setMode((current) => {
      const next = nextMode(current);
      storeMode(next);
      // Apply directly so this tab updates immediately. The `storage`
      // event we'd otherwise wait on doesn't fire in the originating tab.
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
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]',
        compact ? 'p-1.5 justify-center' : 'px-2 py-1.5',
      )}
    >
      <Icon size={14} />
      {!compact && <span>{meta.label}</span>}
    </button>
  );
}
