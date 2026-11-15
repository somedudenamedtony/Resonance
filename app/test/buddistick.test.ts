import { describe, expect, it } from "vitest";
import { findBand, frequencyGrid, IDENTITY_TERMS, type RlcAntenna, rlcGamma, US_BAND_PLAN } from "@resonance/analysis";
import { BridgeClient } from "../src/bridge/client";
import { SimulatedTransport } from "../src/bridge/simulator";
import { advise, BuddiSession, buddiSetup, quarterWaveM, readBuddi, simApply } from "../src/buddistick";
import { tuneRange } from "../src/tune";

const band = (id: string) => findBand(US_BAND_PLAN, id)!;
const setup20 = buddiSetup(band("20m"), 14_074_000);

const reading = (ant: RlcAntenna, targetHz = setup20.targetHz) => {
  const { startHz, stopHz } = tuneRange(targetHz);
  const freqHz = frequencyGrid(startHz, stopHz, 201);
  return readBuddi({ freqHz, s11: freqHz.map((f) => rlcGamma(ant, f)) }, targetHz, true);
};

describe("buddistick advice", () => {
  it("uses the coil for a big move, toward the whip to go up", () => {
    const a = advise(reading({ f0Hz: 13.0e6, r: 30, q: 20 }), setup20);
    expect(a).toMatchObject({ kind: "coil", dir: "toward" });
    if (a.kind === "coil") expect(a.turns).toBeGreaterThanOrEqual(2);
  });

  it("uses the coil away from the whip to go down", () => {
    expect(advise(reading({ f0Hz: 15.0e6, r: 30, q: 20 }), setup20)).toMatchObject({ kind: "coil", dir: "away" });
  });

  it("fine tunes with the whip: shorten when resonance is low", () => {
    const a = advise(reading({ f0Hz: 13.9e6, r: 45, q: 20 }), setup20);
    expect(a).toMatchObject({ kind: "whip", dir: "shorten" });
    // About 1.2% off on 20m: a few inches of whip, not feet.
    if (a.kind === "whip") expect(a.amountM).toBeGreaterThan(0.05);
    if (a.kind === "whip") expect(a.amountM).toBeLessThan(0.3);
  });

  it("lengthens the whip when resonance is a little high", () => {
    expect(advise(reading({ f0Hz: 14.25e6, r: 45, q: 20 }), setup20)).toMatchObject({ kind: "whip", dir: "lengthen" });
  });

  it("goes to the radial once on frequency with low resistance", () => {
    expect(advise(reading({ f0Hz: 14.08e6, r: 25, q: 20 }), setup20)).toMatchObject({ kind: "radial", dir: "lower" });
    expect(advise(reading({ f0Hz: 14.08e6, r: 90, q: 20 }), setup20)).toMatchObject({ kind: "radial", dir: "raise" });
  });

  it("is done when on frequency with a good match", () => {
    expect(advise(reading({ f0Hz: 14.08e6, r: 48, q: 20 }), setup20)).toEqual({ kind: "done" });
  });

  it("switches to the coil when the whip is at its limit", () => {
    const r = reading({ f0Hz: 14.25e6, r: 45, q: 20 });
    expect(advise(r, setup20, { whipAtLimit: "lengthen" })).toMatchObject({ kind: "coil", dir: "away" });
  });

  it("asks for the coil back in when a whip-only setup is too short", () => {
    const s10 = buddiSetup(band("10m"), 28_074_000);
    expect(s10.coilOut).toBe(true);
    expect(advise(reading({ f0Hz: 31e6, r: 40, q: 15 }, s10.targetHz), s10)).toEqual({ kind: "coil-in" });
  });

  it("starts the radial at a quarter wave", () => {
    expect(quarterWaveM(14.074e6)).toBeCloseTo(5.33, 1);
  });
});

describe("buddistick session", () => {
  it("learns how far the whip moves it and sizes the next step from that", () => {
    const s = new BuddiSession(setup20, () => null);
    let ant: RlcAntenna = { f0Hz: 13.85e6, r: 45, q: 20 };
    s.take(reading(ant));
    const first = s.advice!;
    expect(first.kind).toBe("whip");
    ant = simApply(s.madeTheChange()!, ant);
    s.take(reading(ant));
    expect(s.learned.whipPerM).toBeDefined();
    expect(s.log[0]!.afterHz).toBeCloseTo(ant.f0Hz, -4);
    // The sim whip moves 70% as far as asked, so the learned figure is lower than the guess.
    if (first.kind === "whip") expect(s.learned.whipPerM!).toBeLessThan(0.5 / quarterWaveM(setup20.targetHz));
  });

  it("flags a change that moved resonance the wrong way", () => {
    const s = new BuddiSession(setup20, () => null);
    s.take(reading({ f0Hz: 13.85e6, r: 45, q: 20 }));
    s.madeTheChange();
    s.take(reading({ f0Hz: 13.7e6, r: 45, q: 20 }));
    expect(s.wrongWay).toBe(true);
    expect(s.learned.whipPerM).toBeUndefined();
  });

  it("tunes a pretend Buddistick from the chart to done against the simulator", async () => {
    const sim = new SimulatedTransport();
    sim.configure({ msPer100Points: 0, noise: 0.0002, errorTerms: () => IDENTITY_TERMS, antenna: { f0Hz: 13.2e6, r: 27, q: 22 } });
    const client = new BridgeClient(sim);
    client.start();
    await new Promise<void>((r) => {
      client.onChange = () => {
        if (client.link === "open" && client.device?.connected) r();
      };
    });
    const s = new BuddiSession(setup20, () => null);
    await s.measure(client);
    const kinds: string[] = [];
    for (let i = 0; i < 15 && !s.done; i++) {
      const a = s.madeTheChange()!;
      kinds.push(a.kind);
      sim.configure({ antenna: simApply(a, sim.antenna) });
      await s.measure(client);
    }
    expect(s.done).toBe(true);
    expect(kinds[0]).toBe("coil");
    expect(kinds).toContain("whip");
    expect(kinds).toContain("radial");
    expect(s.reading!.swrAtTarget).toBeLessThanOrEqual(1.5);
  });
});
