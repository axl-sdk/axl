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

export function Sidebar() {
  return (
    <aside className="w-56 border-r border-[hsl(var(--border))] bg-[hsl(var(--card))] flex flex-col h-screen">
      <div className="p-4 border-b border-[hsl(var(--border))]">
        <h1 className="text-lg font-semibold tracking-tight">Axl Studio</h1>
      </div>
      <nav className="flex-1 p-2 space-y-0.5">
        {links.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors',
                isActive
                  ? 'bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))] font-medium'
                  : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--accent-foreground))]',
              )
            }
          >
            <Icon size={16} />
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="p-4 border-t border-[hsl(var(--border))] text-xs text-[hsl(var(--muted-foreground))]">
        @axlsdk/studio
      </div>
    </aside>
  );
}
