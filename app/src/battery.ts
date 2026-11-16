// Turning a single-cell lithium battery voltage into a rough charge level.

import type { BatteryStatus } from "./bridge/protocol";

/** Resting voltage of a 1S Li-ion/LiPo cell (mV) against charge (%), from full to empty. */
const CURVE: ReadonlyArray<readonly [number, number]> = [
  [4150, 100],
  [4100, 95],
  [4000, 82],
  [3900, 68],
  [3800, 52],
  [3750, 42],
  [3700, 30],
  [3650, 20],
  [3600, 12],
  [3500, 5],
  [3300, 0],
];

/**
 * About how full a 1S lithium battery is, 0–100, from its voltage. Only a guide: the voltage
 * reads high while charging and sags under load.
 */
export function batteryPercent(mV: number): number {
  if (mV >= CURVE[0]![0]) return 100;
  for (let i = 1; i < CURVE.length; i++) {
    const [v1, p1] = CURVE[i]!;
    if (mV >= v1) {
      const [v0, p0] = CURVE[i - 1]!;
      return Math.round(p1 + ((mV - v1) / (v0 - v1)) * (p0 - p1));
    }
  }
  return 0;
}

/** Below this the NanoVNA is close to shutting off. */
export const LOW_BATTERY_PERCENT = 15;

/**
 * The battery to show in the status strip: whichever of the NanoVNA's and the bridge's is lower,
 * since that one runs out first.
 */
export function lowestBattery(b: BatteryStatus | null, nanovnaConnected: boolean): { name: string; mV: number } | null {
  const all: Array<{ name: string; mV: number }> = [];
  if (nanovnaConnected && b?.nanovna) all.push({ name: "NanoVNA", mV: b.nanovna.mV });
  if (b?.bridge) all.push({ name: "Bridge", mV: b.bridge.mV });
  if (!all.length) return null;
  return all.reduce((lo, x) => (batteryPercent(x.mV) < batteryPercent(lo.mV) ? x : lo));
}

export function batteryDetail(mV: number): string {
  return `${(mV / 1000).toFixed(2)} V, about ${batteryPercent(mV)}%`;
}
