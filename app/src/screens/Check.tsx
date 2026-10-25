import { useEffect, useState } from "preact/hooks";
import { type Band, scanRangeFor, type Sweep, swrSeries } from "@resonance/analysis";
import { ModePicker } from "../components/ModePicker";
import { LearnLink } from "./Learn";
import { SwrChart } from "../components/SwrChart";
import { Readings, Verdict } from "../components/Verdict";
import { BAND_ORDER, bandsById, CHECK_POINTS, checkOneBand, rejudge, SCAN_ALL_ORDER } from "../check";
import { type AntennaProfile, drift, listSweeps, saveCheck } from "../history";
import {
  calibration,
  checkProfileId,
  client,
  device,
  go,
  lastCheck,
  type LastCheck,
  link,
  profiles,
  refreshProfiles,
  settings,
  store,
} from "../state";

interface AllRow {
  band: Band;
  check?: LastCheck;
  error?: string;
}

type Phase =
  | { kind: "pick" }
  | { kind: "scanning"; band: Band; partial: Sweep | null; received: number }
  | { kind: "done"; band: Band }
  | { kind: "error"; band: Band; message: string }
  | { kind: "all"; rows: AllRow[]; current: number | null };

export function Check() {
  const last = lastCheck.value;
  const [phase, setPhase] = useState<Phase>(last ? { kind: "done", band: last.result.band } : { kind: "pick" });
  const [allRows, setAllRows] = useState<AllRow[] | null>(null);
  const [saved, setSaved] = useState<{ at: number; note: string | null } | null>(null);
  const ready = link.value === "open" && !!device.value?.connected;
  const profile = profiles.value.find((p) => p.id === checkProfileId.value) ?? null;
  const thresholds = settings.value.thresholds;
  const modes = settings.value.modes;

  useEffect(() => () => client.cancelScan(), []);

  async function run(band: Band) {
    setPhase({ kind: "scanning", band, partial: null, received: 0 });
    try {
      lastCheck.value = await checkOneBand(
        client,
        band,
        calibration.value,
        (partial, received) => setPhase({ kind: "scanning", band, partial, received }),
        thresholds,
        modes,
      );
      setPhase({ kind: "done", band });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "cancelled") setPhase({ kind: "pick" });
      else setPhase({ kind: "error", band, message: (e as Error).message });
    }
  }

  async function runAll() {
    const rows: AllRow[] = bandsById(profile ? profile.bands : SCAN_ALL_ORDER).map((band) => ({ band }));
    setAllRows(rows);
    for (let i = 0; i < rows.length; i++) {
      setPhase({ kind: "all", rows: [...rows], current: i });
      try {
        rows[i] = {
          band: rows[i]!.band,
          check: await checkOneBand(client, rows[i]!.band, calibration.value, undefined, thresholds, modes),
        };
      } catch (e) {
        if ((e as { code?: string }).code === "cancelled") break;
        rows[i] = { band: rows[i]!.band, error: (e as Error).message };
      }
    }
    setAllRows([...rows]);
    setPhase({ kind: "all", rows: [...rows], current: null });
  }

  const close = () => {
    client.cancelScan();
    go({ name: "home" });
  };

  return (
    <>
      <div class="flow-head">
        <h2>Check my antenna</h2>
        <button class="icon-btn" onClick={close}>
          Close
        </button>
      </div>

      {phase.kind === "pick" && <BandPicker ready={ready} profile={profile} onPick={run} onScanAll={runAll} />}

      {phase.kind === "scanning" && (
        <>
          <p class="muted">
            Scanning {phase.band.name}, {Math.round((phase.received / CHECK_POINTS) * 100)}%
          </p>
          <div class="chart">
            <SwrChart
              {...scanRangeFor(phase.band)}
              freqHz={phase.partial?.freqHz ?? []}
              swr={phase.partial ? swrSeries(phase.partial) : []}
              band={phase.band}
            />
          </div>
          <div class="actions">
            <button class="btn" onClick={() => client.cancelScan()}>
              Cancel scan
            </button>
          </div>
        </>
      )}

      {phase.kind === "all" && (
        <AllBands
          rows={phase.rows}
          current={phase.current}
          onOpen={(row) => {
            if (!row.check) return;
            lastCheck.value = row.check;
            setPhase({ kind: "done", band: row.band });
          }}
          onCancel={() => client.cancelScan()}
          onDone={() => setPhase({ kind: "pick" })}
        />
      )}

      {phase.kind === "done" && last && (
        <>
          <Verdict result={last.result} calibrated={last.calibrated} />
          <div class="chart">
            <SwrChart
              {...scanRangeFor(last.result.band)}
              freqHz={last.sweep.freqHz}
              swr={last.result.metrics.swr}
              band={last.result.band}
              min={last.result.metrics.min}
              segment={
                last.result.segment
                  ? { ...last.result.segment, label: last.result.segment.label ?? "yours" }
                  : undefined
              }
              cursor
            />
          </div>
          <Readings result={last.result} />
          <div class="judge-on">
            <p class="muted">Judge it for</p>
            <ModePicker onChange={(m) => (lastCheck.value = rejudge(last, thresholds, m))} />
          </div>
          <button class="link-btn advanced-link" onClick={() => go({ name: "advanced" })}>
            Advanced: Smith chart, R and X, export
          </button>
          <SaveBar
            check={last}
            profile={profile}
            saved={saved?.at === last.at ? saved : null}
            onSaved={(note) => setSaved({ at: last.at, note })}
          />
          <div class="actions">
            <button class="btn primary" disabled={!ready} onClick={() => run(last.result.band)}>
              Scan again
            </button>
            {allRows ? (
              <button class="btn" onClick={() => setPhase({ kind: "all", rows: allRows, current: null })}>
                All bands
              </button>
            ) : (
              <button class="btn" onClick={() => setPhase({ kind: "pick" })}>
                Another band
              </button>
            )}
          </div>
        </>
      )}

      {phase.kind === "error" && (
        <>
          <div class="error" role="alert">
            <p>{phase.message}</p>
          </div>
          <div class="actions">
            <button class="btn primary" disabled={!ready} onClick={() => run(phase.band)}>
              Retry scan
            </button>
            <button class="btn" onClick={() => go({ name: "connect" })}>
              Check connection
            </button>
          </div>
        </>
      )}
    </>
  );
}

const LEVEL_WORD = { good: "Good", usable: "Usable", poor: "Needs work" } as const;

function AllBands(props: {
  rows: AllRow[];
  current: number | null;
  onOpen: (row: AllRow) => void;
  onCancel: () => void;
  onDone: () => void;
}) {
  const { rows, current } = props;
  const finished = current === null;
  return (
    <>
      <p class="muted" style={{ margin: "4px 0 12px" }}>
        {finished ? "Tap a band for details." : `Scanning ${rows[current]!.band.name} (${current + 1} of ${rows.length})`}
      </p>
      <ul class="all-bands">
        {rows.map((row, i) => {
          const c = row.check;
          const status = c ? c.result.level : row.error ? "error" : i === current ? "scanning" : "waiting";
          return (
            <li key={row.band.id}>
              <button class={`all-row ${status}`} disabled={!c} onClick={() => props.onOpen(row)}>
                <strong>{row.band.name}</strong>
                <span class="all-chip">
                  {c ? LEVEL_WORD[c.result.level] : row.error ? "Failed" : i === current ? "Scanning" : "Waiting"}
                </span>
                <span class="all-detail num">
                  {c ? `best ${c.result.metrics.min.swr > 10 ? ">10" : c.result.metrics.min.swr.toFixed(1)}:1` : row.error ? row.error : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div class="actions single">
        {finished ? (
          <button class="btn" onClick={props.onDone}>
            Pick one band
          </button>
        ) : (
          <button class="btn" onClick={props.onCancel}>
            Stop scanning
          </button>
        )}
      </div>
    </>
  );
}

function BandPicker(props: { ready: boolean; profile: AntennaProfile | null; onPick: (b: Band) => void; onScanAll: () => void }) {
  const { ready, profile, onPick, onScanAll } = props;
  const order = profile ? [...profile.bands, ...BAND_ORDER.filter((b) => !profile.bands.includes(b))] : BAND_ORDER;
  const bands = bandsById(order);
  return (
    <>
      {!ready && (
        <div class="error" role="alert">
          <p>The NanoVNA isn't ready. Check the connection, then pick a band.</p>
        </div>
      )}
      {profiles.value.length > 0 && (
        <label class="field compact">
          <span>Antenna</span>
          <select
            value={profile?.id ?? ""}
            onChange={(e) => (checkProfileId.value = (e.target as HTMLSelectElement).value || null)}
          >
            <option value="">Quick check (don't save to an antenna)</option>
            {profiles.value.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <p class="muted" style={{ margin: "12px 0 8px" }}>
        Where do you operate?
      </p>
      <ModePicker />
      <p class="learn-links">
        <LearnLink topic="segments">Why pick a mode?</LearnLink>
      </p>
      <p class="muted" style={{ margin: "12px 0 12px" }}>
        Which band?
      </p>
      <div class="bands">
        {bands.map((b) => (
          <button key={b.id} class={`band${profile?.bands.includes(b.id) ? " mine" : ""}`} disabled={!ready} onClick={() => onPick(b)}>
            <strong>{b.name}</strong>
            <span class="num">
              {(b.startHz / 1e6).toFixed(b.startHz < 1e7 ? 1 : 0)}–{(b.stopHz / 1e6).toFixed(b.stopHz < 1e7 ? 1 : 2).replace(/\.?0+$/, "")}
            </span>
          </button>
        ))}
      </div>
      <div class="actions single">
        <button class="btn" disabled={!ready} onClick={onScanAll}>
          {profile ? `Scan all of ${profile.name}'s bands` : "Scan all bands (160m to 6m)"}
        </button>
      </div>
    </>
  );
}

function SaveBar(props: {
  check: LastCheck;
  profile: AntennaProfile | null;
  saved: { note: string | null } | null;
  onSaved: (driftNote: string | null) => void;
}) {
  const { check, profile, saved } = props;
  const [target, setTarget] = useState(profile?.id ?? "");
  if (saved) {
    return (
      <div class="save-bar">
        <p class="saved">Saved{profile ? ` to ${profile.name}` : ""}.</p>
        {saved.note && (
          <p class="drift-note" role="status">
            {saved.note}
          </p>
        )}
      </div>
    );
  }
  const save = async (profileId: string | null) => {
    const s = await saveCheck(store, check, profileId);
    let note: string | null = null;
    const p = profiles.value.find((x) => x.id === profileId);
    const baseId = p && s.bandId ? p.baselines[s.bandId] : undefined;
    if (profileId && baseId) {
      const base = (await listSweeps(store, profileId)).find((x) => x.id === baseId);
      if (base) note = drift(base, s)?.message ?? null;
    }
    await refreshProfiles();
    props.onSaved(note);
  };
  if (profile) {
    return (
      <div class="save-bar">
        <button class="btn" onClick={() => save(profile.id)}>
          Save to {profile.name}
        </button>
      </div>
    );
  }
  return (
    <div class="save-bar row">
      <select value={target} onChange={(e) => setTarget((e.target as HTMLSelectElement).value)} aria-label="Save to antenna">
        <option value="">No antenna</option>
        {profiles.value.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button class="btn" onClick={() => save(target || null)}>
        Save
      </button>
    </div>
  );
}
