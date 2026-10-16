import { type Complex, add, c, mul } from "./complex";
import { fft, nextPow2 } from "./fft";
import { impedance, returnLoss, C0, Z0 } from "./rf";
import type { Sweep } from "./sweep";

export interface CoaxType {
  readonly id: string;
  readonly name: string;
  readonly velocityFactor: number;
  /** Typical matched loss, dB per 100 m at 10 MHz. Scales roughly with √f. */
  readonly lossDbPer100mAt10MHz: number;
}

/** Common 50 Ω feedlines. Typical published values; check your cable's datasheet. */
export const COAX_TYPES: readonly CoaxType[] = [
  { id: "rg58", name: "RG-58", velocityFactor: 0.66, lossDbPer100mAt10MHz: 4.6 },
  { id: "rg8x", name: "RG-8X", velocityFactor: 0.78, lossDbPer100mAt10MHz: 3.3 },
  { id: "rg213", name: "RG-213", velocityFactor: 0.66, lossDbPer100mAt10MHz: 2.0 },
  { id: "lmr240", name: "LMR-240", velocityFactor: 0.84, lossDbPer100mAt10MHz: 2.6 },
  { id: "lmr400", name: "LMR-400", velocityFactor: 0.85, lossDbPer100mAt10MHz: 1.3 },
  { id: "lmr600", name: "LMR-600", velocityFactor: 0.87, lossDbPer100mAt10MHz: 0.8 },
];

export function findCoaxType(id: string): CoaxType | undefined {
  return COAX_TYPES.find((t) => t.id === id);
}

/** Typical matched loss of `lengthM` of this cable at `fHz`, dB. */
export function typicalLossDb(type: CoaxType, lengthM: number, fHz: number): number {
  return (type.lossDbPer100mAt10MHz * Math.sqrt(fHz / 10e6) * lengthM) / 100;
}

/**
 * Line length from the first quarter-wave frequency of an open-ended line
 * (where the input first looks like a short): L = VF · c / (4 · f).
 */
export function lengthFromQuarterWave(quarterWaveHz: number, velocityFactor: number): number {
  if (!(quarterWaveHz > 0)) throw new RangeError("frequency must be positive");
  return (velocityFactor * C0) / (4 * quarterWaveHz);
}

/** Matched-line loss in dB estimated from the return loss of an open-ended line. */
export function lossFromOpenReturnLoss(returnLossDb: number): number {
  return returnLossDb / 2;
}

// ---------- physical model (simulator, emulator, tests) ----------

export interface CoaxModel {
  lengthM: number;
  velocityFactor: number;
  lossDbPer100mAt10MHz: number;
  /** What's at the far end: Γ as a function of frequency. */
  end: (fHz: number) => Complex;
  /** Small discontinuities along the line (kinks, water, bad splice). */
  faults?: { atM: number; gamma: number }[];
}

/** Γ at the input of a lossy line: sum of round-trip reflections (first-order). */
export function coaxGamma(m: CoaxModel, fHz: number): Complex {
  const beta = (2 * Math.PI * fHz) / (m.velocityFactor * C0);
  const alpha = (m.lossDbPer100mAt10MHz * Math.sqrt(fHz / 10e6)) / 100 / 8.686; // Np/m
  const roundTrip = (d: number): Complex => {
    const mag = Math.exp(-2 * alpha * d);
    return c(mag * Math.cos(-2 * beta * d), mag * Math.sin(-2 * beta * d));
  };
  let g: Complex = c(0);
  let through = 1;
  for (const f of [...(m.faults ?? [])].sort((a, b) => a.atM - b.atM)) {
    g = add(g, mul(c(f.gamma * through), roundTrip(f.atM)));
    through *= 1 - f.gamma * f.gamma;
  }
  return add(g, mul(mul(c(through), m.end(fHz)), roundTrip(m.lengthM)));
}

export const OPEN_END = () => c(1);
export const SHORT_END = () => c(-1);

// ---------- measurement ----------

/**
 * First frequency where an open-ended line looks like a short (quarter wave): reactance
 * crosses zero going from negative to positive while resistance is low. Null if not found.
 */
export function firstQuarterWaveHz(sweep: Sweep, z0 = Z0): number | null {
  const z = sweep.s11.map((g) => impedance(g, z0));
  for (let i = 1; i < z.length; i++) {
    const x0 = z[i - 1]!.im;
    const x1 = z[i]!.im;
    if (x0 < 0 && x1 >= 0 && Math.max(z[i - 1]!.re, z[i]!.re) < z0) {
      const t = x0 / (x0 - x1);
      return sweep.freqHz[i - 1]! + t * (sweep.freqHz[i]! - sweep.freqHz[i - 1]!);
    }
  }
  return null;
}

/** Return loss averaged over a few points near `fHz`, dB. */
function returnLossNear(sweep: Sweep, fHz: number, halfWidth = 3): number {
  let k = 0;
  for (let i = 1; i < sweep.freqHz.length; i++) if (Math.abs(sweep.freqHz[i]! - fHz) < Math.abs(sweep.freqHz[k]! - fHz)) k = i;
  let sum = 0;
  let n = 0;
  for (let i = Math.max(0, k - halfWidth); i <= Math.min(sweep.freqHz.length - 1, k + halfWidth); i++) {
    sum += returnLoss(sweep.s11[i]!);
    n++;
  }
  return sum / n;
}

export interface TdrResult {
  distanceM: number[];
  /** Approximate |Γ| of the reflection at each distance. */
  reflection: number[];
  resolutionM: number;
  maxRangeM: number;
}

/**
 * Band-pass time-domain reflectometry: Hann-windowed S11, zero-padded inverse FFT.
 * Needs an evenly spaced sweep. A reflection of size |Γ| at distance d shows as a peak of
 * height ≈ |Γ| at d.
 */
export function tdr(sweep: Sweep, velocityFactor: number, pad = 8192): TdrResult {
  const n = sweep.freqHz.length;
  if (n < 8) throw new RangeError("TDR needs at least 8 points");
  const df = (sweep.freqHz[n - 1]! - sweep.freqHz[0]!) / (n - 1);
  const m = nextPow2(Math.max(pad, n));
  const re = new Float64Array(m);
  const im = new Float64Array(m);
  let wsum = 0;
  for (let k = 0; k < n; k++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (n - 1));
    wsum += w;
    re[k] = sweep.s11[k]!.re * w;
    im[k] = sweep.s11[k]!.im * w;
  }
  fft(re, im, true); // e^{+j2πkn/M}
  const v = velocityFactor * C0;
  const distanceM: number[] = [];
  const reflection: number[] = [];
  for (let i = 0; i < m; i++) {
    distanceM.push(((i / (m * df)) * v) / 2);
    reflection.push(Math.hypot(re[i]!, im[i]!) / wsum);
  }
  const span = sweep.freqHz[n - 1]! - sweep.freqHz[0]!;
  // Hann roughly doubles the main lobe, so resolution is about v / span.
  return { distanceM, reflection, resolutionM: v / span, maxRangeM: v / (2 * df) };
}

export interface Reflection {
  distanceM: number;
  reflection: number;
}

/** Peaks in a TDR trace, with sub-sample (parabolic) refinement. */
export function tdrPeaks(t: TdrResult, minReflection = 0.05): Reflection[] {
  const { distanceM: d, reflection: r } = t;
  const out: Reflection[] = [];
  const limit = d.findIndex((x) => x > t.maxRangeM * 0.95);
  const end = limit < 0 ? r.length - 1 : limit;
  const skip = d.findIndex((x) => x > t.resolutionM * 0.75); // connector at the VNA port
  for (let i = Math.max(1, skip); i < end; i++) {
    const a = r[i - 1]!;
    const b = r[i]!;
    const cc = r[i + 1]!;
    if (b >= minReflection && b > a && b >= cc) {
      const denom = a - 2 * b + cc;
      const off = denom !== 0 ? (0.5 * (a - cc)) / denom : 0;
      const step = d[1]! - d[0]!;
      out.push({ distanceM: d[i]! + off * step, reflection: b - 0.25 * (a - cc) * off });
    }
  }
  return out;
}

export interface CoaxAnalysis {
  /** Best length estimate, meters. */
  lengthM: number | null;
  method: "quarter-wave" | "tdr" | null;
  /** Matched loss at `lossAtHz`, dB (open far end only). */
  lossDb: number | null;
  lossAtHz: number;
  /** Discontinuities before the far end. */
  faults: Reflection[];
  farEnd: Reflection | null;
  tdr: TdrResult;
}

/**
 * Coax test (spec: Features > Test coax). `farEnd` "open" allows length by quarter wave and
 * loss; "connected" (antenna on the end) still finds length and faults by TDR.
 */
export function analyzeCoax(
  sweep: Sweep,
  velocityFactor: number,
  opts: { farEnd: "open" | "connected"; lossAtHz?: number },
): CoaxAnalysis {
  const t = tdr(sweep, velocityFactor);
  const peaks = tdrPeaks(t);
  // The far end (open, or an antenna that's mismatched over most of the sweep) is the
  // strongest reflection.
  const farEnd = peaks.length ? peaks.reduce((a, b) => (b.reflection > a.reflection ? b : a)) : null;
  // A fault is a peak before the far end that stands out: at least 6% reflection.
  const faults = farEnd
    ? peaks.filter((p) => p.distanceM < farEnd.distanceM - t.resolutionM * 0.75 && p.reflection >= 0.06)
    : [];

  let lengthM = farEnd?.distanceM ?? null;
  let method: CoaxAnalysis["method"] = farEnd ? "tdr" : null;
  if (opts.farEnd === "open") {
    const q = firstQuarterWaveHz(sweep);
    if (q !== null) {
      const lq = lengthFromQuarterWave(q, velocityFactor);
      // Quarter wave is finer than TDR's resolution, but a fault upsets it: only use it on a
      // clean line where it agrees with TDR within 5%.
      if (lengthM === null || (faults.length === 0 && Math.abs(lq - lengthM) < lengthM * 0.05)) {
        lengthM = lq;
        method = "quarter-wave";
      }
    }
  }

  const lossAtHz = opts.lossAtHz ?? 14.2e6;
  const lossDb = opts.farEnd === "open" ? lossFromOpenReturnLoss(returnLossNear(sweep, lossAtHz)) : null;
  return { lengthM, method, lossDb, lossAtHz, faults, farEnd, tdr: t };
}
