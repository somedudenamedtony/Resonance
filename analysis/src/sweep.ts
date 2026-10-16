import type { Complex } from "./complex";

/** One corrected (or raw) S11 sweep. Arrays are parallel and sorted by frequency. */
export interface Sweep {
  readonly freqHz: readonly number[];
  readonly s11: readonly Complex[];
  readonly s21?: readonly Complex[];
}

/** Evenly spaced frequency grid, inclusive of both ends. */
export function frequencyGrid(startHz: number, stopHz: number, points: number): number[] {
  if (points < 2) throw new Error("points must be >= 2");
  if (!(stopHz > startHz)) throw new Error("stopHz must be greater than startHz");
  const step = (stopHz - startHz) / (points - 1);
  return Array.from({ length: points }, (_, i) => Math.round(startHz + i * step));
}

export function assertSweep(s: Sweep): void {
  if (s.freqHz.length !== s.s11.length) throw new Error("freqHz and s11 lengths differ");
  if (s.freqHz.length < 2) throw new Error("sweep needs at least 2 points");
  for (let i = 1; i < s.freqHz.length; i++) {
    if (s.freqHz[i]! <= s.freqHz[i - 1]!) throw new Error("freqHz must be strictly increasing");
  }
}
