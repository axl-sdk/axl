import type { ReactNode } from 'react';

type Props = {
  title: string;
  description?: string;
  icon?: ReactNode;
};

export function EmptyState({ title, description, icon }: Props) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {icon && <div className="mb-3 text-[hsl(var(--muted-foreground))]">{icon}</div>}
      <h3 className="text-sm font-medium text-[hsl(var(--foreground))]">{title}</h3>
      {description && (
        <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1 max-w-sm">{description}</p>
      )}
    </div>
  );
}
