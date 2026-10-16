import { useEffect, useRef, useState } from "preact/hooks";
import { type AntennaType, type Band } from "@resonance/analysis";
import { SimulatedTransport } from "../bridge/simulator";
import { BAND_ORDER, bandsById } from "../check";
import { formatLength, parseLength } from "../history";
import { calibration, client, device, go, isSimulator, link, settings } from "../state";
import { defaultSetup, type TuneReading, TuneSession, type TuneSetup } from "../tune";

const TYPES: { id: AntennaType; label: string; element: string }[] = [
  { id: "dipole", label: "Dipole", element: "each leg" },
  { id: "efhw", label: "End-fed", element: "the wire" },
  { id: "vertical", label: "Vertical", element: "the radiator" },
  { id: "mobile", label: "Mobile", element: "the whip" },
  { id: "other", label: "Other", element: "the element" },
];

const LIVE_INTERVAL_MS = 2000;

export function Tune() {
  const [setup, setSetup] = useState<TuneSetup | null>(null);
  return setup ? <Coach setup={setup} onEdit={() => setSetup(null)} /> : <Setup onStart={setSetup} />;
}

function Setup({ onStart }: { onStart: (s: TuneSetup) => void }) {
  const bands = bandsById(BAND_ORDER).filter((b) => b.id !== "2m");
  const [band, setBand] = useState<Band>(bands[0]!);
  const [type, setType] = useState<AntennaType>("dipole");
  const [target, setTarget] = useState(((band.startHz + band.stopHz) / 2e6).toFixed(3));
  const [length, setLength] = useState("");
  const [error, setError] = useState<string | null>(null);
  const element = TYPES.find((t) => t.id === type)!.element;
  const unitWord = settings.value.units === "imperial" ? "feet" : "meters";

  const pickBand = (b: Band) => {
    setBand(b);
    setTarget(((b.startHz + b.stopHz) / 2e6).toFixed(3));
    setError(null);
  };

  const start = () => {
    const mhz = Number(target);
    if (!Number.isFinite(mhz) || mhz * 1e6 < band.startHz * 0.9 || mhz * 1e6 > band.stopHz * 1.1) {
      setError(`Enter a target near ${band.name}, between ${(band.startHz / 1e6).toFixed(3)} and ${(band.stopHz / 1e6).toFixed(3)} MHz.`);
      return;
    }
    const len = parseLength(length, settings.value.units);
    if (length.trim() !== "" && (len === undefined || len <= 0 || len > 200)) {
      setError(`Enter the length in ${unitWord}, or leave it blank to estimate it.`);
      return;
    }
    onStart({ ...defaultSetup(band, type), targetHz: Math.round(mhz * 1e6), elementLengthM: len });
  };

  return (
    <>
      <div class="flow-head">
        <h2>Tune my antenna</h2>
        <button class="icon-btn" onClick={() => go({ name: "home" })}>
          Close
        </button>
      </div>

      <h3 class="section-title first">Band</h3>
      <div class="bands">
        {bands.map((b) => (
          <button key={b.id} class={`band${b.id === band.id ? " selected" : ""}`} aria-pressed={b.id === band.id} onClick={() => pickBand(b)}>
            <strong>{b.name}</strong>
          </button>
        ))}
      </div>

      <h3 class="section-title">Antenna</h3>
      <div class="segmented" role="radiogroup" aria-label="Antenna type">
        {TYPES.map((t) => (
          <button key={t.id} role="radio" aria-checked={t.id === type} class={t.id === type ? "on" : ""} onClick={() => setType(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <label class="field">
        <span>Target frequency, MHz</span>
        <input type="text" inputMode="decimal" value={target} onInput={(e) => (setTarget((e.target as HTMLInputElement).value), setError(null))} />
      </label>
      <label class="field">
        <span>
          Length of {element} now, {unitWord} (optional)
        </span>
        <input
          type="text"
          inputMode="decimal"
          placeholder="Leave blank to estimate"
          value={length}
          onInput={(e) => (setLength((e.target as HTMLInputElement).value), setError(null))}
        />
      </label>
      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}

      <div class="actions single">
        <button class="btn primary big" onClick={start}>
          Start tuning
        </button>
      </div>
    </>
  );
}

function Coach({ setup, onEdit }: { setup: TuneSetup; onEdit: () => void }) {
  const session = useRef(new TuneSession(setup, () => calibration.value)).current;
  const [, bump] = useState(0);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = link.value === "open" && !!device.value?.connected;
  const sim = client.transport instanceof SimulatedTransport ? client.transport : null;
  const mounted = useRef(true);

  async function sweep() {
    if (client.scanning) return;
    setBusy(true);
    try {
      await session.sweep(client);
      setError(null);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "cancelled") setError((e as Error).message);
    } finally {
      if (mounted.current) {
        setBusy(false);
        bump((n) => n + 1);
      }
    }
  }

  useEffect(() => {
    mounted.current = true;
    void sweep();
    return () => {
      mounted.current = false;
      client.cancelScan();
    };
  }, []);

  // Live mode: keep sweeping every couple of seconds while the user cuts.
  useEffect(() => {
    if (!live) return;
    let stop = false;
    (async () => {
      while (!stop && mounted.current) {
        const t0 = Date.now();
        await sweep();
        await new Promise((r) => setTimeout(r, Math.max(200, LIVE_INTERVAL_MS - (Date.now() - t0))));
      }
    })();
    return () => {
      stop = true;
    };
  }, [live]);

  const madeTheCut = async () => {
    const delta = session.madeTheCut();
    sim?.trim(delta, setup.type); // the simulator applies your cut
    bump((n) => n + 1);
    if (!live) await sweep();
  };

  const r = session.reading;
  const mhz = (hz: number) => (hz / 1e6).toFixed(3);
  const typeLabel = TYPES.find((t) => t.id === setup.type)!.label.toLowerCase();

  return (
    <>
      <div class="flow-head">
        <h2>Tune</h2>
        <button class="icon-btn" onClick={onEdit}>
          Setup
        </button>
        <button class="icon-btn" onClick={() => go({ name: "home" })}>
          Close
        </button>
      </div>
      <p class="muted">
        {setup.band.name} {typeLabel}, target {mhz(setup.targetHz)} MHz
      </p>

      {!r ? (
        <div class="coach">
          <p class="muted">{error ?? (busy ? "Sweeping…" : "Waiting for the NanoVNA")}</p>
        </div>
      ) : (
        <>
          <Instruction reading={r} setupType={setup.type} />
          <TuneScale reading={r} targetHz={setup.targetHz} />
          <div class="readings">
            <div class="reading static">
              <strong class="num">{r.bound === "exact" ? mhz(r.resonanceHz) : r.bound === "below" ? `<${mhz(r.resonanceHz)}` : `>${mhz(r.resonanceHz)}`}</strong>
              <span>resonant, MHz</span>
            </div>
            <div class="reading static">
              <strong class="num">{r.swrAtTarget > 10 ? ">10" : r.swrAtTarget.toFixed(2)}</strong>
              <span>SWR at target</span>
            </div>
            <div class="reading static">
              <strong class="num">{r.minSwr > 10 ? ">10" : r.minSwr.toFixed(2)}</strong>
              <span>lowest SWR</span>
            </div>
          </div>
        </>
      )}

      {error && r && (
        <div class="error" role="alert" style={{ marginTop: "12px" }}>
          <p>{error}</p>
        </div>
      )}

      <label class="toggle">
        <input type="checkbox" checked={live} onChange={(e) => setLive((e.target as HTMLInputElement).checked)} disabled={!ready} />
        Live re-sweep every 2 seconds
      </label>

      <div class="actions">
        {session.done ? (
          <button class="btn primary" onClick={() => go({ name: "home" })}>
            Finish
          </button>
        ) : (
          <button class="btn primary" disabled={!ready || !r || busy} onClick={madeTheCut}>
            I made the {r?.instruction.action === "lengthen" ? "change" : "cut"}
          </button>
        )}
        <button class="btn" disabled={!ready || busy || live} onClick={sweep}>
          {busy ? "Sweeping…" : "Sweep again"}
        </button>
      </div>

      {isSimulator && <p class="muted small">Simulator: it applies your cuts to the pretend antenna.</p>}
      {session.lengthIsEstimate && r && !session.done && (
        <p class="muted small">
          Cut sizes assume about {formatLength(session.elementLengthM, settings.value.units)} for {TYPES.find((t) => t.id === setup.type)!.element}. Enter
          the real length in Setup for a more accurate first cut.
        </p>
      )}
      {r && !r.calibrated && (
        <p class="muted small">
          Uncalibrated.{" "}
          <button class="link-btn" onClick={() => go({ name: "calibrate" })}>
            Calibrate
          </button>{" "}
          for accurate resonance.
        </p>
      )}

      {session.log.length > 0 && (
        <>
          <h3 class="section-title">Cut log</h3>
          <ol class="cut-log">
            {session.log.map((e) => (
              <li key={e.n}>
                {e.action === "shorten" ? "Shortened" : "Lengthened"} {formatLength(e.amountM, settings.value.units)}
                <span class="muted num">{e.resultHz === null ? ", measuring…" : `, now ${mhz(e.resultHz)} MHz`}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </>
  );
}

function Instruction({ reading, setupType }: { reading: TuneReading; setupType: AntennaType }) {
  const i = reading.instruction;
  if (i.action === "done") {
    return (
      <section class="coach done" aria-live="polite">
        <p class="coach-verb">Done</p>
        <p class="coach-sub num">
          Resonant at {(reading.resonanceHz / 1e6).toFixed(3)} MHz, SWR {reading.swrAtTarget.toFixed(2)}
        </p>
      </section>
    );
  }
  const where = TYPES.find((t) => t.id === setupType)?.element ?? "the element";
  const verb = `${i.action === "shorten" ? "Shorten" : "Lengthen"} ${where}`;
  return (
    <section class="coach" aria-live="polite">
      <p class="coach-verb">{verb}</p>
      <p class="coach-amount num">
        {formatLength(i.amountM, settings.value.units)}
        {reading.bound !== "exact" && <span class="coach-more"> or more</span>}
      </p>
      {reading.trend && (
        <p class={`coach-trend ${reading.trend}`}>
          {reading.trend === "closer" ? "Getting closer" : reading.trend === "further" ? "Moved away from target" : "No change since last sweep"}
        </p>
      )}
    </section>
  );
}

/** Slim scale: target in the middle, resonance marker within ±5%. */
function TuneScale({ reading, targetHz }: { reading: TuneReading; targetHz: number }) {
  const W = 340;
  const span = 0.05;
  const x = (hz: number) => {
    const rel = Math.max(-span, Math.min(span, (hz - targetHz) / targetHz));
    return 20 + ((rel + span) / (2 * span)) * (W - 40);
  };
  const xr = x(reading.resonanceHz);
  const label = `Now ${(reading.resonanceHz / 1e6).toFixed(3)}`;
  return (
    <div class="chart scale">
      <svg viewBox={`0 0 ${W} 74`} role="img" aria-label={`Resonance ${label} megahertz, target ${(targetHz / 1e6).toFixed(3)}`}>
        <line x1="20" x2={W - 20} y1="34" y2="34" stroke="var(--rule)" stroke-width="3" stroke-linecap="round" />
        <line x1={W / 2} x2={W / 2} y1="20" y2="48" stroke="var(--trace)" stroke-width="3" />
        <text x={W / 2} y="14" text-anchor="middle" font-size="12" fill="var(--muted)">
          Target
        </text>
        <path d={`M${xr} 25 L${xr + 9} 34 L${xr} 43 L${xr - 9} 34 Z`} fill="var(--ink)" />
        <text x={Math.max(50, Math.min(W - 50, xr))} y="66" text-anchor="middle" font-size="12" fill="var(--ink)" class="num">
          {label}
        </text>
        <text x="20" y="14" font-size="11" fill="var(--muted)">
          too long
        </text>
        <text x={W - 20} y="14" text-anchor="end" font-size="11" fill="var(--muted)">
          too short
        </text>
      </svg>
    </div>
  );
}
