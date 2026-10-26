/**
 * Live SWR meter: SWR at one frequency, re-measured as fast as the NanoVNA allows, for
 * adjusting an antenna tuner. UI-free so tests can drive it.
 */
import {
  type Band,
  bandCenterHz,
  type Calibration,
  type Complex,
  impedance,
  returnLoss,
  type RlcAntenna,
  swr,
  type Sweep,
} from "@resonance/analysis";
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

/**
 * Simulator only: the pretend antenna for a tuner knob position, -100..100. Centered (0) it is
 * the antenna as connected, so the meter agrees with a sweep of it; turning either way moves its
 * resonance and raises its resistance, like a tuner knob off its best spot.
 */
export function simTunerAntenna(base: RlcAntenna, knob: number): RlcAntenna {
  if (knob === 0) return base;
  return { ...base, f0Hz: base.f0Hz * (1 + knob / 1000), r: base.r + Math.abs(knob) / 2 };
}

export interface MeterPreset {
  label: string;
  freqHz: number;
}

const k = (v: number) => Math.round(v * 1000);
/** Common US dial frequencies, kHz. Digital modes are the usual USB dial frequencies. */
const PRESETS_KHZ: Record<string, [string, number][]> = {
  "160m": [["FT8", 1840], ["CW", 1810], ["SSB", 1900]],
  "80m": [["FT8", 3573], ["FT4", 3575], ["CW", 3530], ["SSB", 3850]],
  "60m": [["FT8", 5357], ["Ch 1", 5332], ["Ch 5", 5405]],
  "40m": [["FT8", 7074], ["FT4", 7047.5], ["CW", 7030], ["SSB", 7200]],
  "30m": [["FT8", 10136], ["FT4", 10140], ["CW", 10110]],
  "20m": [["FT8", 14074], ["FT4", 14080], ["CW", 14030], ["SSB", 14250]],
  "17m": [["FT8", 18100], ["FT4", 18104], ["CW", 18080], ["SSB", 18140]],
  "15m": [["FT8", 21074], ["FT4", 21140], ["CW", 21030], ["SSB", 21300]],
  "12m": [["FT8", 24915], ["FT4", 24919], ["CW", 24900], ["SSB", 24950]],
  "10m": [["FT8", 28074], ["FT4", 28180], ["CW", 28030], ["SSB", 28400]],
  "6m": [["FT8", 50313], ["FT4", 50318], ["CW", 50090], ["SSB", 50125]],
  "2m": [["FT8", 144174], ["SSB", 144200], ["FM", 146520]],
};

/** Presets for a band: its mode frequencies, then the band center. */
export function presetsFor(band: Band): MeterPreset[] {
  const modes = (PRESETS_KHZ[band.id] ?? []).map(([label, khz]) => ({ label, freqHz: k(khz) }));
  return [...modes, { label: "Center", freqHz: bandCenterHz(band) }];
}

export function bandOf(bands: readonly Band[], freqHz: number): Band | undefined {
  return bands.find((b) => freqHz >= b.startHz && freqHz <= b.stopHz);
}
