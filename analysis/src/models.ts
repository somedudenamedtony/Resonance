import { type Complex, c } from "./complex";
import { gammaFromImpedance, Z0 } from "./rf";

/**
 * Simple series-RLC antenna model used by the simulator and tests.
 * Z(f) = R + jX, with X = X0 · Q-scaled detuning: X = R·Q·(f/f0 − f0/f).
 * `r` is the feedpoint resistance at resonance, `q` sets how fast reactance grows off resonance.
 */
export interface RlcAntenna {
  readonly f0Hz: number;
  readonly r: number;
  readonly q: number;
}

export function rlcImpedance(a: RlcAntenna, fHz: number): Complex {
  const x = a.r * a.q * (fHz / a.f0Hz - a.f0Hz / fHz);
  return c(a.r, x);
}

export function rlcGamma(a: RlcAntenna, fHz: number, z0 = Z0): Complex {
  return gammaFromImpedance(rlcImpedance(a, fHz), z0);
}

/** Small deterministic pseudo-random generator (mulberry32) for repeatable noise. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
