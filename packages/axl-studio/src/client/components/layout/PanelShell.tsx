import type { ReactNode } from 'react';
import { PanelHeader } from './PanelHeader';

type Props = {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
};

// Full-shell layout for panels that want the default header + scrollable main
// area. Panels with custom body layouts (split screens, tabs, etc.) should
// use PanelHeader directly instead of this wrapper.
export function PanelShell({ title, description, actions, children }: Props) {
  return (
    <div className="flex flex-col h-screen">
      <PanelHeader title={title} description={description} actions={actions} />
      <main className="flex-1 overflow-auto p-6">{children}</main>
    </div>
  );
}
