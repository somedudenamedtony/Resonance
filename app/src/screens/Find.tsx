import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import { type Range, type Sweep, swrSeries, wantsLogAxis, wideChunks } from "@resonance/analysis";
import { SwrChart } from "../components/SwrChart";
import {
  deviceMaxHz,
  dipHz,
  dipSwr,
  type FindResult,
  findHeadline,
  findResonance,
  type FoundDip,
  formatHz,
  fullRange,
  hzParts,
  nearestDip,
  parseMhz,
  rangeNotes,
  rangeProblem,
  swrAt,
  targetRange,
  zoomDip,
} from "../find";
import { drift, listSweeps, saveFind, TARGET_KEY } from "../history";
import { findView } from "../mirror";
import { useDeviceView } from "../useDeviceView";
import { calibration, client, device, go, link, profiles, refreshProfiles, settings, store } from "../state";

type Mode = "target" | "all" | "custom";

interface Setup {
  mode: Mode;
  range: Range;
  targetHz?: number;
  profileId: string | null;
}

type Phase =
  | { kind: "pick" }
  | { kind: "scanning"; setup: Setup; partial: Sweep | null; fraction: number; stage: "coarse" | "zoom" }
  | { kind: "done" }
  | { kind: "error"; setup: Setup; message: string };

/** The last search, kept while the app is open so leaving and coming back shows it again. */
const lastFind = signal<{ result: FindResult; setup: Setup } | null>(null);

const LEVEL_TEXT = { good: "Good", usable: "Usable", poor: "Needs work" } as const;
const LEVEL_MARK = { good: "✓", usable: "~", poor: "!" } as const;
const fmtSwr = (s: number) => (Number.isFinite(s) && s < 10 ? s.toFixed(2) : ">10");

export function Find({ targetHz, profileId }: { targetHz?: number; profileId?: string }) {
  const fresh = targetHz !== undefined || profileId !== undefined;
  const [phase, setPhase] = useState<Phase>(!fresh && lastFind.value ? { kind: "done" } : { kind: "pick" });
  const [selected, setSelected] = useState(0);
  const ready = link.value === "open" && !!device.value?.connected;
  const last = lastFind.value;

  useEffect(() => () => client.cancelScan(), []);

  const result = phase.kind === "done" ? last?.result : undefined;
  const pick = result?.dips[selected];
  useDeviceView(
    phase.kind === "scanning" || phase.kind === "error"
      ? findView(phase.setup.range, [phase.setup.targetHz])
      : result
        ? findView(pick?.zoom?.range ?? result.range, [result.targetHz, pick ? dipHz(pick) : null])
        : null,
  );

  async function run(setup: Setup) {
    setPhase({ kind: "scanning", setup, partial: null, fraction: 0, stage: "coarse" });
    try {
      const result = await findResonance(client, setup.range, calibration.value, {
        targetHz: setup.targetHz,
        onProgress: (p) => setPhase({ kind: "scanning", setup, ...p }),
      });
      lastFind.value = { result, setup };
      const near = setup.targetHz ? nearestDip(result.dips, setup.targetHz) : undefined;
      setSelected(near ? result.dips.indexOf(near) : 0);
      setPhase({ kind: "done" });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "cancelled") setPhase({ kind: "pick" });
      else setPhase({ kind: "error", setup, message: (e as Error).message });
    }
  }

  const close = () => {
    client.cancelScan();
    go({ name: "home" });
  };

  return (
    <>
      <div class="flow-head">
        <h2>Find resonance</h2>
        <button class="icon-btn" onClick={close}>
          Close
        </button>
      </div>

      {phase.kind === "pick" && (
        <SetupForm
          ready={ready}
          initial={fresh ? { targetHz, profileId: profileId ?? null } : last?.setup}
          onStart={run}
        />
      )}

      {phase.kind === "scanning" && (
        <>
          <p class="muted">
            {phase.stage === "coarse"
              ? `Sweeping ${formatHz(phase.setup.range.startHz)} to ${formatHz(phase.setup.range.stopHz)}, ${Math.round(phase.fraction * 100)}%`
              : `Taking a closer look at each dip, ${Math.round(phase.fraction * 100)}%`}
          </p>
          <div class="chart">
            <SwrChart
              {...phase.setup.range}
              freqHz={phase.partial?.freqHz ?? []}
              swr={phase.partial ? swrSeries(phase.partial) : []}
              log={wantsLogAxis(phase.setup.range)}
              swrMax={10}
              target={phase.setup.targetHz}
              edges
            />
          </div>
          <div class="actions">
            <button class="btn" onClick={() => client.cancelScan()}>
              Cancel
            </button>
          </div>
        </>
      )}

      {phase.kind === "done" && last && (
        <Results
          result={last.result}
          setup={last.setup}
          selected={selected}
          onSelect={setSelected}
          ready={ready}
          onAgain={() => run(last.setup)}
          onNew={() => setPhase({ kind: "pick" })}
        />
      )}

      {phase.kind === "error" && (
        <>
          <div class="error" role="alert">
            <p>{phase.message}</p>
          </div>
          <div class="actions">
            <button class="btn primary" disabled={!ready} onClick={() => run(phase.setup)}>
              Try again
            </button>
            <button class="btn" onClick={() => setPhase({ kind: "pick" })}>
              Change range
            </button>
          </div>
        </>
      )}
    </>
  );
}

function SetupForm(props: { ready: boolean; initial?: Partial<Setup>; onStart: (s: Setup) => void }) {
  const init = props.initial;
  const initProfile = profiles.value.find((p) => p.id === init?.profileId) ?? null;
  const initTarget = init?.targetHz ?? initProfile?.targetHz;
  const maxHz = deviceMaxHz(device.value);
  const [mode, setMode] = useState<Mode>(init?.mode ?? (initTarget ? "target" : "all"));
  const [profileId, setProfileId] = useState<string | null>(initProfile?.id ?? null);
  const [target, setTarget] = useState(initTarget ? String(initTarget / 1e6) : "");
  const [from, setFrom] = useState(init?.mode === "custom" && init.range ? String(init.range.startHz / 1e6) : "");
  const [to, setTo] = useState(init?.mode === "custom" && init.range ? String(init.range.stopHz / 1e6) : "");
  const [error, setError] = useState<string | null>(null);

  const targetHz = parseMhz(target);
  const range: Range | null =
    mode === "all"
      ? fullRange(device.value)
      : mode === "target"
        ? targetHz
          ? targetRange(targetHz, maxHz)
          : null
        : parseMhz(from) && parseMhz(to)
          ? { startHz: parseMhz(from)!, stopHz: parseMhz(to)! }
          : null;
  const pieces = range && !rangeProblem(range, maxHz) ? wideChunks(range).length : 0;

  const pickProfile = (id: string | null) => {
    setProfileId(id);
    const t = profiles.value.find((p) => p.id === id)?.targetHz;
    if (t) {
      setTarget(String(t / 1e6));
      setMode("target");
    }
  };

  const start = () => {
    if (target.trim() !== "" && !targetHz) return setError("Enter the target in MHz, like 1090.");
    if (mode === "target" && !targetHz) return setError("Enter the frequency the antenna is for, in MHz.");
    if (!range) return setError("Enter a start and stop frequency in MHz.");
    if (targetHz && targetHz > maxHz) return setError(`This NanoVNA tops out at ${formatHz(maxHz)}.`);
    const problem = rangeProblem(range, maxHz);
    if (problem) return setError(problem);
    props.onStart({ mode, range, targetHz, profileId });
  };

  const setter = (f: (v: string) => void) => (e: Event) => {
    f((e.target as HTMLInputElement).value);
    setError(null);
  };

  return (
    <>
      {!props.ready && (
        <div class="error" role="alert">
          <p>The NanoVNA isn't ready. Check the connection, then search.</p>
        </div>
      )}
      <p class="muted">
        Sweep any range the NanoVNA reaches and see where the antenna is resonant, ham band or not. Good for ADS-B,
        airband, scanners and anything else.
      </p>
      {profiles.value.length > 0 && (
        <label class="field compact">
          <span>Antenna</span>
          <select value={profileId ?? ""} onChange={(e) => pickProfile((e.target as HTMLSelectElement).value || null)}>
            <option value="">Don't save to an antenna</option>
            {profiles.value.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.targetHz ? `, ${formatHz(p.targetHz)}` : ""}
              </option>
            ))}
          </select>
        </label>
      )}

      <h3 class="section-title">Search</h3>
      <div class="segmented" role="radiogroup" aria-label="What to sweep">
        {(
          [
            ["target", "Around a frequency"],
            ["all", "Everything"],
            ["custom", "Custom range"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} role="radio" aria-checked={mode === id} class={mode === id ? "on" : ""} onClick={() => (setMode(id), setError(null))}>
            {label}
          </button>
        ))}
      </div>

      {mode === "custom" && (
        <div class="field-row">
          <label class="field">
            <span>Start, MHz</span>
            <input type="text" inputMode="decimal" placeholder="900" value={from} onInput={setter(setFrom)} />
          </label>
          <label class="field">
            <span>Stop, MHz</span>
            <input type="text" inputMode="decimal" placeholder="1300" value={to} onInput={setter(setTo)} />
          </label>
        </div>
      )}
      <label class="field">
        <span>{mode === "target" ? "Frequency it's for, MHz" : "Target frequency, MHz (optional)"}</span>
        <input type="text" inputMode="decimal" placeholder="1090" value={target} onInput={setter(setTarget)} />
      </label>

      {range && !rangeProblem(range, maxHz) && (
        <p class="muted small">
          {formatHz(range.startHz)} to {formatHz(range.stopHz)}
          {pieces > 1 ? `, in ${pieces} pieces so narrow dips aren't skipped` : ""}.
          {mode === "all" && ` ${formatHz(maxHz)} is as high as this NanoVNA goes.`}
        </p>
      )}
      {range && rangeNotes(range, true).map((n) => (
        <p key={n} class="muted small">
          {n}
        </p>
      ))}
      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}

      <div class="actions single">
        <button class="btn primary big" disabled={!props.ready} onClick={start}>
          Search
        </button>
      </div>
    </>
  );
}

function Results(props: {
  result: FindResult;
  setup: Setup;
  selected: number;
  onSelect: (i: number) => void;
  ready: boolean;
  onAgain: () => void;
  onNew: () => void;
}) {
  const { result, setup, selected } = props;
  const [, bump] = useState(0);
  const [zooming, setZooming] = useState<number | null>(null);
  const [zoomError, setZoomError] = useState<string | null>(null);
  const { headline, detail } = findHeadline(result);
  const t = result.targetHz;
  const judged = t ? swrAt(result, t) : result.dips[0] ? dipSwr(result.dips[0]) : null;
  const th = settings.value.thresholds;
  const level = judged === null || result.dips.length === 0 ? "poor" : judged <= th.good ? "good" : judged <= th.usable ? "usable" : "poor";
  const pick = result.dips[selected];
  const near = t ? nearestDip(result.dips, t) : undefined;
  const notes = rangeNotes(result.range, result.calibrated);

  const lookCloser = async (i: number) => {
    const d = result.dips[i]!;
    setZooming(i);
    setZoomError(null);
    try {
      d.zoom = await zoomDip(client, d.dip, result.coarse, calibration.value);
      bump((n) => n + 1);
    } catch (e) {
      if ((e as { code?: string }).code !== "cancelled") setZoomError((e as Error).message);
    } finally {
      setZooming(null);
    }
  };

  return (
    <>
      <section class={`verdict ${level}`} aria-live="polite">
        <span class="level">
          <span aria-hidden="true">{LEVEL_MARK[level]}</span>
          {t ? `${LEVEL_TEXT[level]} at ${formatHz(t)}` : LEVEL_TEXT[level]}
        </span>
        <h1>{headline}</h1>
        <p class="detail">{detail}</p>
        {!result.calibrated && result.range.stopHz <= 60_000_000 && (
          <p class="uncal">
            <span class="badge">Uncalibrated</span>
            <button class="link-btn" onClick={() => go({ name: "calibrate" })}>
              Calibrate for accurate results
            </button>
          </p>
        )}
      </section>

      <h3 class="section-title">
        {formatHz(result.range.startHz)} to {formatHz(result.range.stopHz)}
      </h3>
      <div class="chart">
        <SwrChart
          {...result.range}
          freqHz={result.coarse.freqHz}
          swr={swrSeries(result.coarse)}
          log={wantsLogAxis(result.range)}
          swrMax={10}
          marks={result.dips.map((d, i) => ({ freqHz: d.dip.freqHz, label: String(i + 1) }))}
          target={t}
          edges
          cursor
        />
      </div>

      {result.dips.length > 0 && (
        <>
          <h3 class="section-title">Dips, deepest first</h3>
          <ul class="all-bands">
            {result.dips.map((d, i) => (
              <li key={i}>
                <button class={`dip-row${i === selected ? " selected" : ""}`} aria-pressed={i === selected} onClick={() => props.onSelect(i)}>
                  <span class="dip-num">{i + 1}</span>
                  <span class="dip-main">
                    <strong class="num">{formatHz(dipHz(d))}</strong>
                    <span class="muted small num">
                      {d === near ? "Nearest the target" : ""}
                      {d === near && d.zoom?.bw2 ? ". " : ""}
                      {d.zoom?.bw2 ? `Under 2:1 from ${formatHz(d.zoom.bw2.lowHz)} to ${formatHz(d.zoom.bw2.highHz)}` : ""}
                    </span>
                  </span>
                  <span class="dip-swr num">SWR {fmtSwr(dipSwr(d))}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {pick && (
        <>
          <h3 class="section-title">Dip {selected + 1} up close</h3>
          {pick.zoom ? (
            <DipDetail dip={pick} targetHz={t} />
          ) : (
            <div class="actions single">
              <button class="btn" disabled={!props.ready || zooming !== null} onClick={() => lookCloser(selected)}>
                {zooming === selected ? "Sweeping…" : `Look closer at ${formatHz(dipHz(pick))}`}
              </button>
            </div>
          )}
          {zoomError && (
            <div class="error" role="alert">
              <p>{zoomError}</p>
            </div>
          )}
        </>
      )}

      {notes.map((n) => (
        <p key={n} class="muted small">
          {n}
        </p>
      ))}

      <SaveFind result={result} pick={pick} profileId={setup.profileId} />

      <div class="actions">
        <button class="btn primary" disabled={!props.ready} onClick={props.onAgain}>
          Search again
        </button>
        <button class="btn" onClick={props.onNew}>
          Change range
        </button>
      </div>
      {t && near && Math.abs(dipHz(near) - t) / t > 0.005 && (
        <button class="link-btn advanced-link" onClick={() => go({ name: "tune", targetHz: t })}>
          Tune it to {formatHz(t)}: what to cut
        </button>
      )}
    </>
  );
}

function DipDetail({ dip, targetHz }: { dip: FoundDip; targetHz?: number }) {
  const z = dip.zoom!;
  return (
    <>
      <div class="chart">
        <SwrChart
          {...z.range}
          freqHz={z.sweep.freqHz}
          swr={swrSeries(z.sweep)}
          min={{ freqHz: z.bestHz, swr: z.bestSwr }}
          swrMax={z.bestSwr > 2.5 ? 10 : 3}
          target={targetHz}
          edges
          cursor
        />
      </div>
      <div class="readings">
        <div class="reading static">
          <strong class="num">{hzParts(z.bestHz).value}</strong>
          <span>best match, {hzParts(z.bestHz).unit}</span>
        </div>
        <div class="reading static">
          <strong class="num">{fmtSwr(z.bestSwr)}</strong>
          <span>lowest SWR</span>
        </div>
        <div class="reading static">
          <strong class="num">
            {z.bw2 ? hzParts(z.bw2.widthHz).value : "none"}
            {z.bw2?.clipped ? "+" : ""}
          </strong>
          <span>2:1 width{z.bw2 ? `, ${hzParts(z.bw2.widthHz).unit}` : ""}</span>
        </div>
      </div>
    </>
  );
}

function SaveFind(props: { result: FindResult; pick: FoundDip | undefined; profileId: string | null }) {
  const { result, pick } = props;
  const [to, setTo] = useState(props.profileId ?? "");
  const [saved, setSaved] = useState<{ at: number; name: string | null; note: string | null } | null>(null);
  if (profiles.value.length === 0) return null;
  if (saved?.at === result.at) {
    return (
      <div class="save-bar">
        <p class="saved">Saved{saved.name ? ` to ${saved.name}` : ""}.</p>
        {saved.note && (
          <p class="drift-note" role="status">
            {saved.note}
          </p>
        )}
      </div>
    );
  }
  const save = async () => {
    const profileId = to || null;
    const zoom = pick?.zoom;
    const t = result.targetHz ?? profiles.value.find((p) => p.id === profileId)?.targetHz;
    const s = await saveFind(
      store,
      {
        sweep: zoom?.sweep ?? result.coarse,
        calibrated: zoom?.calibrated ?? result.calibrated,
        at: result.at,
        swrAtTarget: t ? swrAt(result, t) : null,
      },
      profileId,
      settings.value.thresholds,
    );
    const p = profiles.value.find((x) => x.id === profileId);
    let note: string | null = null;
    const baseId = p?.baselines[TARGET_KEY];
    if (profileId && baseId && baseId !== s.id) {
      const base = (await listSweeps(store, profileId)).find((x) => x.id === baseId);
      if (base) note = drift(base, s)?.message ?? null;
    }
    await refreshProfiles();
    setSaved({ at: result.at, name: p?.name ?? null, note });
  };
  return (
    <div class="save-bar row">
      <select value={to} onChange={(e) => setTo((e.target as HTMLSelectElement).value)} aria-label="Save to antenna">
        <option value="">No antenna</option>
        {profiles.value.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button class="btn" onClick={save}>
        Save{pick?.zoom ? ` dip ${result.dips.indexOf(pick) + 1}` : ""}
      </button>
    </div>
  );
}
