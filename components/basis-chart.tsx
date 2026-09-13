"use client";

/**
 * The basis chart. Hand-rolled SVG on purpose: a charting dependency would be the
 * largest thing in the client bundle and would render the one number that matters -
 * the signed basis - with somebody else's idea of a default axis.
 *
 * Two rules the drawing obeys:
 *   - The y-axis is SYMMETRIC around zero, so "above the reference" and "below the
 *     reference" always look the same distance from the line. An autoscaled axis that
 *     hides zero would quietly misrepresent the sign convention.
 *   - Session bands are drawn from the data's own session labels, never guessed from
 *     the pixel position, so the weekend shading is the same classification the stats
 *     panels and the memo use.
 *
 * The perp basis is overlaid because the comparison IS the finding: the perp tracks the
 * index several times more tightly than the rToken does.
 */

import { useMemo, useState } from "react";

import type { ClientPack } from "@/lib/research/contract";
import type { SessionKind } from "@/lib/compute/types";
import { SESSION_SHORT, pct, plainPct, utcShort } from "@/lib/research/format";

const W = 960;
const H = 300;
const PAD = { top: 16, right: 16, bottom: 28, left: 52 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

const BAND_FILL: Record<SessionKind, string> = {
  rth: "rgba(127, 209, 193, 0.07)",
  offhours: "rgba(139, 152, 171, 0.05)",
  weekend: "rgba(240, 180, 41, 0.08)",
};

interface Band {
  kind: SessionKind;
  x0: number;
  x1: number;
}

export function BasisChart({ pack }: { pack: ClientPack }) {
  const series = pack.series;
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const view = useMemo(() => {
    const first = series[0];
    const last = series[series.length - 1];
    if (!first || !last) return null;
    const fromTs = first.ts;
    const toTs = last.ts;
    const span = Math.max(1, toTs - fromTs);
    const x = (ts: number): number => PAD.left + ((ts - fromTs) / span) * PLOT_W;

    let peak = 0;
    for (const point of series) {
      peak = Math.max(peak, Math.abs(point.basisPct));
      if (point.perpBasisPct !== null) peak = Math.max(peak, Math.abs(point.perpBasisPct));
    }
    const domain = Math.max(0.05, peak * 1.18);
    const y = (value: number): number => PAD.top + PLOT_H / 2 - (value / domain) * (PLOT_H / 2);

    const line = (pick: (ts: number, p: (typeof series)[number]) => number | null): string[] => {
      const parts: string[] = [];
      let current: string[] = [];
      for (const point of series) {
        const value = pick(point.ts, point);
        if (value === null || !Number.isFinite(value)) {
          if (current.length > 0) parts.push(current.join(" "));
          current = [];
          continue;
        }
        current.push((current.length === 0 ? "M" : "L") + x(point.ts).toFixed(2) + "," + y(value).toFixed(2));
      }
      if (current.length > 0) parts.push(current.join(" "));
      return parts;
    };

    const bands: Band[] = [];
    for (let i = 0; i < series.length; i += 1) {
      const point = series[i];
      if (!point) continue;
      const previous = bands[bands.length - 1];
      if (previous && previous.kind === point.session) {
        previous.x1 = x(point.ts);
      } else {
        bands.push({ kind: point.session, x0: x(point.ts), x1: x(point.ts) });
      }
    }

    const ticks: number[] = [];
    const step = domain > 1 ? 0.5 : domain > 0.4 ? 0.2 : domain > 0.15 ? 0.05 : 0.02;
    for (let value = step; value <= domain; value += step) {
      ticks.push(value);
      ticks.push(-value);
    }

    return {
      x,
      y,
      domain,
      bands,
      ticks,
      rTokenPath: line((_ts, p) => p.basisPct).join(" "),
      perpPath: line((_ts, p) => p.perpBasisPct).join(" "),
      lastX: x(toTs),
      lastBasisPct: last.basisPct,
      zeroY: y(0),
      fromTs,
      toTs,
    };
  }, [series]);

  if (!view) {
    return (
      <div className="panel empty">
        No matched hourly observations in this window, so there is no series to draw. The join is by timestamp, and an
        hour with no rToken candle is dropped rather than interpolated.
      </div>
    );
  }

  const hovered = hoverIndex !== null ? series[hoverIndex] : null;

  /**
   * The svg is scaled to its container by viewBox, so map the pointer from client
   * pixels into viewBox units before inverting the x-scale. Index spacing is used for
   * hit-testing only; the drawn positions stay time-proportional.
   */
  const onMove = (event: React.MouseEvent<SVGSVGElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || series.length < 2) return;
    const viewBoxX = ((event.clientX - rect.left) / rect.width) * W;
    const ratio = (viewBoxX - PAD.left) / PLOT_W;
    const index = Math.round(ratio * (series.length - 1));
    setHoverIndex(Math.max(0, Math.min(series.length - 1, index)));
  };

  return (
    <div className="chart-wrap">
      <svg
        viewBox={"0 0 " + W + " " + H}
        className="chart"
        role="img"
        aria-label={"Basis of " + pack.base + " rToken against its reference index over the observation window"}
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIndex(null)}
      >
        {view.bands.map((band, index) => (
          <rect
            key={index}
            x={band.x0}
            y={PAD.top}
            width={Math.max(0, band.x1 - band.x0)}
            height={PLOT_H}
            fill={BAND_FILL[band.kind]}
          />
        ))}

        {view.ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={view.y(tick)}
              y2={view.y(tick)}
              stroke="var(--line)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <text x={PAD.left - 8} y={view.y(tick) + 4} textAnchor="end" className="axis">
              {plainPct(tick, 2)}
            </text>
          </g>
        ))}

        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={view.zeroY}
          y2={view.zeroY}
          stroke="var(--muted)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        <text x={PAD.left - 8} y={view.zeroY + 4} textAnchor="end" className="axis zero">
          0.00%
        </text>

        {view.perpPath ? (
          <path
            d={view.perpPath}
            fill="none"
            stroke="var(--perp)"
            strokeWidth={1.4}
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
            opacity={0.9}
          />
        ) : null}
        <path
          d={view.rTokenPath}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={1.9}
          vectorEffect="non-scaling-stroke"
        />

        <circle cx={view.lastX} cy={view.y(view.lastBasisPct)} r={3.6} fill="var(--accent)" />

        {hovered ? (
          <g>
            <line
              x1={view.x(hovered.ts)}
              x2={view.x(hovered.ts)}
              y1={PAD.top}
              y2={PAD.top + PLOT_H}
              stroke="var(--text)"
              strokeWidth={1}
              opacity={0.35}
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={view.x(hovered.ts)} cy={view.y(hovered.basisPct)} r={3.4} fill="var(--accent)" />
            {hovered.perpBasisPct !== null ? (
              <circle cx={view.x(hovered.ts)} cy={view.y(hovered.perpBasisPct)} r={3} fill="var(--perp)" />
            ) : null}
          </g>
        ) : null}

        <text x={PAD.left} y={H - 8} className="axis">
          {utcShort(view.fromTs)}
        </text>
        <text x={W - PAD.right} y={H - 8} textAnchor="end" className="axis">
          {utcShort(view.toTs)}
        </text>
      </svg>

      {hovered ? (
        <div
          className="chart-tip"
          style={{ left: Math.min(88, Math.max(2, (view.x(hovered.ts) / W) * 100)) + "%" }}
        >
          <div className="tip-time">{utcShort(hovered.ts)} &middot; {SESSION_SHORT[hovered.session]}</div>
          <div className="tip-row">
            <span>rToken basis</span>
            <strong className={hovered.basisPct >= 0 ? "pos" : "neg"}>{pct(hovered.basisPct, 4)}</strong>
          </div>
          <div className="tip-row">
            <span>Perp basis</span>
            <strong>{pct(hovered.perpBasisPct, 4)}</strong>
          </div>
        </div>
      ) : null}

      <div className="legend">
        <span>
          <i className="swatch rtoken" /> {pack.rTokenSymbol} basis vs reference
        </span>
        <span>
          <i className="swatch perp" /> {pack.perpSymbol} perp basis vs the same index
        </span>
        <span className="legend-window">
          window {utcShort(view.fromTs)} &rarr; {utcShort(view.toTs)} &middot; {series.length} plotted of{" "}
          {pack.observationWindow ? pack.observationWindow.n : series.length} matched hours
        </span>
      </div>
    </div>
  );
}