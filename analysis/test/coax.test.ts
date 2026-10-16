import { describe, expect, it } from "vitest";
import {
  analyzeCoax,
  coaxGamma,
  type CoaxModel,
  findCoaxType,
  firstQuarterWaveHz,
  frequencyGrid,
  OPEN_END,
  rlcGamma,
  typicalLossDb,
} from "../src";
import { fft } from "../src/fft";
import { parseTouchstone, toCsv, toTouchstone } from "../src/export";

const rg8x = findCoaxType("rg8x")!;
const grid = frequencyGrid(50_000, 60_000_000, 1001);

function measure(model: CoaxModel) {
  return { freqHz: grid, s11: grid.map((f) => coaxGamma(model, f)) };
}

const cable = (extra: Partial<CoaxModel> = {}): CoaxModel => ({
  lengthM: 18,
  velocityFactor: rg8x.velocityFactor,
  lossDbPer100mAt10MHz: rg8x.lossDbPer100mAt10MHz,
  end: OPEN_END,
  ...extra,
});

describe("fft", () => {
  it("inverse of forward is identity (scaled)", () => {
    const re = Float64Array.from({ length: 16 }, (_, i) => Math.sin(i));
    const im = new Float64Array(16);
    const orig = [...re];
    fft(re, im);
    fft(re, im, true);
    re.forEach((v, i) => expect(v / 16).toBeCloseTo(orig[i]!, 10));
  });
});

describe("coax test", () => {
  it("measures length of an open cable by quarter wave", () => {
    const s = measure(cable());
    const q = firstQuarterWaveHz(s)!;
    expect(q / 1e6).toBeCloseTo((0.78 * 299_792_458) / (4 * 18) / 1e6, 1);
    const a = analyzeCoax(s, rg8x.velocityFactor, { farEnd: "open" });
    expect(a.method).toBe("quarter-wave");
    expect(a.lengthM!).toBeCloseTo(18, 1);
    expect(a.faults).toHaveLength(0);
  });

  it("estimates loss of an open cable", () => {
    const a = analyzeCoax(measure(cable()), rg8x.velocityFactor, { farEnd: "open", lossAtHz: 14.2e6 });
    expect(a.lossDb!).toBeCloseTo(typicalLossDb(rg8x, 18, 14.2e6), 1);
  });

  it("finds a fault partway along the cable", () => {
    const a = analyzeCoax(measure(cable({ faults: [{ atM: 12, gamma: 0.15 }] })), rg8x.velocityFactor, { farEnd: "open" });
    expect(a.faults).toHaveLength(1);
    expect(a.faults[0]!.distanceM).toBeCloseTo(12, 0);
    expect(a.faults[0]!.reflection).toBeGreaterThan(0.1);
    expect(a.lengthM!).toBeCloseTo(18, 0);
  });

  it("finds length by TDR with an antenna on the end", () => {
    const antenna = (f: number) => rlcGamma({ f0Hz: 14.2e6, r: 50, q: 6 }, f);
    const a = analyzeCoax(measure(cable({ lengthM: 25, end: antenna })), rg8x.velocityFactor, { farEnd: "connected" });
    expect(a.method).toBe("tdr");
    expect(Math.abs(a.lengthM! - 25)).toBeLessThan(1);
    expect(a.lossDb).toBeNull();
  });
});

describe("export", () => {
  it("round-trips Touchstone and writes CSV", () => {
    const s = measure(cable());
    const back = parseTouchstone(toTouchstone(s));
    expect(back.freqHz).toHaveLength(1001);
    expect(back.s11[500]!.re).toBeCloseTo(s.s11[500]!.re, 8);
    const csv = toCsv(s).split("\n");
    expect(csv[0]).toBe("frequency_hz,s11_re,s11_im,swr,r_ohm,x_ohm,return_loss_db");
    expect(csv[1]!.split(",")).toHaveLength(7);
    const ma = parseTouchstone("# MHz S MA R 50\n14.0 0.5 90\n");
    expect(ma.freqHz[0]).toBe(14e6);
    expect(ma.s11[0]!.im).toBeCloseTo(0.5, 9);
  });
});
