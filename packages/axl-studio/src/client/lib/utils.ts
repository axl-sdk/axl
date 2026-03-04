/** Merge class names (simplified cn utility). */
export function cn(...classes: (string | undefined | false | null)[]): string {
  return classes.filter(Boolean).join(' ');
}

/** Format a cost value as a dollar string. */
export function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/** Format a duration in milliseconds to a human-readable string. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/** Format token count with comma separators. */
export function formatTokens(tokens: number): string {
  return tokens.toLocaleString();
}

/** Get status color class. */
export function statusColor(status: string): string {
  switch (status) {
    case 'running':
      return 'text-blue-500';
    case 'completed':
      return 'text-green-500';
    case 'failed':
      return 'text-red-500';
    case 'waiting':
      return 'text-amber-500';
    default:
      return 'text-gray-500';
  }
}
