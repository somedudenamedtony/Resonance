import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  checkBand,
  distort,
  findBand,
  rlcGamma,
  scanRangeFor,
  typicalNanoVnaErrorTerms,
  US_BAND_PLAN,
} from "@resonance/analysis";
import { BridgeClient } from "../src/bridge/client";
import { SimulatedTransport } from "../src/bridge/simulator";
import { applyCalibration, CAL_RANGE, calState, CalibrationSession, loadForm, saveForm } from "../src/cal";
import { IdbStore, MemoryStore } from "../src/storage";

const band20 = findBand(US_BAND_PLAN, "20m")!;

async function simClient() {
  const sim = new SimulatedTransport();
  sim.configure({ msPer100Points: 0, noise: 0.0003, errorTerms: typicalNanoVnaErrorTerms });
  const client = new BridgeClient(sim);
  client.start();
  await new Promise<void>((r) => {
    client.onChange = () => {
      if (client.link === "open" && client.device?.connected) r();
    };
  });
  return { sim, client };
}

describe("storage", () => {
  const makers = { memory: async () => new MemoryStore(), indexeddb: async () => IdbStore.open() };
  for (const [name, make] of Object.entries(makers)) {
    it(`round-trips records (${name})`, async () => {
      const s = await make();
      await s.clear("kv");
      await s.put("kv", { id: "a", n: 1 });
      await s.put("kv", { id: "b", n: 2 });
      expect(await s.get<{ n: number }>("kv", "a")).toEqual({ id: "a", n: 1 });
      expect((await s.getAll("kv")).length).toBe(2);
      await s.delete("kv", "a");
      expect(await s.get("kv", "a")).toBeUndefined();
    });
  }
});

describe("calibration model", () => {
  it("survives the stored form", () => {
    const freqHz = [1e6, 2e6];
    const t = typicalNanoVnaErrorTerms(1e6);
    const cal = { freqHz, terms: [t, typicalNanoVnaErrorTerms(2e6)] };
    const back = loadForm(JSON.parse(JSON.stringify(saveForm(cal, null))));
    expect(back.terms[0]!.es.im).toBeCloseTo(t.es.im, 12);
    expect(back.freqHz).toEqual(freqHz);
  });

  it("goes stale after 7 days or on a different device", () => {
    const saved = saveForm({ freqHz: [1, 2], terms: [] }, { connected: true, model: "H4", firmware: "1.2", bridgeVersion: "x" }, 0);
    const dev = { connected: true, model: "H4", firmware: "1.2", bridgeVersion: "x" };
    expect(calState(null, dev).state).toBe("none");
    expect(calState(saved, dev, 2 * 86_400_000)).toMatchObject({ state: "ok" });
    expect(calState(saved, dev, 8 * 86_400_000)).toMatchObject({ state: "stale", reason: "age" });
    expect(calState(saved, { ...dev, firmware: "1.3" }, 1000)).toMatchObject({ state: "stale", reason: "device" });
  });

  it("only applies when the calibration covers the sweep", () => {
    const cal = { freqHz: [1e6, 30e6], terms: [typicalNanoVnaErrorTerms(1e6), typicalNanoVnaErrorTerms(30e6)] };
    const inRange = { freqHz: [7e6], s11: [distort(rlcGamma({ f0Hz: 7e6, r: 50, q: 5 }, 7e6), typicalNanoVnaErrorTerms(7e6))] };
    expect(applyCalibration(cal, inRange).calibrated).toBe(true);
    expect(applyCalibration(cal, { freqHz: [144e6], s11: [{ re: 0, im: 0 }] }).calibrated).toBe(false);
    expect(applyCalibration(null, inRange).calibrated).toBe(false);
  });
});

describe("guided calibration against the simulator", () => {
  it("rejects the wrong standard, then calibrates out raw errors", async () => {
    const { sim, client } = await simClient();
    const session = new CalibrationSession();

    sim.configure({ standard: "short" });
    const wrong = await session.measure(client, "open");
    expect(wrong.ok).toBe(false);
    expect(wrong.detected).toBe("short");
    expect(session.step).toBe(0);

    for (const kind of ["open", "short", "load"] as const) {
      sim.configure({ standard: kind });
      expect((await session.measure(client, kind)).ok).toBe(true);
    }
    expect(session.done).toBe(true);
    const cal = session.finish();
    expect(cal.freqHz).toHaveLength(CAL_RANGE.points);

    sim.configure({ standard: null, antennaId: "good20" });
    const raw = await client.scan({ ...scanRangeFor(band20), points: 201 });
    const { sweep, calibrated } = applyCalibration(cal, raw);
    expect(calibrated).toBe(true);
    const r = checkBand(sweep, band20);
    expect(r.level).toBe("good");
    expect(Math.abs(r.metrics.resonanceHz! - 14.175e6) / 14.175e6).toBeLessThan(0.001);
    client.stop();
  });
});
