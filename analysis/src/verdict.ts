import type { Band } from "./bands";
import { analyze, type SweepMetrics } from "./metrics";
import type { Sweep } from "./sweep";

export type VerdictLevel = "good" | "usable" | "poor";
export type Cause = "too_long" | "too_short" | "mismatch" | "no_resonance";

export interface SwrThresholds {
  /** Max SWR across the band for "good". */
  readonly good: number;
  /** Max SWR across the band (or chosen segment) for "usable". */
  readonly usable: number;
}

export const DEFAULT_THRESHOLDS: SwrThresholds = { good: 1.5, usable: 2.0 };

export interface Segment {
  readonly startHz: number;
  readonly stopHz: number;
  /** What the user calls this part of the band, e.g. "CW" or "digital". */
  readonly label?: string;
}

export interface CheckResult {
  readonly band: Band;
  readonly level: VerdictLevel;
  /** One-line headline, e.g. "Good on 20m". */
  readonly headline: string;
  /** Supporting line under the headline. */
  readonly detail: string;
  /** Optional cause line explaining a poor or usable result. */
  readonly cause: Cause | null;
  readonly causeText: string | null;
  readonly maxSwrInBand: number;
  /** The part of the band the verdict judged, when narrower than the whole band. */
  readonly segment: Segment | null;
  readonly metrics: SweepMetrics;
}

const fmtMHz = (hz: number, digits = 3) => (hz / 1e6).toFixed(digits);
const fmtSwr = (v: number) => (Number.isFinite(v) ? `${v.toFixed(1)}:1` : "very high");

/** Max SWR over the sweep points that fall inside [startHz, stopHz]. */
export function maxSwrIn(freqHz: readonly number[], swrs: readonly number[], startHz: number, stopHz: number): number {
  let max = Number.NEGATIVE_INFINITY;
  let any = false;
  for (let i = 0; i < freqHz.length; i++) {
    const f = freqHz[i]!;
    if (f >= startHz && f <= stopHz) {
      any = true;
      max = Math.max(max, swrs[i]!);
    }
  }
  if (!any) throw new RangeError("sweep does not cover the requested band");
  return max;
}

/** What the verdict judged: the whole band, or the user's part of it. */
interface Target {
  readonly name: string;
  readonly startHz: number;
  readonly stopHz: number;
}

function diagnose(
  band: Target,
  m: SweepMetrics,
  thresholds: SwrThresholds,
): { cause: Cause | null; text: string | null } {
  const res = m.resonanceHz;
  if (res === null) {
    // Fall back to the SWR minimum as the best estimate of where the antenna "wants" to be.
    if (m.min.swr > thresholds.usable) {
      return {
        cause: "no_resonance",
        text: "No resonance found in this scan. Try Scan all bands, or check the feedline connection.",
      };
    }
  }
  // No reactance zero in the scan and the SWR minimum sits on a scan edge: resonance is
  // somewhere beyond the edge. Say so rather than naming the edge as the resonance.
  if (res === null && m.min.index <= 2) {
    return {
      cause: "too_long",
      text: `Resonant somewhere below ${fmtMHz(m.min.freqHz, 2)} MHz, under ${band.name}. The antenna is too long.`,
    };
  }
  if (res === null && m.min.index >= m.swr.length - 3) {
    return {
      cause: "too_short",
      text: `Resonant somewhere above ${fmtMHz(m.min.freqHz, 2)} MHz, over ${band.name}. The antenna is too short.`,
    };
  }
  const f = res ?? m.min.freqHz;
  if (f < band.startHz) {
    return {
      cause: "too_long",
      text: `Resonant at ${fmtMHz(f, 2)} MHz, below ${band.name}. The antenna is too long.`,
    };
  }
  if (f > band.stopHz) {
    return {
      cause: "too_short",
      text: `Resonant at ${fmtMHz(f, 2)} MHz, above ${band.name}. The antenna is too short.`,
    };
  }
  if (m.min.swr > thresholds.usable) {
    const r = m.resonanceR;
    const rText = r !== null ? ` Resistance there is ${Math.round(r)} Ω instead of 50 Ω.` : "";
    return {
      cause: "mismatch",
      text: `Resonant in band, but the match is poor.${rText} A matching network or feedpoint change is needed.`,
    };
  }
  return { cause: null, text: null };
}

/**
 * Verdict for one band. The sweep should cover the band (see `scanRangeFor`).
 * `segment` narrows the verdict to the part of the band the user operates in: the level is
 * judged there, and the detail says how the rest of the band looks.
 */
export function checkBand(
  sweep: Sweep,
  band: Band,
  options: { thresholds?: SwrThresholds; segment?: Segment | null } = {},
): CheckResult {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const metrics = analyze(sweep);
  const maxInBand = maxSwrIn(sweep.freqHz, metrics.swr, band.startHz, band.stopHz);
  const seg = options.segment ?? null;
  const judged = seg ? maxSwrIn(sweep.freqHz, metrics.swr, seg.startHz, seg.stopHz) : maxInBand;

  const level: VerdictLevel = judged <= thresholds.good ? "good" : judged <= thresholds.usable ? "usable" : "poor";

  const segName = seg?.label ? `${seg.label} part of ${band.name}` : `your part of ${band.name}`;
  const target: Target = seg ? { name: `the ${segName}`, startHz: seg.startHz, stopHz: seg.stopHz } : band;
  const { cause, text } = level === "good" ? { cause: null, text: null } : diagnose(target, metrics, thresholds);

  const where = seg ? (seg.label ? ` for ${seg.label}` : " where you operate") : "";
  const across = seg ? `in the ${segName}` : "across the whole band";
  const elsewhere = seg && maxInBand > judged + 0.05 ? `; up to ${fmtSwr(maxInBand)} elsewhere in the band` : "";

  let headline: string;
  let detail: string;
  switch (level) {
    case "good":
      headline = `Good${where} on ${band.name}`;
      detail = `Under ${thresholds.good}:1 ${across}${elsewhere}`;
      break;
    case "usable":
      headline = `Usable${where} on ${band.name}`;
      detail = `Under ${thresholds.usable}:1 ${across}, best at ${fmtMHz(metrics.min.freqHz)} MHz${elsewhere}`;
      break;
    case "poor":
      headline = `Poor${where} on ${band.name}`;
      detail = `Up to ${fmtSwr(judged)} ${seg ? `in the ${segName}` : "in band"}, best ${fmtSwr(metrics.min.swr)} at ${fmtMHz(metrics.min.freqHz)} MHz`;
      break;
  }

  return { band, level, headline, detail, cause, causeText: text, maxSwrInBand: maxInBand, segment: seg, metrics };
}
