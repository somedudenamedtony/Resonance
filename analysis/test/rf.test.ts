import { describe, expect, it } from "vitest";
import { abs, c } from "../src/complex";
import { gammaFromImpedance, impedance, reflectedPower, returnLoss, swr } from "../src/rf";

describe("rf conversions", () => {
  it("matched load has SWR 1 and infinite return loss", () => {
    const g = gammaFromImpedance(c(50, 0));
    expect(abs(g)).toBeCloseTo(0, 12);
    expect(swr(g)).toBeCloseTo(1, 12);
    expect(returnLoss(g)).toBe(Number.POSITIVE_INFINITY);
  });

  it("100 Ω resistive load gives SWR 2", () => {
    const g = gammaFromImpedance(c(100, 0));
    expect(abs(g)).toBeCloseTo(1 / 3, 12);
    expect(swr(g)).toBeCloseTo(2, 12);
    expect(reflectedPower(g)).toBeCloseTo(1 / 9, 12);
    expect(returnLoss(g)).toBeCloseTo(9.542, 3);
  });

  it("impedance and gamma round-trip", () => {
    const z = c(37, -22);
    const back = impedance(gammaFromImpedance(z));
    expect(back.re).toBeCloseTo(37, 9);
    expect(back.im).toBeCloseTo(-22, 9);
  });

  it("open circuit has infinite SWR", () => {
    expect(swr(c(1, 0))).toBe(Number.POSITIVE_INFINITY);
  });
});
