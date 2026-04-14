import { useState, useRef, useEffect, useCallback, useMemo, useId } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { Search, Check, ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';

// Generic, command-palette-style picker used across studio panels. Owns the
// popover, search, keyboard navigation, and click-outside — the parent owns
// the trigger's outer container so the picker can slot into rounded pill
// button groups, filter rows, or standalone. Two visual variants:
//
//   variant="picker" — primary action picker (search icon, optional ⌘K hint,
//                      wider min-width). Used for "pick a thing and act".
//   variant="filter" — compact filter dropdown (chevron icon, no kbd hint,
//                      tighter padding). Used for table/view filters.
//
// The ⌘K shortcut is opt-in via the `shortcut` prop. Studio panels are
// separate React Router routes, so only one panel mounts at a time. A panel
// may enable `shortcut` on exactly one picker. Double-opt-in within the same
// mounted tree stacks global listeners — avoid it.
export interface CommandPickerProps<T> {
  items: readonly T[];
  value: string;
  onSelect: (key: string) => void;
  getKey: (item: T) => string;
  getLabel: (item: T) => string;
  getDescription?: (item: T) => ReactNode;
  // Custom search-match callback. The `query` argument is already
  // lowercased — callers should lowercase the item side for a consistent
  // case-insensitive match.
  searchMatch?: (item: T, query: string) => boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  shortcut?: boolean;
  variant?: 'picker' | 'filter';
  triggerClassName?: string;
  popoverWidth?: number;
  ariaLabel?: string;
}

export function CommandPicker<T>({
  items,
  value,
  onSelect,
  getKey,
  getLabel,
  getDescription,
  searchMatch,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyLabel = 'No results',
  shortcut = false,
  variant = 'picker',
  triggerClassName,
  popoverWidth,
  ariaLabel,
}: CommandPickerProps<T>) {
  // Filter popovers are typically anchored to narrow filter chips with short
  // item lists (event types, agent names). Default them narrower than the
  // full-fat picker popover which needs room for label + metadata subhead.
  const resolvedPopoverWidth = popoverWidth ?? (variant === 'filter' ? 260 : 440);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  // The reset-to-selection effect stomps the user's keyboard cursor if we
  // reset on every filter change. This ref remembers whether the user has
  // manually moved the highlight since the popover opened — if so, we keep
  // their position instead of snapping back.
  const userMovedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Position-below flip state: when the trigger is near the bottom of the
  // viewport, render the popover above it instead of below so it doesn't
  // clip offscreen. Computed on open from the trigger's bounding rect.
  const [placeAbove, setPlaceAbove] = useState(false);
  // aria-controls/activedescendant need stable ids per picker instance.
  const reactId = useId();
  const popoverId = `cmdpicker-pop-${reactId}`;
  const optionId = (i: number) => `cmdpicker-opt-${reactId}-${i}`;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    if (searchMatch) return items.filter((item) => searchMatch(item, q));
    return items.filter((item) => getLabel(item).toLowerCase().includes(q));
  }, [items, query, searchMatch, getLabel]);

  // Selected item's display label. When no value is set, show placeholder.
  const selectedLabel = useMemo(() => {
    if (!value) return null;
    const item = items.find((i) => getKey(i) === value);
    return item ? getLabel(item) : null;
  }, [items, value, getKey]);

  // Snap the highlight to the currently-selected row so Enter re-selects it
  // without surprise. Only runs while the user hasn't manually moved the
  // cursor — once they press ArrowDown/Up or start typing, we stop resetting.
  useEffect(() => {
    if (userMovedRef.current) {
      // Clamp to valid range after a filter change so the cursor doesn't
      // point at a no-longer-visible row, but don't snap back to selection.
      setActiveIndex((i) => Math.max(0, Math.min(i, filtered.length - 1)));
      return;
    }
    const idx = filtered.findIndex((item) => getKey(item) === value);
    setActiveIndex(idx >= 0 ? idx : 0);
  }, [filtered, value, getKey]);

  // Reset transient state on open/close: focus input, reset query + user-moved
  // flag, and compute whether to place the popover above or below the trigger.
  useEffect(() => {
    if (!open) {
      setQuery('');
      userMovedRef.current = false;
      return;
    }
    // Rough estimate: header (~50) + list (340) + footer (~32) ≈ 425.
    // If the trigger is too close to the bottom edge, flip to above.
    const POPOVER_MAX_HEIGHT = 425;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      setPlaceAbove(spaceBelow < POPOVER_MAX_HEIGHT && spaceAbove > spaceBelow);
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (!shortcut) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        const target = e.target as HTMLElement | null;
        // Allow ⌘K to close from inside this picker's own popover so users
        // can toggle with one shortcut. Block it in other inputs so we don't
        // steal focus from the user typing in a message/code editor.
        const inOwnPopover = !!(target && popoverRef.current?.contains(target));
        const isEditable =
          target?.tagName === 'INPUT' ||
          target?.tagName === 'TEXTAREA' ||
          target?.isContentEditable === true;
        if (isEditable && !inOwnPopover) return;
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [shortcut]);

  const selectItem = useCallback(
    (key: string) => {
      onSelect(key);
      setOpen(false);
      requestAnimationFrame(() => triggerRef.current?.focus());
    },
    [onSelect],
  );

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        userMovedRef.current = true;
        setActiveIndex((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        userMovedRef.current = true;
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = filtered[activeIndex];
        if (item) selectItem(getKey(item));
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      } else if (e.key === 'Tab') {
        // Don't trap focus — just close the popover and let focus flow
        // naturally to the next element. Prevents leaving a ghost listbox
        // open when the user tabs away.
        setOpen(false);
      }
    },
    [filtered, activeIndex, selectItem, getKey],
  );

  const displayLabel = selectedLabel ?? placeholder;
  const isFilter = variant === 'filter';

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={ariaLabel ?? (selectedLabel ? `Selected: ${selectedLabel}` : placeholder)}
        className={cn(
          'group inline-flex items-center gap-2 text-sm cursor-pointer transition-colors',
          'focus:outline-none focus-visible:bg-[hsl(var(--muted))]',
          'hover:bg-[hsl(var(--muted))]',
          isFilter ? 'px-3 py-1.5 text-xs' : 'pl-4 pr-3 py-2 min-w-[240px] max-w-[320px]',
          triggerClassName,
        )}
      >
        {!isFilter && <Search size={13} className="text-[hsl(var(--muted-foreground))] shrink-0" />}
        <span
          className={cn(
            'flex-1 text-left truncate',
            isFilter ? '' : 'font-medium',
            !selectedLabel && 'text-[hsl(var(--muted-foreground))] font-normal',
          )}
        >
          {displayLabel}
        </span>
        {isFilter ? (
          <ChevronDown
            size={12}
            className="text-[hsl(var(--muted-foreground))] shrink-0 opacity-70"
          />
        ) : shortcut ? (
          <kbd
            className={cn(
              'hidden md:inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-mono rounded',
              'border border-[hsl(var(--border))] bg-[hsl(var(--background))]',
              'text-[hsl(var(--muted-foreground))]',
            )}
          >
            <span className="text-xs leading-none">⌘</span>K
          </kbd>
        ) : null}
      </button>

      {open && (
        <div
          ref={popoverRef}
          id={popoverId}
          role="listbox"
          aria-label={ariaLabel ?? placeholder}
          aria-activedescendant={filtered[activeIndex] ? optionId(activeIndex) : undefined}
          style={{ width: resolvedPopoverWidth }}
          className={cn(
            'absolute right-0 z-50',
            placeAbove ? 'bottom-[calc(100%+8px)]' : 'top-[calc(100%+8px)]',
            'rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--background))]',
            'shadow-2xl overflow-hidden popover-enter',
          )}
        >
          <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[hsl(var(--border))]">
            <Search size={14} className="text-[hsl(var(--muted-foreground))] shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                // Typing resets to top of the filtered list. The user-moved
                // flag stays true so they can keep arrowing from there.
                userMovedRef.current = false;
              }}
              onKeyDown={handleKeyDown}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className={cn(
                'flex-1 bg-transparent text-sm focus:outline-none',
                'placeholder:text-[hsl(var(--muted-foreground))]',
              )}
            />
            <kbd
              className={cn(
                'text-[10px] font-mono px-1.5 py-0.5 rounded',
                'border border-[hsl(var(--border))]',
                'text-[hsl(var(--muted-foreground))]',
              )}
            >
              ESC
            </kbd>
          </div>

          <div className="max-h-[340px] overflow-y-auto py-1.5">
            {filtered.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-[hsl(var(--muted-foreground))]">
                {query ? `No results for "${query}"` : emptyLabel}
              </div>
            ) : (
              filtered.map((item, i) => {
                const key = getKey(item);
                const label = getLabel(item);
                const desc = getDescription?.(item);
                const isActive = i === activeIndex;
                const isChosen = key === value;
                return (
                  <button
                    key={key || `__empty__${i}`}
                    id={optionId(i)}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    onClick={() => selectItem(key)}
                    onMouseEnter={() => {
                      userMovedRef.current = true;
                      setActiveIndex(i);
                    }}
                    className={cn(
                      'w-full flex items-center gap-3 px-4 py-2.5 text-left cursor-pointer',
                      'transition-colors',
                      isActive && 'bg-[hsl(var(--muted))]',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{label || placeholder}</div>
                      {desc && (
                        <div className="text-[10px] uppercase tracking-[0.08em] text-[hsl(var(--muted-foreground))] mt-0.5 truncate">
                          {desc}
                        </div>
                      )}
                    </div>
                    {isChosen && (
                      <Check
                        size={14}
                        className="text-[hsl(var(--muted-foreground))] shrink-0"
                        aria-label="Currently selected"
                      />
                    )}
                  </button>
                );
              })
            )}
          </div>

          <div
            className={cn(
              'flex items-center justify-between px-4 py-2 border-t border-[hsl(var(--border))]',
              'bg-[hsl(var(--muted))]/40 text-[10px] text-[hsl(var(--muted-foreground))]',
            )}
          >
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <kbd className="font-mono opacity-70">↑↓</kbd> navigate
              </span>
              <span className="flex items-center gap-1">
                <kbd className="font-mono opacity-70">↵</kbd> select
              </span>
            </div>
            <span className="tabular-nums">
              {filtered.length} of {items.length}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
