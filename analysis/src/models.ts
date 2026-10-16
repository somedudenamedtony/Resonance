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

export interface AntennaPreset {
  readonly id: string;
  readonly name: string;
  readonly antenna: RlcAntenna;
}

/** Antennas the simulator and emulator can pretend to be measuring. */
export const ANTENNA_PRESETS: readonly AntennaPreset[] = [
  { id: "good20", name: "20m dipole, well tuned", antenna: { f0Hz: 14.175e6, r: 52, q: 6 } },
  { id: "long20", name: "20m dipole, too long", antenna: { f0Hz: 13.82e6, r: 60, q: 7 } },
  { id: "short40", name: "40m dipole, too short", antenna: { f0Hz: 7.42e6, r: 58, q: 6 } },
  { id: "mismatch20", name: "20m vertical, poor match", antenna: { f0Hz: 14.2e6, r: 16, q: 5 } },
  { id: "efhw40", name: "40m EFHW, usable", antenna: { f0Hz: 7.12e6, r: 50, q: 12 } },
];

export function findPreset(id: string): AntennaPreset | undefined {
  return ANTENNA_PRESETS.find((p) => p.id === id);
}

/**
 * Plausible error terms for an uncalibrated NanoVNA port: a little directivity leakage,
 * some source mismatch, and phase rotation from the internal path that grows with frequency.
 * Used to make emulated "raw" data look like a real device with calibration turned off.
 */
export function typicalNanoVnaErrorTerms(fHz: number): { ed: Complex; es: Complex; er: Complex } {
  const t = fHz / 1e8;
  const rot = (mag: number, phase: number) => c(mag * Math.cos(phase), mag * Math.sin(phase));
  return {
    ed: rot(0.04 + 0.03 * t, 0.6 + 2.1 * t),
    es: rot(0.06 + 0.04 * t, -0.9 + 1.4 * t),
    er: rot(0.92 - 0.05 * t, -3.4 * t),
  };
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
