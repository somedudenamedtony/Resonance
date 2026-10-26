/**
 * Find resonance anywhere the NanoVNA reaches, not just the ham bands: a coarse sweep in log-spaced
 * pieces, the SWR dips in it, then a close look at the deepest few. UI-free so tests can drive it.
 */
import {
  analyze,
  type Bandwidth,
  type Calibration,
  type Dip,
  findDips,
  joinSweeps,
  MIN_SCAN_HZ,
  type Range,
  swr,
  type Sweep,
  wideChunks,
  zoomRange,
} from "@resonance/analysis";
import type { BridgeClient } from "./bridge/client";
import type { DeviceStatus } from "./bridge/protocol";
import { applyCalibration, CAL_RANGE } from "./cal";

export const FIND_CHUNK_POINTS = 201;
export const ZOOM_POINTS = 201;
/** Dips that get a close look after the coarse sweep. */
export const ZOOM_DIPS = 3;
/** "Around a target" sweeps this far either side of it. */
export const TARGET_SPAN = 0.25;
/** Above this the NanoVNA-H measures on harmonics of its oscillator: less dynamic range, more noise. */
export const HARMONIC_HZ = 900_000_000;
/** Within this of the target counts as on target. */
export const ON_TARGET = 0.005;

/**
 * Highest frequency to offer for this NanoVNA. The NanoVNA-H and H4 (and most clones) are specified
 * to 1.5 GHz; the LiteVNA and NanoVNA-F V2/V3 reach further. Unknown models get the safe 1.5 GHz.
 */
export function deviceMaxHz(device: Pick<DeviceStatus, "model"> | null | undefined): number {
  const m = device?.model ?? "";
  if (/litevna/i.test(m)) return 6_000_000_000;
  if (/nanovna-f\s*v[23]|sysjoint|saa-?2|v2/i.test(m)) return 3_000_000_000;
  return 1_500_000_000;
}

export const fullRange = (device: Pick<DeviceStatus, "model"> | null | undefined): Range => ({
  startHz: MIN_SCAN_HZ,
  stopHz: deviceMaxHz(device),
});

export function targetRange(targetHz: number, maxHz: number): Range {
  return {
    startHz: Math.max(MIN_SCAN_HZ, Math.round(targetHz * (1 - TARGET_SPAN))),
    stopHz: Math.min(maxHz, Math.round(targetHz * (1 + TARGET_SPAN))),
  };
}

/** A frequency as a number and its unit: 1090 MHz, 14.175 MHz, 475 kHz, 1.5 GHz. Trailing zeros dropped. */
export function hzParts(hz: number): { value: string; unit: "kHz" | "MHz" | "GHz" } {
  const trim = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
  if (hz < 1e6) return { value: trim((hz / 1e3).toFixed(1)), unit: "kHz" };
  if (hz >= 1e9 && hz % 1e8 === 0) return { value: trim((hz / 1e9).toFixed(1)), unit: "GHz" };
  return { value: trim((hz / 1e6).toFixed(hz >= 1e8 ? 1 : 3)), unit: "MHz" };
}

export function formatHz(hz: number): string {
  const p = hzParts(hz);
  return `${p.value} ${p.unit}`;
}

/** Parse a frequency typed in MHz. Undefined unless it's a positive number. */
export function parseMhz(text: string): number | undefined {
  const t = text.trim().replace(",", ".");
  const v = Number(t);
  return t !== "" && Number.isFinite(v) && v > 0 ? Math.round(v * 1e6) : undefined;
}

/** Why a range can't be swept on this device, or null when it's fine. */
export function rangeProblem(range: Range, maxHz: number): string | null {
  if (!(range.stopHz > range.startHz)) return "The stop frequency has to be above the start.";
  if (range.startHz < MIN_SCAN_HZ) return `Start at ${formatHz(MIN_SCAN_HZ)} or higher.`;
  if (range.stopHz > maxHz) return `This NanoVNA tops out at ${formatHz(maxHz)}.`;
  if (range.stopHz - range.startHz < 10_000) return "Make the range at least 10 kHz wide.";
  return null;
}

export interface Zoom {
  range: Range;
  sweep: Sweep;
  calibrated: boolean;
  /** Where SWR is lowest on the close look: the frequency the antenna works best at. */
  bestHz: number;
  bestSwr: number;
  bw2: Bandwidth | null;
}

export interface FoundDip {
  /** As seen on the coarse sweep. */
  dip: Dip;
  zoom?: Zoom;
}

export interface FindResult {
  range: Range;
  targetHz?: number;
  coarse: Sweep;
  calibrated: boolean;
  dips: FoundDip[];
  at: number;
}

export interface FindProgress {
  /** Coarse sweep so far. */
  partial: Sweep;
  /** 0..1 over the coarse sweep and the close looks. */
  fraction: number;
  stage: "coarse" | "zoom";
}

/** Best frequency and SWR of a dip: the close look if there is one, else the coarse reading. */
export const dipHz = (d: FoundDip) => d.zoom?.bestHz ?? d.dip.freqHz;
export const dipSwr = (d: FoundDip) => d.zoom?.bestSwr ?? d.dip.swr;

async function sweepRange(
  client: BridgeClient,
  range: Range,
  points: number,
  cal: Calibration | null,
  onPartial?: (s: Sweep) => void,
): Promise<{ sweep: Sweep; calibrated: boolean }> {
  const raw = await client.scan({ ...range, points }, (p) =>
    onPartial?.(applyCalibration(cal, { freqHz: [...p.partial.freqHz], s11: [...p.partial.s11] }).sweep),
  );
  return applyCalibration(cal, raw);
}

/** Close look at one dip found on the coarse sweep. */
export async function zoomDip(client: BridgeClient, dip: Dip, coarse: Sweep, cal: Calibration | null): Promise<Zoom> {
  const range = zoomRange(dip, coarse);
  const { sweep, calibrated } = await sweepRange(client, range, ZOOM_POINTS, cal);
  const m = analyze(sweep);
  return { range, sweep, calibrated, bestHz: m.min.freqHz, bestSwr: m.min.swr, bw2: m.bw2 };
}

/** Coarse sweep over `range`, find the dips, zoom on the deepest few (and the one nearest the target). */
export async function findResonance(
  client: BridgeClient,
  range: Range,
  cal: Calibration | null,
  opts: { targetHz?: number; onProgress?: (p: FindProgress) => void } = {},
): Promise<FindResult> {
  const chunks = wideChunks(range);
  const total = chunks.length + ZOOM_DIPS;
  const parts: Sweep[] = [];
  let calibrated = true;
  for (let i = 0; i < chunks.length; i++) {
    const r = await sweepRange(client, chunks[i]!, FIND_CHUNK_POINTS, cal, (s) =>
      opts.onProgress?.({
        partial: joinSweeps([...parts, s]),
        fraction: (i + s.freqHz.length / FIND_CHUNK_POINTS) / total,
        stage: "coarse",
      }),
    );
    parts.push(r.sweep);
    calibrated &&= r.calibrated;
  }
  const coarse = joinSweeps(parts);
  const dips: FoundDip[] = findDips(coarse).map((dip) => ({ dip }));

  // The deepest few, plus the one nearest the target if it isn't among them.
  const picks = dips.slice(0, ZOOM_DIPS);
  const near = opts.targetHz ? nearestDip(dips, opts.targetHz) : undefined;
  if (near && !picks.includes(near)) picks[picks.length - 1] = near;
  for (let i = 0; i < picks.length; i++) {
    opts.onProgress?.({ partial: coarse, fraction: (chunks.length + i) / total, stage: "zoom" });
    picks[i]!.zoom = await zoomDip(client, picks[i]!.dip, coarse, cal);
  }
  return { range, targetHz: opts.targetHz, coarse, calibrated, dips, at: Date.now() };
}

/** The dip closest to `targetHz`, on a ratio scale. */
export function nearestDip(dips: readonly FoundDip[], targetHz: number): FoundDip | undefined {
  let best: FoundDip | undefined;
  for (const d of dips) {
    if (!best || Math.abs(Math.log(dipHz(d) / targetHz)) < Math.abs(Math.log(dipHz(best) / targetHz))) best = d;
  }
  return best;
}

/** SWR at a frequency from the closest-spaced sweep that covers it. */
export function swrAt(result: FindResult, hz: number): number | null {
  const sweeps = [...result.dips.flatMap((d) => (d.zoom ? [d.zoom.sweep] : [])), result.coarse];
  for (const s of sweeps) {
    const f = s.freqHz;
    if (f.length < 2 || hz < f[0]! || hz > f[f.length - 1]!) continue;
    let k = 0;
    for (let i = 1; i < f.length; i++) if (Math.abs(f[i]! - hz) < Math.abs(f[k]! - hz)) k = i;
    return swr(s.s11[k]!);
  }
  return null;
}

/** The plain-English answer, like a check's verdict. */
export function findHeadline(result: FindResult): { headline: string; detail: string } {
  const span = `${formatHz(result.range.startHz)} and ${formatHz(result.range.stopHz)}`;
  const fmtSwr = (s: number) => (Number.isFinite(s) && s < 10 ? s.toFixed(2) : "over 10");
  if (result.dips.length === 0) {
    const m = analyze(result.coarse);
    return {
      headline: `No clear resonance between ${span}`,
      detail: `SWR stays above ${fmtSwr(m.min.swr)}. Try a wider range, or check the feedline and connectors.`,
    };
  }
  const t = result.targetHz;
  if (t) {
    const d = nearestDip(result.dips, t)!;
    const hz = dipHz(d);
    const off = (hz - t) / t;
    const at = swrAt(result, t);
    const atTarget = at !== null ? ` SWR at ${formatHz(t)} is ${fmtSwr(at)}.` : "";
    if (Math.abs(off) <= ON_TARGET) {
      return { headline: `Resonant on target, at ${formatHz(hz)}`, detail: `Lowest SWR ${fmtSwr(dipSwr(d))}.${atTarget}` };
    }
    const pct = (Math.abs(off) * 100).toFixed(Math.abs(off) < 0.1 ? 1 : 0);
    const why = off < 0 ? "Below the target usually means the antenna is a little long." : "Above the target usually means the antenna is a little short.";
    return {
      headline: `Resonant at ${formatHz(hz)}, ${pct}% ${off < 0 ? "below" : "above"} ${formatHz(t)}`,
      detail: `Lowest SWR there ${fmtSwr(dipSwr(d))}.${atTarget} ${why}`,
    };
  }
  const best = result.dips[0]!;
  const others = result.dips.length - 1;
  return {
    headline: `Resonant at ${formatHz(dipHz(best))}`,
    detail: `Lowest SWR ${fmtSwr(dipSwr(best))}.${others ? ` ${others} more dip${others > 1 ? "s" : ""} listed below.` : ""}`,
  };
}

/** Accuracy notes for a range, in the order they matter. */
export function rangeNotes(range: Range, calibrated: boolean): string[] {
  const notes: string[] = [];
  if (range.stopHz > HARMONIC_HZ) {
    notes.push(
      "Above about 900 MHz the NanoVNA measures on harmonics, so readings are noisier and dips look shallower than they are. Where a dip sits is more trustworthy than how deep it is.",
    );
  }
  if (!calibrated && range.stopHz > CAL_RANGE.stopHz) {
    notes.push(
      `The app's calibration covers up to ${formatHz(CAL_RANGE.stopHz)}, so above that these readings use the NanoVNA's own calibration. Calibrate on the NanoVNA itself over this range for the best numbers.`,
    );
  }
  return notes;
}
