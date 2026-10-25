import { describe, expect, it } from "vitest";
import { checkBand, findBand, frequencyGrid, rlcGamma, scanRangeFor, US_BAND_PLAN } from "@resonance/analysis";
import {
  createProfile,
  deleteProfile,
  deleteSweep,
  drift,
  exportBackup,
  formatLength,
  importBackup,
  latestPerBand,
  listProfiles,
  listSweeps,
  loadSettings,
  parseLength,
  saveCheck,
  saveSettings,
  setBaseline,
  toSweep,
} from "../src/history";
import type { LastCheck } from "../src/state";
import { MemoryStore } from "../src/storage";

const band20 = findBand(US_BAND_PLAN, "20m")!;
const band40 = findBand(US_BAND_PLAN, "40m")!;

function check(bandId: "20m" | "40m", f0Hz: number, r = 50, at = Date.now()): LastCheck {
  const band = bandId === "20m" ? band20 : band40;
  const { startHz, stopHz } = scanRangeFor(band);
  const freqHz = frequencyGrid(startHz, stopHz, 101);
  const sweep = { freqHz, s11: freqHz.map((f) => rlcGamma({ f0Hz, r, q: 6 }, f)) };
  return { result: checkBand(sweep, band), sweep, calibrated: true, at };
}

describe("profiles and sweeps", () => {
  it("creates profiles with validation", async () => {
    const store = new MemoryStore();
    await expect(createProfile(store, { name: " ", type: "dipole", bands: ["20m"] })).rejects.toThrow(/name/);
    await expect(createProfile(store, { name: "X", type: "dipole", bands: ["99m"] })).rejects.toThrow(/band/);
    const p = await createProfile(store, { name: "Backyard EFHW", type: "efhw", bands: ["40m", "20m"] });
    expect((await listProfiles(store)).map((x) => x.name)).toEqual(["Backyard EFHW"]);
    expect(p.bands).toEqual(["40m", "20m"]);
  });

  it("saves checks, makes the first one the baseline, and round-trips the data", async () => {
    const store = new MemoryStore();
    const p = await createProfile(store, { name: "Dipole", type: "dipole", bands: ["20m", "40m"] });
    const c1 = check("20m", 14.175e6, 50, 1000);
    const s1 = await saveCheck(store, c1, p.id);
    const s2 = await saveCheck(store, check("20m", 14.1e6, 50, 2000), p.id);
    await saveCheck(store, check("40m", 7.15e6, 50, 3000), p.id);
    const profile = (await listProfiles(store))[0]!;
    expect(profile.baselines["20m"]).toBe(s1.id);
    const sweeps = await listSweeps(store, p.id);
    expect(sweeps.map((s) => s.takenAt)).toEqual([3000, 2000, 1000]);
    const latest = latestPerBand(sweeps);
    expect(latest.get("20m")!.id).toBe(s2.id);
    const back = toSweep(s1);
    expect(back.s11[10]!.re).toBeCloseTo(c1.sweep.s11[10]!.re, 12);
    expect(s1.summary.level).toBe("good");

    await setBaseline(store, p.id, s2);
    expect((await listProfiles(store))[0]!.baselines["20m"]).toBe(s2.id);
    await deleteSweep(store, s2.id);
    expect((await listProfiles(store))[0]!.baselines["20m"]).toBeUndefined();

    await deleteProfile(store, p.id);
    expect(await listSweeps(store)).toHaveLength(0);
  });
});

describe("drift", () => {
  it("flags a rise in SWR or a resonance shift past the spec thresholds", async () => {
    const store = new MemoryStore();
    const base = await saveCheck(store, check("20m", 14.175e6, 50), null);
    const same = await saveCheck(store, check("20m", 14.18e6, 50), null);
    const wet = await saveCheck(store, check("20m", 14.175e6, 120), null);
    const sagged = await saveCheck(store, check("20m", 13.9e6, 50), null);
    expect(drift(base, base)).toBeNull();
    expect(drift(base, same)).toBeNull();
    expect(drift(base, wet)!.message).toMatch(/lowest SWR rose/);
    expect(drift(base, wet)!.message).toMatch(/connectors/);
    expect(drift(base, sagged)!.message).toMatch(/resonance moved down 1\.9%/);
  });
});

describe("settings and backup", () => {
  it("validates thresholds", async () => {
    const store = new MemoryStore();
    expect((await loadSettings(store)).thresholds).toEqual({ good: 1.5, usable: 2 });
    await expect(saveSettings(store, { units: "metric", theme: "auto", thresholds: { good: 2, usable: 1.5 }, modes: [], introSeen: false })).rejects.toThrow();
    await saveSettings(store, { units: "imperial", theme: "sunlight", thresholds: { good: 1.3, usable: 1.8 }, modes: ["cw"], introSeen: true });
    expect(await loadSettings(store)).toMatchObject({ units: "imperial", theme: "sunlight", modes: ["cw"], introSeen: true });
  });

  it("exports and imports everything", async () => {
    const a = new MemoryStore();
    const p = await createProfile(a, { name: "Vertical", type: "vertical", bands: ["20m"] });
    await saveCheck(a, check("20m", 14.2e6), p.id);
    await saveSettings(a, { units: "imperial", theme: "dark", thresholds: { good: 1.5, usable: 2 }, modes: [], introSeen: true });
    const backup = JSON.parse(JSON.stringify(await exportBackup(a)));

    const b = new MemoryStore();
    expect(await importBackup(b, backup)).toEqual({ profiles: 1, sweeps: 1, calibrations: 0 });
    expect((await listProfiles(b))[0]!.name).toBe("Vertical");
    expect((await loadSettings(b)).units).toBe("imperial");
    await expect(importBackup(b, { hello: 1 })).rejects.toThrow(/isn't a Resonance backup/);
  });
});

describe("units", () => {
  it("formats and parses lengths", () => {
    expect(formatLength(0.042, "metric")).toBe("4.2 cm");
    expect(formatLength(5.03, "metric")).toBe("5.03 m");
    expect(formatLength(0.0508, "imperial")).toBe("2.0 in");
    expect(formatLength(5.03, "imperial")).toBe("16.5 ft");
    expect(parseLength("16.5", "imperial")).toBeCloseTo(5.03, 2);
    expect(parseLength("", "metric")).toBeUndefined();
  });
});
