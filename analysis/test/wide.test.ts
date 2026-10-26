import { describe, expect, it } from "vitest";
import { c, frequencyGrid, gammaFromImpedance, rlcImpedance, swr } from "../src";
import { findDips, joinSweeps, wantsLogAxis, wideChunks, zoomRange } from "../src/wide";

// Two resonances in parallel-ish: a 14 MHz dipole that also loads up on 1090 MHz, through nothing.
const twoDips = (f: number) => {
  const a = rlcImpedance({ f0Hz: 14.2e6, r: 55, q: 6 }, f);
  const b = rlcImpedance({ f0Hz: 1.09e9, r: 40, q: 5 }, f);
  // Whichever branch is closer to resonance dominates: pick the smaller reactance.
  return gammaFromImpedance(Math.abs(a.im) < Math.abs(b.im) ? a : b);
};

describe("wide sweeps", () => {
  it("splits a wide range into log-spaced pieces no wider than 3:1", () => {
    const chunks = wideChunks({ startHz: 50_000, stopHz: 1.5e9 });
    expect(chunks.length).toBe(10);
    expect(chunks[0]!.startHz).toBe(50_000);
    expect(chunks.at(-1)!.stopHz).toBe(1.5e9);
    for (const k of chunks) expect(k.stopHz / k.startHz).toBeLessThanOrEqual(3.0001);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.startHz).toBe(chunks[i - 1]!.stopHz);
    expect(wideChunks({ startHz: 900e6, stopHz: 1300e6 })).toEqual([{ startHz: 900e6, stopHz: 1300e6 }]);
  });

  it("joins pieces without repeating the shared edge", () => {
    const a = { freqHz: [1, 2, 3], s11: [c(0), c(0), c(0)] };
    const b = { freqHz: [3, 4], s11: [c(0.5), c(0)] };
    expect(joinSweeps([a, b]).freqHz).toEqual([1, 2, 3, 4]);
  });

  it("finds both dips on a 50 kHz–1.5 GHz search and zooms onto each", () => {
    const parts = wideChunks({ startHz: 50_000, stopHz: 1.5e9 }).map((r) => {
      const freqHz = frequencyGrid(r.startHz, r.stopHz, 201);
      return { freqHz, s11: freqHz.map(twoDips) };
    });
    const sweep = joinSweeps(parts);
    const dips = findDips(sweep);
    expect(dips.length).toBe(2);
    const hz = dips.map((d) => d.freqHz).sort((x, y) => x - y);
    expect(Math.abs(hz[0]! / 14.2e6 - 1)).toBeLessThan(0.01);
    expect(Math.abs(hz[1]! / 1.09e9 - 1)).toBeLessThan(0.01);
    for (const d of dips) {
      const z = zoomRange(d, sweep);
      expect(z.startHz).toBeLessThan(d.freqHz);
      expect(z.stopHz).toBeGreaterThan(d.freqHz);
      const f0 = d.freqHz > 1e8 ? 1.09e9 : 14.2e6;
      expect(z.startHz).toBeLessThan(f0);
      expect(z.stopHz).toBeGreaterThan(f0);
      expect(z.stopHz / z.startHz).toBeLessThan(1.5);
    }
    expect(wantsLogAxis({ startHz: 50_000, stopHz: 1.5e9 })).toBe(true);
  });

  it("ignores noise, a slope into the sweep edge, and shallow ripple", () => {
    const freqHz = frequencyGrid(100e6, 200e6, 201);
    // SWR falls toward the top edge (resonance above the sweep) with a little ripple on it.
    const s11 = freqHz.map((f, i) => {
      const mag = 0.95 - ((f - 100e6) / 100e6) * 0.4 + 0.01 * Math.sin(i);
      return c(mag, 0);
    });
    expect(findDips({ freqHz, s11 })).toEqual([]);
  });

  it("reports SWR at the bottom of the dip", () => {
    const freqHz = frequencyGrid(1e9, 1.2e9, 201);
    const s11 = freqHz.map((f) => gammaFromImpedance(rlcImpedance({ f0Hz: 1.09e9, r: 50, q: 5 }, f)));
    const [d] = findDips({ freqHz, s11 });
    expect(d!.swr).toBeLessThan(1.05);
    expect(d!.swr).toBeCloseTo(swr(s11[d!.index]!), 6);
  });
});
