import { cn } from '../../../lib/utils';

export type BarDatum = { label: string; value: number; color?: string };

/**
 * Horizontal bar chart. Each bar is one row with a label on the left,
 * a proportional bar, and the numeric value on the right. Good for
 * "top-N" views (tools, event types, agents).
 */
export function BarChart({
  data,
  maxBars,
  defaultColor = 'hsl(var(--primary))',
  formatValue = (v) => String(v),
  className,
}: {
  data: BarDatum[];
  maxBars?: number;
  defaultColor?: string;
  formatValue?: (v: number) => string;
  className?: string;
}) {
  const sorted = [...data].sort((a, b) => b.value - a.value);
  const rows = maxBars ? sorted.slice(0, maxBars) : sorted;
  const max = rows.length > 0 ? Math.max(...rows.map((r) => r.value)) : 1;

  if (rows.length === 0) {
    return <p className={cn('text-xs text-[hsl(var(--muted-foreground))]', className)}>No data</p>;
  }

  return (
    <div className={cn('space-y-1', className)}>
      {rows.map((row) => {
        const pct = max > 0 ? (row.value / max) * 100 : 0;
        return (
          <div key={row.label} className="flex items-center gap-2 text-xs">
            <div
              className="w-24 truncate font-mono text-[hsl(var(--muted-foreground))]"
              title={row.label}
            >
              {row.label}
            </div>
            <div className="relative flex-1 h-5 rounded bg-[hsl(var(--muted))]">
              <div
                className="absolute inset-y-0 left-0 rounded"
                style={{
                  width: `${pct}%`,
                  backgroundColor: row.color ?? defaultColor,
                  opacity: 0.7,
                }}
              />
            </div>
            <div className="w-12 text-right font-mono tabular-nums">{formatValue(row.value)}</div>
          </div>
        );
      })}
    </div>
  );
}

export type StackedBarDatum = {
  label: string;
  segments: Array<{ name: string; value: number; color: string }>;
};

/**
 * Horizontal stacked bar chart. Each row has multiple colored segments
 * side-by-side whose total width is proportional to the row's total.
 * Used for retry-by-agent with stacked schema/validate/guardrail.
 */
export function StackedBarChart({
  data,
  maxBars,
  formatValue = (v) => String(v),
  showLegend = true,
  className,
}: {
  data: StackedBarDatum[];
  maxBars?: number;
  formatValue?: (v: number) => string;
  showLegend?: boolean;
  className?: string;
}) {
  const withTotals = data.map((d) => ({
    ...d,
    total: d.segments.reduce((sum, s) => sum + s.value, 0),
  }));
  const sorted = [...withTotals].sort((a, b) => b.total - a.total);
  const rows = maxBars ? sorted.slice(0, maxBars) : sorted;
  const max = rows.length > 0 ? Math.max(...rows.map((r) => r.total)) : 1;

  if (rows.length === 0) {
    return <p className={cn('text-xs text-[hsl(var(--muted-foreground))]', className)}>No data</p>;
  }

  // Collect all segment names for the legend
  const legend = new Map<string, string>();
  for (const row of rows) {
    for (const seg of row.segments) {
      if (!legend.has(seg.name)) legend.set(seg.name, seg.color);
    }
  }

  return (
    <div className={cn('space-y-2', className)}>
      {showLegend && legend.size > 0 && (
        <div className="flex flex-wrap gap-3 text-[10px] text-[hsl(var(--muted-foreground))]">
          {Array.from(legend.entries()).map(([name, color]) => (
            <div key={name} className="flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: color }}
              />
              <span>{name}</span>
            </div>
          ))}
        </div>
      )}
      <div className="space-y-1">
        {rows.map((row) => {
          const widthPct = max > 0 ? (row.total / max) * 100 : 0;
          return (
            <div key={row.label} className="flex items-center gap-2 text-xs">
              <div
                className="w-24 truncate font-mono text-[hsl(var(--muted-foreground))]"
                title={row.label}
              >
                {row.label}
              </div>
              <div className="relative flex-1 h-5 rounded bg-[hsl(var(--muted))] overflow-hidden">
                <div className="absolute inset-y-0 left-0 flex" style={{ width: `${widthPct}%` }}>
                  {row.segments.map((seg, i) => {
                    const segPct = row.total > 0 ? (seg.value / row.total) * 100 : 0;
                    return (
                      <div
                        key={`${seg.name}-${i}`}
                        style={{
                          width: `${segPct}%`,
                          backgroundColor: seg.color,
                          opacity: 0.75,
                        }}
                        title={`${seg.name}: ${seg.value}`}
                      />
                    );
                  })}
                </div>
              </div>
              <div className="w-12 text-right font-mono tabular-nums">{formatValue(row.total)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
