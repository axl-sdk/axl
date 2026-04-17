import { useState } from 'react';
import { cn } from '../../../lib/utils';

export type LinePoint = { x: number; y: number; label?: string; meta?: unknown };
export type LineSeries = {
  name: string;
  color: string;
  points: LinePoint[];
};

/**
 * Lightweight multi-series line chart. x/y are plain numbers — caller maps
 * timestamps to x and scores (0..1) to y. Tooltips show the nearest point
 * across all series when hovering.
 */
export function LineChart({
  series,
  xMin,
  xMax,
  yMin,
  yMax,
  yDomain,
  yClamp,
  height = 160,
  padding = { top: 8, right: 8, bottom: 20, left: 32 },
  formatX = (v) => String(v),
  formatY = (v) => v.toFixed(2),
  onPointClick,
  ariaLabel,
  className,
}: {
  series: LineSeries[];
  xMin: number;
  xMax: number;
  /** Explicit min. If omitted, auto-scales from data. */
  yMin?: number;
  /** Explicit max. If omitted, auto-scales from data. */
  yMax?: number;
  /** Auto-scale strategy. 'data' (default) = tight fit with padding, expands to
   *  `minSpan` if data range is narrower. 'fixed' = use `yMin`/`yMax` as-is. */
  yDomain?: { strategy?: 'data' | 'fixed'; minSpan?: number; padPct?: number };
  /** Clamp the auto-scaled domain to a reference range (e.g., [0,1] for scores).
   *  The axis shrinks to actually-visible data but won't overshoot the clamp. */
  yClamp?: { min?: number; max?: number };
  height?: number;
  padding?: { top: number; right: number; bottom: number; left: number };
  formatX?: (v: number) => string;
  formatY?: (v: number) => string;
  onPointClick?: (series: LineSeries, point: LinePoint) => void;
  /** Short text summary for assistive tech — describes what the chart shows. */
  ariaLabel?: string;
  className?: string;
}) {
  const [hover, setHover] = useState<{
    x: number;
    points: Array<{ series: LineSeries; point: LinePoint }>;
  } | null>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 480, height });

  // ── Compute y-axis domain ───────────────────────────────────────────
  const strategy = yDomain?.strategy ?? 'data';
  const minSpan = yDomain?.minSpan ?? 0.1;
  const padPct = yDomain?.padPct ?? 0.1;

  let computedYMin: number;
  let computedYMax: number;
  if (strategy === 'fixed' || (yMin != null && yMax != null)) {
    computedYMin = yMin ?? 0;
    computedYMax = yMax ?? 1;
  } else {
    // Auto-scale from data
    const allY: number[] = [];
    for (const s of series) for (const p of s.points) if (Number.isFinite(p.y)) allY.push(p.y);
    if (allY.length === 0) {
      computedYMin = yMin ?? 0;
      computedYMax = yMax ?? 1;
    } else {
      let dataMin = Math.min(...allY);
      let dataMax = Math.max(...allY);
      const span = dataMax - dataMin;
      // Expand tight ranges so single-value or near-flat lines don't flatten against an edge.
      if (span < minSpan) {
        const mid = (dataMin + dataMax) / 2;
        dataMin = mid - minSpan / 2;
        dataMax = mid + minSpan / 2;
      }
      // Pad above and below by padPct of the (possibly expanded) span.
      const pad = Math.max(minSpan, dataMax - dataMin) * padPct;
      let lo = dataMin - pad;
      let hi = dataMax + pad;
      // Clamp to reference range if provided.
      if (yClamp?.min != null) lo = Math.max(lo, yClamp.min);
      if (yClamp?.max != null) hi = Math.min(hi, yClamp.max);
      computedYMin = yMin ?? lo;
      computedYMax = yMax ?? hi;
    }
  }

  const innerW = Math.max(1, size.width - padding.left - padding.right);
  const innerH = Math.max(1, size.height - padding.top - padding.bottom);
  const xRange = Math.max(1, xMax - xMin);
  const yRange = Math.max(0.001, computedYMax - computedYMin);

  const scaleX = (x: number) => padding.left + ((x - xMin) / xRange) * innerW;
  const scaleY = (y: number) => padding.top + innerH - ((y - computedYMin) / yRange) * innerH;

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const dataX = xMin + ((mouseX - padding.left) / innerW) * xRange;

    // 1. Find the globally-nearest point across *all* series. This is the
    //    point the user's cursor is actually closest to — picking per-series
    //    and then filtering to a single snapX fails when series don't share
    //    x-values (e.g., "by model" view where each run belongs to one model).
    let snapPoint: { series: LineSeries; point: LinePoint } | null = null;
    let bestDist = Infinity;
    for (const s of series) {
      for (const p of s.points) {
        const d = Math.abs(p.x - dataX);
        if (d < bestDist) {
          bestDist = d;
          snapPoint = { series: s, point: p };
        }
      }
    }
    if (!snapPoint) return;
    const snapX = snapPoint.point.x;

    // 2. Include any *other* series' points that share this exact x-value,
    //    so multi-series-at-same-timestamp (e.g., "by scorer" view where all
    //    scorers share a run timestamp) still shows the full multi-line
    //    readout. Series that have no point at snapX are omitted.
    const points: Array<{ series: LineSeries; point: LinePoint }> = [];
    for (const s of series) {
      const match = s.points.find((p) => p.x === snapX);
      if (match) points.push({ series: s, point: match });
    }
    setHover({ x: snapX, points });
  };

  // y-axis gridlines: 5 evenly-spaced values across the computed domain so
  // the gap between labels is always representative of the visible range.
  const gridYValues = [
    computedYMin,
    computedYMin + (computedYMax - computedYMin) * 0.25,
    computedYMin + (computedYMax - computedYMin) * 0.5,
    computedYMin + (computedYMax - computedYMin) * 0.75,
    computedYMax,
  ];

  return (
    <div
      className={cn('relative w-full', className)}
      ref={(el) => {
        if (el && el.clientWidth > 0 && el.clientWidth !== size.width) {
          setSize({ width: el.clientWidth, height });
        }
      }}
    >
      <svg
        width="100%"
        height={size.height}
        viewBox={`0 0 ${size.width} ${size.height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={
          ariaLabel ??
          `Line chart with ${series.length} series and ${series.reduce(
            (s, se) => s + se.points.length,
            0,
          )} data points.`
        }
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
        // Chart-level click: if a point is currently hovered and a click handler
        // was provided, fire it for the first hovered point. This is more
        // forgiving than requiring a pixel-perfect hit on a 2.5px circle, and
        // avoids the larger hover-indicator dot swallowing the cursor style.
        onClick={
          onPointClick && hover && hover.points.length > 0
            ? () => {
                const first = hover.points[0];
                onPointClick(first.series, first.point);
              }
            : undefined
        }
        className={cn(
          'block',
          onPointClick && hover && hover.points.length > 0 && 'cursor-pointer',
        )}
      >
        {/* Grid lines */}
        {gridYValues.map((v) => (
          <g key={v}>
            <line
              x1={padding.left}
              x2={size.width - padding.right}
              y1={scaleY(v)}
              y2={scaleY(v)}
              stroke="currentColor"
              strokeOpacity={0.08}
              strokeDasharray="2 3"
            />
            <text
              x={padding.left - 4}
              y={scaleY(v) + 3}
              textAnchor="end"
              fontSize={9}
              fill="currentColor"
              fillOpacity={0.5}
            >
              {formatY(v)}
            </text>
          </g>
        ))}

        {/* Lines — non-hovered series fade to 25% opacity when a point is
            hovered, so the active line stands out. In By Scorer view all
            series share the hovered X and stay at full opacity (correct).
            In By Model / Duration view only the hovered model's line stays
            bright, which makes the comparison obvious. */}
        {(() => {
          const activeNames = hover ? new Set(hover.points.map((hp) => hp.series.name)) : null;
          return series.map((s) => {
            // Filter non-finite y-values up-front: scaleY(NaN) = NaN, which
            // produces invalid SVG path data ("L 12.3 NaN") and silently
            // breaks the line. Upstream reducers exclude NaN today, but any
            // future code path that lets one through would corrupt the chart
            // without a clear failure mode.
            const sorted = [...s.points]
              .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
              .sort((a, b) => a.x - b.x);
            if (sorted.length === 0) return null;
            const d = sorted
              .map(
                (p, i) =>
                  `${i === 0 ? 'M' : 'L'} ${scaleX(p.x).toFixed(2)} ${scaleY(p.y).toFixed(2)}`,
              )
              .join(' ');
            const isActive = !activeNames || activeNames.has(s.name);
            return (
              <g
                key={s.name}
                style={{
                  opacity: isActive ? 1 : 0.2,
                  transition: 'opacity 120ms ease-out',
                }}
              >
                <path
                  d={d}
                  stroke={s.color}
                  strokeWidth={isActive && activeNames ? 2 : 1.5}
                  fill="none"
                />
                {sorted.map((p, i) => (
                  <circle key={i} cx={scaleX(p.x)} cy={scaleY(p.y)} r={2.5} fill={s.color} />
                ))}
              </g>
            );
          });
        })()}

        {/* Hover indicator */}
        {hover && (
          <g>
            <line
              x1={scaleX(hover.x)}
              x2={scaleX(hover.x)}
              y1={padding.top}
              y2={size.height - padding.bottom}
              stroke="currentColor"
              strokeOpacity={0.15}
            />
            {hover.points.map(({ series: s, point: p }) => (
              <circle
                key={s.name}
                cx={scaleX(p.x)}
                cy={scaleY(p.y)}
                r={4}
                fill={s.color}
                stroke="hsl(var(--background))"
                strokeWidth={1.5}
              />
            ))}
          </g>
        )}

        {/* x-axis min/max labels */}
        <text
          x={padding.left}
          y={size.height - 4}
          fontSize={9}
          fill="currentColor"
          fillOpacity={0.5}
          textAnchor="start"
        >
          {formatX(xMin)}
        </text>
        <text
          x={size.width - padding.right}
          y={size.height - 4}
          fontSize={9}
          fill="currentColor"
          fillOpacity={0.5}
          textAnchor="end"
        >
          {formatX(xMax)}
        </text>
      </svg>

      {/* Tooltip — flips to the left of the cursor when it would overflow
          the chart on the right. Width is capped so it doesn't blow up on
          long labels (model names + run IDs). */}
      {hover &&
        (() => {
          const pointX = scaleX(hover.x);
          const GAP = 8;
          const MAX_WIDTH = 240;
          // Use the cursor position vs chart midpoint as a cheap, stable
          // heuristic: on the right half, pin to the right of the tooltip
          // container so the tooltip extends leftward. Avoids overflow
          // without needing post-render measurement.
          const pinRight = pointX > size.width / 2;
          const style: React.CSSProperties = pinRight
            ? {
                right: `${Math.max(GAP, size.width - pointX + GAP)}px`,
                top: `${padding.top + 2}px`,
                maxWidth: `${MAX_WIDTH}px`,
              }
            : {
                left: `${Math.min(pointX + GAP, size.width - GAP)}px`,
                top: `${padding.top + 2}px`,
                maxWidth: `${MAX_WIDTH}px`,
              };
          return (
            <div
              className="pointer-events-none absolute z-10 rounded border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-2 py-1 text-[10px] shadow-sm"
              style={style}
            >
              <div className="mb-0.5 text-[hsl(var(--muted-foreground))]">{formatX(hover.x)}</div>
              {hover.points.map(({ series: s, point: p }) => (
                <div key={s.name} className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 rounded-full shrink-0"
                    style={{ backgroundColor: s.color }}
                  />
                  <span className="font-mono truncate">{s.name}</span>
                  <span className="ml-auto font-mono shrink-0">{formatY(p.y)}</span>
                </div>
              ))}
              {hover.points[0]?.point.label && (
                <div className="mt-0.5 truncate text-[hsl(var(--muted-foreground))]">
                  {hover.points[0].point.label}
                </div>
              )}
            </div>
          );
        })()}
    </div>
  );
}
