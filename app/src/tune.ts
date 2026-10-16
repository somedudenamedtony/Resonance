/**
 * Trim coach session (spec: Features > Tune antenna). UI-free so tests can drive it.
 * Each reading: sweep around the target, find resonance, turn it into one cut instruction.
 */
import {
  type AntennaType,
  analyze,
  type Band,
  bandCenterHz,
  type Calibration,
  estimateElementLengthM,
  swr,
  type Sweep,
  trimInstruction,
  type TrimInstruction,
} from "@resonance/analysis";
import type { BridgeClient } from "./bridge/client";
import { applyCalibration } from "./cal";

export const TUNE_POINTS = 201;
/** Sweep ±15% around the target so a badly-off antenna's resonance is still in view. */
export const TUNE_SPAN = 0.15;
export const DONE_TOLERANCE = 0.005;

export interface TuneSetup {
  band: Band;
  type: AntennaType;
  targetHz: number;
  /** Current element length in meters, if known (per leg for a dipole). */
  elementLengthM?: number;
}

export interface TuneReading {
  at: number;
  /** Best estimate of resonance. `bound` says when it lies beyond the sweep edge. */
  resonanceHz: number;
  bound: "exact" | "below" | "above";
  swrAtTarget: number;
  minSwr: number;
  instruction: TrimInstruction;
  /** Compared with the previous reading. */
  trend: "closer" | "further" | "same" | null;
  calibrated: boolean;
  sweep: Sweep;
}

export interface CutLogEntry {
  n: number;
  instruction: string;
  action: "shorten" | "lengthen";
  amountM: number;
  /** Resonance after the cut. */
  resultHz: number | null;
}

export function tuneRange(targetHz: number): { startHz: number; stopHz: number } {
  return {
    startHz: Math.max(50_000, Math.round(targetHz * (1 - TUNE_SPAN))),
    stopHz: Math.round(targetHz * (1 + TUNE_SPAN)),
  };
}

export function defaultSetup(band: Band, type: AntennaType = "dipole"): TuneSetup {
  return { band, type, targetHz: bandCenterHz(band) };
}

/** Turn one sweep into a reading. Pure. */
export function readTune(
  sweep: Sweep,
  setup: TuneSetup,
  elementLengthM: number | undefined,
  prev: TuneReading | null,
  calibrated: boolean,
): TuneReading {
  const m = analyze(sweep);
  const n = sweep.freqHz.length;
  let resonanceHz: number;
  let bound: TuneReading["bound"] = "exact";
  if (m.resonanceHz !== null) {
    resonanceHz = m.resonanceHz;
  } else if (m.min.index <= 2) {
    resonanceHz = sweep.freqHz[0]!;
    bound = "below";
  } else if (m.min.index >= n - 3) {
    resonanceHz = sweep.freqHz[n - 1]!;
    bound = "above";
  } else {
    resonanceHz = m.min.freqHz;
  }

  const instruction = trimInstruction({
    type: setup.type,
    resonanceHz,
    targetHz: setup.targetHz,
    elementLengthM,
    doneTolerance: DONE_TOLERANCE,
  });
  // Off the edge of the sweep, the real cut is bigger than computed: say "at least".
  const text = bound !== "exact" && instruction.action !== "done" ? `${instruction.text} or more` : instruction.text;

  // SWR at the target: nearest point.
  let k = 0;
  for (let i = 1; i < n; i++) if (Math.abs(sweep.freqHz[i]! - setup.targetHz) < Math.abs(sweep.freqHz[k]! - setup.targetHz)) k = i;

  let trend: TuneReading["trend"] = null;
  if (prev) {
    const before = Math.abs(prev.resonanceHz - setup.targetHz);
    const now = Math.abs(resonanceHz - setup.targetHz);
    trend = Math.abs(before - now) < setup.targetHz * 0.0005 ? "same" : now < before ? "closer" : "further";
  }

  return {
    at: Date.now(),
    resonanceHz,
    bound,
    swrAtTarget: swr(sweep.s11[k]!),
    minSwr: m.min.swr,
    instruction: { ...instruction, text },
    trend,
    calibrated,
    sweep,
  };
}

/** A tuning session: holds the setup, the latest reading and the cut log. */
export class TuneSession {
  reading: TuneReading | null = null;
  readonly log: CutLogEntry[] = [];
  /** Known or tracked element length; undefined means "estimate from resonance". */
  private lengthM: number | undefined;

  constructor(
    readonly setup: TuneSetup,
    private readonly cal: () => Calibration | null,
  ) {
    this.lengthM = setup.elementLengthM;
  }

  get elementLengthM(): number {
    return this.lengthM ?? estimateElementLengthM(this.setup.type, this.reading?.resonanceHz ?? this.setup.targetHz);
  }

  get lengthIsEstimate(): boolean {
    return this.lengthM === undefined;
  }

  get done(): boolean {
    return this.reading?.instruction.action === "done";
  }

  async sweep(client: BridgeClient): Promise<TuneReading> {
    const raw = await client.scan({ ...tuneRange(this.setup.targetHz), points: TUNE_POINTS });
    const { sweep, calibrated } = applyCalibration(this.cal(), raw);
    this.reading = readTune(sweep, this.setup, this.lengthM, this.reading, calibrated);
    const pending = this.log.at(-1);
    if (pending && pending.resultHz === null) pending.resultHz = this.reading.resonanceHz;
    return this.reading;
  }

  /**
   * The user made the recommended change. Records it and keeps a known length in step.
   * Returns the change in meters (positive = shortened) so a simulator can apply it.
   */
  madeTheCut(): number {
    const r = this.reading;
    if (!r || r.instruction.action === "done") return 0;
    const delta = r.instruction.action === "shorten" ? r.instruction.amountM : -r.instruction.amountM;
    if (this.lengthM !== undefined) this.lengthM -= delta;
    this.log.push({
      n: this.log.length + 1,
      instruction: r.instruction.text,
      action: r.instruction.action,
      amountM: r.instruction.amountM,
      resultHz: null,
    });
    return delta;
  }
}
