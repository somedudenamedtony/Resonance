import { C0 } from "./rf";

export interface CoaxType {
  readonly id: string;
  readonly name: string;
  readonly velocityFactor: number;
}

/** Common feedlines. Velocity factors are typical published values; check your cable's datasheet. */
export const COAX_TYPES: readonly CoaxType[] = [
  { id: "rg58", name: "RG-58", velocityFactor: 0.66 },
  { id: "rg8x", name: "RG-8X", velocityFactor: 0.78 },
  { id: "rg213", name: "RG-213", velocityFactor: 0.66 },
  { id: "lmr240", name: "LMR-240", velocityFactor: 0.84 },
  { id: "lmr400", name: "LMR-400", velocityFactor: 0.85 },
  { id: "lmr600", name: "LMR-600", velocityFactor: 0.87 },
  { id: "ladder450", name: "450 Ω ladder line", velocityFactor: 0.91 },
];

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
