import { describe, expect, it } from "vitest";
import { findBand, scanRangeFor, US_BAND_PLAN } from "../src/bands";
import { lengthFromQuarterWave } from "../src/coax";
import { analyze } from "../src/metrics";
import { type RlcAntenna, rlcGamma } from "../src/models";
import { frequencyGrid, type Sweep } from "../src/sweep";
import { estimateElementLengthM, trimInstruction } from "../src/trim";
import { checkBand } from "../src/verdict";

const band20 = findBand(US_BAND_PLAN, "20m")!;

function sweepOf(a: RlcAntenna, startHz: number, stopHz: number, points = 201): Sweep {
  const freqHz = frequencyGrid(startHz, stopHz, points);
  return { freqHz, s11: freqHz.map((f) => rlcGamma(a, f)) };
}

function bandSweep(a: RlcAntenna): Sweep {
  const { startHz, stopHz } = scanRangeFor(band20);
  return sweepOf(a, startHz, stopHz);
}

describe("metrics", () => {
  it("finds resonance and minimum SWR of an RLC antenna", () => {
    const m = analyze(bandSweep({ f0Hz: 14.175e6, r: 50, q: 25 }));
    expect(m.resonanceHz! / 1e6).toBeCloseTo(14.175, 3);
    expect(m.resonanceR!).toBeCloseTo(50, 1);
    expect(m.min.swr).toBeLessThan(1.01);
    expect(m.bw2!.widthHz).toBeGreaterThan(m.bw15!.widthHz);
  });

  it("resonance and minimum SWR can differ in level", () => {
    const m = analyze(bandSweep({ f0Hz: 14.1e6, r: 100, q: 8 }));
    expect(m.min.swr).toBeCloseTo(2, 1);
    expect(m.resonanceHz! / 1e6).toBeCloseTo(14.1, 2);
  });
});

describe("band verdicts", () => {
  it("good: broad, matched antenna centered in band", () => {
    const r = checkBand(bandSweep({ f0Hz: 14.175e6, r: 50, q: 3 }), band20);
    expect(r.level).toBe("good");
    expect(r.headline).toBe("Good on 20m");
    expect(r.cause).toBeNull();
  });

  it("poor and too long when resonant below the band", () => {
    const r = checkBand(bandSweep({ f0Hz: 13.8e6, r: 50, q: 12 }), band20);
    expect(r.level).toBe("poor");
    expect(r.cause).toBe("too_long");
    expect(r.causeText).toMatch(/too long/);
  });

  it("says 'somewhere below' when resonance is outside the scan", () => {
    const r = checkBand(bandSweep({ f0Hz: 13.0e6, r: 50, q: 4 }), band20);
    expect(r.cause).toBe("too_long");
    expect(r.causeText).toMatch(/somewhere below/);
  });

  it("poor and too short when resonant above the band", () => {
    const r = checkBand(bandSweep({ f0Hz: 14.6e6, r: 50, q: 12 }), band20);
    expect(r.cause).toBe("too_short");
  });

  it("mismatch when resonant in band at the wrong resistance", () => {
    const r = checkBand(bandSweep({ f0Hz: 14.175e6, r: 180, q: 8 }), band20);
    expect(r.level).toBe("poor");
    expect(r.cause).toBe("mismatch");
    expect(r.causeText).toMatch(/Ω/);
  });

  it("usable when under 2:1 but not 1.5:1 across the band", () => {
    const r = checkBand(bandSweep({ f0Hz: 14.175e6, r: 50, q: 22 }), band20);
    expect(r.maxSwrInBand).toBeGreaterThan(1.5);
    expect(r.maxSwrInBand).toBeLessThanOrEqual(2);
    expect(r.level).toBe("usable");
  });
});

describe("trim coach", () => {
  it("tells you to shorten when resonant low", () => {
    const t = trimInstruction({ type: "dipole", resonanceHz: 13.92e6, targetHz: 14.175e6, elementLengthM: 5.12 });
    expect(t.action).toBe("shorten");
    // 5.12 * (1 - 13.92/14.175) * 0.8 ≈ 0.0737 m
    expect(t.amountM).toBeCloseTo(0.0737, 3);
    expect(t.text).toBe("Shorten each leg 7.4 cm");
  });

  it("tells you to lengthen when resonant high", () => {
    const t = trimInstruction({ type: "efhw", resonanceHz: 14.5e6, targetHz: 14.175e6 });
    expect(t.action).toBe("lengthen");
    expect(t.lengthIsEstimate).toBe(true);
    expect(t.text).toMatch(/^Lengthen the element/);
  });

  it("is done within tolerance", () => {
    const t = trimInstruction({ type: "dipole", resonanceHz: 14.17e6, targetHz: 14.175e6 });
    expect(t.action).toBe("done");
  });

  it("estimates a 20m dipole leg near 5 m", () => {
    expect(estimateElementLengthM("dipole", 14.175e6)).toBeCloseTo(5.03, 2);
  });
});

describe("coax", () => {
  it("length from quarter-wave frequency", () => {
    // 10 m of RG-8X (VF 0.78) has its quarter wave at VF·c/(4·L) ≈ 5.846 MHz.
    expect(lengthFromQuarterWave(5.846e6, 0.78)).toBeCloseTo(10, 2);
  });
});
