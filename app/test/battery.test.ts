import { describe, expect, it } from "vitest";
import { batteryDetail, batteryPercent, lowestBattery } from "../src/battery";

describe("batteryPercent", () => {
  it("clamps at full and empty", () => {
    expect(batteryPercent(4200)).toBe(100);
    expect(batteryPercent(4150)).toBe(100);
    expect(batteryPercent(3300)).toBe(0);
    expect(batteryPercent(2900)).toBe(0);
  });

  it("follows the curve between points", () => {
    expect(batteryPercent(3800)).toBe(52);
    expect(batteryPercent(3850)).toBe(60);
    expect(batteryPercent(3400)).toBe(3);
  });

  it("never goes down as voltage goes up", () => {
    let last = -1;
    for (let mv = 3000; mv <= 4300; mv += 5) {
      const p = batteryPercent(mv);
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
  });

  it("describes a reading", () => {
    expect(batteryDetail(3910)).toBe("3.91 V, about 69%");
  });
});

describe("lowestBattery", () => {
  it("picks whichever battery runs out first", () => {
    expect(lowestBattery({ nanovna: { mV: 3700 }, bridge: { mV: 4000 } }, true)).toEqual({ name: "NanoVNA", mV: 3700 });
    expect(lowestBattery({ nanovna: { mV: 4100 }, bridge: { mV: 3600 } }, true)).toEqual({ name: "Bridge", mV: 3600 });
  });

  it("leaves out the NanoVNA when it isn't connected, and handles nothing to show", () => {
    expect(lowestBattery({ nanovna: { mV: 3500 }, bridge: { mV: 4000 } }, false)).toEqual({ name: "Bridge", mV: 4000 });
    expect(lowestBattery({}, true)).toBeNull();
    expect(lowestBattery(null, true)).toBeNull();
  });
});
