import { cn, statusColor } from '../../lib/utils';

type Props = {
  status: string;
  className?: string;
};

export function StatusBadge({ status, className }: Props) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium',
        statusColor(status),
        status === 'running' && 'animate-pulse',
        className,
      )}
    >
      <span
        className={cn(
          'w-1.5 h-1.5 rounded-full',
          status === 'running' && 'bg-blue-500',
          status === 'completed' && 'bg-green-500',
          status === 'failed' && 'bg-red-500',
          status === 'waiting' && 'bg-amber-500',
        )}
      />
      {status}
    </span>
  );
}
