import { type Complex, abs, add, c, div, sub, ONE } from "./complex";

/** Default reference impedance, ohms. */
export const Z0 = 50;

/** Impedance from reflection coefficient: Z = Z0 (1 + Γ) / (1 − Γ). */
export function impedance(gamma: Complex, z0 = Z0): Complex {
  const z = div(add(ONE, gamma), sub(ONE, gamma));
  return c(z.re * z0, z.im * z0);
}

/** Reflection coefficient from impedance: Γ = (Z − Z0) / (Z + Z0). */
export function gammaFromImpedance(z: Complex, z0 = Z0): Complex {
  return div(sub(z, c(z0)), add(z, c(z0)));
}

/** Standing wave ratio. Returns Infinity when |Γ| >= 1. */
export function swr(gamma: Complex): number {
  const m = abs(gamma);
  if (m >= 1) return Number.POSITIVE_INFINITY;
  return (1 + m) / (1 - m);
}

/** Return loss in dB (positive number; larger is a better match). */
export function returnLoss(gamma: Complex): number {
  const m = abs(gamma);
  if (m === 0) return Number.POSITIVE_INFINITY;
  return -20 * Math.log10(m);
}

/** Fraction of forward power reflected, 0..1. */
export function reflectedPower(gamma: Complex): number {
  const m = abs(gamma);
  return Math.min(1, m * m);
}

/** Speed of light, m/s. */
export const C0 = 299_792_458;
