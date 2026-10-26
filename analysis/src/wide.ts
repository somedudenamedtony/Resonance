import type { Complex } from "./complex";
import { returnLoss, swr } from "./rf";
import type { Sweep } from "./sweep";

/**
 * Wide-range resonance search: sweep a span far wider than any band (50 kHz to the NanoVNA's top,
 * or any custom range), find where SWR dips, then zoom in on each dip.
 */

/** Lowest frequency the app sweeps. */
export const MIN_SCAN_HZ = 50_000;

export interface Range {
  readonly startHz: number;
  readonly stopHz: number;
}

/**
 * Split a range into pieces no wider than `maxRatio` (stop/start), evenly spaced on a log scale.
 * Each piece is swept linearly, so a 50 kHz–1.5 GHz search still has points every ~1% instead of
 * every 1.5 MHz (which would step right over an HF antenna's dip). A narrow range is one piece.
 */
export function wideChunks(range: Range, maxRatio = 3): Range[] {
  const start = Math.max(MIN_SCAN_HZ, range.startHz);
  const stop = range.stopHz;
  if (!(stop > start)) throw new Error("stop must be above start");
  const n = Math.max(1, Math.ceil(Math.log(stop / start) / Math.log(maxRatio) - 1e-9));
  const edges = Array.from({ length: n + 1 }, (_, i) => Math.round(start * (stop / start) ** (i / n)));
  edges[0] = Math.round(start);
  edges[n] = Math.round(stop);
  return edges.slice(0, -1).map((s, i) => ({ startHz: s, stopHz: edges[i + 1]! }));
}

/** Join chunk sweeps into one, dropping the repeated frequency where pieces meet. */
export function joinSweeps(parts: readonly Sweep[]): Sweep {
  const freqHz: number[] = [];
  const s11: Complex[] = [];
  for (const p of parts) {
    for (let i = 0; i < p.freqHz.length; i++) {
      const f = p.freqHz[i]!;
      if (freqHz.length && f <= freqHz[freqHz.length - 1]!) continue;
      freqHz.push(f);
      s11.push(p.s11[i]!);
    }
  }
  return { freqHz, s11 };
}

export interface Dip {
  readonly index: number;
  readonly freqHz: number;
  readonly swr: number;
  /** Return loss at the bottom of the dip, dB. */
  readonly returnLossDb: number;
  /** How far the dip stands out from what surrounds it, dB of return loss. */
  readonly prominenceDb: number;
  /** Frequencies on each side where the dip has come back up halfway (in dB). */
  readonly lowHz: number;
  readonly highHz: number;
}

export interface DipOptions {
  /** Ignore dips that stand out less than this, dB. Filters noise and coax ripple. */
  minProminenceDb?: number;
  /** Ignore dips shallower than this return loss, dB (about SWR 8.7 at 2 dB). */
  minReturnLossDb?: number;
  /** Most dips to return, deepest first. */
  max?: number;
}

/**
 * SWR dips in a sweep, deepest first. A dip is a local peak of return loss whose prominence
 * (height above the higher of the two lowest points between it and anything deeper) clears
 * `minProminenceDb`, the same rule topographers use to tell a summit from a bump on a ridge.
 */
export function findDips(sweep: Sweep, opts: DipOptions = {}): Dip[] {
  const minProm = opts.minProminenceDb ?? 2;
  const minRl = opts.minReturnLossDb ?? 2;
  const max = opts.max ?? 6;
  const f = sweep.freqHz;
  const rl = sweep.s11.map((g) => {
    const v = returnLoss(g);
    return Number.isFinite(v) ? Math.min(v, 60) : 60;
  });
  const n = rl.length;
  const dips: Dip[] = [];
  for (let i = 0; i < n; i++) {
    const v = rl[i]!;
    // Local peak; plateaus count once, at their first point.
    if (i > 0 && rl[i - 1]! >= v) continue;
    let j = i;
    while (j + 1 < n && rl[j + 1] === v) j++;
    if (j + 1 < n && rl[j + 1]! > v) continue;
    // Still falling at the edge of the sweep: the bottom is outside it, so it isn't a dip here.
    if (v < minRl || i === 0 || j === n - 1) continue;

    // Lowest point on each side before the curve climbs past this peak (or the sweep ends).
    let leftMin = v;
    for (let l = i - 1; l >= 0 && rl[l]! <= v; l--) leftMin = Math.min(leftMin, rl[l]!);
    let rightMin = v;
    for (let r = j + 1; r < n && rl[r]! <= v; r++) rightMin = Math.min(rightMin, rl[r]!);
    const prominence = v - Math.max(leftMin, rightMin);
    if (!(prominence >= minProm)) continue;

    const half = v - prominence / 2;
    let a = i;
    while (a > 0 && rl[a - 1]! >= half) a--;
    let b = j;
    while (b < n - 1 && rl[b + 1]! >= half) b++;
    const k = i + Math.floor((j - i) / 2);
    dips.push({
      index: k,
      freqHz: f[k]!,
      swr: swr(sweep.s11[k]!),
      returnLossDb: v,
      prominenceDb: prominence,
      lowHz: f[Math.max(0, a - 1)]!,
      highHz: f[Math.min(n - 1, b + 1)]!,
    });
    i = j;
  }
  return dips.sort((x, y) => y.returnLossDb - x.returnLossDb).slice(0, max);
}

/**
 * Range for a close look at a dip found on a coarse sweep: the dip's half-depth width, widened to
 * at least a few coarse steps and 1% of the frequency each side so the bottom is surely inside.
 */
export function zoomRange(dip: Dip, sweep: Sweep): Range {
  const f = sweep.freqHz;
  const step = (i: number) => Math.abs((f[Math.min(f.length - 1, i + 1)] ?? f[i]!) - (f[Math.max(0, i - 1)] ?? f[i]!)) / 2;
  const pad = Math.max(3 * step(dip.index), dip.freqHz * 0.01);
  // Half the dip's width again on each side, so the 2:1 edges of a broad dip are usually inside too.
  const extra = (dip.highHz - dip.lowHz) / 2;
  const startHz = Math.max(MIN_SCAN_HZ, Math.min(dip.lowHz - extra, dip.freqHz - pad));
  const stopHz = Math.max(dip.highHz + extra, dip.freqHz + pad);
  return { startHz: Math.round(startHz), stopHz: Math.round(stopHz) };
}

/** True when a log axis reads better than a linear one (the range spans more than ~3:1). */
export const wantsLogAxis = (range: Range) => range.stopHz / range.startHz > 3;
