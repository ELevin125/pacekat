import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Small SVG charts for Trends (rules from docs/m4-plan.md): one y-axis per
 * chart, 2 px lines, rounded bar tops with 2 px stack gaps, faint grid,
 * emphasised endpoint, hover tooltip. Colours come from CSS tokens.
 */

function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.round(e!.contentRect.width), h: Math.round(e!.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

interface Tip {
  x: number;
  y: number;
  head: string;
  rows: Array<{ k: string; v: string; color?: string }>;
}

function TipBox({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  const left = Math.min(tip.x + 14, window.innerWidth - 200);
  return (
    <div className="tip-box" style={{ display: 'block', left, top: tip.y + 14 }}>
      <div className="h">{tip.head}</div>
      {tip.rows.map((r) => (
        <div key={r.k} className="r">
          <span>
            {r.color && <i style={{ background: r.color }} />}
            {r.k}
          </span>
          <b>{r.v}</b>
        </div>
      ))}
    </div>
  );
}

const PAD = { l: 40, r: 14, t: 6, b: 18 };

function niceTicks(lo: number, hi: number, n = 3): number[] {
  if (hi <= lo) return [lo];
  return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
}

function XLabels({ labels, x, h }: { labels: string[]; x: (i: number) => number; h: number }) {
  const idx = labels.length <= 4 ? labels.map((_, i) => i) : [0, Math.floor((labels.length - 1) / 2), labels.length - 1];
  return (
    <>
      {idx.map((i) => (
        <text key={i} x={x(i)} y={h - 2} textAnchor={i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'} className="ch-txt">
          {labels[i]}
        </text>
      ))}
    </>
  );
}

export interface LineOpts {
  name: string;
  fmt: (v: number) => string;
  /** Faster-is-better axes (pace): smaller values plot higher. */
  invert?: boolean;
  band?: [number, number];
  bandLabel?: string;
  refLine?: number;
  color?: string;
}

/** One series over weeks; gaps (null) break the line. */
export function LineChart({ values, labels, opts }: { values: Array<number | null>; labels: string[]; opts: LineOpts }) {
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const pts = values.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v != null);
  const color = opts.color ?? 'var(--text)';

  let body: ReactNode = null;
  if (w > 0 && h > 0 && pts.length) {
    const all = [...pts.map((p) => p.v), ...(opts.band ?? []), ...(opts.refLine != null ? [opts.refLine] : [])];
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    const pad = (hi - lo) * 0.15 || Math.max(1, Math.abs(hi) * 0.05);
    lo -= pad;
    hi += pad;
    const n = values.length;
    const iw = w - PAD.l - PAD.r;
    const ih = h - PAD.t - PAD.b;
    const x = (i: number) => PAD.l + (n === 1 ? iw / 2 : (iw * i) / (n - 1));
    const y = (v: number) => (opts.invert ? PAD.t + (ih * (v - lo)) / (hi - lo) : PAD.t + ih * (1 - (v - lo) / (hi - lo)));
    // Path with breaks at nulls.
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i)},${y(v)}`;
      pen = true;
    });
    const last = pts.at(-1)!;
    body = (
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${opts.name}: latest ${opts.fmt(last.v)}`}>
        {opts.band && (
          <>
            <rect x={PAD.l} y={Math.min(y(opts.band[0]), y(opts.band[1]))} width={iw} height={Math.abs(y(opts.band[0]) - y(opts.band[1]))} style={{ fill: 'var(--tile-2)' }} />
            {opts.bandLabel && (
              <text x={w - PAD.r - 4} y={Math.min(y(opts.band[0]), y(opts.band[1])) + 12} textAnchor="end" className="ch-txt small">
                {opts.bandLabel}
              </text>
            )}
          </>
        )}
        {niceTicks(lo + pad, hi - pad).map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={w - PAD.r} y1={y(t)} y2={y(t)} style={{ stroke: 'var(--border)' }} strokeWidth={1} />
            <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end" className="ch-txt">
              {opts.fmt(t)}
            </text>
          </g>
        ))}
        {opts.refLine != null && <line x1={PAD.l} x2={w - PAD.r} y1={y(opts.refLine)} y2={y(opts.refLine)} style={{ stroke: 'var(--text-3)' }} strokeDasharray="4 4" strokeWidth={1} />}
        <XLabels labels={labels} x={x} h={h} />
        <path d={d} fill="none" style={{ stroke: color }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {pts.length === 1 && <circle cx={x(last.i)} cy={y(last.v)} r={3} style={{ fill: color }} />}
        <circle cx={x(last.i)} cy={y(last.v)} r={4} style={{ fill: color, stroke: 'var(--tile)' }} strokeWidth={2} />
        {hover != null && values[hover] != null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={h - PAD.b} style={{ stroke: 'var(--text-3)' }} strokeWidth={1} />
            <circle cx={x(hover)} cy={y(values[hover]!)} r={4} style={{ fill: color, stroke: 'var(--tile)' }} strokeWidth={2} />
          </>
        )}
        <rect
          x={PAD.l}
          y={0}
          width={iw}
          height={h}
          fill="transparent"
          onMouseMove={(e) => {
            const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
            const i = Math.max(0, Math.min(n - 1, Math.round((e.clientX - r.left - PAD.l) / (iw / (n - 1 || 1)))));
            setHover(i);
            setTip({ x: e.clientX, y: e.clientY, head: `Week of ${labels[i]}`, rows: [{ k: opts.name, v: values[i] == null ? 'no data' : opts.fmt(values[i]!), color }] });
          }}
          onMouseLeave={() => {
            setHover(null);
            setTip(null);
          }}
        />
      </svg>
    );
  }
  return (
    <div className="chart-box" ref={ref}>
      {pts.length === 0 ? <div className="chart-empty">No data in this range</div> : body}
      <TipBox tip={tip} />
    </div>
  );
}

export interface StackSeries {
  key: string;
  name: string;
  color: string;
  values: number[];
}

/** Weekly stacked bars; the last week is labelled "so far". */
export function StackedBars({ series, labels, partialLast }: { series: StackSeries[]; labels: string[]; partialLast: boolean }) {
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const n = labels.length;
  const tot = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  let body: ReactNode = null;
  if (w > 0 && h > 0) {
    const hi = Math.max(100, ...tot) * 1.1;
    const iw = w - PAD.l - PAD.r;
    const ih = h - PAD.t - PAD.b;
    const step = iw / n;
    const bw = Math.min(46, step * 0.62);
    const x = (i: number) => PAD.l + step * (i + 0.5);
    const y = (v: number) => PAD.t + ih * (1 - v / hi);
    const ticks = [0, Math.round(hi / 2 / 50) * 50, Math.round((hi * 0.9) / 50) * 50].filter((t, i, a) => a.indexOf(t) === i);
    body = (
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Weekly load by sport">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={w - PAD.r} y1={y(t)} y2={y(t)} style={{ stroke: 'var(--border)' }} strokeWidth={1} />
            <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end" className="ch-txt">
              {t}
            </text>
          </g>
        ))}
        <XLabels labels={labels} x={x} h={h} />
        {labels.map((lab, i) => {
          let base = 0;
          const segs = series.map((s) => ({ s, v: s.values[i] ?? 0 })).filter((d) => d.v > 0);
          return (
            <g key={lab}>
              {segs.map((d, j) => {
                const y0 = y(base);
                const y1 = y(base + d.v);
                base += d.v;
                const gap = j === 0 ? 0 : 2;
                const hh = Math.max(0, y0 - y1 - gap);
                const top = j === segs.length - 1;
                const rr = top ? Math.min(4, hh) : 0;
                const xl = x(i) - bw / 2;
                return (
                  <path
                    key={d.s.key}
                    d={`M${xl},${y1 + hh} V${y1 + rr} Q${xl},${y1} ${xl + rr},${y1} H${xl + bw - rr} Q${xl + bw},${y1} ${xl + bw},${y1 + rr} V${y1 + hh} Z`}
                    style={{ fill: d.s.color }}
                  />
                );
              })}
              {partialLast && i === n - 1 && tot[i]! > 0 && (
                <text x={x(i)} y={y(tot[i]!) - 6} textAnchor="middle" className="ch-txt">
                  so far
                </text>
              )}
              <rect
                x={x(i) - step / 2}
                y={PAD.t}
                width={step}
                height={ih}
                fill="transparent"
                onMouseMove={(e) =>
                  setTip({
                    x: e.clientX,
                    y: e.clientY,
                    head: `Week of ${lab}${partialLast && i === n - 1 ? ' (so far)' : ''}`,
                    rows: [...series.map((s) => ({ k: s.name, v: String(s.values[i] ?? 0), color: s.color })), { k: 'Total', v: String(tot[i]) }],
                  })
                }
                onMouseLeave={() => setTip(null)}
              />
            </g>
          );
        })}
      </svg>
    );
  }
  return (
    <div className="chart-box" ref={ref} style={{ flex: 2.2 }}>
      {tot.every((t) => t === 0) ? <div className="chart-empty">No training load in this range</div> : body}
      <TipBox tip={tip} />
    </div>
  );
}

/** Load ratio strip sharing the bar chart's week positions, with the 0.8–1.3 band. */
export function RatioStrip({ values, labels }: { values: Array<number | null>; labels: string[] }) {
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const n = labels.length;
  const pts = values.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v != null);
  let body: ReactNode = null;
  if (w > 0 && h > 0 && pts.length) {
    const lo = Math.min(0.6, ...pts.map((p) => p.v - 0.05));
    const hi = Math.max(1.5, ...pts.map((p) => p.v + 0.05));
    const iw = w - PAD.l - PAD.r;
    const ih = h - PAD.t - PAD.b;
    const x = (i: number) => PAD.l + (iw / n) * (i + 0.5);
    const y = (v: number) => PAD.t + ih * (1 - (v - lo) / (hi - lo));
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i)},${y(v)}`;
      pen = true;
    });
    body = (
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Load ratio by week">
        <rect x={PAD.l} y={y(1.3)} width={iw} height={y(0.8) - y(1.3)} style={{ fill: 'var(--tile-2)' }} />
        {[0.8, 1.3].map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={w - PAD.r} y1={y(t)} y2={y(t)} style={{ stroke: 'var(--border)' }} strokeWidth={1} />
            <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end" className="ch-txt">
              {t.toFixed(1)}
            </text>
          </g>
        ))}
        <path d={d} fill="none" style={{ stroke: 'var(--text)' }} strokeWidth={2} strokeLinejoin="round" />
        {pts.map((p) => (
          <circle key={p.i} cx={x(p.i)} cy={y(p.v)} r={p.i === pts.at(-1)!.i ? 4 : 2.5} style={{ fill: 'var(--text)', stroke: 'var(--tile)' }} strokeWidth={2} />
        ))}
        {values.map((v, i) => (
          <rect
            key={i}
            x={x(i) - iw / n / 2}
            y={0}
            width={iw / n}
            height={h}
            fill="transparent"
            onMouseMove={(e) =>
              setTip({
                x: e.clientX,
                y: e.clientY,
                head: `Week of ${labels[i]}`,
                rows: v == null ? [{ k: 'Load ratio', v: 'building baseline' }] : [{ k: 'Load ratio', v: v.toFixed(2) }, { k: 'Range', v: v > 1.3 ? 'above safe' : v < 0.8 ? 'fresh / detraining' : 'safe' }],
              })
            }
            onMouseLeave={() => setTip(null)}
          />
        ))}
      </svg>
    );
  }
  return (
    <div className="chart-box" ref={ref} style={{ flex: 1 }}>
      {pts.length === 0 ? <div className="chart-empty">Load ratio appears after 4 weeks of history</div> : body}
      <TipBox tip={tip} />
    </div>
  );
}
