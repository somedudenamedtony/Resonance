import { useEffect, useRef, useState } from "preact/hooks";
import type { StandardKind } from "@resonance/analysis";
import { SimulatedTransport } from "../bridge/simulator";
import { CAL_STEPS, CalibrationSession, saveForm } from "../cal";
import { client, device, go, isSimulator, link, saveCalibration } from "../state";
import { LearnLink } from "./Learn";

const STEP_TEXT: Record<StandardKind, { title: string; how: string }> = {
  open: { title: "Open", how: "Screw the OPEN standard onto port 1 (CH0). If your kit has no open, leave the port empty." },
  short: { title: "Short", how: "Screw the SHORT standard onto port 1 (CH0)." },
  load: { title: "Load", how: "Screw the 50 Ω LOAD standard onto port 1 (CH0)." },
};

type Phase =
  | { kind: "ready" }
  | { kind: "measuring"; pct: number }
  | { kind: "wrong"; hint: string }
  | { kind: "error"; message: string }
  | { kind: "saved" };

export function Calibrate() {
  const session = useRef(new CalibrationSession()).current;
  const [step, setStep] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "ready" });
  const ready = link.value === "open" && !!device.value?.connected;
  const sim = client.transport instanceof SimulatedTransport ? client.transport : null;

  useEffect(
    () => () => {
      client.cancelScan();
      sim?.configure({ standard: null });
    },
    [],
  );

  const kind = CAL_STEPS[Math.min(step, CAL_STEPS.length - 1)]!;

  async function measure() {
    setPhase({ kind: "measuring", pct: 0 });
    sim?.configure({ standard: kind }); // the simulator "attaches" the standard for you
    try {
      const check = await session.measure(client, kind, (p) =>
        setPhase({ kind: "measuring", pct: Math.round((p.received / p.total) * 100) }),
      );
      if (!check.ok) {
        setPhase({ kind: "wrong", hint: check.hint ?? "That doesn't look like the right standard." });
        return;
      }
      if (session.done) {
        await saveCalibration(saveForm(session.finish(), device.value));
        sim?.configure({ standard: null });
        setStep(CAL_STEPS.length);
        setPhase({ kind: "saved" });
      } else {
        setStep(session.step);
        setPhase({ kind: "ready" });
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      setPhase(code === "cancelled" ? { kind: "ready" } : { kind: "error", message: (e as Error).message });
    }
  }

  const close = () => {
    client.cancelScan();
    go({ name: "home" });
  };

  return (
    <>
      <div class="flow-head">
        <h2>Calibrate</h2>
        <button class="icon-btn" onClick={close}>
          Close
        </button>
      </div>

      <p class="learn-links">
        <LearnLink topic="calibration">Why calibrate?</LearnLink>
      </p>
      <ol class="steps" aria-label="Calibration steps">
        {CAL_STEPS.map((k, i) => (
          <li key={k} class={i < step ? "done" : i === step ? "current" : ""} aria-current={i === step ? "step" : undefined}>
            <span class="step-dot" aria-hidden="true">
              {i < step ? "✓" : i + 1}
            </span>
            {STEP_TEXT[k].title}
          </li>
        ))}
      </ol>

      {phase.kind === "saved" ? (
        <div class="verdict good">
          <span class="level">
            <span aria-hidden="true">✓</span> Calibrated
          </span>
          <h1>Ready for accurate checks</h1>
          <p class="detail">Covers 50 kHz to 60 MHz (HF and 6m). Recalibrate after 7 days or if you change cables.</p>
          <div class="actions">
            <button class="btn primary" onClick={() => go({ name: "check" })}>
              Check my antenna
            </button>
            <button class="btn" onClick={() => go({ name: "home" })}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <>
          <div class="cal-card">
            <StandardPicture kind={kind} />
            <div>
              <h1 class="cal-title">Attach the {STEP_TEXT[kind].title.toLowerCase()}</h1>
              <p class="muted">{STEP_TEXT[kind].how}</p>
              {isSimulator && <p class="muted small">Simulator: it attaches the standard for you.</p>}
            </div>
          </div>

          {phase.kind === "wrong" && (
            <div class="error" role="alert">
              <p>{phase.hint}</p>
            </div>
          )}
          {phase.kind === "error" && (
            <div class="error" role="alert">
              <p>{phase.message}</p>
            </div>
          )}
          {!ready && (
            <div class="error" role="alert">
              <p>The NanoVNA isn't ready. Check the connection.</p>
            </div>
          )}

          <div class="actions single">
            {phase.kind === "measuring" ? (
              <button class="btn" onClick={() => client.cancelScan()}>
                Measuring {phase.pct}%, tap to cancel
              </button>
            ) : (
              <button class="btn primary big" disabled={!ready} onClick={measure}>
                {phase.kind === "wrong" || phase.kind === "error" ? "Measure again" : `Measure ${STEP_TEXT[kind].title.toLowerCase()}`}
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}

/** Port 1 with the standard attached: open = bare connector, short = shorted cap, load = resistor. */
function StandardPicture({ kind }: { kind: StandardKind }) {
  return (
    <svg viewBox="0 0 96 96" width="96" height="96" role="img" aria-label={`Port 1 with the ${kind} standard`} class="cal-pic">
      <rect x="8" y="34" width="34" height="28" rx="4" fill="none" stroke="var(--muted)" stroke-width="2" />
      <text x="25" y="52" text-anchor="middle" font-size="11" fill="var(--muted)">CH0</text>
      <rect x="42" y="40" width="14" height="16" fill="none" stroke="var(--ink)" stroke-width="2" />
      {kind === "open" && <rect x="56" y="38" width="20" height="20" rx="3" fill="none" stroke="var(--trace)" stroke-width="2.5" />}
      {kind === "short" && (
        <g>
          <rect x="56" y="38" width="20" height="20" rx="3" fill="var(--trace)" />
          <line x1="60" y1="48" x2="72" y2="48" stroke="var(--surface)" stroke-width="2.5" />
        </g>
      )}
      {kind === "load" && (
        <g>
          <rect x="56" y="38" width="20" height="20" rx="3" fill="none" stroke="var(--trace)" stroke-width="2.5" />
          <path d="M59 48 l2 -4 l3 8 l3 -8 l3 8 l3 -8 l2 4" fill="none" stroke="var(--trace)" stroke-width="1.8" />
        </g>
      )}
      <text x="66" y="76" text-anchor="middle" font-size="11" font-weight="600" fill="var(--trace)">
        {kind === "load" ? "50 Ω" : kind.toUpperCase()}
      </text>
    </svg>
  );
}
