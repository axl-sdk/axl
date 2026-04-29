// @vitest-environment jsdom
/**
 * Coverage for the theme module — mode storage, OS resolution, idempotent
 * apply, cycle ordering, listener cleanup, and the FOUC-prevention inline
 * script in index.html. The inline script duplicates a handful of magic
 * strings from `lib/theme.ts`; the tripwire test below catches drift.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyResolvedTheme,
  DARK_QUERY,
  loadStoredMode,
  nextMode,
  resolveTheme,
  storeMode,
  STORAGE_KEY,
  subscribeToThemeChanges,
  THEME_CLASS,
  type ResolvedTheme,
  type ThemeMode,
} from '../client/lib/theme';

type FakeMQ = {
  matches: boolean;
  media: string;
  addEventListener: (type: 'change', listener: () => void) => void;
  removeEventListener: (type: 'change', listener: () => void) => void;
  __fire: (matches: boolean) => void;
};

function installMatchMedia(initialMatches = false) {
  const queries = new Map<string, FakeMQ>();
  const matchMedia = (query: string): FakeMQ => {
    let entry = queries.get(query);
    if (!entry) {
      const listeners = new Set<() => void>();
      entry = {
        matches: query === DARK_QUERY ? initialMatches : false,
        media: query,
        addEventListener: (_t, l) => listeners.add(l),
        removeEventListener: (_t, l) => listeners.delete(l),
        __fire: (matches: boolean) => {
          entry!.matches = matches;
          for (const l of listeners) l();
        },
      };
      queries.set(query, entry);
    }
    return entry;
  };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: matchMedia,
  });
  return { queries };
}

describe('theme — mode storage', () => {
  beforeEach(() => localStorage.clear());

  it("returns 'auto' when nothing is stored", () => {
    expect(loadStoredMode()).toBe('auto');
  });

  it('round-trips valid modes', () => {
    storeMode('light');
    expect(loadStoredMode()).toBe('light');
    storeMode('dark');
    expect(loadStoredMode()).toBe('dark');
    storeMode('auto');
    expect(loadStoredMode()).toBe('auto');
  });

  it("falls back to 'auto' on a corrupted value", () => {
    localStorage.setItem(STORAGE_KEY, 'sepia');
    expect(loadStoredMode()).toBe('auto');
  });

  it('survives localStorage throwing (e.g., privacy-locked Safari)', () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error('access denied');
    };
    try {
      expect(loadStoredMode()).toBe('auto');
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});

describe('theme — resolve + cycle', () => {
  it("'light' / 'dark' resolve to themselves regardless of OS preference", () => {
    installMatchMedia(true);
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
  });

  it("'auto' reflects the OS preference", () => {
    installMatchMedia(false);
    expect(resolveTheme('auto')).toBe('light');
    installMatchMedia(true);
    expect(resolveTheme('auto')).toBe('dark');
  });

  it("'auto' falls back to 'light' when matchMedia is missing", () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    expect(resolveTheme('auto')).toBe('light');
  });

  it('nextMode cycles auto → light → dark → auto', () => {
    expect(nextMode('auto')).toBe('light');
    expect(nextMode('light')).toBe('dark');
    expect(nextMode('dark')).toBe('auto');
  });
});

describe('theme — applyResolvedTheme', () => {
  beforeEach(() => {
    document.documentElement.classList.remove(THEME_CLASS);
  });

  it('adds the dark class for dark theme', () => {
    applyResolvedTheme('dark');
    expect(document.documentElement.classList.contains(THEME_CLASS)).toBe(true);
  });

  it('removes the dark class for light theme', () => {
    document.documentElement.classList.add(THEME_CLASS);
    applyResolvedTheme('light');
    expect(document.documentElement.classList.contains(THEME_CLASS)).toBe(false);
  });

  it('is idempotent', () => {
    applyResolvedTheme('dark');
    applyResolvedTheme('dark');
    applyResolvedTheme('dark');
    expect(document.documentElement.classList.contains(THEME_CLASS)).toBe(true);
    applyResolvedTheme('light');
    applyResolvedTheme('light');
    expect(document.documentElement.classList.contains(THEME_CLASS)).toBe(false);
  });
});

describe('theme — subscribeToThemeChanges', () => {
  beforeEach(() => localStorage.clear());

  it('fires onChange when the OS preference flips', () => {
    const { queries } = installMatchMedia(false);
    const onChange = vi.fn<(mode: ThemeMode, theme: ResolvedTheme) => void>();
    subscribeToThemeChanges(onChange);
    queries.get(DARK_QUERY)!.__fire(true);
    expect(onChange).toHaveBeenCalledWith('auto', 'dark');
  });

  it('fires onChange when another tab writes a new mode', () => {
    installMatchMedia(false);
    const onChange = vi.fn<(mode: ThemeMode, theme: ResolvedTheme) => void>();
    subscribeToThemeChanges(onChange);
    localStorage.setItem(STORAGE_KEY, 'dark');
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: 'dark' }));
    expect(onChange).toHaveBeenCalledWith('dark', 'dark');
  });

  it('ignores storage events for unrelated keys', () => {
    installMatchMedia(false);
    const onChange = vi.fn<(mode: ThemeMode, theme: ResolvedTheme) => void>();
    subscribeToThemeChanges(onChange);
    window.dispatchEvent(new StorageEvent('storage', { key: 'something.else', newValue: 'x' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('handles a storage event with null key (clear()) by re-resolving', () => {
    installMatchMedia(false);
    localStorage.setItem(STORAGE_KEY, 'dark');
    const onChange = vi.fn<(mode: ThemeMode, theme: ResolvedTheme) => void>();
    subscribeToThemeChanges(onChange);
    // localStorage.clear() in another tab fires a storage event with key=null.
    localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null, newValue: null }));
    expect(onChange).toHaveBeenCalledWith('auto', 'light');
  });

  it('cleanup removes both listeners', () => {
    const { queries } = installMatchMedia(false);
    const onChange = vi.fn<(mode: ThemeMode, theme: ResolvedTheme) => void>();
    const unsubscribe = subscribeToThemeChanges(onChange);
    unsubscribe();
    queries.get(DARK_QUERY)!.__fire(true);
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: 'dark' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('returns a no-op cleanup when matchMedia is missing', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const onChange = vi.fn();
    const unsubscribe = subscribeToThemeChanges(onChange);
    expect(() => unsubscribe()).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('theme — inline FOUC script tripwire', () => {
  // The inline script in index.html runs before the React bundle, so it
  // can't import from this module. It hand-codes the storage key, the
  // matchMedia query, and the theme class name. Drift between the two
  // is silently broken behavior (no FOUC-prevention) so we assert the
  // script literally contains every magic string we depend on.
  const indexHtml = readFileSync(resolve(__dirname, '../client/index.html'), 'utf-8');

  it('references the live STORAGE_KEY', () => {
    expect(indexHtml).toContain(STORAGE_KEY);
  });

  it('references the live DARK_QUERY', () => {
    expect(indexHtml).toContain(DARK_QUERY);
  });

  it('references the live THEME_CLASS', () => {
    // The class-name is in `classList.add('dark')`. We assert the literal
    // is present somewhere in the script.
    expect(indexHtml).toContain(`'${THEME_CLASS}'`);
  });

  it('runs synchronously in <head> (no defer/async)', () => {
    // Find the inline script and confirm it's a synchronous <script>
    // before the </head> closing tag — otherwise FOUC isn't actually
    // prevented.
    const headEnd = indexHtml.indexOf('</head>');
    const inlineScriptIdx = indexHtml.indexOf('classList.add');
    expect(inlineScriptIdx).toBeGreaterThan(0);
    expect(inlineScriptIdx).toBeLessThan(headEnd);
    // No `defer` or `async` attribute on the wrapping <script> tag.
    const scriptTagStart = indexHtml.lastIndexOf('<script', inlineScriptIdx);
    const scriptTagEnd = indexHtml.indexOf('>', scriptTagStart);
    const scriptOpenTag = indexHtml.slice(scriptTagStart, scriptTagEnd + 1);
    expect(scriptOpenTag).not.toMatch(/\bdefer\b/);
    expect(scriptOpenTag).not.toMatch(/\basync\b/);
  });
});
