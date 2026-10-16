import { describe, expect, it } from "vitest";
import { checkBand, findBand, scanRangeFor, US_BAND_PLAN } from "@resonance/analysis";
import { BridgeClient } from "../src/bridge/client";
import {
  decodeOtaFrame,
  decodeScanFrame,
  detectUpdateTarget,
  encodeOtaFrame,
  encodeScanFrame,
  recordsPerFrame,
} from "../src/bridge/protocol";
import { SimulatedTransport } from "../src/bridge/simulator";

describe("binary scan frames", () => {
  it("round-trip S11 records", () => {
    const pts = [
      { freqHz: 14_000_000, s11re: 0.25, s11im: -0.5 },
      { freqHz: 14_350_000, s11re: -0.125, s11im: 0.75 },
    ];
    const buf = encodeScanFrame({ scanId: 513, offset: 40, hasS21: false, points: pts });
    expect(buf.byteLength).toBe(8 + 2 * 16);
    const f = decodeScanFrame(buf);
    expect(f).toMatchObject({ scanId: 513, offset: 40, hasS21: false });
    expect(f.points).toEqual(pts);
  });

  it("round-trip S21 records and respect the 4 KB frame cap", () => {
    const buf = encodeScanFrame({
      scanId: 1,
      offset: 0,
      hasS21: true,
      points: [{ freqHz: 7.1e6, s11re: 0.5, s11im: 0, s21re: 0.25, s21im: -0.25 }],
    });
    expect(decodeScanFrame(buf).points[0]).toEqual({ freqHz: 7.1e6, s11re: 0.5, s11im: 0, s21re: 0.25, s21im: -0.25 });
    expect(8 + recordsPerFrame(false) * 16).toBeLessThanOrEqual(4096);
    expect(8 + recordsPerFrame(true) * 24).toBeLessThanOrEqual(4096);
  });

  it("rejects a truncated frame", () => {
    const buf = encodeScanFrame({ scanId: 1, offset: 0, hasS21: false, points: [{ freqHz: 1, s11re: 0, s11im: 0 }] });
    expect(() => decodeScanFrame(buf.slice(0, 20))).toThrow();
  });
});

describe("update frames", () => {
  it("round-trip and detect image types", () => {
    const data = new Uint8Array([1, 2, 3]);
    const f = decodeOtaFrame(encodeOtaFrame(70_000, data));
    expect(f.offset).toBe(70_000);
    expect([...f.data]).toEqual([1, 2, 3]);
    const lfs = new Uint8Array(32);
    lfs.set(new TextEncoder().encode("littlefs"), 8);
    expect(detectUpdateTarget(lfs)).toBe("app");
    expect(detectUpdateTarget(new Uint8Array([0xe9, 0]))).toBe("firmware");
    expect(detectUpdateTarget(new Uint8Array([0x7f, 0x45]))).toBeNull();
  });
});

describe("bridge client against the simulator", () => {
  const connected = async () => {
    const sim = new SimulatedTransport();
    sim.configure({ msPer100Points: 0, noise: 0 });
    const client = new BridgeClient(sim);
    client.start();
    await new Promise<void>((resolve) => {
      client.onChange = () => {
        if (client.link === "open" && client.device?.connected) resolve();
      };
    });
    return { sim, client };
  };

  it("scans a band and produces a good verdict for the tuned preset", async () => {
    const { client } = await connected();
    const band = findBand(US_BAND_PLAN, "20m")!;
    let lastProgress = 0;
    const sweep = await client.scan({ ...scanRangeFor(band), points: 201 }, (p) => (lastProgress = p.received));
    expect(sweep.freqHz).toHaveLength(201);
    expect(lastProgress).toBe(201);
    const r = checkBand(sweep, band);
    expect(r.level).toBe("good");
    client.stop();
  });

  it("reports a missing NanoVNA", async () => {
    const { sim, client } = await connected();
    sim.configure({ deviceConnected: false });
    await expect(client.scan({ startHz: 1e6, stopHz: 2e6, points: 11 })).rejects.toMatchObject({ code: "no_device" });
    client.stop();
  });

  it("reads the device screen", async () => {
    const { client } = await connected();
    const cap = await client.capture();
    expect(cap).toMatchObject({ width: 480, height: 320, format: "rgb565be" });
    expect(cap.data.length).toBe(480 * 320 * 2);
    client.stop();
  });

  it("uploads a firmware image in acked chunks", async () => {
    const { sim, client } = await connected();
    const img = new Uint8Array(10_000).map((_, i) => (i * 31) & 0xff);
    img[0] = 0xe9;
    const seen: number[] = [];
    await client.update("firmware", img, (sent) => seen.push(sent));
    expect(seen).toEqual([4088, 8176, 10_000]);
    expect(sim.lastUpdate?.target).toBe("firmware");
    expect(sim.lastUpdate?.bytes).toEqual(img);
    client.stop();
  });

  it("refuses the wrong file for the target", async () => {
    const { client } = await connected();
    const img = new Uint8Array(100);
    img[0] = 0xe9;
    await expect(client.update("app", img)).rejects.toMatchObject({ message: expect.stringContaining("littlefs.bin") });
    client.stop();
  });

  it("answers raw commands", async () => {
    const { client } = await connected();
    expect(await client.raw("version")).toBe("1.2.40-sim");
    client.stop();
  });
});
