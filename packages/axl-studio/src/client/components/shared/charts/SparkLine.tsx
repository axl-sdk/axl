import { cn } from '../../../lib/utils';

/**
 * Tiny inline line — no axes, no tooltip. Used for cost-over-time
 * under each eval card. Height ~24px.
 */
export function SparkLine({
  values,
  color = 'hsl(var(--primary))',
  width = 120,
  height = 24,
  fill = true,
  className,
}: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
  fill?: boolean;
  className?: string;
}) {
  if (values.length === 0) {
    return <div className={cn('inline-block', className)} style={{ width, height }} />;
  }
  if (values.length === 1) {
    // Single point — render as a dot
    return (
      <svg width={width} height={height} className={cn('inline-block', className)}>
        <circle cx={width / 2} cy={height / 2} r={2} fill={color} />
      </svg>
    );
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(0.001, max - min);
  const padY = 2;
  const innerH = height - padY * 2;

  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = padY + innerH - ((v - min) / range) * innerH;
    return [x, y];
  });

  const linePath = points
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(' ');
  const areaPath = fill ? `${linePath} L ${width} ${height} L 0 ${height} Z` : null;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('inline-block', className)}
    >
      {areaPath && <path d={areaPath} fill={color} fillOpacity={0.12} />}
      <path d={linePath} stroke={color} strokeWidth={1.25} fill="none" />
    </svg>
  );
}
