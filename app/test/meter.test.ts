import { describe, expect, it } from "vitest";
import { frequencyGrid, IDENTITY_TERMS, rlcGamma, US_BAND_PLAN } from "@resonance/analysis";
import { BridgeClient } from "../src/bridge/client";
import { SimulatedTransport } from "../src/bridge/simulator";
import { bandOf, METER_POINTS, meterRange, MeterSession, needleFraction, presetsFor, readMeter } from "../src/meter";

async function simClient() {
  const sim = new SimulatedTransport();
  sim.configure({ msPer100Points: 0, noise: 0.0002, errorTerms: () => IDENTITY_TERMS });
  const client = new BridgeClient(sim);
  client.start();
  await new Promise<void>((r) => {
    client.onChange = () => {
      if (client.link === "open" && client.device?.connected) r();
    };
  });
  return { sim, client };
}

describe("meter readings", () => {
  it("asks for a tiny valid scan centered on the frequency", () => {
    const r = meterRange(14.2e6);
    expect(r.points).toBe(METER_POINTS);
    expect(r.stopHz).toBeGreaterThan(r.startHz);
    expect((r.startHz + r.stopHz) / 2).toBe(14.2e6);
    expect(frequencyGrid(r.startHz, r.stopHz, r.points)[Math.floor(r.points / 2)]).toBe(14.2e6);
  });

  it("reads SWR, impedance and return loss", () => {
    const { startHz, stopHz, points } = meterRange(14.2e6);
    const freqHz = frequencyGrid(startHz, stopHz, points);
    const z100 = { f0Hz: 14.2e6, r: 100, q: 0.001 };
    const r = readMeter({ freqHz, s11: freqHz.map((f) => rlcGamma(z100, f)) }, 14.2e6, true);
    expect(r.swr).toBeCloseTo(2, 2);
    expect(r.z.re).toBeCloseTo(100, 0);
    expect(r.returnLossDb).toBeCloseTo(9.54, 1);
  });

  it("puts the needle linear in |Γ|", () => {
    expect(needleFraction(1)).toBe(0);
    expect(needleFraction(1.5)).toBeCloseTo(0.2);
    expect(needleFraction(3)).toBeCloseTo(0.5);
    expect(needleFraction(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("meter against the simulator", () => {
  it("follows a tuner adjustment and remembers the best reading", async () => {
    const { sim, client } = await simClient();
    const s = new MeterSession(14.2e6, () => null);
    sim.configure({ antenna: { f0Hz: 14.6e6, r: 120, q: 6 } });
    const before = await s.measure(client);
    sim.configure({ antenna: { f0Hz: 14.2e6, r: 50, q: 6 } });
    const after = await s.measure(client);
    expect(before.swr).toBeGreaterThan(2);
    expect(after.swr).toBeLessThan(1.1);
    expect(s.best).toBe(after);
    sim.configure({ antenna: { f0Hz: 14.4e6, r: 60, q: 6 } });
    await s.measure(client);
    expect(s.best).toBe(after);
    s.resetBest();
    expect(s.best).toBe(s.reading);
    expect(s.history).toHaveLength(3);
    client.stop();
  });
});

describe("meter presets", () => {
  it("offers FT8 and the band center for every band, all inside the band", () => {
    for (const band of US_BAND_PLAN.bands) {
      const ps = presetsFor(band);
      expect(ps.map((p) => p.label)).toContain("FT8");
      expect(ps.at(-1)!.label).toBe("Center");
      for (const p of ps) expect(bandOf(US_BAND_PLAN.bands, p.freqHz)?.id, `${band.id} ${p.label}`).toBe(band.id);
    }
  });

  it("uses the usual FT8 dial frequency", () => {
    const b20 = US_BAND_PLAN.bands.find((b) => b.id === "20m")!;
    expect(presetsFor(b20).find((p) => p.label === "FT8")!.freqHz).toBe(14_074_000);
  });
});
