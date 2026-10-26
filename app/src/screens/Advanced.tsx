import { useState } from "preact/hooks";
import { abs, arg, impedance, returnLoss, swr, type Sweep, toCsv, toTouchstone } from "@resonance/analysis";
import { go, lastCheck } from "../state";
import { LearnLink } from "./Learn";

export function Advanced() {
  const last = lastCheck.value;
  if (!last) {
    return (
      <div class="soon">
        <p>Run a check first; its raw data shows here.</p>
        <button class="link-btn" onClick={() => go({ name: "check" })}>
          Check my antenna
        </button>
      </div>
    );
  }
  return <AdvancedView sweep={last.sweep} title={`${last.result.band.name}, ${new Date(last.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`} band={last.result.band} />;
}

function download(name: string, text: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function AdvancedView({ sweep, title, band }: { sweep: Sweep; title: string; band: { startHz: number; stopHz: number; name: string } }) {
  const n = sweep.freqHz.length;
  const minIdx = sweep.s11.reduce((best, g, i) => (abs(g) < abs(sweep.s11[best]!) ? i : best), 0);
  const [k, setK] = useState(minIdx);
  const z = sweep.s11.map((g) => impedance(g));
  const f = sweep.freqHz[k]!;
  const g = sweep.s11[k]!;
  const zk = z[k]!;
  const w = 2 * Math.PI * f;
  const equiv =
    Math.abs(zk.im) < 0.5
      ? "resistive"
      : zk.im > 0
        ? `${((zk.im / w) * 1e6).toFixed(2)} µH (inductive)`
        : `${((-1 / (w * zk.im)) * 1e12).toFixed(0)} pF (capacitive)`;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

  return (
    <>
      <div class="flow-head">
        <h2>Advanced</h2>
        <button class="icon-btn" onClick={() => go({ name: "check" })}>
          Back
        </button>
      </div>
      <p class="muted">{title}</p>

      <div class="chart">
        <SmithChart sweep={sweep} marker={k} band={band} />
      </div>

      <label class="field compact marker-field">
        <span class="num">Marker {(f / 1e6).toFixed(4)} MHz</span>
        <input type="range" min="0" max={n - 1} step="1" value={k} onInput={(e) => setK(Number((e.target as HTMLInputElement).value))} aria-label="Marker frequency" />
      </label>

      <dl class="readout num">
        <div>
          <dt>SWR</dt>
          <dd>{Number.isFinite(swr(g)) ? swr(g).toFixed(2) : "∞"}</dd>
        </div>
        <div>
          <dt>Return loss</dt>
          <dd>{returnLoss(g).toFixed(1)} dB</dd>
        </div>
        <div>
          <dt>R</dt>
          <dd>{zk.re.toFixed(1)} Ω</dd>
        </div>
        <div>
          <dt>X</dt>
          <dd>
            {zk.im >= 0 ? "+" : "−"}
            {Math.abs(zk.im).toFixed(1)} Ω
          </dd>
        </div>
        <div>
          <dt>|Z|</dt>
          <dd>{Math.hypot(zk.re, zk.im).toFixed(1)} Ω</dd>
        </div>
        <div>
          <dt>Γ</dt>
          <dd>
            {abs(g).toFixed(3)} ∠ {((arg(g) * 180) / Math.PI).toFixed(1)}°
          </dd>
        </div>
        <div class="wide">
          <dt>Equivalent</dt>
          <dd>{equiv}</dd>
        </div>
      </dl>
      <p class="learn-links">
        <LearnLink topic="smith">Reading the Smith chart</LearnLink>
        <LearnLink topic="impedance">What R and X mean</LearnLink>
      </p>

      <h3 class="section-title">Resistance and reactance</h3>
      <div class="chart">
        <LineChart
          x={sweep.freqHz}
          marker={k}
          band={band}
          unit="Ω"
          series={[
            { label: "R", values: z.map((v) => v.re), color: "var(--trace)" },
            { label: "X", values: z.map((v) => v.im), color: "var(--usable)", dashed: true },
          ]}
        />
      </div>

      <h3 class="section-title">Return loss</h3>
      <div class="chart">
        <LineChart
          x={sweep.freqHz}
          marker={k}
          band={band}
          unit="dB"
          series={[{ label: "Return loss", values: sweep.s11.map((s) => Math.min(60, returnLoss(s))), color: "var(--trace)" }]}
        />
      </div>

      <h3 class="section-title">Export</h3>
      <div class="actions">
        <button class="btn" onClick={() => download(`resonance-${band.name}-${stamp}.s1p`, toTouchstone(sweep, `Resonance ${band.name}`), "text/plain")}>
          Touchstone (.s1p)
        </button>
        <button class="btn" onClick={() => download(`resonance-${band.name}-${stamp}.csv`, toCsv(sweep), "text/csv")}>
          CSV
        </button>
      </div>
      <div class="actions single">
        <button class="btn" onClick={() => go({ name: "connect" })}>
          Command console and device screen
        </button>
      </div>
    </>
  );
}

/** Smith chart: constant-R circles, constant-X arcs, the sweep trace, zones and the marker. */
function SmithChart({ sweep, marker, band }: { sweep: Sweep; marker: number; band: { startHz: number; stopHz: number } }) {
  const S = 340;
  const R = 150;
  const cx = S / 2;
  const cy = S / 2;
  const px = (re: number) => cx + re * R;
  const py = (im: number) => cy - im * R;
  const rCircles = [0.2, 0.5, 1, 2, 5];
  const xArcs = [0.2, 0.5, 1, 2, 5];
  const trace = sweep.s11.map((g, i) => `${i ? "L" : "M"}${px(g.re).toFixed(1)} ${py(g.im).toFixed(1)}`).join(" ");
  const inBand = sweep.s11
    .map((g, i) => ({ g, f: sweep.freqHz[i]! }))
    .filter((p) => p.f >= band.startHz && p.f <= band.stopHz)
    .map((p, i) => `${i ? "L" : "M"}${px(p.g.re).toFixed(1)} ${py(p.g.im).toFixed(1)}`)
    .join(" ");
  const g = sweep.s11[marker]!;
  return (
    <svg viewBox={`0 0 ${S} ${S}`} role="img" aria-label="Smith chart of the sweep">
      <defs>
        <clipPath id="smith-clip">
          <circle cx={cx} cy={cy} r={R} />
        </clipPath>
      </defs>
      <circle cx={cx} cy={cy} r={R} fill="none" stroke="var(--muted)" stroke-width="1.25" />
      <g clip-path="url(#smith-clip)" stroke="var(--rule)" fill="none" stroke-width="1">
        {rCircles.map((r) => (
          <circle key={`r${r}`} cx={px(r / (1 + r))} cy={cy} r={R / (1 + r)} />
        ))}
        {xArcs.flatMap((x) => [
          <circle key={`xp${x}`} cx={px(1)} cy={py(1 / x)} r={R / x} />,
          <circle key={`xn${x}`} cx={px(1)} cy={py(-1 / x)} r={R / x} />,
        ])}
        <line x1={cx - R} x2={cx + R} y1={cy} y2={cy} />
      </g>
      <text x={cx} y={cy - R * 0.55} text-anchor="middle" font-size="12" fill="var(--muted)">
        inductive: too long
      </text>
      <text x={cx} y={cy + R * 0.6} text-anchor="middle" font-size="12" fill="var(--muted)">
        capacitive: too short
      </text>
      <circle cx={cx} cy={cy} r="4" fill="none" stroke="var(--good)" stroke-width="2" />
      <text x={cx + 8} y={cy - 6} font-size="11" fill="var(--good)">
        50 Ω
      </text>
      <path d={trace} fill="none" stroke="var(--muted)" stroke-width="1.5" />
      <path d={inBand} fill="none" stroke="var(--trace)" stroke-width="3" stroke-linecap="round" />
      <circle cx={px(g.re)} cy={py(g.im)} r="6" fill="var(--ink)" stroke="var(--surface)" stroke-width="2" />
    </svg>
  );
}

function LineChart(props: {
  x: readonly number[];
  series: { label: string; values: number[]; color: string; dashed?: boolean }[];
  marker: number;
  band: { startHz: number; stopHz: number };
  unit: string;
}) {
  const W = 360;
  const H = 180;
  const P = { l: 40, r: 10, t: 16, b: 26 };
  const xs = props.x;
  const all = props.series.flatMap((s) => s.values).filter(Number.isFinite);
  // Keep huge off-resonance values from flattening the interesting part.
  const sorted = [...all].sort((a, b) => a - b);
  let lo = sorted[Math.floor(sorted.length * 0.02)] ?? 0;
  let hi = sorted[Math.ceil(sorted.length * 0.98) - 1] ?? 1;
  lo = Math.min(lo, 0);
  if (hi - lo < 1) hi = lo + 1;
  const x = (f: number) => P.l + ((f - xs[0]!) / (xs.at(-1)! - xs[0]!)) * (W - P.l - P.r);
  const y = (v: number) => P.t + (1 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (H - P.t - P.b);
  const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));
  const mx = x(xs[props.marker]!);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={props.series.map((s) => s.label).join(" and ") + " versus frequency"}>
      <rect x={x(props.band.startHz)} y={P.t} width={Math.max(1, x(props.band.stopHz) - x(props.band.startHz))} height={H - P.t - P.b} fill="var(--trace-wash)" />
      {lo < 0 && hi > 0 && <line x1={P.l} x2={W - P.r} y1={y(0)} y2={y(0)} stroke="var(--rule)" />}
      {[lo, hi].map((v) => (
        <text key={v} x={P.l + 4} y={v === hi ? y(v) + 12 : y(v) - 4} font-size="11" fill="var(--muted)" class="num">
          {fmt(v)} {props.unit}
        </text>
      ))}
      {props.series.map((s) => (
        <path
          key={s.label}
          d={s.values.map((v, i) => `${i ? "L" : "M"}${x(xs[i]!).toFixed(1)} ${y(v).toFixed(1)}`).join(" ")}
          fill="none"
          stroke={s.color}
          stroke-width="2"
          stroke-dasharray={s.dashed ? "5 4" : undefined}
        />
      ))}
      <line x1={mx} x2={mx} y1={P.t} y2={H - P.b} stroke="var(--ink)" stroke-width="1" />
      <text x={P.l} y={H - 8} font-size="11" fill="var(--muted)" class="num">
        {(xs[0]! / 1e6).toFixed(2)}
      </text>
      <text x={W - P.r} y={H - 8} text-anchor="end" font-size="11" fill="var(--muted)" class="num">
        {(xs.at(-1)! / 1e6).toFixed(2)} MHz
      </text>
      {props.series.length > 1 &&
        props.series.map((s, i) => (
          <g key={`l${s.label}`}>
            <line x1={W - P.r - 70 + i * 36} x2={W - P.r - 56 + i * 36} y1={P.t - 6} y2={P.t - 6} stroke={s.color} stroke-width="2" stroke-dasharray={s.dashed ? "4 3" : undefined} />
            <text x={W - P.r - 52 + i * 36} y={P.t - 2} font-size="11" fill="var(--muted)">
              {s.label}
            </text>
          </g>
        ))}
    </svg>
  );
}
