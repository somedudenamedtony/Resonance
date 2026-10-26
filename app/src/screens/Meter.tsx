import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Band, SwrThresholds } from "@resonance/analysis";
import { SimulatedTransport } from "../bridge/simulator";
import { BAND_ORDER, bandsById } from "../check";
import { bandOf, type MeterReading, MeterSession, needleFraction, presetsFor } from "../meter";
import { bandView, meterView } from "../mirror";
import { useDeviceView } from "../useDeviceView";
import { calibration, client, device, go, link, settings } from "../state";
import { LearnLink } from "./Learn";

/** Pause between scans so the bridge and the screen get a breath. */
const MIN_GAP_MS = 40;

/** Last frequency used, so coming back to the meter picks up where you left off. */
const lastFreqHz = signal<number | null>(null);

export function Meter() {
  const [freqHz, setFreqHz] = useState<number | null>(lastFreqHz.value);
  const tuneTo = (hz: number) => {
    lastFreqHz.value = hz;
    setFreqHz(hz);
  };
  if (freqHz === null) return <Setup onStart={tuneTo} />;
  return <Live key={freqHz} freqHz={freqHz} onTune={tuneTo} onEdit={() => setFreqHz(null)} />;
}

const mhzText = (hz: number) => (hz / 1e6).toFixed(hz % 1000 === 0 ? 3 : 4);

function Setup({ onStart }: { onStart: (hz: number) => void }) {
  const bands = bandsById(BAND_ORDER);
  const [band, setBand] = useState<Band>((lastFreqHz.value && bandOf(bands, lastFreqHz.value)) || bands[0]!);
  const [mhz, setMhz] = useState(lastFreqHz.value ? mhzText(lastFreqHz.value) : "");
  const [error, setError] = useState<string | null>(null);
  useDeviceView(bandView(band));
  const start = () => {
    const v = Number(mhz.replace(",", "."));
    if (mhz.trim() === "" || !Number.isFinite(v) || v < 0.1 || v > 1500) {
      setError("Enter the frequency you'll transmit on, in MHz, for example 14.074.");
      return;
    }
    onStart(Math.round(v * 1e6));
  };

  return (
    <>
      <div class="flow-head">
        <h2>SWR meter</h2>
        <button class="icon-btn" onClick={() => go({ name: "home" })}>
          Close
        </button>
      </div>
      <p class="muted">Live SWR at one frequency, for adjusting a tuner or matching network.</p>
      <p class="learn-links">
        <LearnLink topic="tuner">What a tuner does</LearnLink>
      </p>

      <h3 class="section-title">Band</h3>
      <div class="bands">
        {bands.map((b) => (
          <button key={b.id} class={`band${b.id === band.id ? " selected" : ""}`} aria-pressed={b.id === band.id} onClick={() => setBand(b)}>
            <strong>{b.name}</strong>
          </button>
        ))}
      </div>

      <h3 class="section-title">Tune to</h3>
      <Presets band={band} onPick={onStart} />

      <h3 class="section-title">Or enter a frequency</h3>
      <div class="freq-entry">
        <label class="field">
          <span>Frequency, MHz</span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="14.074"
            value={mhz}
            onInput={(e) => (setMhz((e.target as HTMLInputElement).value), setError(null))}
            onKeyDown={(e) => e.key === "Enter" && start()}
          />
        </label>
        <button class="btn primary" onClick={start}>
          Start
        </button>
      </div>
      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}

      <p class="muted small">
        Connect the NanoVNA where the radio plugs into the tuner. Never transmit into the NanoVNA.
      </p>
    </>
  );
}

/** One button per preset for the band, showing mode and dial frequency. */
function Presets({ band, current, onPick }: { band: Band; current?: number; onPick: (hz: number) => void }) {
  return (
    <div class="presets">
      {presetsFor(band).map((p) => (
        <button
          key={p.label}
          class={`preset${p.freqHz === current ? " selected" : ""}`}
          aria-pressed={p.freqHz === current}
          onClick={() => onPick(p.freqHz)}
        >
          <strong>{p.label}</strong>
          <span class="num">{mhzText(p.freqHz)}</span>
        </button>
      ))}
    </div>
  );
}

function Live({ freqHz, onTune, onEdit }: { freqHz: number; onTune: (hz: number) => void; onEdit: () => void }) {
  const session = useRef(new MeterSession(freqHz, () => calibration.value)).current;
  const [, bump] = useState(0);
  const [running, setRunning] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const ready = link.value === "open" && !!device.value?.connected;
  const sim = client.transport instanceof SimulatedTransport ? client.transport : null;
  const thresholds = settings.value.thresholds;
  const band = bandOf(bandsById(BAND_ORDER), freqHz);
  // The device redraws once readings pause; between back-to-back scans it holds still.
  useDeviceView(meterView(freqHz, band));

  useEffect(() => {
    if (!running) return;
    let stop = false;
    (async () => {
      while (!stop) {
        const t0 = Date.now();
        if (client.link !== "open" || !client.device?.connected || client.scanning) {
          await sleep(500);
          continue;
        }
        try {
          await session.measure(client);
          setError(null);
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code === "cancelled") break;
          if (!stop) setError((e as Error).message);
          await sleep(1000);
        }
        if (stop) break;
        bump((n) => n + 1);
        await sleep(Math.max(0, MIN_GAP_MS - (Date.now() - t0)));
      }
    })();
    return () => {
      stop = true;
      client.cancelScan();
    };
  }, [running]);

  const r = session.reading;
  const level = r ? swrLevel(r.swr, thresholds) : null;
  const rate = session.rate;

  return (
    <>
      <div class="flow-head">
        <h2>SWR meter</h2>
        <button class="icon-btn" onClick={onEdit}>
          Change
        </button>
        <button class="icon-btn" onClick={() => go({ name: "home" })}>
          Close
        </button>
      </div>
      <p class="muted num">
        {mhzText(freqHz)} MHz{band ? `, ${band.name}` : ""}
      </p>

      <section class={`meter-face ${level ?? ""}`} aria-live="off">
        <Needle reading={r} thresholds={thresholds} />
        <p class="meter-swr num" role="status" aria-label={r ? `SWR ${formatSwr(r.swr)}` : "Waiting for a reading"}>
          {r ? formatSwr(r.swr) : "–"}
        </p>
        <p class="meter-sub">
          {!ready ? "Waiting for the NanoVNA" : !r ? "Measuring…" : !running ? "Paused" : level === "good" ? "Good match" : level === "usable" ? "Usable" : "Keep adjusting"}
        </p>
      </section>

      <Trace history={session.history} thresholds={thresholds} />

      <div class="readings">
        <div class="reading static">
          <strong class="num">{session.best ? formatSwr(session.best.swr) : "–"}</strong>
          <span>best so far</span>
        </div>
        <div class="reading static">
          <strong class="num">{r ? formatZ(r) : "–"}</strong>
          <span>impedance, Ω</span>
        </div>
        <div class="reading static">
          <strong class="num">{r ? (Number.isFinite(r.returnLossDb) ? r.returnLossDb.toFixed(1) : "∞") : "–"}</strong>
          <span>return loss, dB</span>
        </div>
      </div>

      {error && (
        <div class="error" role="alert" style={{ marginTop: "12px" }}>
          <p>{error}</p>
        </div>
      )}

      <div class="actions">
        <button class="btn primary" disabled={!ready} onClick={() => setRunning((x) => !x)}>
          {running ? "Pause" : "Resume"}
        </button>
        <button class="btn" disabled={!r} onClick={() => (session.resetBest(), bump((n) => n + 1))}>
          Reset best
        </button>
      </div>

      {band && (
        <>
          <h3 class="section-title">Switch to</h3>
          <Presets band={band} current={freqHz} onPick={onTune} />
        </>
      )}

      {sim && <SimTuner sim={sim} freqHz={freqHz} />}

      <p class="muted small num">
        {rate ? `${rate.toFixed(1)} readings a second` : " "}
        {r && !r.calibrated && (
          <>
            {" · "}Uncalibrated.{" "}
            <button class="link-btn" onClick={() => go({ name: "calibrate" })}>
              Calibrate
            </button>
          </>
        )}
      </p>
      <p class="muted small">Never transmit into the NanoVNA. Reconnect the radio only after you finish tuning.</p>
    </>
  );
}

/** Analog-style meter: a half dial, linear in |Γ|, with the good and usable zones colored. */
function Needle({ reading, thresholds }: { reading: MeterReading | null; thresholds: SwrThresholds }) {
  const cx = 160;
  const cy = 164;
  const R = 128;
  const at = (f: number, rad = R) => {
    const a = Math.PI * (1 - f);
    return [cx + rad * Math.cos(a), cy - rad * Math.sin(a)] as const;
  };
  const arc = (f0: number, f1: number) => {
    const [x0, y0] = at(f0);
    const [x1, y1] = at(f1);
    return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${R} ${R} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  };
  const g = needleFraction(thresholds.good);
  const u = needleFraction(thresholds.usable);
  const f = reading ? needleFraction(reading.swr) : 0;
  const ticks: [number, string][] = [
    [1, "1"],
    [1.5, "1.5"],
    [2, "2"],
    [3, "3"],
    [5, "5"],
    [Number.POSITIVE_INFINITY, "∞"],
  ];
  return (
    <svg class="needle" viewBox="0 0 320 186" aria-hidden="true">
      <path d={arc(0, g)} stroke="var(--good)" stroke-width="12" fill="none" />
      <path d={arc(g, u)} stroke="var(--usable)" stroke-width="12" fill="none" />
      <path d={arc(u, 1)} stroke="var(--poor)" stroke-width="12" fill="none" />
      {ticks.map(([s, label]) => {
        const tf = needleFraction(s);
        const [x0, y0] = at(tf, R - 8);
        const [x1, y1] = at(tf, R + 8);
        const [lx, ly] = at(tf, R + 20);
        return (
          <g key={label}>
            <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="var(--ink)" stroke-width="2" />
            <text x={lx} y={ly + 4} text-anchor="middle" font-size="13" fill="var(--muted)" class="num">
              {label}
            </text>
          </g>
        );
      })}
      {reading && (
        <line
          class="needle-hand"
          x1={cx}
          y1={cy}
          x2={cx - (R - 14)}
          y2={cy}
          style={{ transform: `rotate(${(f * 180).toFixed(1)}deg)`, transformOrigin: `${cx}px ${cy}px` }}
          stroke="var(--ink)"
          stroke-width="4"
          stroke-linecap="round"
        />
      )}
      <circle cx={cx} cy={cy} r="7" fill="var(--ink)" />
    </svg>
  );
}

/** The last readings as a strip, same scale as the needle, so you can see which way a knob helped. */
function Trace({ history, thresholds }: { history: readonly MeterReading[]; thresholds: SwrThresholds }) {
  if (history.length < 2) return null;
  const W = 340;
  const H = 64;
  const n = history.length;
  const y = (s: number) => H - 6 - needleFraction(Math.min(s, 20)) * (H - 12);
  const pts = history.map((r, i) => `${((i / (n - 1)) * W).toFixed(1)},${y(r.swr).toFixed(1)}`).join(" ");
  const yg = y(thresholds.good);
  return (
    <div class="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Recent SWR readings, lower is better">
        <line x1="0" x2={W} y1={yg} y2={yg} stroke="var(--good)" stroke-width="1.5" stroke-dasharray="4 4" />
        <polyline points={pts} fill="none" stroke="var(--trace)" stroke-width="2.5" stroke-linejoin="round" />
      </svg>
    </div>
  );
}

export function swrLevel(s: number, t: SwrThresholds): "good" | "usable" | "poor" {
  return s <= t.good ? "good" : s <= t.usable ? "usable" : "poor";
}

const formatSwr = (s: number) => (!Number.isFinite(s) || s >= 100 ? "∞" : s >= 10 ? s.toFixed(0) : s.toFixed(2));

const formatZ = (r: MeterReading) => {
  const { re, im } = r.z;
  if (!Number.isFinite(re) || Math.abs(re) > 9999) return "open";
  return `${re.toFixed(0)}${im < 0 ? "−" : "+"}j${Math.abs(im).toFixed(0)}`;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Simulator only: one knob that walks the pretend antenna through a match at your frequency. */
function SimTuner({ sim, freqHz }: { sim: SimulatedTransport; freqHz: number }) {
  const [knob, setKnob] = useState(70);
  useEffect(() => {
    sim.configure({ antenna: { f0Hz: freqHz * (1 + knob / 1000), r: 50 + Math.abs(knob) / 2, q: 6 }, standard: null, coax: null });
  }, [knob, freqHz]);
  useEffect(() => () => sim.configure({ antenna: null }), []);
  return (
    <label class="field">
      <span>Simulator: pretend tuner knob</span>
      <input type="range" min="-100" max="100" value={knob} onInput={(e) => setKnob(Number((e.target as HTMLInputElement).value))} />
    </label>
  );
}
