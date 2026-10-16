import { type Complex, abs } from "./complex";

export type StandardKind = "open" | "short" | "load";

/**
 * Best guess of which calibration standard is attached, from a raw (uncorrected)
 * reading at the lowest calibration frequency, where the VNA's own phase error is smallest.
 *
 * This is a guard against attaching the wrong standard, not a measurement.
 */
export function classifyStandard(rawAtLowFreq: Complex): StandardKind {
  if (abs(rawAtLowFreq) < 0.35) return "load";
  return rawAtLowFreq.re >= 0 ? "open" : "short";
}

export interface StandardCheck {
  readonly ok: boolean;
  readonly detected: StandardKind;
  readonly hint?: string;
}

const HINTS: Record<StandardKind, string> = {
  open: "That looks like the open standard (or nothing attached).",
  short: "That looks like the short standard.",
  load: "That looks like the 50 Ω load.",
};

/** Check that the measured standard matches the step the user is on. */
export function checkStandard(expected: StandardKind, rawAtLowFreq: Complex): StandardCheck {
  const detected = classifyStandard(rawAtLowFreq);
  if (detected === expected) return { ok: true, detected };
  return {
    ok: false,
    detected,
    hint: `${HINTS[detected]} Attach the ${expected} standard to port 1 (CH0) and measure again.`,
  };
}
