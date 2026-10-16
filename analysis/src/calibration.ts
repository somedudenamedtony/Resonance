import { type Complex, add, c, div, lerp, mul, sub, ONE } from "./complex";

/**
 * One-port error terms at a single frequency.
 *   Γm = Ed + Er·Γ / (1 − Es·Γ)
 * Ed: directivity, Es: source match, Er: reflection tracking.
 */
export interface ErrorTerms {
  readonly ed: Complex;
  readonly es: Complex;
  readonly er: Complex;
}

/** Calibration over a frequency grid. Terms are interpolated for other frequencies. */
export interface Calibration {
  readonly freqHz: readonly number[];
  readonly terms: readonly ErrorTerms[];
}

/**
 * Solve error terms from measured open, short and load, assuming ideal standards
 * (Γopen = +1, Γshort = −1, Γload = 0).
 */
export function solveOSL(open: Complex, short: Complex, load: Complex): ErrorTerms {
  const ed = load;
  const a = sub(open, ed); // = Er / (1 − Es)
  const b = sub(short, ed); // = −Er / (1 + Es)
  const es = div(add(a, b), sub(a, b));
  const er = mul(a, sub(ONE, es));
  return { ed, es, er };
}

/** Build a calibration from three parallel measurement arrays on the same grid. */
export function buildCalibration(
  freqHz: readonly number[],
  open: readonly Complex[],
  short: readonly Complex[],
  load: readonly Complex[],
): Calibration {
  const n = freqHz.length;
  if (open.length !== n || short.length !== n || load.length !== n) {
    throw new Error("calibration standards must have the same number of points as freqHz");
  }
  const terms = freqHz.map((_, i) => solveOSL(open[i]!, short[i]!, load[i]!));
  return { freqHz: [...freqHz], terms };
}

/** Apply error terms to a raw measurement: Γ = (Γm − Ed) / (Er + Es·(Γm − Ed)). */
export function correct(raw: Complex, t: ErrorTerms): Complex {
  const d = sub(raw, t.ed);
  return div(d, add(t.er, mul(t.es, d)));
}

/** Inverse of `correct`: what a VNA with these error terms would report for a true Γ. */
export function distort(actual: Complex, t: ErrorTerms): Complex {
  return add(t.ed, div(mul(t.er, actual), sub(ONE, mul(t.es, actual))));
}

/** Error terms at an arbitrary frequency, linearly interpolated. Throws outside the calibrated range. */
export function termsAt(cal: Calibration, fHz: number): ErrorTerms {
  const f = cal.freqHz;
  const n = f.length;
  if (n === 0) throw new Error("empty calibration");
  if (fHz < f[0]! || fHz > f[n - 1]!) {
    throw new RangeError(`${fHz} Hz is outside the calibrated range ${f[0]}–${f[n - 1]} Hz`);
  }
  // Binary search for the bracketing interval.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (f[mid]! <= fHz) lo = mid;
    else hi = mid;
  }
  const f0 = f[lo]!;
  const f1 = f[hi]!;
  const a = cal.terms[lo]!;
  const b = cal.terms[hi]!;
  if (f1 === f0) return a;
  const t = (fHz - f0) / (f1 - f0);
  return { ed: lerp(a.ed, b.ed, t), es: lerp(a.es, b.es, t), er: lerp(a.er, b.er, t) };
}

/** Apply a calibration to a whole raw sweep. */
export function correctSweep(
  cal: Calibration,
  freqHz: readonly number[],
  raw: readonly Complex[],
): Complex[] {
  return freqHz.map((f, i) => correct(raw[i]!, termsAt(cal, f)));
}

/** True when a calibration covers [startHz, stopHz]. */
export function covers(cal: Calibration, startHz: number, stopHz: number): boolean {
  const n = cal.freqHz.length;
  return n > 0 && startHz >= cal.freqHz[0]! && stopHz <= cal.freqHz[n - 1]!;
}

/** Ideal (identity) error terms, useful for uncalibrated display and tests. */
export const IDENTITY_TERMS: ErrorTerms = { ed: c(0), es: c(0), er: c(1) };
