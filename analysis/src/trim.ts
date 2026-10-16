export type AntennaType = "dipole" | "efhw" | "vertical" | "mobile" | "other";

export interface TrimInput {
  readonly type: AntennaType;
  /** Current resonant frequency, Hz. */
  readonly resonanceHz: number;
  /** Where you want resonance, Hz. */
  readonly targetHz: number;
  /**
   * Current length of the element being trimmed, meters (per leg for a dipole, the whole
   * radiator for EFHW/vertical). If omitted it is estimated from the resonant frequency.
   */
  readonly elementLengthM?: number;
  /** Fraction of the computed cut to recommend; < 1 undershoots on purpose. Default 0.8. */
  readonly damping?: number;
  /** Within this fraction of target counts as done. Default 0.005 (0.5%). */
  readonly doneTolerance?: number;
}

export interface TrimInstruction {
  readonly action: "shorten" | "lengthen" | "done";
  /** Amount to change per element, meters (always >= 0). */
  readonly amountM: number;
  readonly elementLengthM: number;
  readonly lengthIsEstimate: boolean;
  /** Plain-English instruction, e.g. "Shorten each leg 4.2 cm". */
  readonly text: string;
}

/**
 * Rough physical length of one element from its resonant frequency.
 * Dipole leg ≈ 71.3 / f(MHz) m (468 ft / f total); EFHW ≈ 142.6 / f; quarter-wave vertical ≈ 71.3 / f.
 */
export function estimateElementLengthM(type: AntennaType, resonanceHz: number): number {
  const fMHz = resonanceHz / 1e6;
  switch (type) {
    case "efhw":
      return 142.6 / fMHz;
    case "dipole":
    case "vertical":
    case "mobile":
    case "other":
      return 71.3 / fMHz;
  }
}

const elementWord = (type: AntennaType) => (type === "dipole" ? "each leg" : "the element");

function fmtLength(m: number): string {
  if (m < 0.01) return `${(m * 1000).toFixed(0)} mm`;
  if (m < 1) return `${(m * 100).toFixed(1)} cm`;
  return `${m.toFixed(2)} m`;
}

/**
 * Trim coach: resonant frequency scales inversely with length, so
 *   ΔL = L · (1 − f_res / f_target) · k
 * Positive ΔL means shorten; negative means add wire.
 */
export function trimInstruction(input: TrimInput): TrimInstruction {
  const k = input.damping ?? 0.8;
  const tol = input.doneTolerance ?? 0.005;
  const { resonanceHz: fr, targetHz: ft } = input;
  if (!(fr > 0) || !(ft > 0)) throw new RangeError("frequencies must be positive");

  const lengthIsEstimate = input.elementLengthM === undefined;
  const L = input.elementLengthM ?? estimateElementLengthM(input.type, fr);
  const where = elementWord(input.type);

  if (Math.abs(fr - ft) / ft <= tol) {
    return {
      action: "done",
      amountM: 0,
      elementLengthM: L,
      lengthIsEstimate,
      text: `Done: resonant at ${(fr / 1e6).toFixed(3)} MHz`,
    };
  }

  const delta = L * (1 - fr / ft) * k;
  const amountM = Math.abs(delta);
  // fr < ft means the antenna is too long → shorten. ΔL > 0 in that case.
  const action = delta > 0 ? "shorten" : "lengthen";
  const verb = action === "shorten" ? "Shorten" : "Lengthen";
  return {
    action,
    amountM,
    elementLengthM: L,
    lengthIsEstimate,
    text: `${verb} ${where} ${fmtLength(amountM)}`,
  };
}
