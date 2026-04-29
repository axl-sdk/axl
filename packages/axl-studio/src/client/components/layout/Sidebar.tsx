import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  MessageSquare,
  Play,
  Activity,
  DollarSign,
  Brain,
  Users,
  Wrench,
  FlaskConical,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { cn } from '../../lib/utils';

const links = [
  { to: '/playground', label: 'Playground', icon: MessageSquare },
  { to: '/workflows', label: 'Workflows', icon: Play },
  { to: '/traces', label: 'Traces', icon: Activity },
  { to: '/costs', label: 'Costs', icon: DollarSign },
  { to: '/memory', label: 'Memory', icon: Brain },
  { to: '/sessions', label: 'Sessions', icon: Users },
  { to: '/tools', label: 'Tools', icon: Wrench },
  { to: '/evals', label: 'Evals', icon: FlaskConical },
];

const STORAGE_KEY = 'axl.studio.sidebar.collapsed';
const NARROW_QUERY = '(max-width: 767px)';

function loadStoredCollapsed(): boolean | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === '1') return true;
    if (v === '0') return false;
    return null;
  } catch {
    return null;
  }
}

function isNarrowViewport(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(NARROW_QUERY).matches;
}

function isEditableElement(el: HTMLElement): boolean {
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

export function Sidebar() {
  // Initial collapse: stored preference wins, otherwise auto-collapse on
  // narrow viewports so phones/tablets get the icon rail by default.
  const [collapsed, setCollapsedState] = useState(() => {
    const stored = loadStoredCollapsed();
    return stored ?? isNarrowViewport();
  });

  // Track whether the user has explicitly toggled. Once they do, the stored
  // preference takes over and the media-query auto-collapse stops firing —
  // resizing the window won't override an intentional choice.
  const userOverrideRef = useRef(loadStoredCollapsed() !== null);

  const toggle = useCallback(() => {
    setCollapsedState((c) => {
      const next = !c;
      userOverrideRef.current = true;
      try {
        localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      } catch {
        // localStorage unavailable — ignore
      }
      return next;
    });
  }, []);

  // Auto-collapse / re-expand when viewport crosses the narrow breakpoint,
  // but only while the user hasn't expressed an explicit preference.
  useEffect(() => {
    if (userOverrideRef.current) return;
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(NARROW_QUERY);
    const apply = () => setCollapsedState(mq.matches);
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Require exactly Cmd/Ctrl + b — Cmd+Shift+B is browser bookmarks
      // bar, Cmd+Alt+B is reserved on some platforms, Cmd+B alone is
      // markdown-bold in many editors so we must not steal it from
      // textareas/inputs. Bail when focus is in any editable element.
      if (e.shiftKey || e.altKey) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() !== 'b') return;
      const target = e.target as HTMLElement | null;
      if (target && isEditableElement(target)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const shortcutLabel =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent)
      ? '⌘B'
      : 'Ctrl+B';

  return (
    <aside
      className={cn(
        'border-r border-[hsl(var(--border))] bg-[hsl(var(--card))] flex flex-col h-screen transition-[width] duration-150 ease-out',
        collapsed ? 'w-14' : 'w-56',
      )}
    >
      <div
        className={cn(
          'p-4 border-b border-[hsl(var(--border))] flex items-center',
          collapsed ? 'justify-center' : 'justify-between gap-2',
        )}
      >
        {!collapsed && <h1 className="text-lg font-semibold tracking-tight">Axl Studio</h1>}
        <button
          type="button"
          onClick={toggle}
          title={`${collapsed ? 'Expand' : 'Collapse'} sidebar (${shortcutLabel})`}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} sidebar`}
          aria-keyshortcuts="Meta+B Control+B"
          className="p-1 rounded-md text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--accent-foreground))] transition-colors"
        >
          <ToggleIcon size={16} />
        </button>
      </div>
      <nav className="flex-1 p-2 space-y-0.5">
        {links.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            title={collapsed ? label : undefined}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2.5 rounded-md text-sm transition-colors',
                collapsed ? 'justify-center px-2 py-2' : 'px-3 py-2',
                isActive
                  ? 'bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))] font-medium'
                  : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--accent-foreground))]',
              )
            }
          >
            <Icon size={16} />
            {!collapsed && label}
          </NavLink>
        ))}
      </nav>
      {!collapsed && (
        <div className="p-4 border-t border-[hsl(var(--border))] text-xs text-[hsl(var(--muted-foreground))]">
          @axlsdk/studio
        </div>
      )}
    </aside>
  );
}
