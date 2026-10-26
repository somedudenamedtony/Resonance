/**
 * Antenna profiles, saved sweeps, baselines, drift, settings and backup (spec: Data model,
 * Features > History). UI-free; everything goes through a Store.
 */
import {
  type AntennaType,
  analyze,
  type Complex,
  DEFAULT_THRESHOLDS,
  findBand,
  type OperatingMode,
  type Sweep,
  type SwrThresholds,
  US_BAND_PLAN,
  type VerdictLevel,
} from "@resonance/analysis";
import type { SavedCalibration } from "./cal";
import type { LastCheck } from "./state";
import { newId, type Store } from "./storage";

// ---------- records ----------

export interface AntennaProfile {
  id: string;
  name: string;
  type: AntennaType;
  bands: string[];
  createdAt: number;
  /** Baseline sweep per band id: what "healthy" looked like. */
  baselines: Record<string, string>;
  notes?: string;
}

export interface SweepSummary {
  level: VerdictLevel | null;
  minSwr: number;
  minSwrHz: number;
  resonanceHz: number | null;
  bw2Hz: number | null;
}

export interface SavedSweep {
  id: string;
  takenAt: number;
  profileId: string | null;
  bandId: string | null;
  job: "check" | "tune" | "coax";
  freqHz: number[];
  /** Interleaved [re, im, ...]. */
  s11: number[];
  calibrated: boolean;
  summary: SweepSummary;
  note?: string;
}

export type Units = "metric" | "imperial";
export type Theme = "auto" | "light" | "dark" | "sunlight";

export interface Settings {
  units: Units;
  thresholds: SwrThresholds;
  theme: Theme;
  /** Modes the user operates; checks judge that part of each band. Empty = whole band. */
  modes: OperatingMode[];
  /** The first-run walkthrough has been shown (finished or skipped). */
  introSeen: boolean;
  /** Set the NanoVNA's own screen to match what the app shows. */
  mirrorScreen: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  units: "metric",
  thresholds: { ...DEFAULT_THRESHOLDS },
  theme: "auto",
  modes: [],
  introSeen: false,
  mirrorScreen: true,
};

// ---------- conversions ----------

export const flattenS11 = (s11: readonly Complex[]) => s11.flatMap((z) => [z.re, z.im]);
export function unflattenS11(xs: readonly number[]): Complex[] {
  const out: Complex[] = [];
  for (let i = 0; i < xs.length; i += 2) out.push({ re: xs[i]!, im: xs[i + 1]! });
  return out;
}
export const toSweep = (s: SavedSweep): Sweep => ({ freqHz: s.freqHz, s11: unflattenS11(s.s11) });

export function summarize(sweep: Sweep, level: VerdictLevel | null): SweepSummary {
  const m = analyze(sweep);
  return { level, minSwr: m.min.swr, minSwrHz: m.min.freqHz, resonanceHz: m.resonanceHz, bw2Hz: m.bw2?.widthHz ?? null };
}

// ---------- profiles ----------

export async function listProfiles(store: Store): Promise<AntennaProfile[]> {
  return (await store.getAll<AntennaProfile>("profiles")).sort((a, b) => a.createdAt - b.createdAt);
}

export async function createProfile(
  store: Store,
  fields: Pick<AntennaProfile, "name" | "type" | "bands"> & { notes?: string },
): Promise<AntennaProfile> {
  const name = fields.name.trim();
  if (!name) throw new Error("Give the antenna a name.");
  const bands = fields.bands.filter((b) => findBand(US_BAND_PLAN, b));
  if (bands.length === 0) throw new Error("Pick at least one band.");
  const p: AntennaProfile = { id: newId("ant"), name, type: fields.type, bands, createdAt: Date.now(), baselines: {}, notes: fields.notes };
  await store.put("profiles", p);
  return p;
}

export async function updateProfile(store: Store, p: AntennaProfile): Promise<void> {
  await store.put("profiles", p);
}

export async function deleteProfile(store: Store, id: string): Promise<void> {
  for (const s of await listSweeps(store, id)) await store.delete("sweeps", s.id);
  await store.delete("profiles", id);
}

// ---------- sweeps ----------

/** Save a check. The first sweep of a band for a profile becomes its baseline. */
export async function saveCheck(store: Store, check: LastCheck, profileId: string | null): Promise<SavedSweep> {
  const s: SavedSweep = {
    id: newId("swp"),
    takenAt: check.at,
    profileId,
    bandId: check.result.band.id,
    job: "check",
    freqHz: [...check.sweep.freqHz],
    s11: flattenS11(check.sweep.s11),
    calibrated: check.calibrated,
    summary: summarize(check.sweep, check.result.level),
  };
  await store.put("sweeps", s);
  if (profileId) {
    const p = await store.get<AntennaProfile>("profiles", profileId);
    if (p && s.bandId && !p.baselines[s.bandId]) {
      p.baselines[s.bandId] = s.id;
      await store.put("profiles", p);
    }
  }
  return s;
}

export async function listSweeps(store: Store, profileId?: string | null): Promise<SavedSweep[]> {
  const all = await store.getAll<SavedSweep>("sweeps");
  return all.filter((s) => profileId === undefined || s.profileId === profileId).sort((a, b) => b.takenAt - a.takenAt);
}

export async function deleteSweep(store: Store, id: string): Promise<void> {
  const s = await store.get<SavedSweep>("sweeps", id);
  await store.delete("sweeps", id);
  if (s?.profileId) {
    const p = await store.get<AntennaProfile>("profiles", s.profileId);
    if (p) {
      for (const [band, sid] of Object.entries(p.baselines)) if (sid === id) delete p.baselines[band];
      await store.put("profiles", p);
    }
  }
}

export async function setBaseline(store: Store, profileId: string, sweep: SavedSweep): Promise<void> {
  const p = await store.get<AntennaProfile>("profiles", profileId);
  if (!p || !sweep.bandId) return;
  p.baselines[sweep.bandId] = sweep.id;
  await store.put("profiles", p);
}

/** Newest sweep per band, newest first. */
export function latestPerBand(sweeps: readonly SavedSweep[]): Map<string, SavedSweep> {
  const out = new Map<string, SavedSweep>();
  for (const s of [...sweeps].sort((a, b) => b.takenAt - a.takenAt)) if (s.bandId && !out.has(s.bandId)) out.set(s.bandId, s);
  return out;
}

// ---------- drift ----------

export const DRIFT_SWR = 0.3;
export const DRIFT_RESONANCE = 0.01;

export interface Drift {
  swrRise: number;
  resonanceShift: number | null;
  message: string;
}

/** Compare the latest sweep with the baseline (spec: drift note thresholds). */
export function drift(baseline: SavedSweep, latest: SavedSweep): Drift | null {
  if (baseline.id === latest.id) return null;
  const swrRise = latest.summary.minSwr - baseline.summary.minSwr;
  const a = baseline.summary.resonanceHz;
  const b = latest.summary.resonanceHz;
  const resonanceShift = a !== null && b !== null ? (b - a) / a : null;
  const parts: string[] = [];
  if (swrRise > DRIFT_SWR) parts.push(`lowest SWR rose from ${baseline.summary.minSwr.toFixed(2)} to ${latest.summary.minSwr.toFixed(2)}`);
  if (resonanceShift !== null && Math.abs(resonanceShift) > DRIFT_RESONANCE) {
    parts.push(`resonance moved ${resonanceShift > 0 ? "up" : "down"} ${(Math.abs(resonanceShift) * 100).toFixed(1)}% to ${(b! / 1e6).toFixed(3)} MHz`);
  }
  if (parts.length === 0) return null;
  const hint =
    swrRise > DRIFT_SWR
      ? "Check connectors and the feedline for water or damage."
      : "Something changed: wire stretch, sag, or nearby objects.";
  return { swrRise, resonanceShift, message: `Since the baseline, ${parts.join(" and ")}. ${hint}` };
}

// ---------- settings ----------

const SETTINGS_KEY = "settings";

export async function loadSettings(store: Store): Promise<Settings> {
  const s = await store.get<{ id: string; value: Partial<Settings> }>("kv", SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...s?.value, thresholds: { ...DEFAULT_SETTINGS.thresholds, ...s?.value?.thresholds } };
}

export async function saveSettings(store: Store, settings: Settings): Promise<void> {
  if (!(settings.thresholds.good >= 1 && settings.thresholds.usable >= settings.thresholds.good)) {
    throw new Error("The usable SWR limit must be at least the good limit.");
  }
  await store.put("kv", { id: SETTINGS_KEY, value: settings });
}

// ---------- backup ----------

export interface Backup {
  app: "resonance";
  version: 1;
  exportedAt: string;
  settings: Settings;
  calibrations: SavedCalibration[];
  profiles: AntennaProfile[];
  sweeps: SavedSweep[];
  activeCalibrationId: string | null;
}

export async function exportBackup(store: Store): Promise<Backup> {
  const active = await store.get<{ id: string; value: string }>("kv", "activeCalibration");
  return {
    app: "resonance",
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: await loadSettings(store),
    calibrations: await store.getAll("calibrations"),
    profiles: await store.getAll("profiles"),
    sweeps: await store.getAll("sweeps"),
    activeCalibrationId: active?.value ?? null,
  };
}

/** Merge a backup in (records with the same id are replaced). Returns counts. */
export async function importBackup(store: Store, data: unknown): Promise<{ profiles: number; sweeps: number; calibrations: number }> {
  const b = data as Partial<Backup>;
  if (!b || b.app !== "resonance" || b.version !== 1) throw new Error("That file isn't a Resonance backup.");
  const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
  const profiles = arr<AntennaProfile>(b.profiles).filter((p) => typeof p.id === "string" && typeof p.name === "string");
  const sweeps = arr<SavedSweep>(b.sweeps).filter((s) => typeof s.id === "string" && Array.isArray(s.freqHz));
  const cals = arr<SavedCalibration>(b.calibrations).filter((c) => typeof c.id === "string" && Array.isArray(c.freqHz));
  for (const p of profiles) await store.put("profiles", p);
  for (const s of sweeps) await store.put("sweeps", s);
  for (const c of cals) await store.put("calibrations", c);
  if (b.settings) await saveSettings(store, { ...DEFAULT_SETTINGS, ...b.settings });
  if (b.activeCalibrationId && cals.some((c) => c.id === b.activeCalibrationId)) {
    await store.put("kv", { id: "activeCalibration", value: b.activeCalibrationId });
  }
  return { profiles: profiles.length, sweeps: sweeps.length, calibrations: cals.length };
}

/** Rough storage used, in bytes. */
export async function storageUsed(store: Store): Promise<number> {
  let n = 0;
  for (const name of ["calibrations", "profiles", "sweeps", "kv"] as const) n += JSON.stringify(await store.getAll(name)).length;
  return n;
}

// ---------- units ----------

export function formatLength(m: number, units: Units): string {
  if (units === "imperial") {
    const inches = m / 0.0254;
    if (Math.abs(inches) < 24) return `${inches.toFixed(1)} in`;
    return `${(m / 0.3048).toFixed(1)} ft`;
  }
  if (Math.abs(m) < 0.01) return `${(m * 1000).toFixed(0)} mm`;
  if (Math.abs(m) < 1) return `${(m * 100).toFixed(1)} cm`;
  return `${m.toFixed(2)} m`;
}

export const parseLength = (text: string, units: Units): number | undefined => {
  const v = Number(text.trim());
  if (text.trim() === "" || !Number.isFinite(v)) return undefined;
  return units === "imperial" ? v * 0.3048 : v;
};
