interface Props {
  freqHz: readonly number[];
  swr: readonly number[];
  /** Fixed x range so a partial scan draws into its final frame. */
  startHz: number;
  stopHz: number;
  band?: { startHz: number; stopHz: number; name: string };
  min?: { freqHz: number; swr: number };
}

const W = 360;
const H = 210;
const PAD = { l: 34, r: 12, t: 14, b: 30 };
const SWR_MAX = 3;
const TICKS = [1, 1.5, 2, 3];

export function SwrChart({ freqHz, swr, startHz, stopHz, band, min }: Props) {
  const x = (f: number) => PAD.l + ((f - startHz) / (stopHz - startHz)) * (W - PAD.l - PAD.r);
  const y = (s: number) => {
    const v = Math.min(Math.max(s, 1), SWR_MAX);
    return PAD.t + ((SWR_MAX - v) / (SWR_MAX - 1)) * (H - PAD.t - PAD.b);
  };
  const path = freqHz
    .map((f, i) => `${i === 0 ? "M" : "L"}${x(f).toFixed(1)} ${y(swr[i] ?? SWR_MAX).toFixed(1)}`)
    .join(" ");
  const mhz = (hz: number) => (hz / 1e6).toFixed(hz >= 1e8 ? 1 : 3).replace(/0+$/, "").replace(/\.$/, "");
  const minLabelRight = min ? x(min.freqHz) < W / 2 : true;

  const summary = min
    ? `SWR curve. Lowest ${min.swr.toFixed(2)} to 1 at ${mhz(min.freqHz)} megahertz.`
    : "SWR curve, scanning.";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary}>
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
    </svg>
  );
}
