/** An amateur band as the app shows it. Frequencies in Hz. */
export interface Band {
  readonly id: string;
  readonly name: string;
  readonly startHz: number;
  readonly stopHz: number;
}

export interface BandPlan {
  readonly name: string;
  readonly region: string;
  readonly bands: readonly Band[];
}

const mhz = (v: number) => Math.round(v * 1_000_000);
const band = (id: string, name: string, start: number, stop: number): Band => ({
  id,
  name,
  startHz: mhz(start),
  stopHz: mhz(stop),
});

/**
 * US (FCC Part 97) band edges for HF, 6m and 2m. 60m is shown as the span of its
 * five channels. Editable in Settings in a later milestone.
 */
export const US_BAND_PLAN: BandPlan = {
  name: "US (FCC)",
  region: "US",
  bands: [
    band("160m", "160m", 1.8, 2.0),
    band("80m", "80m", 3.5, 4.0),
    band("60m", "60m", 5.3305, 5.4065),
    band("40m", "40m", 7.0, 7.3),
    band("30m", "30m", 10.1, 10.15),
    band("20m", "20m", 14.0, 14.35),
    band("17m", "17m", 18.068, 18.168),
    band("15m", "15m", 21.0, 21.45),
    band("12m", "12m", 24.89, 24.99),
    band("10m", "10m", 28.0, 29.7),
    band("6m", "6m", 50.0, 54.0),
    band("2m", "2m", 144.0, 148.0),
  ],
};

export function findBand(plan: BandPlan, id: string): Band | undefined {
  return plan.bands.find((b) => b.id === id);
}

export function bandCenterHz(b: Band): number {
  return Math.round((b.startHz + b.stopHz) / 2);
}

/**
 * Scan range for a band check: the band plus `marginFraction` of its width on each side,
 * and never less than `minMarginHz` per side (narrow bands like 30m need room to show the dip).
 */
export function scanRangeFor(
  b: Band,
  marginFraction = 0.25,
  minMarginHz = 150_000,
): { startHz: number; stopHz: number } {
  const width = b.stopHz - b.startHz;
  const margin = Math.max(width * marginFraction, minMarginHz);
  return {
    startHz: Math.max(50_000, Math.round(b.startHz - margin)),
    stopHz: Math.round(b.stopHz + margin),
  };
}

/** What the user operates. Narrows a band check to the part of the band they use. */
export type OperatingMode = "cw" | "digital" | "phone";

export const MODE_ORDER: readonly OperatingMode[] = ["cw", "digital", "phone"];
export const MODE_NAMES: Record<OperatingMode, string> = { cw: "CW", digital: "digital", phone: "phone" };

/**
 * Where each mode lives in the US bands, kHz. CW and phone follow the FCC CW/data and phone
 * sub-bands (General and Extra); digital spans the usual FT8 and FT4 windows. 60m is
 * channelized and has no entry, so it is always judged as a whole.
 */
const US_MODE_KHZ: Record<string, Partial<Record<OperatingMode, [number, number]>>> = {
  "160m": { cw: [1800, 1850], digital: [1836, 1846], phone: [1843, 2000] },
  "80m": { cw: [3500, 3600], digital: [3570, 3600], phone: [3600, 4000] },
  "40m": { cw: [7000, 7125], digital: [7047, 7080], phone: [7125, 7300] },
  "30m": { cw: [10100, 10130], digital: [10130, 10150] },
  "20m": { cw: [14000, 14150], digital: [14070, 14100], phone: [14150, 14350] },
  "17m": { cw: [18068, 18110], digital: [18095, 18110], phone: [18110, 18168] },
  "15m": { cw: [21000, 21200], digital: [21070, 21145], phone: [21200, 21450] },
  "12m": { cw: [24890, 24930], digital: [24910, 24925], phone: [24930, 24990] },
  "10m": { cw: [28000, 28300], digital: [28070, 28190], phone: [28300, 29700] },
  "6m": { cw: [50000, 50100], digital: [50310, 50325], phone: [50100, 54000] },
  "2m": { cw: [144000, 144100], digital: [144170, 144180], phone: [144100, 148000] },
};

/** "CW", "CW and phone", "CW, digital and phone". */
export function modesLabel(modes: readonly OperatingMode[]): string {
  const names = MODE_ORDER.filter((m) => modes.includes(m)).map((m) => MODE_NAMES[m]);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The part of `band` the chosen modes use: from the lowest start to the highest stop of the
 * modes the band has. Null when no mode is chosen or the band has none of them (judge the
 * whole band). Clamped to the band edges.
 */
export function segmentFor(
  band: Band,
  modes: readonly OperatingMode[],
): { startHz: number; stopHz: number; label: string } | null {
  const table = US_MODE_KHZ[band.id];
  if (!table) return null;
  const present = MODE_ORDER.filter((m) => modes.includes(m) && table[m]);
  if (present.length === 0) return null;
  const start = Math.min(...present.map((m) => table[m]![0]));
  const stop = Math.max(...present.map((m) => table[m]![1]));
  const startHz = Math.max(band.startHz, mhz(start / 1000));
  const stopHz = Math.min(band.stopHz, mhz(stop / 1000));
  if (startHz <= band.startHz && stopHz >= band.stopHz) return null;
  return { startHz, stopHz, label: modesLabel(present) };
}
