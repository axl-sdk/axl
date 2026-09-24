import { cn } from '../../lib/utils';
import type { EvalTrendCompleteness } from '../../lib/types';

export type CostPoint = { cost: number; completeness?: EvalTrendCompleteness };

/**
 * The cost-over-time sparkline for a trend window, drawn so that a
 * non-measured point cannot be read as part of the trend.
 *
 * The shared `SparkLine` draws one continuous line through whatever numbers it
 * is given. Handing it a window of `$0.75` (measured), `$0.00` (an unpriced
 * model, so a lower bound) and `$0.42` (a pre-0.24 artifact repeating its own
 * total) draws a clean downward slope, and the reader concludes the last model
 * change made the eval nearly free. The window-level completeness chip does
 * not prevent that reading: it describes the SUM, not the shape.
 *
 * So: segments touching a non-measured point are dashed, non-measured points
 * are drawn as hollow amber rings against filled measured dots, and the
 * accessible name says how many points are not measured spend.
 */
export function CostSparkLine({
  points,
  width = 80,
  height = 22,
  className,
}: {
  points: readonly CostPoint[];
  width?: number;
  height?: number;
  className?: string;
}) {
  const measured = (p: CostPoint) => (p.completeness ?? 'unverified') === 'complete';
  const notMeasured = points.filter((p) => !measured(p)).length;
  const label =
    notMeasured === 0
      ? `Cost over time across ${points.length} measured runs.`
      : `Cost over time across ${points.length} runs. ${notMeasured} of them are lower bounds or ` +
        `unverified totals, drawn as hollow points on dashed segments — the shape between them ` +
        `is not a measured trend.`;

  if (points.length === 0) {
    return <div className={cn('inline-block', className)} style={{ width, height }} />;
  }

  const values = points.map((p) => p.cost);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(0.001, max - min);
  const padY = 3;
  const innerH = height - padY * 2;
  const coords = points.map((p, i) => ({
    x: points.length === 1 ? width / 2 : (i / (points.length - 1)) * width,
    y: padY + innerH - ((p.cost - min) / range) * innerH,
    measured: measured(p),
  }));

  const color = 'hsl(var(--primary))';
  const caution = 'hsl(38 92% 45%)';

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      className={cn('inline-block overflow-visible', className)}
    >
      <title>{label}</title>
      {coords.slice(1).map((to, i) => {
        const from = coords[i];
        const solid = from.measured && to.measured;
        return (
          <line
            key={i}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke={solid ? color : caution}
            strokeWidth={1.25}
            {...(solid ? {} : { strokeDasharray: '2 2' })}
          />
        );
      })}
      {coords.map((c, i) =>
        c.measured ? (
          <circle key={i} cx={c.x} cy={c.y} r={1.6} fill={color} />
        ) : (
          <circle
            key={i}
            cx={c.x}
            cy={c.y}
            r={2.1}
            fill="none"
            stroke={caution}
            strokeWidth={1.25}
          />
        ),
      )}
    </svg>
  );
}
