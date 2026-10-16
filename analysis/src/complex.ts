/** Minimal immutable complex-number helpers. */
export interface Complex {
  readonly re: number;
  readonly im: number;
}

export const c = (re: number, im = 0): Complex => ({ re, im });

export const ZERO: Complex = c(0, 0);
export const ONE: Complex = c(1, 0);

export const add = (a: Complex, b: Complex): Complex => c(a.re + b.re, a.im + b.im);
export const sub = (a: Complex, b: Complex): Complex => c(a.re - b.re, a.im - b.im);
export const mul = (a: Complex, b: Complex): Complex =>
  c(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
export const scale = (a: Complex, k: number): Complex => c(a.re * k, a.im * k);

export const div = (a: Complex, b: Complex): Complex => {
  const d = b.re * b.re + b.im * b.im;
  if (d === 0) return c(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  return c((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
};

export const abs = (a: Complex): number => Math.hypot(a.re, a.im);
export const arg = (a: Complex): number => Math.atan2(a.im, a.re);
export const polar = (mag: number, phase: number): Complex =>
  c(mag * Math.cos(phase), mag * Math.sin(phase));

/** Linear interpolation between two complex values, t in [0, 1]. */
export const lerp = (a: Complex, b: Complex, t: number): Complex =>
  c(a.re + (b.re - a.re) * t, a.im + (b.im - a.im) * t);
