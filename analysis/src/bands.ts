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
