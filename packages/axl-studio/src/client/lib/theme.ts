/**
 * Theme management for Studio.
 *
 * Three modes — `'auto'` (follow OS `prefers-color-scheme`), `'light'`,
 * `'dark'` — persisted to localStorage. The resolved theme is applied to
 * the `<html>` element via the `dark` class so both Tailwind's `dark:`
 * variants and our `.dark` CSS variable block light up from a single
 * source of truth.
 *
 * Lifecycle:
 *   1. `index.html` runs an inline script in <head> to apply the resolved
 *      theme synchronously before any paint (FOUC prevention). The
 *      constants below (`STORAGE_KEY`, `DARK_QUERY`, `THEME_CLASS`) are
 *      duplicated there by hand — see `__tests__/theme.test.ts` for the
 *      tripwire that asserts they stay aligned.
 *   2. `main.tsx` calls `applyResolvedTheme(resolveTheme(loadStoredMode()))`
 *      as a defense-in-depth no-op (the inline script already did this,
 *      but if it threw silently we still want a sane theme).
 *   3. `main.tsx` calls `startThemeAutoApply()` once at module load. This
 *      registers the global OS-preference + cross-tab listeners that
 *      auto-apply on change, decoupled from any UI component's lifecycle.
 *   4. `ThemeToggle` reads the current mode and lets the user cycle it.
 */

export type ThemeMode = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const STORAGE_KEY = 'axl.studio.theme';
export const DARK_QUERY = '(prefers-color-scheme: dark)';
export const THEME_CLASS = 'dark';

const VALID_MODES: readonly ThemeMode[] = ['auto', 'light', 'dark'];

export function loadStoredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && (VALID_MODES as readonly string[]).includes(v)) return v as ThemeMode;
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

function getSystemTheme(): ResolvedTheme {
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
  if (theme === 'dark') root.classList.add(THEME_CLASS);
  else root.classList.remove(THEME_CLASS);
}

/**
 * Watch the OS `prefers-color-scheme` and `localStorage` mode key, calling
 * `onChange` with the current mode and freshly resolved theme whenever
 * either changes. Returns a cleanup function.
 *
 * The OS listener fires regardless of current mode — the resolved theme
 * just stays the same when the user has chosen explicit `'light'` /
 * `'dark'`, so the eventual `applyResolvedTheme` call is a no-op. No
 * filtering needed at the consumer.
 */
export function subscribeToThemeChanges(
  onChange: (mode: ThemeMode, theme: ResolvedTheme) => void,
): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(DARK_QUERY);
  const fire = () => {
    const mode = loadStoredMode();
    onChange(mode, resolveTheme(mode));
  };
  const handleStorage = (e: StorageEvent) => {
    // Filter to our key so an unrelated tab's storage write doesn't
    // trigger a redundant re-apply.
    if (e.key !== null && e.key !== STORAGE_KEY) return;
    fire();
  };
  mq.addEventListener('change', fire);
  window.addEventListener('storage', handleStorage);
  return () => {
    mq.removeEventListener('change', fire);
    window.removeEventListener('storage', handleStorage);
  };
}

/**
 * Module-init hook for `main.tsx`. Subscribes to OS preference changes
 * and cross-tab localStorage changes, applying the resolved theme on
 * each. Returns a cleanup function — usually unused (the listener lives
 * for the page lifetime), but exposed for tests and SSR setups that need
 * to tear down.
 *
 * Decoupling this from any React component's mount lifecycle means OS
 * dark-mode flipping keeps working even in embed scenarios where no
 * Studio chrome is rendered.
 */
export function startThemeAutoApply(): () => void {
  return subscribeToThemeChanges((_mode, theme) => {
    applyResolvedTheme(theme);
  });
}

/**
 * Cycle through theme modes: auto → light → dark → auto.
 */
export function nextMode(mode: ThemeMode): ThemeMode {
  if (mode === 'auto') return 'light';
  if (mode === 'light') return 'dark';
  return 'auto';
}
