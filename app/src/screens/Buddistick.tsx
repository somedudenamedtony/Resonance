import { useEffect, useRef, useState } from "preact/hooks";
import type { Band } from "@resonance/analysis";
import { SimulatedTransport } from "../bridge/simulator";
import { bandsById } from "../check";
import {
  type Advice,
  BAND_STARTS,
  BUDDI_BANDS,
  BuddiSession,
  type BuddiSetup,
  buddiSetup,
  quarterWaveM,
  savedId,
  type SavedBuddiSettings,
  simApply,
} from "../buddistick";
import { formatLength } from "../history";
import { bandView, tuneView } from "../mirror";
import { presetsFor } from "../meter";
import { useDeviceView } from "../useDeviceView";
import { calibration, client, device, go, isSimulator, link, settings, store } from "../state";
import { TuneScale } from "./Tune";

const LIVE_INTERVAL_MS = 2000;
const mhz = (hz: number) => (hz / 1e6).toFixed(3);

export function Buddistick() {
  const [setup, setSetup] = useState<BuddiSetup | null>(null);
  return setup ? <Coach setup={setup} onEdit={() => setSetup(null)} /> : <Setup onStart={setSetup} />;
}

function useSaved(bandId: string): [SavedBuddiSettings | null, (s: SavedBuddiSettings) => Promise<void>] {
  const [saved, setSaved] = useState<SavedBuddiSettings | null>(null);
  useEffect(() => {
    let live = true;
    setSaved(null);
    void store.get<SavedBuddiSettings>("kv", savedId(bandId)).then((s) => live && setSaved(s ?? null));
    return () => {
      live = false;
    };
  }, [bandId]);
  const save = async (s: SavedBuddiSettings) => {
    await store.put("kv", s);
    setSaved(s);
  };
  return [saved, save];
}

function Setup({ onStart }: { onStart: (s: BuddiSetup) => void }) {
  const bands = bandsById([...BUDDI_BANDS]);
  const [band, setBand] = useState<Band>(bands.find((b) => b.id === "20m")!);
  const presets = presetsFor(band);
  const [targetHz, setTargetHz] = useState(presets[0]!.freqHz);
  const [saved] = useSaved(band.id);
  const start = BAND_STARTS[band.id as keyof typeof BAND_STARTS];
  const units = settings.value.units;
  useDeviceView(bandView(band));

  const pickBand = (b: Band) => {
    setBand(b);
    setTargetHz(presetsFor(b)[0]!.freqHz);
  };

  return (
    <>
      <div class="flow-head">
        <h2>Buddistick</h2>
        <button class="icon-btn" onClick={() => go({ name: "home" })}>
          Close
        </button>
      </div>
      <p class="muted">Step by step: coil tap, then whip, then radial. Uses the live SWR after each change.</p>

      <h3 class="section-title">Band</h3>
      <div class="bands">
        {bands.map((b) => (
          <button key={b.id} class={`band${b.id === band.id ? " selected" : ""}`} aria-pressed={b.id === band.id} onClick={() => pickBand(b)}>
            <strong>{b.name}</strong>
          </button>
        ))}
      </div>

      <h3 class="section-title">Frequency</h3>
      <div class="presets">
        {presets.map((p) => (
          <button
            key={p.label}
            class={`preset${p.freqHz === targetHz ? " selected" : ""}`}
            aria-pressed={p.freqHz === targetHz}
            onClick={() => setTargetHz(p.freqHz)}
          >
            <strong>{p.label}</strong>
            <span class="num">{mhz(p.freqHz)}</span>
          </button>
        ))}
      </div>

      <h3 class="section-title">Set it up like this</h3>
      {saved ? (
        <div class="buddi-start from-saved">
          <p class="buddi-start-head">
            What worked last time, <span class="num">{mhz(saved.resonanceHz)} MHz, SWR {saved.swr.toFixed(2)}</span>
          </p>
          <StartRow label="Coil" value={saved.coil || start.coil} />
          <StartRow label="Whip" value={saved.whip || start.whip} />
          <StartRow label="Radial" value={saved.radial || formatLength(quarterWaveM(targetHz), units)} />
        </div>
      ) : (
        <div class="buddi-start">
          <StartRow label="Coil" value={start.coil} />
          <StartRow label="Whip" value={start.whip} />
          <StartRow label="Radial" value={`About ${formatLength(quarterWaveM(targetHz), units)}, a quarter wave`} />
          <StartRow label="Slope" value="Far end of the radial 2 to 4 ft up, never under 2 ft" />
        </div>
      )}
      <p class="muted small">Then step back from the antenna. Your body near it moves the reading.</p>

      <div class="actions single">
        <button class="btn primary big" onClick={() => onStart(buddiSetup(band, targetHz))}>
          Start tuning
        </button>
      </div>
    </>
  );
}

function StartRow({ label, value }: { label: string; value: string }) {
  return (
    <div class="buddi-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Coach({ setup, onEdit }: { setup: BuddiSetup; onEdit: () => void }) {
  const session = useRef(new BuddiSession(setup, () => calibration.value)).current;
  const [, bump] = useState(0);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = link.value === "open" && !!device.value?.connected;
  const sim = client.transport instanceof SimulatedTransport ? client.transport : null;
  const mounted = useRef(true);

  async function measure() {
    if (client.scanning) return;
    setBusy(true);
    try {
      await session.measure(client);
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
    // Simulator: a Buddistick set up from the chart, a little long and not yet matched.
    if (sim) sim.configure({ antenna: { f0Hz: setup.targetHz * 0.955, r: 27, q: 22 } });
    void measure();
    return () => {
      mounted.current = false;
      client.cancelScan();
    };
  }, []);

  useEffect(() => {
    if (!live) return;
    let stop = false;
    (async () => {
      while (!stop && mounted.current) {
        const t0 = Date.now();
        await measure();
        await new Promise((r) => setTimeout(r, Math.max(200, LIVE_INTERVAL_MS - (Date.now() - t0))));
      }
    })();
    return () => {
      stop = true;
    };
  }, [live]);

  const madeTheChange = async () => {
    const a = session.madeTheChange();
    if (a && sim) sim.configure({ antenna: simApply(a, sim.antenna) });
    bump((n) => n + 1);
    if (!live) await measure();
  };

  const r = session.reading;
  const a = session.advice;
  useDeviceView(tuneView(setup.targetHz, r && r.bound === "exact" ? r.resonanceHz : null));
  const units = settings.value.units;

  return (
    <>
      <div class="flow-head">
        <h2>Buddistick</h2>
        <button class="icon-btn" onClick={onEdit}>
          Setup
        </button>
        <button class="icon-btn" onClick={() => go({ name: "home" })}>
          Close
        </button>
      </div>
      <p class="muted">
        {setup.band.name}, target {mhz(setup.targetHz)} MHz
      </p>

      {!r || !a ? (
        <div class="coach">
          <p class="muted">{error ?? (busy ? "Sweeping…" : "Waiting for the NanoVNA")}</p>
        </div>
      ) : (
        <>
          <Steps advice={a} coilOut={setup.coilOut} />
          <Instruction advice={a} session={session} />
          {a.kind === "whip" && (
            <p class="buddi-limit">
              <button class="link-btn" onClick={() => (session.whipStuck(), bump((n) => n + 1))}>
                The whip won't go {a.dir === "shorten" ? "any shorter" : "any longer"}
              </button>
            </p>
          )}
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
              <strong class="num">{r.z.re > 999 ? ">999" : Math.round(r.z.re)} Ω</strong>
              <span>at resonance</span>
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
          <button class="btn primary" disabled={!ready || !r || busy || a?.kind === "coil-in"} onClick={madeTheChange}>
            I made the change
          </button>
        )}
        <button class="btn" disabled={!ready || busy || live} onClick={measure}>
          {busy ? "Sweeping…" : "Measure again"}
        </button>
      </div>

      {session.done && r && <SaveSettings setup={setup} resonanceHz={r.resonanceHz} swr={r.swrAtTarget} />}

      {isSimulator && <p class="muted small">Simulator: it applies your changes to a pretend Buddistick.</p>}
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
          <h3 class="section-title">Changes</h3>
          <ol class="cut-log">
            {session.log.map((e) => (
              <li key={e.n}>
                {e.text}
                <span class="muted num">{e.afterHz === null ? ", measuring…" : `, now ${mhz(e.afterHz)} MHz, SWR ${e.swrAfter! > 10 ? ">10" : e.swrAfter!.toFixed(2)}`}</span>
              </li>
            ))}
          </ol>
        </>
      )}

      <details class="buddi-tips">
        <summary>Buddistick tips</summary>
        <ul>
          <li>Coil for big moves, whip for small ones. The closer the clip is to the whip, the higher it tunes.</li>
          <li>Too low in frequency means the antenna is too long: shorten the whip.</li>
          <li>Coil and whip set where it resonates. The radial mostly sets how good the match is there.</li>
          <li>Keep the radial's far end at least 2 ft off the ground. Sloping it down raises the resistance, levelling it lowers it.</li>
          <li>Step back before each reading. Hands and bodies near the coil or whip move it.</li>
          <li>Under 2:1 most radios give full power. Under {`1.5`} is excellent.</li>
          <li>Write down what worked. Save it below when you're done and it's your starting point next time.</li>
        </ul>
        <p class="muted small">Radial length now: about {formatLength(quarterWaveM(setup.targetHz), units)} is a quarter wave on this frequency.</p>
      </details>
    </>
  );
}

const STEP_LABELS = [
  { id: "coil", label: "Coil tap" },
  { id: "whip", label: "Whip" },
  { id: "radial", label: "Radial" },
] as const;

function Steps({ advice, coilOut }: { advice: Advice; coilOut: boolean }) {
  const now = advice.kind === "coil-in" ? "coil" : advice.kind;
  const order = ["coil", "whip", "radial", "done"];
  return (
    <ol class="buddi-steps" aria-label="Tuning steps">
      {STEP_LABELS.map((s) => {
        const skipped = s.id === "coil" && coilOut && now !== "coil";
        const state = now === s.id ? "now" : order.indexOf(now) > order.indexOf(s.id) || now === "done" ? "past" : "";
        return (
          <li key={s.id} class={`${state}${skipped ? " skipped" : ""}`} aria-current={state === "now" ? "step" : undefined}>
            {s.label}
          </li>
        );
      })}
    </ol>
  );
}

function Instruction({ advice, session }: { advice: Advice; session: BuddiSession }) {
  const r = session.reading!;
  const units = settings.value.units;
  const offHz = Math.abs(session.setup.targetHz - r.resonanceHz);
  const offText = offHz >= 1e6 ? `${(offHz / 1e6).toFixed(2)} MHz` : `${Math.round(offHz / 1000)} kHz`;
  const why = r.resonanceHz < session.setup.targetHz ? `Resonant ${offText} low, the antenna is too long` : `Resonant ${offText} high, the antenna is too short`;
  const trend = session.wrongWay ? (
    <p class="coach-trend further">That moved it the wrong way. Check which way you changed it.</p>
  ) : null;

  switch (advice.kind) {
    case "done":
      return (
        <section class="coach done" aria-live="polite">
          <p class="coach-verb">Tuned</p>
          <p class="coach-sub num">
            Resonant at {mhz(r.resonanceHz)} MHz, SWR {r.swrAtTarget.toFixed(2)} at your frequency
          </p>
        </section>
      );
    case "coil":
      return (
        <section class="coach" aria-live="polite">
          <p class="coach-verb">Move the coil clip {advice.dir === "toward" ? "toward" : "away from"} the whip</p>
          <p class="coach-amount num">
            {advice.turns} turn{advice.turns === 1 ? "" : "s"}
            {r.bound !== "exact" && <span class="coach-more"> or more</span>}
          </p>
          <p class="coach-sub">{r.bound === "exact" ? why : r.bound === "below" ? "Resonance is well below the band" : "Resonance is well above the band"}</p>
          {trend}
          {!advice.learned && <p class="muted small">First guess. After this change it knows how far a turn moves your antenna.</p>}
        </section>
      );
    case "coil-in":
      return (
        <section class="coach" aria-live="polite">
          <p class="coach-verb">Put the coil back in</p>
          <p class="coach-sub">{why}. A fully extended whip can't reach this low without a few turns of coil.</p>
        </section>
      );
    case "whip":
      return (
        <section class="coach" aria-live="polite">
          <p class="coach-verb">{advice.dir === "shorten" ? "Shorten" : "Lengthen"} the whip</p>
          <p class="coach-amount num">
            {!advice.learned && <span class="coach-more">about </span>}
            {formatLength(advice.amountM, units)}
          </p>
          <p class="coach-sub">{why}</p>
          {trend}
          {!advice.learned && <p class="muted small">First guess. After this change it knows how much your whip moves it.</p>}
        </section>
      );
    case "radial": {
      const lower = advice.dir === "lower";
      return (
        <section class="coach" aria-live="polite">
          <p class="coach-verb">{lower ? "Lower the radial's far end" : "Raise the radial's far end"}</p>
          <p class="coach-sub">
            On frequency, but {Math.round(advice.r)} Ω is {lower ? "low" : "high"} for 50 Ω coax.{" "}
            {lower
              ? "Slope the radial down more, keeping its far end at least 2 ft up."
              : "Bring the radial closer to level."}
          </p>
          <p class="muted small">
            {lower
              ? "Already sloped as far as it goes? Try the radial a little longer, then retune the whip."
              : "Already level? Try the radial a little shorter, then retune the whip."}
          </p>
        </section>
      );
    }
  }
}

function SaveSettings({ setup, resonanceHz, swr }: { setup: BuddiSetup; resonanceHz: number; swr: number }) {
  const [saved, save] = useSaved(setup.band.id);
  const start = BAND_STARTS[setup.band.id as keyof typeof BAND_STARTS];
  const [coil, setCoil] = useState("");
  const [whip, setWhip] = useState("");
  const [radial, setRadial] = useState("");
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!saved) return;
    setCoil(saved.coil);
    setWhip(saved.whip);
    setRadial(saved.radial);
  }, [saved?.at]);

  const submit = async () => {
    await save({ id: savedId(setup.band.id), bandId: setup.band.id, coil, whip, radial, resonanceHz, swr, at: Date.now() });
    setDone(true);
  };
  const field = (label: string, value: string, set: (v: string) => void, placeholder: string) => (
    <label class="field">
      <span>{label}</span>
      <input type="text" value={value} placeholder={placeholder} onInput={(e) => (set((e.target as HTMLInputElement).value), setDone(false))} />
    </label>
  );

  return (
    <>
      <h3 class="section-title">Save what worked on {setup.band.name}</h3>
      <p class="muted small">Next time on {setup.band.name}, setup starts from these.</p>
      {field("Coil tap", coil, setCoil, setup.coilOut ? "Coil out" : "e.g. turn 15 from the whip side")}
      {field("Whip", whip, setWhip, start.whip)}
      {field("Radial", radial, setRadial, `e.g. ${formatLength(quarterWaveM(setup.targetHz), settings.value.units)}, far end 3 ft up`)}
      <div class="actions single">
        <button class="btn" onClick={submit}>
          {done ? "Saved" : "Save settings"}
        </button>
      </div>
    </>
  );
}
