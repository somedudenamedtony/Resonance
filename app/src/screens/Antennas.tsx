import { useEffect, useState } from "preact/hooks";
import { type AntennaType, findBand, scanRangeFor, swrSeries, US_BAND_PLAN } from "@resonance/analysis";
import { SwrChart } from "../components/SwrChart";
import { BAND_ORDER, bandsById } from "../check";
import { formatHz, parseMhz } from "../find";
import {
  type AntennaProfile,
  createProfile,
  deleteProfile,
  deleteSweep,
  drift,
  latestPerBand,
  listSweeps,
  type SavedSweep,
  setBaseline,
  TARGET_KEY,
  baselineKey,
  toSweep,
} from "../history";
import { checkProfileId, go, profiles, refreshProfiles, store } from "../state";

export const TYPE_LABEL: Record<AntennaType, string> = {
  dipole: "Dipole",
  efhw: "End-fed half-wave",
  vertical: "Vertical",
  mobile: "Mobile",
  other: "Other",
};

const LEVEL_WORD = { good: "Good", usable: "Usable", poor: "Needs work" } as const;

const when = (t: number) =>
  new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
  ", " +
  new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

// ---------- list ----------

export function Antennas() {
  const list = profiles.value;
  const [adding, setAdding] = useState(false);
  const [latest, setLatest] = useState<Record<string, { bySweep: Map<string, SavedSweep>; drifted: boolean }>>({});

  useEffect(() => {
    void (async () => {
      const out: typeof latest = {};
      for (const p of list) {
        const sweeps = await listSweeps(store, p.id);
        const by = latestPerBand(sweeps);
        let drifted = false;
        for (const [band, s] of by) {
          const baseId = p.baselines[band];
          const base = baseId ? sweeps.find((x) => x.id === baseId) : undefined;
          if (base && drift(base, s)) drifted = true;
        }
        out[p.id] = { bySweep: by, drifted };
      }
      setLatest(out);
    })();
  }, [list]);

  return (
    <>
      <div class="flow-head">
        <h2>Antennas</h2>
        {!adding && list.length > 0 && (
          <button class="icon-btn" onClick={() => setAdding(true)}>
            Add
          </button>
        )}
      </div>

      {adding || list.length === 0 ? (
        <AddAntenna
          first={list.length === 0}
          onDone={async (p) => {
            setAdding(false);
            await refreshProfiles();
            if (p) go({ name: "profile", id: p.id });
          }}
          onCancel={list.length ? () => setAdding(false) : undefined}
        />
      ) : (
        <ul class="profile-list">
          {list.map((p) => {
            const info = latest[p.id];
            return (
              <li key={p.id}>
                <button class="profile-card" onClick={() => go({ name: "profile", id: p.id })}>
                  <span class="profile-name">
                    {p.name}
                    {info?.drifted && <span class="drift-dot">Changed</span>}
                  </span>
                  <span class="muted">{TYPE_LABEL[p.type]}</span>
                  <span class="band-chips">
                    {p.bands.map((b) => {
                      const s = info?.bySweep.get(b);
                      const level = s?.summary.level;
                      return (
                        <span key={b} class={`band-chip ${level ?? "none"}`}>
                          {findBand(US_BAND_PLAN, b)?.name ?? b} {level ? LEVEL_WORD[level] : "not checked"}
                        </span>
                      );
                    })}
                    {p.targetHz && (
                      <span class={`band-chip ${info?.bySweep.get(TARGET_KEY)?.summary.level ?? "none"}`}>
                        {formatHz(p.targetHz)}{" "}
                        {(() => {
                          const level = info?.bySweep.get(TARGET_KEY)?.summary.level;
                          return level ? LEVEL_WORD[level] : "not checked";
                        })()}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function AddAntenna(props: { first: boolean; onDone: (p: AntennaProfile | null) => void; onCancel?: () => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<AntennaType>("dipole");
  const [bands, setBands] = useState<string[]>(["20m"]);
  const [other, setOther] = useState(false);
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: string) => setBands(bands.includes(id) ? bands.filter((b) => b !== id) : [...bands, id]);

  const save = async () => {
    try {
      const ordered = BAND_ORDER.filter((b) => bands.includes(b));
      const targetHz = other ? parseMhz(target) : undefined;
      if (other && !targetHz) throw new Error("Enter the frequency it's for in MHz, like 1090.");
      props.onDone(await createProfile(store, { name, type, bands: ordered, targetHz }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div class="form-card">
      {props.first && <p>Save an antenna to keep its sweeps, set a baseline, and spot changes over time.</p>}
      <label class="field">
        <span>Name</span>
        <input type="text" placeholder="Backyard EFHW" value={name} onInput={(e) => (setName((e.target as HTMLInputElement).value), setError(null))} />
      </label>
      <h3 class="section-title">Type</h3>
      <div class="segmented" role="radiogroup" aria-label="Antenna type">
        {(Object.keys(TYPE_LABEL) as AntennaType[]).map((t) => (
          <button key={t} role="radio" aria-checked={t === type} class={t === type ? "on" : ""} onClick={() => setType(t)}>
            {t === "efhw" ? "End-fed" : TYPE_LABEL[t]}
          </button>
        ))}
      </div>
      <h3 class="section-title">Bands it's for</h3>
      <div class="bands">
        {bandsById(BAND_ORDER).map((b) => (
          <button key={b.id} class={`band${bands.includes(b.id) ? " selected" : ""}`} aria-pressed={bands.includes(b.id)} onClick={() => toggle(b.id)}>
            <strong>{b.name}</strong>
          </button>
        ))}
        <button class={`band${other ? " selected" : ""}`} aria-pressed={other} onClick={() => (setOther(!other), setError(null))}>
          <strong>Other</strong>
        </button>
      </div>
      {other && (
        <label class="field">
          <span>Frequency it's for, MHz</span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="1090"
            value={target}
            onInput={(e) => (setTarget((e.target as HTMLInputElement).value), setError(null))}
          />
        </label>
      )}
      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
      <div class="actions">
        <button class="btn primary" onClick={save}>
          Save antenna
        </button>
        {props.onCancel && (
          <button class="btn" onClick={props.onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

// ---------- detail ----------

export function Profile({ id }: { id: string }) {
  const p = profiles.value.find((x) => x.id === id);
  const [sweeps, setSweeps] = useState<SavedSweep[]>([]);
  const [compare, setCompare] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const reload = async () => setSweeps(await listSweeps(store, id));
  useEffect(() => {
    void reload();
  }, [id]);

  if (!p) {
    return (
      <div class="soon">
        <p>That antenna was deleted.</p>
        <button class="link-btn" onClick={() => go({ name: "antennas" })}>
          Back to antennas
        </button>
      </div>
    );
  }

  const latest = latestPerBand(sweeps);
  const byId = new Map(sweeps.map((s) => [s.id, s]));
  const pair = compare.map((c) => byId.get(c)).filter((s): s is SavedSweep => !!s);

  const toggleCompare = (s: SavedSweep) => {
    if (compare.includes(s.id)) setCompare(compare.filter((c) => c !== s.id));
    else setCompare([...compare.filter((c) => byId.get(c)?.bandId === s.bandId), s.id].slice(-2));
  };

  return (
    <>
      <div class="flow-head">
        <h2>{p.name}</h2>
        <button class="icon-btn" onClick={() => go({ name: "antennas" })}>
          All
        </button>
      </div>
      <p class="muted">
        {TYPE_LABEL[p.type]}
        {p.targetHz ? `, for ${formatHz(p.targetHz)}` : ""}
      </p>

      <div class={`actions${p.bands.length && p.targetHz ? "" : " single"}`}>
        {p.bands.length > 0 && (
          <button
            class="btn primary"
            onClick={() => {
              checkProfileId.value = p.id;
              go({ name: "check" });
            }}
          >
            Check this antenna
          </button>
        )}
        {p.targetHz && (
          <button class={`btn${p.bands.length ? "" : " primary"}`} onClick={() => go({ name: "find", targetHz: p.targetHz, profileId: p.id })}>
            Find resonance
          </button>
        )}
      </div>

      {pair.length === 2 ? (
        <BandCard
          title={`Comparing ${pair[0]!.bandId ? findBand(US_BAND_PLAN, pair[0]!.bandId)?.name : p.targetHz ? formatHz(p.targetHz) : "searches"}`}
          targetHz={p.targetHz}
          latest={pair[0]!.takenAt > pair[1]!.takenAt ? pair[0]! : pair[1]!}
          base={pair[0]!.takenAt > pair[1]!.takenAt ? pair[1]! : pair[0]!}
          baseLabel="Earlier"
        />
      ) : (
        p.bands.map((bandId) => {
          const s = latest.get(bandId);
          const base = p.baselines[bandId] ? byId.get(p.baselines[bandId]!) : undefined;
          const band = findBand(US_BAND_PLAN, bandId);
          if (!band) return null;
          return s ? (
            <BandCard key={bandId} title={band.name} latest={s} base={base && base.id !== s.id ? base : undefined} baseLabel="Baseline" />
          ) : (
            <div key={bandId} class="band-card empty">
              <strong>{band.name}</strong>
              <span class="muted">Not checked yet</span>
            </div>
          );
        })
      )}
      {pair.length !== 2 &&
        p.targetHz &&
        (() => {
          const s = latest.get(TARGET_KEY);
          const base = p.baselines[TARGET_KEY] ? byId.get(p.baselines[TARGET_KEY]!) : undefined;
          return s ? (
            <BandCard title={formatHz(p.targetHz)} latest={s} base={base && base.id !== s.id ? base : undefined} baseLabel="Baseline" targetHz={p.targetHz} />
          ) : (
            <div class="band-card empty">
              <strong>{formatHz(p.targetHz)}</strong>
              <span class="muted">Not checked yet</span>
            </div>
          );
        })()}

      <h3 class="section-title">History</h3>
      {sweeps.length === 0 ? (
        <p class="muted">Checks you save to this antenna show up here.</p>
      ) : (
        <>
          <p class="muted small">Tap two sweeps of the same band to compare them.</p>
          <ul class="history">
            {sweeps.map((s) => {
              const key = baselineKey(s);
              const isBase = key ? p.baselines[key] === s.id : false;
              return (
                <li key={s.id} class={compare.includes(s.id) ? "picked" : ""}>
                  <button class="history-main" aria-pressed={compare.includes(s.id)} onClick={() => toggleCompare(s)}>
                    <span class="num">{when(s.takenAt)}</span>
                    <strong>
                      {s.bandId
                        ? (findBand(US_BAND_PLAN, s.bandId)?.name ?? s.bandId)
                        : s.job === "find"
                          ? p.targetHz
                            ? formatHz(p.targetHz)
                            : formatHz(s.summary.minSwrHz)
                          : "Sweep"}
                    </strong>
                    <span class={`all-chip level-${s.summary.level ?? "none"}`}>{s.summary.level ? LEVEL_WORD[s.summary.level] : ""}</span>
                    <span class="muted num">{s.summary.minSwr > 10 ? ">10" : s.summary.minSwr.toFixed(2)}:1</span>
                  </button>
                  <span class="history-actions">
                    {isBase ? (
                      <span class="muted small">Baseline</span>
                    ) : (
                      <button class="link-btn" onClick={async () => (await setBaseline(store, p.id, s), await refreshProfiles())}>
                        Make baseline
                      </button>
                    )}
                    <button
                      class="link-btn danger"
                      onClick={async () => {
                        await deleteSweep(store, s.id);
                        setCompare(compare.filter((c) => c !== s.id));
                        await refreshProfiles();
                        await reload();
                      }}
                    >
                      Delete
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <div class="actions single" style={{ marginTop: "24px" }}>
        {confirmDelete ? (
          <button
            class="btn danger"
            onClick={async () => {
              await deleteProfile(store, p.id);
              if (checkProfileId.value === p.id) checkProfileId.value = null;
              await refreshProfiles();
              go({ name: "antennas" });
            }}
          >
            Delete {p.name} and its {sweeps.length} sweeps
          </button>
        ) : (
          <button class="btn" onClick={() => setConfirmDelete(true)}>
            Delete antenna
          </button>
        )}
      </div>
    </>
  );
}

function BandCard(props: { title: string; latest: SavedSweep; base?: SavedSweep; baseLabel: string; targetHz?: number }) {
  const { latest, base } = props;
  const band = latest.bandId ? findBand(US_BAND_PLAN, latest.bandId) : undefined;
  const range = band ? scanRangeFor(band) : { startHz: latest.freqHz[0]!, stopHz: latest.freqHz.at(-1)! };
  const sw = toSweep(latest);
  const d = base ? drift(base, latest) : null;
  return (
    <section class="band-card">
      <div class="band-card-head">
        <strong>{props.title}</strong>
        {latest.summary.level && <span class={`all-chip level-${latest.summary.level}`}>{LEVEL_WORD[latest.summary.level]}</span>}
        <span class="muted small">{when(latest.takenAt)}</span>
      </div>
      {d && (
        <p class="drift-note" role="status">
          {d.message}
        </p>
      )}
      <div class="chart">
        <SwrChart
          {...range}
          freqHz={sw.freqHz}
          swr={swrSeries(sw)}
          band={band}
          min={{ freqHz: latest.summary.minSwrHz, swr: latest.summary.minSwr }}
          target={band ? undefined : props.targetHz}
          edges={!band}
          overlays={base ? [{ freqHz: base.freqHz, swr: swrSeries(toSweep(base)), label: `${props.baseLabel}, ${when(base.takenAt)}` }] : undefined}
          cursor
        />
      </div>
      {base && (
        <p class="legend small">
          <span class="legend-item">
            <span class="legend-solid" /> Latest, {when(latest.takenAt)}
          </span>
          <span class="legend-item">
            <span class="legend-dash" /> {props.baseLabel}, {when(base.takenAt)}
          </span>
        </p>
      )}
      {!latest.calibrated && <p class="muted small">Saved uncalibrated.</p>}
    </section>
  );
}
