/**
 * Keep the NanoVNA's own screen on what the app is showing: the same range, SWR (and Smith)
 * traces, markers on the points that matter. The bridge redraws the device after scans go quiet.
 * Pure view builders; screens hand them to `useDeviceView`.
 */
import { type Band, scanRangeFor } from "@resonance/analysis";
import { DISPLAY_MAX_MARKERS, type DisplayView, type TraceFormat } from "./bridge/protocol";
import type { LastCheck } from "./state";
import { tuneRange } from "./tune";

const ANTENNA_TRACES: TraceFormat[] = ["swr", "smith"];

/** A view the bridge accepts: whole hertz, markers inside the range, no near-duplicates. */
export function deviceView(
  range: { startHz: number; stopHz: number },
  markersHz: readonly (number | null | undefined)[] = [],
  traces: TraceFormat[] = ANTENNA_TRACES,
): DisplayView {
  const startHz = Math.round(range.startHz);
  const stopHz = Math.round(range.stopHz);
  const minGap = (stopHz - startHz) / 100; // about one device sweep point
  const markers: number[] = [];
  for (const m of markersHz) {
    if (m == null || !Number.isFinite(m) || m < startHz || m > stopHz) continue;
    if (markers.some((x) => Math.abs(x - m) < minGap)) continue;
    if (markers.length < DISPLAY_MAX_MARKERS) markers.push(Math.round(m));
  }
  return { startHz, stopHz, markersHz: markers, traces };
}

/** A band being scanned or picked: the scan range, no markers yet. */
export const bandView = (band: Band): DisplayView => deviceView(scanRangeFor(band));

/** A check result: marker 1 on the best SWR, marker 2 on resonance. */
export const checkView = (last: LastCheck, extraHz?: number): DisplayView =>
  deviceView(scanRangeFor(last.result.band), [
    extraHz,
    last.result.metrics.min.freqHz,
    last.result.metrics.resonanceHz,
  ]);

/** Trim coach: marker 1 on the target, marker 2 on where the antenna resonates now. */
export const tuneView = (targetHz: number, resonanceHz: number | null): DisplayView =>
  deviceView(tuneRange(targetHz), [targetHz, resonanceHz]);

/** Resonance search: the range being searched, or the close look at a dip, with the dip and target marked. */
export const findView = (range: { startHz: number; stopHz: number }, markersHz: readonly (number | null | undefined)[] = []): DisplayView =>
  deviceView(range, markersHz);

/** SWR meter: the band around the frequency (or ±2% off-band), a marker on it. */
export function meterView(freqHz: number, band: Band | undefined): DisplayView {
  const range = band ? scanRangeFor(band) : { startHz: Math.max(50_000, freqHz * 0.98), stopHz: freqHz * 1.02 };
  return deviceView(range, [freqHz], ["swr"]);
}
