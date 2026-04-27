import { useEffect, useState } from 'react';
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

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(loadCollapsed);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
    } catch {
      // localStorage unavailable — ignore
    }
  }, [collapsed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;

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
          onClick={() => setCollapsed((c) => !c)}
          title={`${collapsed ? 'Expand' : 'Collapse'} sidebar (⌘B)`}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} sidebar`}
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
