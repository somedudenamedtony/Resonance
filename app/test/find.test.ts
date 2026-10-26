import { describe, expect, it } from "vitest";
import { IDENTITY_TERMS } from "@resonance/analysis";
import { BridgeClient } from "../src/bridge/client";
import { SimulatedTransport } from "../src/bridge/simulator";
import {
  deviceMaxHz,
  dipHz,
  findHeadline,
  findResonance,
  formatHz,
  fullRange,
  nearestDip,
  parseMhz,
  rangeNotes,
  rangeProblem,
  swrAt,
  targetRange,
} from "../src/find";
import { createProfile, latestPerBand, listSweeps, saveFind, TARGET_KEY } from "../src/history";
import { findView } from "../src/mirror";
import { MemoryStore } from "../src/storage";

async function simClient(antennaId: string, noise = 0.002) {
  const sim = new SimulatedTransport();
  sim.configure({ msPer100Points: 0, noise, errorTerms: () => IDENTITY_TERMS, antennaId });
  const client = new BridgeClient(sim);
  client.start();
  await new Promise<void>((r) => {
    client.onChange = () => {
      if (client.link === "open" && client.device?.connected) r();
    };
  });
  return { sim, client };
}

describe("find resonance", () => {
  it("finds a 1090 MHz antenna on a full 50 kHz–1.5 GHz search", async () => {
    const { client } = await simClient("adsb1090");
    const result = await findResonance(client, fullRange(null), null, { targetHz: 1090e6 });
    client.stop();
    expect(result.dips.length).toBeGreaterThan(0);
    const near = nearestDip(result.dips, 1090e6)!;
    expect(near).toBe(result.dips[0]);
    expect(near.zoom).toBeDefined();
    // The simulated antenna resonates at 1072 MHz; the close look pins it far tighter than the coarse step.
    expect(Math.abs(dipHz(near) - 1072e6)).toBeLessThan(2e6);
    expect(near.zoom!.bestSwr).toBeLessThan(1.4);
    expect(swrAt(result, 1090e6)).toBeGreaterThan(near.zoom!.bestSwr);
    const h = findHeadline(result);
    expect(h.headline).toMatch(/^Resonant at 107\d(\.\d)? MHz, 1\.\d% below 1090 MHz$/);
    expect(h.detail).toMatch(/a little long/);
  });

  it("finds a 20m dipole on a full search too, and calls it on target when it is", async () => {
    const { client } = await simClient("good20");
    const result = await findResonance(client, fullRange(null), null, { targetHz: 14.175e6 });
    client.stop();
    expect(result.dips.length).toBe(1);
    expect(Math.abs(dipHz(result.dips[0]!) / 14.175e6 - 1)).toBeLessThan(0.005);
    expect(findHeadline(result).headline).toMatch(/^Resonant on target, at 14\.1\d\d MHz$/);
  });

  it("says so when nothing in the range resonates", async () => {
    const { client } = await simClient("good20");
    const result = await findResonance(client, { startHz: 400e6, stopHz: 500e6 }, null);
    client.stop();
    expect(result.dips).toEqual([]);
    expect(findHeadline(result).headline).toBe("No clear resonance between 400 MHz and 500 MHz");
  });

  it("knows each NanoVNA's top frequency and checks ranges against it", () => {
    expect(deviceMaxHz({ model: "NanoVNA-H4" })).toBe(1.5e9);
    expect(deviceMaxHz({ model: "LiteVNA 64" })).toBe(6e9);
    expect(deviceMaxHz(null)).toBe(1.5e9);
    expect(rangeProblem({ startHz: 1e6, stopHz: 2e9 }, 1.5e9)).toMatch(/1.5 GHz/);
    expect(rangeProblem({ startHz: 2e6, stopHz: 1e6 }, 1.5e9)).toMatch(/above the start/);
    expect(rangeProblem({ startHz: 900e6, stopHz: 1300e6 }, 1.5e9)).toBeNull();
    expect(targetRange(1090e6, 1.5e9)).toEqual({ startHz: 817.5e6, stopHz: 1362.5e6 });
    expect(targetRange(1.4e9, 1.5e9).stopHz).toBe(1.5e9);
  });

  it("formats and parses frequencies", () => {
    expect(formatHz(1090e6)).toBe("1090 MHz");
    expect(formatHz(14.175e6)).toBe("14.175 MHz");
    expect(formatHz(50_000)).toBe("50 kHz");
    expect(formatHz(1.5e9)).toBe("1.5 GHz");
    expect(parseMhz("1090")).toBe(1090e6);
    expect(parseMhz("14,2")).toBe(14.2e6);
    expect(parseMhz("abc")).toBeUndefined();
    expect(parseMhz("")).toBeUndefined();
  });

  it("warns about accuracy above 900 MHz and past the app's calibration", () => {
    expect(rangeNotes({ startHz: 1e6, stopHz: 30e6 }, true)).toEqual([]);
    const notes = rangeNotes({ startHz: 900e6, stopHz: 1300e6 }, false);
    expect(notes[0]).toMatch(/harmonics/);
    expect(notes[1]).toMatch(/NanoVNA's own calibration/);
  });

  it("marks the dip and the target on the NanoVNA's screen", () => {
    expect(findView({ startHz: 1e9, stopHz: 1.2e9 }, [1090e6, 1072e6])).toMatchObject({
      startHz: 1e9,
      stopHz: 1.2e9,
      markersHz: [1090e6, 1072e6],
    });
  });

  it("saves a search to an antenna made for a non-ham frequency", async () => {
    const store = new MemoryStore();
    await expect(createProfile(store, { name: "x", type: "vertical", bands: [] })).rejects.toThrow(/frequency/);
    const p = await createProfile(store, { name: "ADS-B", type: "vertical", bands: [], targetHz: 1090e6 });
    expect(p.targetHz).toBe(1090e6);

    const { client } = await simClient("adsb1090", 0.0005);
    const result = await findResonance(client, targetRange(1090e6, 1.5e9), null, { targetHz: 1090e6 });
    client.stop();
    const zoom = nearestDip(result.dips, 1090e6)!.zoom!;
    const s = await saveFind(
      store,
      { sweep: zoom.sweep, calibrated: false, at: result.at, swrAtTarget: swrAt(result, 1090e6) },
      p.id,
      { good: 1.5, usable: 2 },
    );
    expect(s.job).toBe("find");
    expect(s.summary.level).not.toBeNull();
    const latest = latestPerBand(await listSweeps(store, p.id));
    expect(latest.get(TARGET_KEY)?.id).toBe(s.id);
    expect((await store.get<{ baselines: Record<string, string> }>("profiles", p.id))!.baselines[TARGET_KEY]).toBe(s.id);
  });
});
