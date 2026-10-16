import { impedance, swr, Z0 } from "./rf";
import type { Sweep } from "./sweep";

export interface MinSwr {
  readonly index: number;
  readonly freqHz: number;
  readonly swr: number;
}

export interface Bandwidth {
  readonly threshold: number;
  readonly lowHz: number;
  readonly highHz: number;
  readonly widthHz: number;
  /** True when the span reaches the edge of the sweep, so the true width may be larger. */
  readonly clipped: boolean;
}

export interface SweepMetrics {
  readonly swr: readonly number[];
  readonly r: readonly number[];
  readonly x: readonly number[];
  readonly min: MinSwr;
  /** Frequency where reactance crosses zero nearest the SWR minimum, if any. */
  readonly resonanceHz: number | null;
  /** Resistance at resonance, ohms. */
  readonly resonanceR: number | null;
  readonly bw2: Bandwidth | null;
  readonly bw15: Bandwidth | null;
}

export function swrSeries(s: Sweep): number[] {
  return s.s11.map(swr);
}

export function findMinSwr(freqHz: readonly number[], swrs: readonly number[]): MinSwr {
  let best = 0;
  for (let i = 1; i < swrs.length; i++) if (swrs[i]! < swrs[best]!) best = i;
  return { index: best, freqHz: freqHz[best]!, swr: swrs[best]! };
}

/**
 * Zero crossings of reactance, with linear interpolation. Returns the crossing nearest
 * to `nearIndex` (normally the SWR minimum), or null when X never changes sign.
 */
export function findResonance(
  freqHz: readonly number[],
  x: readonly number[],
  r: readonly number[],
  nearIndex: number,
): { freqHz: number; r: number } | null {
  let best: { freqHz: number; r: number; dist: number } | null = null;
  for (let i = 1; i < x.length; i++) {
    const x0 = x[i - 1]!;
    const x1 = x[i]!;
    if (x0 === 0 || Math.sign(x0) !== Math.sign(x1)) {
      // Skip crossings through a near-open (X jumps from +big to −big where |Γ|≈1 at Γ≈+1).
      if (Math.abs(x0) > 5000 || Math.abs(x1) > 5000) continue;
      const t = x1 === x0 ? 0 : x0 / (x0 - x1);
      const f = freqHz[i - 1]! + t * (freqHz[i]! - freqHz[i - 1]!);
      const rr = r[i - 1]! + t * (r[i]! - r[i - 1]!);
      const dist = Math.min(Math.abs(i - 1 - nearIndex), Math.abs(i - nearIndex));
      if (!best || dist < best.dist) best = { freqHz: f, r: rr, dist };
    }
  }
  return best ? { freqHz: best.freqHz, r: best.r } : null;
}

/** Continuous span around `centerIndex` where SWR <= threshold, edges interpolated. */
export function bandwidthAt(
  freqHz: readonly number[],
  swrs: readonly number[],
  centerIndex: number,
  threshold: number,
): Bandwidth | null {
  if (!(swrs[centerIndex]! <= threshold)) return null;
  const n = swrs.length;
  let lo = centerIndex;
  while (lo > 0 && swrs[lo - 1]! <= threshold) lo--;
  let hi = centerIndex;
  while (hi < n - 1 && swrs[hi + 1]! <= threshold) hi++;

  const edge = (inside: number, outside: number): number => {
    const si = swrs[inside]!;
    const so = swrs[outside]!;
    if (!Number.isFinite(so) || so === si) return freqHz[inside]!;
    const t = (threshold - si) / (so - si);
    return freqHz[inside]! + t * (freqHz[outside]! - freqHz[inside]!);
  };

  const lowHz = lo > 0 ? edge(lo, lo - 1) : freqHz[0]!;
  const highHz = hi < n - 1 ? edge(hi, hi + 1) : freqHz[n - 1]!;
  return { threshold, lowHz, highHz, widthHz: highHz - lowHz, clipped: lo === 0 || hi === n - 1 };
}

export function analyze(s: Sweep, z0 = Z0): SweepMetrics {
  const swrs = s.s11.map(swr);
  const zs = s.s11.map((g) => impedance(g, z0));
  const r = zs.map((z) => z.re);
  const x = zs.map((z) => z.im);
  const min = findMinSwr(s.freqHz, swrs);
  const res = findResonance(s.freqHz, x, r, min.index);
  return {
    swr: swrs,
    r,
    x,
    min,
    resonanceHz: res?.freqHz ?? null,
    resonanceR: res?.r ?? null,
    bw2: bandwidthAt(s.freqHz, swrs, min.index, 2),
    bw15: bandwidthAt(s.freqHz, swrs, min.index, 1.5),
  };
}
