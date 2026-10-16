import { describe, expect, it } from "vitest";
import { findBand, frequencyGrid, IDENTITY_TERMS, rlcGamma, US_BAND_PLAN } from "@resonance/analysis";
import { BridgeClient } from "../src/bridge/client";
import { SimulatedTransport } from "../src/bridge/simulator";
import { defaultSetup, readTune, TuneSession, tuneRange } from "../src/tune";

const band20 = findBand(US_BAND_PLAN, "20m")!;

async function simClient(antennaId: string) {
  const sim = new SimulatedTransport();
  sim.configure({ msPer100Points: 0, noise: 0.0002, errorTerms: () => IDENTITY_TERMS, antennaId });
  const client = new BridgeClient(sim);
  client.start();
  await new Promise<void>((r) => {
    client.onChange = () => {
      if (client.link === "open" && client.device?.connected) r();
    };
  });
  return { sim, client };
}

const sweepOf = (f0Hz: number, startHz: number, stopHz: number) => {
  const freqHz = frequencyGrid(startHz, stopHz, 201);
  return { freqHz, s11: freqHz.map((f) => rlcGamma({ f0Hz, r: 55, q: 7 }, f)) };
};

describe("tune readings", () => {
  const setup = defaultSetup(band20);
  const range = tuneRange(setup.targetHz);

  it("tells you to shorten a long antenna, with the cut in centimeters", () => {
    const r = readTune(sweepOf(13.8e6, range.startHz, range.stopHz), setup, undefined, null, true);
    expect(r.bound).toBe("exact");
    expect(r.resonanceHz / 1e6).toBeCloseTo(13.8, 2);
    expect(r.instruction.action).toBe("shorten");
    expect(r.instruction.text).toMatch(/^Shorten each leg \d+(\.\d)? cm$/);
  });

  it("says 'or more' when resonance is off the sweep", () => {
    const r = readTune(sweepOf(9e6, range.startHz, range.stopHz), setup, undefined, null, true);
    expect(r.bound).toBe("below");
    expect(r.instruction.text).toMatch(/or more$/);
  });

  it("tracks the trend between readings", () => {
    const a = readTune(sweepOf(13.6e6, range.startHz, range.stopHz), setup, undefined, null, true);
    const b = readTune(sweepOf(14.0e6, range.startHz, range.stopHz), setup, undefined, a, true);
    const c = readTune(sweepOf(13.5e6, range.startHz, range.stopHz), setup, undefined, b, true);
    expect(b.trend).toBe("closer");
    expect(c.trend).toBe("further");
  });

  it("is done within 0.5% of target", () => {
    const r = readTune(sweepOf(14.18e6, range.startHz, range.stopHz), setup, undefined, null, true);
    expect(r.instruction.action).toBe("done");
  });
});

describe("trim coach against the simulator", () => {
  it("brings a too-long 20m dipole to resonance in 3 cuts or fewer (spec success criterion)", async () => {
    const { sim, client } = await simClient("long20");
    const session = new TuneSession(defaultSetup(band20, "dipole"), () => null);
    await session.sweep(client);
    expect(session.reading!.instruction.action).toBe("shorten");
    let cuts = 0;
    while (!session.done && cuts < 5) {
      sim.trim(session.madeTheCut(), "dipole");
      cuts++;
      await session.sweep(client);
    }
    expect(session.done).toBe(true);
    expect(cuts).toBeLessThanOrEqual(3);
    expect(session.log).toHaveLength(cuts);
    expect(session.log.every((e) => e.resultHz !== null)).toBe(true);
    expect(Math.abs(session.reading!.resonanceHz - 14.175e6) / 14.175e6).toBeLessThan(0.005);
    client.stop();
  });

  it("lengthens a too-short 40m dipole, tracking a known length", async () => {
    const { sim, client } = await simClient("short40");
    const band40 = findBand(US_BAND_PLAN, "40m")!;
    const session = new TuneSession({ ...defaultSetup(band40), elementLengthM: 9.6 }, () => null);
    await session.sweep(client);
    expect(session.reading!.instruction.action).toBe("lengthen");
    const before = session.elementLengthM;
    sim.trim(session.madeTheCut(), "dipole");
    expect(session.elementLengthM).toBeGreaterThan(before);
    await session.sweep(client);
    expect(session.reading!.trend).toBe("closer");
    client.stop();
  });
});
