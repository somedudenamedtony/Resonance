import { useEffect, useState } from "preact/hooks";
import {
  analyzeCoax,
  type CoaxAnalysis,
  COAX_TYPES,
  findCoaxType,
  OPEN_END,
  rlcGamma,
  typicalLossDb,
} from "@resonance/analysis";
import { SimulatedTransport } from "../bridge/simulator";
import { applyCalibration, CAL_RANGE } from "../cal";
import { calibration, client, device, go, isSimulator, link, settings } from "../state";

type FarEnd = "open" | "connected";

/** Cable distances: 0.1 m or whole feet. */
const dist = (m: number, units: "metric" | "imperial") =>
  units === "imperial" ? `${Math.round(m / 0.3048)} ft` : `${m.toFixed(1)} m`;

interface Setup {
  typeId: string; // a COAX_TYPES id or "custom"
  vf: number;
  farEnd: FarEnd;
  lossAtMHz: number;
}

type Phase =
  | { kind: "setup" }
  | { kind: "measuring"; pct: number }
  | { kind: "result"; analysis: CoaxAnalysis; calibrated: boolean }
  | { kind: "error"; message: string };

export function Coax() {
  const [setup, setSetup] = useState<Setup>({ typeId: "rg8x", vf: 0.78, farEnd: "open", lossAtMHz: 14.2 });
  const [phase, setPhase] = useState<Phase>({ kind: "setup" });
  const [vfText, setVfText] = useState("0.78");
  const [lossText, setLossText] = useState("14.2");
  const [error, setError] = useState<string | null>(null);
  const ready = link.value === "open" && !!device.value?.connected;
  const sim = client.transport instanceof SimulatedTransport ? client.transport : null;
  const units = settings.value.units;

  useEffect(
    () => () => {
      client.cancelScan();
      sim?.configure({ coax: null });
    },
    [],
  );

  const measure = async () => {
    const vf = setup.typeId === "custom" ? Number(vfText) : findCoaxType(setup.typeId)!.velocityFactor;
    const lossAtMHz = Number(lossText);
    if (!(vf > 0.3 && vf <= 1)) return setError("Velocity factor is between 0.3 and 1 (check the cable's datasheet).");
    if (setup.farEnd === "open" && !(lossAtMHz >= 0.1 && lossAtMHz <= 60)) return setError("Pick a frequency between 0.1 and 60 MHz.");
    setError(null);
    setSetup({ ...setup, vf, lossAtMHz });

    if (sim) {
      // The simulator pretends to have 18.3 m of the chosen cable with a kink at 12.2 m.
      const t = findCoaxType(setup.typeId) ?? findCoaxType("rg8x")!;
      sim.configure({
        coax: {
          lengthM: 18.3,
          velocityFactor: vf,
          lossDbPer100mAt10MHz: t.lossDbPer100mAt10MHz,
          end: setup.farEnd === "open" ? OPEN_END : (f) => rlcGamma(sim.antenna, f),
          faults: [{ atM: 12.2, gamma: 0.12 }],
        },
      });
    }
    setPhase({ kind: "measuring", pct: 0 });
    try {
      const raw = await client.scan({ ...CAL_RANGE }, (p) => setPhase({ kind: "measuring", pct: Math.round((p.received / p.total) * 100) }), 30_000);
      const { sweep, calibrated } = applyCalibration(calibration.value, raw);
      const analysis = analyzeCoax(sweep, vf, { farEnd: setup.farEnd, lossAtHz: lossAtMHz * 1e6 });
      setPhase({ kind: "result", analysis, calibrated });
    } catch (e) {
      const code = (e as { code?: string }).code;
      setPhase(code === "cancelled" ? { kind: "setup" } : { kind: "error", message: (e as Error).message });
    }
  };

  return (
    <>
      <div class="flow-head">
        <h2>Test my coax</h2>
        <button
          class="icon-btn"
          onClick={() => {
            client.cancelScan();
            go({ name: "home" });
          }}
        >
          Close
        </button>
      </div>

      {(phase.kind === "setup" || phase.kind === "error") && (
        <>
          <label class="field compact">
            <span>Cable type</span>
            <select value={setup.typeId} onChange={(e) => setSetup({ ...setup, typeId: (e.target as HTMLSelectElement).value })}>
              {COAX_TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} (velocity factor {t.velocityFactor})
                </option>
              ))}
              <option value="custom">Other: enter velocity factor</option>
            </select>
          </label>
          {setup.typeId === "custom" && (
            <label class="field">
              <span>Velocity factor</span>
              <input type="text" inputMode="decimal" value={vfText} onInput={(e) => setVfText((e.target as HTMLInputElement).value)} />
            </label>
          )}

          <h3 class="section-title">What's on the far end?</h3>
          <div class="segmented" role="radiogroup" aria-label="Far end">
            {(
              [
                ["open", "Nothing (open)"],
                ["connected", "The antenna"],
              ] as [FarEnd, string][]
            ).map(([v, label]) => (
              <button key={v} role="radio" aria-checked={setup.farEnd === v} class={setup.farEnd === v ? "on" : ""} onClick={() => setSetup({ ...setup, farEnd: v })}>
                {label}
              </button>
            ))}
          </div>
          <p class="muted small">
            {setup.farEnd === "open"
              ? "Leave the far end unconnected. You'll get length, loss and any faults."
              : "Length and faults only. Disconnect the antenna to measure loss."}
          </p>

          {setup.farEnd === "open" && (
            <label class="field">
              <span>Loss at, MHz</span>
              <input type="text" inputMode="decimal" value={lossText} onInput={(e) => setLossText((e.target as HTMLInputElement).value)} />
            </label>
          )}

          {error && (
            <p class="field-error" role="alert">
              {error}
            </p>
          )}
          {phase.kind === "error" && (
            <div class="error" role="alert" style={{ marginTop: "12px" }}>
              <p>{phase.message}</p>
            </div>
          )}
          {isSimulator && <p class="muted small">Simulator: pretends to have 18.3 m of this cable with a kink at 12.2 m.</p>}
          <div class="actions single">
            <button class="btn primary big" disabled={!ready} onClick={measure}>
              Test cable
            </button>
          </div>
        </>
      )}

      {phase.kind === "measuring" && (
        <div class="coach">
          <p class="coach-verb">Measuring the cable</p>
          <p class="coach-sub num">{phase.pct}%</p>
          <div class="actions single">
            <button class="btn" onClick={() => client.cancelScan()}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {phase.kind === "result" && (
        <CoaxResult analysis={phase.analysis} calibrated={phase.calibrated} setup={setup} units={units} onAgain={() => setPhase({ kind: "setup" })} />
      )}
    </>
  );
}

function CoaxResult(props: { analysis: CoaxAnalysis; calibrated: boolean; setup: Setup; units: "metric" | "imperial"; onAgain: () => void }) {
  const { analysis: a, setup, units } = props;
  const type = findCoaxType(setup.typeId);
  const len = a.lengthM;
  const typical = type && len !== null ? typicalLossDb(type, len, a.lossAtHz) : null;
  const lossHigh = a.lossDb !== null && typical !== null && a.lossDb > typical * 1.5 + 0.2;
  const healthy = a.faults.length === 0 && !lossHigh;
  return (
    <>
      <section class={`verdict ${len === null ? "poor" : healthy ? "good" : "usable"}`} aria-live="polite">
        <span class="level">{len === null ? "No reading" : healthy ? "Looks healthy" : "Check this cable"}</span>
        <h1 class="num">{len !== null ? `${dist(len, units)}${type ? ` of ${type.name}` : ""}` : "Couldn't find the far end"}</h1>
        {a.lossDb !== null && (
          <p class="detail num">
            Loss {a.lossDb.toFixed(1)} dB at {(a.lossAtHz / 1e6).toFixed(1)} MHz
            {typical !== null && `, typical ${typical.toFixed(1)} dB`}
          </p>
        )}
        {lossHigh && <p class="cause">Loss is higher than typical for this cable. Look for water in the line or a bad connector.</p>}
        {a.faults.map((f) => (
          <p class="cause" key={f.distanceM}>
            Possible fault {dist(f.distanceM, units)} from the NanoVNA ({Math.round(f.reflection * 100)}% reflection). Check for a kink,
            crushed spot or splice there.
          </p>
        ))}
        {len === null && <p class="cause">Make sure the cable is on port 1 and the velocity factor is right.</p>}
        {!props.calibrated && (
          <p class="uncal">
            <span class="badge">Uncalibrated</span>
            <span class="muted small">Length is close; loss needs calibration.</span>
          </p>
        )}
      </section>
      <div class="chart">
        <TdrChart analysis={a} units={units} />
      </div>
      <p class="muted small">
        Reflections along the cable. Features closer together than {dist(a.tdr.resolutionM, units)} blur into one.
        {a.method === "quarter-wave" ? " Length refined from the quarter-wave frequency." : ""}
      </p>
      <div class="actions single">
        <button class="btn" onClick={props.onAgain}>
          Test another cable
        </button>
      </div>
    </>
  );
}

function TdrChart({ analysis: a, units }: { analysis: CoaxAnalysis; units: "metric" | "imperial" }) {
  const W = 360;
  const H = 180;
  const P = { l: 34, r: 12, t: 14, b: 30 };
  const far = a.farEnd?.distanceM ?? 30;
  const maxD = Math.max(5, far * 1.3);
  const maxR = Math.max(0.3, ...a.tdr.reflection.filter((_, i) => a.tdr.distanceM[i]! <= maxD).slice(1)) * 1.1;
  const x = (d: number) => P.l + (d / maxD) * (W - P.l - P.r);
  const y = (r: number) => P.t + (1 - Math.min(r, maxR) / maxR) * (H - P.t - P.b);
  let path = "";
  a.tdr.distanceM.forEach((d, i) => {
    if (d > maxD) return;
    path += `${path ? "L" : "M"}${x(d).toFixed(1)} ${y(a.tdr.reflection[i]!).toFixed(1)}`;
  });
  const ticks = [0, maxD / 2, maxD];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Reflection versus distance along the cable">
      <line x1={P.l} x2={W - P.r} y1={y(0)} y2={y(0)} stroke="var(--rule)" />
      {ticks.map((d) => (
        <text key={d} x={x(d)} y={H - 10} text-anchor={d === 0 ? "start" : d === maxD ? "end" : "middle"} font-size="11" fill="var(--muted)" class="num">
          {dist(d, units)}
        </text>
      ))}
      <path d={path} fill="none" stroke="var(--trace)" stroke-width="2" stroke-linejoin="round" />
      {a.farEnd && (
        <g>
          <line x1={x(a.farEnd.distanceM)} x2={x(a.farEnd.distanceM)} y1={P.t} y2={y(0)} stroke="var(--muted)" stroke-dasharray="3 3" />
          <text x={x(a.farEnd.distanceM) - 4} y={P.t + 10} text-anchor="end" font-size="12" fill="var(--ink)">
            far end
          </text>
        </g>
      )}
      {a.faults.map((f) => (
        <g key={f.distanceM}>
          <circle cx={x(f.distanceM)} cy={y(f.reflection)} r="5" fill="var(--poor)" />
          <text x={x(f.distanceM)} y={y(f.reflection) - 10} text-anchor="middle" font-size="12" font-weight="600" fill="var(--poor)">
            fault?
          </text>
        </g>
      ))}
    </svg>
  );
}
