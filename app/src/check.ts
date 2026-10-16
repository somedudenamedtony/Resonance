/** Running checks, UI-free so screens and tests share it. */
import {
  type Band,
  type Calibration,
  checkBand,
  findBand,
  scanRangeFor,
  type Sweep,
  US_BAND_PLAN,
} from "@resonance/analysis";
import type { BridgeClient } from "./bridge/client";
import { applyCalibration } from "./cal";
import type { LastCheck } from "./state";

export const CHECK_POINTS = 201;

/** Band picker order: the most used HF bands first. */
export const BAND_ORDER = ["20m", "40m", "80m", "15m", "10m", "17m", "30m", "12m", "160m", "60m", "6m", "2m"];

/** "Scan all" covers HF and 6m, which the calibration range also covers. */
export const SCAN_ALL_ORDER = ["160m", "80m", "60m", "40m", "30m", "20m", "17m", "15m", "12m", "10m", "6m"];

export const bandsById = (ids: readonly string[]): Band[] =>
  ids.map((id) => findBand(US_BAND_PLAN, id)).filter((b): b is Band => !!b);

export async function checkOneBand(
  client: BridgeClient,
  band: Band,
  cal: Calibration | null,
  onPartial?: (partial: Sweep, received: number) => void,
): Promise<LastCheck> {
  const raw = await client.scan({ ...scanRangeFor(band), points: CHECK_POINTS }, (p) =>
    onPartial?.(applyCalibration(cal, { freqHz: [...p.partial.freqHz], s11: [...p.partial.s11] }).sweep, p.received),
  );
  const { sweep, calibrated } = applyCalibration(cal, raw);
  return { result: checkBand(sweep, band), sweep, calibrated, at: Date.now() };
}

/** Plain-English meaning of the three headline readings (spec: teach in place). */
export function explainSwr(swr: number): string {
  if (!Number.isFinite(swr)) return "SWR is off the scale: almost all your power bounces back. Check the feedline.";
  const g = (swr - 1) / (swr + 1);
  const pct = g * g * 100;
  const share = pct < 1 ? "under 1%" : `about ${Math.round(pct)}%`;
  const verdict =
    swr <= 1.5 ? "That's an excellent match." : swr <= 2 ? "Most radios are happy at this level." : "Many radios cut power above 2:1.";
  return `SWR ${swr.toFixed(2)} means ${share} of your power reflects back toward the radio. ${verdict}`;
}

export const EXPLAIN_RESONANCE =
  "Resonance is the antenna's natural frequency, where its reactance is zero. Below the band means the antenna is too long; above means too short.";

export const EXPLAIN_BANDWIDTH =
  "How wide a slice of spectrum stays under 2:1 SWR. A + means it runs past the edge of this scan, so it's at least that wide.";
