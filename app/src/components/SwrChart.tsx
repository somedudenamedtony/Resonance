import { useRef, useState } from "preact/hooks";

interface Props {
  freqHz: readonly number[];
  swr: readonly number[];
  /** Fixed x range so a partial scan draws into its final frame. */
  startHz: number;
  stopHz: number;
  band?: { startHz: number; stopHz: number; name: string };
  min?: { freqHz: number; swr: number };
  /** Earlier sweeps drawn dashed behind the main trace (e.g. the baseline). */
  overlays?: { freqHz: readonly number[]; swr: readonly number[]; label: string }[];
  /** The part of the band the verdict judged (e.g. CW), shaded darker than the band. */
  segment?: { startHz: number; stopHz: number; label: string };
  /** Drag (or arrow keys) to read SWR at any frequency. Only for finished sweeps. */
  cursor?: boolean;
}

const W = 360;
const H = 210;
const PAD = { l: 34, r: 12, t: 14, b: 30 };
const SWR_MAX = 3;
const TICKS = [1, 1.5, 2, 3];

/** Index of the sweep point nearest `f`. Sweeps are sorted by frequency. */
export function nearestIndex(freqHz: readonly number[], f: number): number {
  let lo = 0;
  let hi = freqHz.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (freqHz[mid]! < f) lo = mid;
    else hi = mid;
  }
  return Math.abs(freqHz[lo]! - f) <= Math.abs(freqHz[hi]! - f) ? lo : hi;
}

/** A few words on what an SWR means for the radio, for the cursor readout. */
export function swrWord(s: number): string {
  if (!Number.isFinite(s) || s > 3) return "too high for most radios";
  if (s <= 1.5) return "excellent";
  if (s <= 2) return "fine for most radios";
  return "many radios cut power";
}

export function SwrChart({ freqHz, swr, startHz, stopHz, band, min, overlays, segment, cursor }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [at, setAt] = useState<number | null>(null);
  const dragging = useRef(false);
  const x = (f: number) => PAD.l + ((f - startHz) / (stopHz - startHz)) * (W - PAD.l - PAD.r);
  const y = (s: number) => {
    const v = Math.min(Math.max(s, 1), SWR_MAX);
    return PAD.t + ((SWR_MAX - v) / (SWR_MAX - 1)) * (H - PAD.t - PAD.b);
  };
  const toPath = (fs: readonly number[], ss: readonly number[]) =>
    fs
      .map((f, i) => `${i === 0 ? "M" : "L"}${x(Math.min(Math.max(f, startHz), stopHz)).toFixed(1)} ${y(ss[i] ?? SWR_MAX).toFixed(1)}`)
      .join(" ");
  const path = toPath(freqHz, swr);
  const mhz = (hz: number) => (hz / 1e6).toFixed(hz >= 1e8 ? 1 : 3).replace(/0+$/, "").replace(/\.$/, "");
  const minLabelRight = min ? x(min.freqHz) < W / 2 : true;
  const canCursor = !!cursor && freqHz.length > 1;
  const idx = canCursor && at !== null ? Math.min(at, freqHz.length - 1) : null;

  const pick = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const vx = ((clientX - r.left) / r.width) * W;
    const f = startHz + ((vx - PAD.l) / (W - PAD.l - PAD.r)) * (stopHz - startHz);
    setAt(nearestIndex(freqHz, f));
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    const from = idx ?? (min ? nearestIndex(freqHz, min.freqHz) : 0);
    if (e.key === "ArrowLeft") setAt(Math.max(0, from - step));
    else if (e.key === "ArrowRight") setAt(Math.min(freqHz.length - 1, from + step));
    else if (e.key === "Escape") setAt(null);
    else return;
    e.preventDefault();
  };
  const interaction = canCursor
    ? {
        tabIndex: 0,
        class: "cursor-chart",
        onPointerDown: (e: PointerEvent) => {
          dragging.current = true;
          (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
          pick(e.clientX);
        },
        onPointerMove: (e: PointerEvent) => {
          if (dragging.current || e.pointerType === "mouse") pick(e.clientX);
        },
        onPointerUp: () => (dragging.current = false),
        onPointerCancel: () => (dragging.current = false),
        onKeyDown: onKey,
      }
    : {};

  const summary = min
    ? `SWR curve. Lowest ${min.swr.toFixed(2)} to 1 at ${mhz(min.freqHz)} megahertz.`
    : "SWR curve, scanning.";

  const cf = idx !== null ? freqHz[idx]! : null;
  const cs = idx !== null ? swr[idx]! : null;
  const fmtS = (v: number) => (Number.isFinite(v) && v < 10 ? v.toFixed(2) : ">10");

  const chart = (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={canCursor ? `${summary} Use the arrow keys to read other frequencies.` : summary}
      {...interaction}
    >
      <defs>
        <linearGradient id="swr-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="var(--trace)" stop-opacity="0" />
          <stop offset="1" stop-color="var(--trace)" stop-opacity="0.16" />
        </linearGradient>
      </defs>
      {band && (
        <g>
          <rect
            x={x(band.startHz)}
            y={PAD.t}
            width={Math.max(1, x(band.stopHz) - x(band.startHz))}
            height={H - PAD.t - PAD.b}
            fill="var(--trace-wash)"
          />
          <text x={(x(band.startHz) + x(band.stopHz)) / 2} y={PAD.t + 14} text-anchor="middle" font-size="12" fill="var(--muted)">
            {band.name}
          </text>
        </g>
      )}
      {segment && (
        <g>
          <rect
            x={x(segment.startHz)}
            y={PAD.t}
            width={Math.max(2, x(segment.stopHz) - x(segment.startHz))}
            height={H - PAD.t - PAD.b}
            fill="var(--trace-wash)"
          />
          <text
            x={(x(segment.startHz) + x(segment.stopHz)) / 2}
            y={PAD.t + 30}
            text-anchor="middle"
            font-size="11"
            font-weight="600"
            fill="var(--trace-deep)"
          >
            {segment.label}
          </text>
        </g>
      )}
      {TICKS.map((t) => (
        <g key={t}>
          <line
            x1={PAD.l}
            x2={W - PAD.r}
            y1={y(t)}
            y2={y(t)}
            stroke="var(--rule)"
            stroke-width="1"
            stroke-dasharray={t === 2 ? "4 4" : undefined}
          />
          <text x={PAD.l - 6} y={y(t) + 4} text-anchor="end" font-size="11" fill="var(--muted)" class="num">
            {t === 1 ? "1:1" : `${t}`}
          </text>
        </g>
      ))}
      {band && (
        <g font-size="11" fill="var(--muted)" class="num">
          <text x={x(band.startHz)} y={H - 10} text-anchor="middle">
            {mhz(band.startHz)}
          </text>
          <text x={x(band.stopHz)} y={H - 10} text-anchor="middle">
            {mhz(band.stopHz)}
          </text>
        </g>
      )}
      <text x={W - PAD.r} y={H - 10} text-anchor="end" font-size="11" fill="var(--muted)">
        MHz
      </text>
      {overlays?.map((o) => (
        <path
          key={o.label}
          d={toPath(o.freqHz, o.swr)}
          fill="none"
          stroke="var(--muted)"
          stroke-width="2"
          stroke-dasharray="5 4"
          stroke-linejoin="round"
        >
          <title>{o.label}</title>
        </path>
      ))}
      {path && freqHz.length > 1 && (
        <path
          class="trace-path trace-fill"
          d={`${path} L${x(Math.min(freqHz[freqHz.length - 1]!, stopHz)).toFixed(1)} ${H - PAD.b} L${x(Math.max(freqHz[0]!, startHz)).toFixed(1)} ${H - PAD.b} Z`}
          fill="url(#swr-fill)"
          stroke="none"
        />
      )}
      {path && (
        <path class="trace-path" d={path} fill="none" stroke="var(--trace)" stroke-width="2.5" stroke-linejoin="round" />
      )}
      {min && (
        <g>
          <circle cx={x(min.freqHz)} cy={y(min.swr)} r="5" fill="var(--trace)" stroke="var(--surface)" stroke-width="2" />
          <text
            x={x(min.freqHz) + (minLabelRight ? 9 : -9)}
            y={y(min.swr) - 14}
            text-anchor={minLabelRight ? "start" : "end"}
            font-size="12"
            font-weight="600"
            fill="var(--ink)"
            stroke="var(--surface)"
            stroke-width="4"
            paint-order="stroke"
            stroke-linejoin="round"
            class="num"
          >
            {min.swr.toFixed(2)} at {mhz(min.freqHz)}
          </text>
        </g>
      )}
      {cf !== null && cs !== null && (
        <g pointer-events="none">
          <line x1={x(cf)} x2={x(cf)} y1={PAD.t} y2={H - PAD.b} stroke="var(--ink)" stroke-width="1.5" stroke-dasharray="3 3" />
          <circle cx={x(cf)} cy={y(cs)} r="5" fill="var(--surface)" stroke="var(--ink)" stroke-width="2" />
        </g>
      )}
    </svg>
  );
  if (!canCursor) return chart;
  return (
    <>
      {chart}
      <p class="chart-readout" aria-live="polite">
        {cf !== null && cs !== null ? (
          <>
            <strong class="num">{(cf / 1e6).toFixed(3)} MHz</strong>
            <span>
              SWR <strong class="num">{fmtS(cs)}</strong>, {swrWord(cs)}
            </span>
            {overlays?.map((o) =>
              o.freqHz.length ? (
                <span key={o.label} class="muted">
                  {o.label} <span class="num">{fmtS(o.swr[nearestIndex(o.freqHz, cf)]!)}</span>
                </span>
              ) : null,
            )}
          </>
        ) : (
          <span class="muted">Drag across the chart to read the SWR at any frequency.</span>
        )}
      </p>
    </>
  );
}
