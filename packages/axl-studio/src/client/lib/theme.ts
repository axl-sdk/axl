/**
 * Theme management for Studio.
 *
 * Supports three modes: `'auto'` (follow OS `prefers-color-scheme`),
 * `'light'`, and `'dark'`. The chosen mode is persisted to localStorage; the
 * resolved theme is applied to the `<html>` element via the `dark` class so
 * Tailwind's `dark:` variants light up.
 *
 * `applyResolvedTheme()` runs synchronously before React hydrates to avoid
 * a flash of unstyled colors. `subscribeToThemeChanges()` re-applies when
 * the mode is `'auto'` and the OS preference flips, and emits cross-tab
 * updates when localStorage changes elsewhere.
 */

export type ThemeMode = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'axl.studio.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

export function loadStoredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'auto') return v;
  } catch {
    // localStorage unavailable
  }
  return 'auto';
}

export function storeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // localStorage unavailable — ignore
  }
}

export function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  return mode === 'auto' ? getSystemTheme() : mode;
}

/**
 * Apply the resolved theme to the document root by toggling the `dark`
 * class. Idempotent — safe to call repeatedly. No-op outside the browser.
 */
export function applyResolvedTheme(theme: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
}

/**
 * Watch the OS `prefers-color-scheme` and `localStorage` mode key, calling
 * `onChange` with the freshly resolved theme whenever either changes.
 * Returns a cleanup function.
 *
 * The OS listener fires regardless of mode — the consumer is responsible
 * for re-checking the current mode and ignoring the event when not in
 * `'auto'`. Storage events come from other tabs writing to localStorage
 * and let multiple Studio tabs stay in sync.
 */
export function subscribeToThemeChanges(
  onChange: (mode: ThemeMode, theme: ResolvedTheme) => void,
): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(DARK_QUERY);
  const handleSystem = () => {
    const mode = loadStoredMode();
    onChange(mode, resolveTheme(mode));
  };
  const handleStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    const mode = loadStoredMode();
    onChange(mode, resolveTheme(mode));
  };
  mq.addEventListener('change', handleSystem);
  window.addEventListener('storage', handleStorage);
  return () => {
    mq.removeEventListener('change', handleSystem);
    window.removeEventListener('storage', handleStorage);
  };
}

/**
 * Cycle through theme modes: auto → light → dark → auto.
 */
export function nextMode(mode: ThemeMode): ThemeMode {
  if (mode === 'auto') return 'light';
  if (mode === 'light') return 'dark';
  return 'auto';
}
