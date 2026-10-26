import { describe, expect, it } from "vitest";
import { checkBand, DEFAULT_THRESHOLDS, findBand, frequencyGrid, rlcGamma, scanRangeFor, US_BAND_PLAN } from "@resonance/analysis";
import { rejudge } from "../src/check";
import { nearestIndex, swrWord } from "../src/components/SwrChart";
import type { LastCheck } from "../src/state";

const band20 = findBand(US_BAND_PLAN, "20m")!;

function narrowCwAntenna(): LastCheck {
  const { startHz, stopHz } = scanRangeFor(band20);
  const freqHz = frequencyGrid(startHz, stopHz, 201);
  const sweep = { freqHz, s11: freqHz.map((f) => rlcGamma({ f0Hz: 14.075e6, r: 50, q: 25 }, f)) };
  return { result: checkBand(sweep, band20), sweep, calibrated: true, at: 1 };
}

describe("judging where you operate", () => {
  it("re-judges a check for a mode without rescanning, and back again", () => {
    const whole = narrowCwAntenna();
    expect(whole.result.level).toBe("poor");
    const cw = rejudge(whole, DEFAULT_THRESHOLDS, ["cw"]);
    expect(cw.result.level).toBe("good");
    expect(cw.result.segment).toMatchObject({ startHz: 14_000_000, stopHz: 14_150_000, label: "CW" });
    expect(cw.sweep).toBe(whole.sweep);
    expect(cw.at).toBe(whole.at);
    expect(rejudge(cw, DEFAULT_THRESHOLDS, []).result.level).toBe("poor");
  });
});

describe("chart cursor", () => {
  it("snaps to the nearest sweep point", () => {
    const f = [14.0e6, 14.1e6, 14.2e6, 14.3e6];
    expect(nearestIndex(f, 13e6)).toBe(0);
    expect(nearestIndex(f, 14.149e6)).toBe(1);
    expect(nearestIndex(f, 14.151e6)).toBe(2);
    expect(nearestIndex(f, 15e6)).toBe(3);
  });

  it("puts an SWR in words", () => {
    expect(swrWord(1.2)).toBe("excellent");
    expect(swrWord(1.9)).toBe("fine for most radios");
    expect(swrWord(2.5)).toBe("many radios cut power");
    expect(swrWord(Number.POSITIVE_INFINITY)).toBe("too high for most radios");
  });
});
