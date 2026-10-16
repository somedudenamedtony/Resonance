/**
 * Calibration as the app stores and applies it. The math lives in @resonance/analysis;
 * this file handles persistence, staleness and the guided open/short/load session.
 */
import {
  buildCalibration,
  type Calibration,
  checkStandard,
  type Complex,
  correctSweep,
  covers,
  type StandardCheck,
  type StandardKind,
  type Sweep,
} from "@resonance/analysis";
import type { BridgeClient, ScanProgress } from "./bridge/client";
import type { DeviceStatus } from "./bridge/protocol";
import { newId } from "./storage";

/** One calibration covers HF and 6m: 50 kHz–60 MHz at 1001 points (spec: Analysis). */
export const CAL_RANGE = { startHz: 50_000, stopHz: 60_000_000, points: 1001 } as const;
export const CAL_MAX_AGE_DAYS = 7;
export const CAL_STEPS: readonly StandardKind[] = ["open", "short", "load"];

/** Stored form: plain arrays so it survives IndexedDB and JSON export. */
export interface SavedCalibration {
  id: string;
  createdAt: number;
  startHz: number;
  stopHz: number;
  points: number;
  freqHz: number[];
  /** Interleaved [re, im, re, im, ...] per term. */
  ed: number[];
  es: number[];
  er: number[];
  device: { model?: string; firmware?: string };
}

const flat = (xs: readonly Complex[]) => xs.flatMap((z) => [z.re, z.im]);
const unflat = (xs: readonly number[]): Complex[] => {
  const out: Complex[] = [];
  for (let i = 0; i < xs.length; i += 2) out.push({ re: xs[i]!, im: xs[i + 1]! });
  return out;
};

export function saveForm(cal: Calibration, device: DeviceStatus | null, now = Date.now()): SavedCalibration {
  const f = cal.freqHz;
  return {
    id: newId("cal"),
    createdAt: now,
    startHz: f[0]!,
    stopHz: f[f.length - 1]!,
    points: f.length,
    freqHz: [...f],
    ed: flat(cal.terms.map((t) => t.ed)),
    es: flat(cal.terms.map((t) => t.es)),
    er: flat(cal.terms.map((t) => t.er)),
    device: { model: device?.model, firmware: device?.firmware },
  };
}

export function loadForm(s: SavedCalibration): Calibration {
  const ed = unflat(s.ed);
  const es = unflat(s.es);
  const er = unflat(s.er);
  return { freqHz: s.freqHz, terms: s.freqHz.map((_, i) => ({ ed: ed[i]!, es: es[i]!, er: er[i]! })) };
}

export type CalState =
  | { state: "none" }
  | { state: "ok"; ageDays: number }
  | { state: "stale"; ageDays: number; reason: "age" | "device" };

export function calState(saved: SavedCalibration | null, device: DeviceStatus | null, now = Date.now()): CalState {
  if (!saved) return { state: "none" };
  const ageDays = (now - saved.createdAt) / 86_400_000;
  if (device?.connected && device.model && (saved.device.model !== device.model || saved.device.firmware !== device.firmware)) {
    return { state: "stale", ageDays, reason: "device" };
  }
  if (ageDays > CAL_MAX_AGE_DAYS) return { state: "stale", ageDays, reason: "age" };
  return { state: "ok", ageDays };
}

/** Correct a raw sweep if the calibration covers it. */
export function applyCalibration(
  cal: Calibration | null,
  raw: Sweep,
): { sweep: Sweep; calibrated: boolean } {
  const n = raw.freqHz.length;
  if (!cal || n === 0 || !covers(cal, raw.freqHz[0]!, raw.freqHz[n - 1]!)) return { sweep: raw, calibrated: false };
  return { sweep: { freqHz: raw.freqHz, s11: correctSweep(cal, raw.freqHz, raw.s11) }, calibrated: true };
}

/** Guided open/short/load. UI-free so it can be driven by tests against the emulator. */
export class CalibrationSession {
  private measured: Partial<Record<StandardKind, Sweep>> = {};

  /** Step index of the first standard not yet measured, or CAL_STEPS.length when done. */
  get step(): number {
    const i = CAL_STEPS.findIndex((k) => !this.measured[k]);
    return i < 0 ? CAL_STEPS.length : i;
  }

  get done(): boolean {
    return this.step === CAL_STEPS.length;
  }

  /** Scan the attached standard. Rejects the reading (and keeps the step) if it looks wrong. */
  async measure(
    client: BridgeClient,
    kind: StandardKind,
    onProgress?: (p: ScanProgress) => void,
  ): Promise<StandardCheck> {
    const sweep = await client.scan({ ...CAL_RANGE }, onProgress, 30_000);
    const check = checkStandard(kind, sweep.s11[0]!);
    if (check.ok) this.measured[kind] = sweep;
    return check;
  }

  /** Forget a step so it can be measured again. */
  redo(kind: StandardKind): void {
    delete this.measured[kind];
  }

  finish(): Calibration {
    const { open, short, load } = this.measured;
    if (!open || !short || !load) throw new Error("measure open, short and load first");
    return buildCalibration(open.freqHz, open.s11, short.s11, load.s11);
  }
}
