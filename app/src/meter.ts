/**
 * Live SWR meter: SWR at one frequency, re-measured as fast as the NanoVNA allows, for
 * adjusting an antenna tuner. UI-free so tests can drive it.
 */
import { type Calibration, type Complex, impedance, returnLoss, swr, type Sweep } from "@resonance/analysis";
import type { BridgeClient } from "./bridge/client";
import { applyCalibration } from "./cal";

/** A handful of points keeps each scan short; the bridge needs at least 2 and stop > start. */
export const METER_POINTS = 5;
/** Half-width of the tiny window around the frequency. Narrow enough to be "one frequency". */
export const METER_HALF_SPAN_HZ = 2_000;
/** Readings kept for the trace under the needle. */
export const METER_HISTORY = 120;

export interface MeterReading {
  at: number;
  freqHz: number;
  gamma: Complex;
  swr: number;
  z: Complex;
  returnLossDb: number;
  calibrated: boolean;
}

export function meterRange(freqHz: number): { startHz: number; stopHz: number; points: number } {
  return {
    startHz: Math.max(1, Math.round(freqHz - METER_HALF_SPAN_HZ)),
    stopHz: Math.round(freqHz + METER_HALF_SPAN_HZ),
    points: METER_POINTS,
  };
}

/** Turn one tiny sweep into a reading. Averages Γ across the window to steady the number. Pure. */
export function readMeter(sweep: Sweep, freqHz: number, calibrated: boolean, at = Date.now()): MeterReading {
  const n = sweep.s11.length;
  if (n === 0) throw new Error("empty sweep");
  let re = 0;
  let im = 0;
  for (const g of sweep.s11) {
    re += g.re;
    im += g.im;
  }
  const gamma = { re: re / n, im: im / n };
  return { at, freqHz, gamma, swr: swr(gamma), z: impedance(gamma), returnLossDb: returnLoss(gamma), calibrated };
}

/**
 * Needle position for an SWR, 0..1. Linear in |Γ| like an analog SWR meter, so the low end
 * (where tuning happens) gets most of the scale: 1.5 sits at 0.2, 2 at 0.33, 3 at 0.5.
 */
export function needleFraction(s: number): number {
  if (!Number.isFinite(s)) return 1;
  if (s <= 1) return 0;
  return (s - 1) / (s + 1);
}

/** One meter session: the frequency, the latest reading, the best seen and a short history. */
export class MeterSession {
  reading: MeterReading | null = null;
  best: MeterReading | null = null;
  readonly history: MeterReading[] = [];

  constructor(
    readonly freqHz: number,
    private readonly cal: () => Calibration | null,
  ) {}

  async measure(client: BridgeClient): Promise<MeterReading> {
    const raw = await client.scan(meterRange(this.freqHz), undefined, 5_000);
    const { sweep, calibrated } = applyCalibration(this.cal(), raw);
    const r = readMeter(sweep, this.freqHz, calibrated);
    this.reading = r;
    if (!this.best || r.swr < this.best.swr) this.best = r;
    this.history.push(r);
    if (this.history.length > METER_HISTORY) this.history.splice(0, this.history.length - METER_HISTORY);
    return r;
  }

  resetBest(): void {
    this.best = this.reading;
  }

  /** Readings per second over the last few seconds, or null before there are enough. */
  get rate(): number | null {
    const h = this.history;
    if (h.length < 3) return null;
    const recent = h.filter((r) => r.at >= h[h.length - 1]!.at - 3_000);
    if (recent.length < 3) return null;
    const dt = recent[recent.length - 1]!.at - recent[0]!.at;
    return dt > 0 ? ((recent.length - 1) * 1000) / dt : null;
  }
}

