import { describe, expect, it } from "vitest";
import { c, polar } from "../src/complex";
import {
  buildCalibration,
  correct,
  correctSweep,
  covers,
  distort,
  type ErrorTerms,
  solveOSL,
  termsAt,
} from "../src/calibration";
import { checkStandard, classifyStandard } from "../src/standards";
import { frequencyGrid } from "../src/sweep";

// Plausible, non-trivial error terms that vary with frequency.
const termsFor = (fHz: number): ErrorTerms => {
  const t = fHz / 60e6;
  return {
    ed: polar(0.05 + 0.02 * t, 0.4 + 1.1 * t),
    es: polar(0.1 + 0.05 * t, -0.7 + 0.5 * t),
    er: polar(0.9 - 0.1 * t, -2.3 * t),
  };
};

describe("one-port OSL calibration", () => {
  it("solves the exact error terms from ideal standards", () => {
    const truth = termsFor(14e6);
    const solved = solveOSL(distort(c(1), truth), distort(c(-1), truth), distort(c(0), truth));
    for (const k of ["ed", "es", "er"] as const) {
      expect(solved[k].re).toBeCloseTo(truth[k].re, 10);
      expect(solved[k].im).toBeCloseTo(truth[k].im, 10);
    }
  });

  it("recovers an unknown load through the error model", () => {
    const truth = termsFor(7.1e6);
    const actual = c(0.21, -0.37);
    const measured = distort(actual, truth);
    const recovered = correct(measured, truth);
    expect(recovered.re).toBeCloseTo(actual.re, 10);
    expect(recovered.im).toBeCloseTo(actual.im, 10);
  });

  it("interpolates terms between calibration points", () => {
    const grid = frequencyGrid(1e6, 60e6, 1001);
    const cal = buildCalibration(
      grid,
      grid.map((f) => distort(c(1), termsFor(f))),
      grid.map((f) => distort(c(-1), termsFor(f))),
      grid.map((f) => distort(c(0), termsFor(f))),
    );
    expect(covers(cal, 3.5e6, 4e6)).toBe(true);
    expect(covers(cal, 0.5e6, 4e6)).toBe(false);

    // A scan on a different grid, inside the cal range.
    const scan = frequencyGrid(14e6, 14.35e6, 201);
    const actual = scan.map((_, i) => polar(0.3, i / 50));
    const raw = scan.map((f, i) => distort(actual[i]!, termsFor(f)));
    const corrected = correctSweep(cal, scan, raw);
    corrected.forEach((g, i) => {
      expect(Math.abs(g.re - actual[i]!.re)).toBeLessThan(1e-4);
      expect(Math.abs(g.im - actual[i]!.im)).toBeLessThan(1e-4);
    });
  });

  it("refuses frequencies outside the calibrated range", () => {
    const grid = frequencyGrid(1e6, 30e6, 11);
    const cal = buildCalibration(grid, grid.map(() => c(1)), grid.map(() => c(-1)), grid.map(() => c(0)));
    expect(() => termsAt(cal, 50e6)).toThrow(RangeError);
  });
});

describe("standard check", () => {
  const t = termsFor(50e3);
  it("classifies raw open, short and load", () => {
    expect(classifyStandard(distort(c(1), t))).toBe("open");
    expect(classifyStandard(distort(c(-1), t))).toBe("short");
    expect(classifyStandard(distort(c(0), t))).toBe("load");
  });

  it("explains a wrong standard", () => {
    const r = checkStandard("open", distort(c(-1), t));
    expect(r.ok).toBe(false);
    expect(r.detected).toBe("short");
    expect(r.hint).toMatch(/open standard/);
  });
});
