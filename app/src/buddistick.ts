/**
 * Buddistick coach: a loaded vertical with a tapped coil, a telescoping whip and one counterpoise
 * (radial) wire. UI-free so tests can drive it.
 *
 * Each reading sweeps around the target, finds resonance and the resistance there, then picks
 * the one adjustment that matters next, the way Buddipole's manuals tune it:
 *   1. Coil tap for big moves. The closer the clip to the whip, the higher the frequency.
 *   2. Whip length to fine tune. Too low in frequency means the antenna is too long.
 *   3. Radial slope for the match, once it resonates on target.
 * After each change it compares the move with what it asked for, so the next step is sized for
 * this antenna, not a textbook one.
 */
import {
  analyze,
  type Band,
  bandCenterHz,
  type Calibration,
  type Complex,
  impedance,
  swr,
  type Sweep,
} from "@resonance/analysis";
import type { BridgeClient } from "./bridge/client";
import { applyCalibration } from "./cal";
import { tuneRange, TUNE_POINTS } from "./tune";

/** Bands a Buddistick covers (Buddipole: 40m through 6m). */
export const BUDDI_BANDS = ["40m", "30m", "20m", "17m", "15m", "12m", "10m", "6m"] as const;

/** Within this of the target, resonance is "on frequency". */
export const ON_FREQ = 0.005;
/** Off by more than this and the whip alone won't get there: move the coil tap. */
export const COIL_STEP = 0.04;
/** Good enough to stop: SWR at the target at or under this, resonance on frequency. */
export const DONE_SWR = 1.5;
/** Resistance window around 50 Ω that counts as a match. */
const R_LOW = 40;
const R_HIGH = 62;

/** First guesses before anything is learned. */
const DEFAULT_TURN_SHIFT = 0.03;
/** A loaded whip moves resonance less per inch than a full-size one: about half. */
const WHIP_FACTOR = 0.5;

export interface BandStart {
  coil: string;
  whip: string;
  coilOut: boolean;
}

/**
 * Where to start on each band, from the Buddistick manuals. Exact tap turns vary by coil and
 * site, so these are starting points; what you save after tuning replaces them.
 */
export const BAND_STARTS: Record<(typeof BUDDI_BANDS)[number], BandStart> = {
  "40m": { coil: "Whole coil in (clip at the end away from the whip)", whip: "All sections out except the last one", coilOut: false },
  "30m": { coil: "Most of the coil in", whip: "Fully extended", coilOut: false },
  "20m": { coil: "Clip about 15 turns in from the whip side", whip: "Fully extended", coilOut: false },
  "17m": { coil: "Clip a few turns closer to the whip than 20m", whip: "Fully extended", coilOut: false },
  "15m": { coil: "Clip closer to the whip again", whip: "Fully extended", coilOut: false },
  "12m": { coil: "Only a few turns in, near the whip end", whip: "Fully extended", coilOut: false },
  "10m": { coil: "Coil out, whip only", whip: "Fully extended", coilOut: true },
  "6m": { coil: "Coil out, whip only", whip: "Partly collapsed", coilOut: true },
};

/** Quarter wavelength in free space, meters. The counterpoise starts here. */
export const quarterWaveM = (hz: number) => 299_792_458 / hz / 4;

export interface BuddiSetup {
  band: Band;
  targetHz: number;
  /** Coil out of the circuit (whip only), as on 10m and 6m. */
  coilOut: boolean;
}

export function buddiSetup(band: Band, targetHz = bandCenterHz(band)): BuddiSetup {
  const start = BAND_STARTS[band.id as keyof typeof BAND_STARTS];
  return { band, targetHz, coilOut: start?.coilOut ?? false };
}

export type Advice =
  | { kind: "done" }
  | { kind: "coil"; dir: "toward" | "away"; turns: number; learned: boolean }
  /** Only when the coil is out and the whip, fully out, still can't get low enough. */
  | { kind: "coil-in" }
  | { kind: "whip"; dir: "shorten" | "lengthen"; amountM: number; learned: boolean }
  | { kind: "radial"; dir: "lower" | "raise"; r: number };

export interface BuddiReading {
  at: number;
  resonanceHz: number;
  bound: "exact" | "below" | "above";
  swrAtTarget: number;
  minSwr: number;
  /** Impedance at resonance (at the SWR dip if there's no zero crossing). */
  z: Complex;
  calibrated: boolean;
  sweep: Sweep;
}

export interface ChangeLogEntry {
  n: number;
  text: string;
  kind: "coil" | "whip" | "radial";
  /** Resonance before and after the change. */
  beforeHz: number;
  afterHz: number | null;
  swrAfter: number | null;
}

/** Turn one sweep into a reading. Pure. */
export function readBuddi(sweep: Sweep, targetHz: number, calibrated: boolean, at = Date.now()): BuddiReading {
  const m = analyze(sweep);
  const n = sweep.freqHz.length;
  let resonanceHz: number;
  let bound: BuddiReading["bound"] = "exact";
  if (m.resonanceHz !== null) resonanceHz = m.resonanceHz;
  else if (m.min.index <= 2) (resonanceHz = sweep.freqHz[0]!), (bound = "below");
  else if (m.min.index >= n - 3) (resonanceHz = sweep.freqHz[n - 1]!), (bound = "above");
  else resonanceHz = m.min.freqHz;

  const nearest = (f: number) => {
    let k = 0;
    for (let i = 1; i < n; i++) if (Math.abs(sweep.freqHz[i]! - f) < Math.abs(sweep.freqHz[k]! - f)) k = i;
    return k;
  };
  return {
    at,
    resonanceHz,
    bound,
    swrAtTarget: swr(sweep.s11[nearest(targetHz)]!),
    minSwr: m.min.swr,
    z: impedance(sweep.s11[nearest(resonanceHz)]!),
    calibrated,
    sweep,
  };
}

/** What this antenna has taught the session so far. */
export interface Learned {
  /** Fractional resonance shift per meter of whip (positive: shorter whip, higher frequency). */
  whipPerM?: number;
  /** Fractional resonance shift per coil turn. */
  perTurn?: number;
}

export interface AdviseOptions {
  learned?: Learned;
  /** The user says the whip can't go further this way; go to the coil instead. */
  whipAtLimit?: "shorten" | "lengthen" | null;
}

/** The one thing to change next. Pure. */
export function advise(r: BuddiReading, setup: BuddiSetup, opts: AdviseOptions = {}): Advice {
  const { learned = {}, whipAtLimit = null } = opts;
  // Positive: resonance is below the target, the antenna is too long, go up.
  const rel = (setup.targetHz - r.resonanceHz) / setup.targetHz;
  const off = Math.abs(rel);
  const goUp = rel > 0;

  // On frequency and matched, or so well matched at the target that chasing resonance won't help.
  if ((off <= ON_FREQ && r.swrAtTarget <= DONE_SWR) || (off <= 0.01 && r.swrAtTarget <= 1.25)) return { kind: "done" };
  if (off <= ON_FREQ) {
    const res = r.z.re;
    if (res < R_LOW) return { kind: "radial", dir: "lower", r: res };
    if (res > R_HIGH) return { kind: "radial", dir: "raise", r: res };
    // Resistance is fine but SWR isn't: it's reactance, so it's still a whip job.
  }

  const whipDir = goUp ? "shorten" : "lengthen";
  const coilNeeded = r.bound !== "exact" || off > COIL_STEP || whipAtLimit === whipDir;
  if (coilNeeded) {
    if (setup.coilOut) {
      // Whip only: it can shorten forever but can't grow past its full length.
      if (!goUp) return { kind: "coil-in" };
    } else {
      const per = learned.perTurn ?? DEFAULT_TURN_SHIFT;
      // Off the sweep edge the real shift is bigger; ask for at least a few turns.
      const want = r.bound === "exact" ? off : Math.max(off, 0.12);
      const turns = Math.max(1, Math.min(8, Math.round(want / per)));
      return { kind: "coil", dir: goUp ? "toward" : "away", turns, learned: learned.perTurn !== undefined };
    }
  }

  const perM = learned.whipPerM ?? WHIP_FACTOR / quarterWaveM(setup.targetHz);
  const amountM = Math.min(1.5, Math.max(0.005, off / perM));
  return { kind: "whip", dir: whipDir, amountM, learned: learned.whipPerM !== undefined };
}

/** A tuning session: the setup, the latest reading, the change log and what it has learned. */
export class BuddiSession {
  reading: BuddiReading | null = null;
  advice: Advice | null = null;
  readonly log: ChangeLogEntry[] = [];
  learned: Learned = {};
  whipAtLimit: AdviseOptions["whipAtLimit"] = null;
  /** The change the user said they made, waiting for the next reading. */
  private pending: { advice: Advice; beforeHz: number; exact: boolean } | null = null;
  /** The last change moved resonance the wrong way. */
  wrongWay = false;

  constructor(
    readonly setup: BuddiSetup,
    private readonly cal: () => Calibration | null,
  ) {}

  get done(): boolean {
    return this.advice?.kind === "done";
  }

  async measure(client: BridgeClient): Promise<BuddiReading> {
    const raw = await client.scan({ ...tuneRange(this.setup.targetHz), points: TUNE_POINTS });
    const { sweep, calibrated } = applyCalibration(this.cal(), raw);
    return this.take(readBuddi(sweep, this.setup.targetHz, calibrated));
  }

  /** Take a reading (from a sweep or a test). Learns from the change made since the last one. */
  take(r: BuddiReading): BuddiReading {
    this.reading = r;
    const p = this.pending;
    this.wrongWay = false;
    if (p) {
      this.pending = null;
      const entry = this.log.at(-1);
      if (entry) {
        entry.afterHz = r.resonanceHz;
        entry.swrAfter = r.swrAtTarget;
      }
      if (p.exact && r.bound === "exact") this.learn(p.advice, (r.resonanceHz - p.beforeHz) / p.beforeHz);
    }
    this.advice = advise(r, this.setup, { learned: this.learned, whipAtLimit: this.whipAtLimit });
    return r;
  }

  private learn(a: Advice, moved: number): void {
    if (a.kind === "whip") {
      const signed = a.dir === "shorten" ? moved : -moved;
      if (signed <= 0) this.wrongWay = Math.abs(moved) > 0.001;
      else this.learned.whipPerM = clampRatio(signed / a.amountM, this.learned.whipPerM);
    } else if (a.kind === "coil") {
      const signed = a.dir === "toward" ? moved : -moved;
      if (signed <= 0) this.wrongWay = Math.abs(moved) > 0.001;
      else this.learned.perTurn = clampRatio(signed / a.turns, this.learned.perTurn);
    }
  }

  /** The whip won't go further the way it was asked. Re-advise using the coil. */
  whipStuck(): void {
    if (this.advice?.kind !== "whip" || !this.reading) return;
    this.whipAtLimit = this.advice.dir;
    this.advice = advise(this.reading, this.setup, { learned: this.learned, whipAtLimit: this.whipAtLimit });
  }

  /**
   * The user made the change. Logs it; the next reading checks how far it moved resonance.
   * Returns the advice acted on, so a simulator can apply it.
   */
  madeTheChange(): Advice | null {
    const a = this.advice;
    const r = this.reading;
    if (!a || !r || a.kind === "done" || a.kind === "coil-in") return null;
    // A coil move resets the whip's limit: the whip has room again.
    if (a.kind === "coil") this.whipAtLimit = null;
    this.pending = { advice: a, beforeHz: r.resonanceHz, exact: r.bound === "exact" };
    this.log.push({ n: this.log.length + 1, text: changeText(a), kind: a.kind, beforeHz: r.resonanceHz, afterHz: null, swrAfter: null });
    return a;
  }
}

/** Blend a new measurement into what's known, ignoring wild outliers. */
function clampRatio(v: number, prev: number | undefined): number {
  if (prev === undefined) return v;
  const bounded = Math.min(prev * 4, Math.max(prev / 4, v));
  return (prev + bounded * 2) / 3;
}

/** Short past-tense line for the change log. Lengths are filled in by the screen. */
export function changeText(a: Advice): string {
  switch (a.kind) {
    case "coil":
      return `Moved the clip ${a.turns} turn${a.turns === 1 ? "" : "s"} ${a.dir === "toward" ? "toward" : "away from"} the whip`;
    case "whip":
      return a.dir === "shorten" ? "Shortened the whip" : "Lengthened the whip";
    case "radial":
      return a.dir === "lower" ? "Lowered the radial's far end" : "Raised the radial's far end";
    default:
      return "";
  }
}

/** Settings that worked on a band, saved so next time starts there. */
export interface SavedBuddiSettings {
  id: string;
  bandId: string;
  coil: string;
  whip: string;
  radial: string;
  resonanceHz: number;
  swr: number;
  at: number;
}

export const savedId = (bandId: string) => `buddistick:${bandId}`;

/**
 * Simulator only: what a change does to the pretend Buddistick. Real antennas don't move exactly
 * as asked, so the whip moves 70% as far and a coil turn 120%, which gives the learning something
 * to correct.
 */
export function simApply(
  a: Advice,
  ant: { f0Hz: number; r: number; q: number },
): { f0Hz: number; r: number; q: number } {
  switch (a.kind) {
    case "whip": {
      const perM = WHIP_FACTOR / quarterWaveM(ant.f0Hz);
      const shift = a.amountM * perM * 0.7 * (a.dir === "shorten" ? 1 : -1);
      return { ...ant, f0Hz: ant.f0Hz * (1 + shift) };
    }
    case "coil": {
      const shift = a.turns * DEFAULT_TURN_SHIFT * 1.2 * (a.dir === "toward" ? 1 : -1);
      return { ...ant, f0Hz: ant.f0Hz * (1 + shift) };
    }
    case "radial": {
      // Sloping the radial down raises the resistance; it also nudges resonance a little.
      const r = a.dir === "lower" ? ant.r + Math.max(6, (50 - ant.r) * 0.6) : ant.r - Math.max(6, (ant.r - 50) * 0.6);
      return { ...ant, r, f0Hz: ant.f0Hz * (a.dir === "lower" ? 0.996 : 1.004) };
    }
    default:
      return ant;
  }
}
