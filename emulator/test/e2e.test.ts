/**
 * End to end, no hardware: the app's real BridgeClient talks over a real WebSocket to the real
 * C bridge core, which drives an emulated NanoVNA shell over a serial link.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCalibration,
  checkBand,
  correctSweep,
  findBand,
  findPreset,
  IDENTITY_TERMS,
  scanRangeFor,
  type Sweep,
  typicalNanoVnaErrorTerms,
  US_BAND_PLAN,
} from "@resonance/analysis";
import { BridgeClient } from "../../app/src/bridge/client";
import { WebSocketTransport } from "../../app/src/bridge/transport";
import { EmulatedBridge, type EmulatedBridgeOptions } from "../src/bridgeHost";

const band20 = findBand(US_BAND_PLAN, "20m")!;
const good20 = findPreset("good20")!.antenna;

let bridge: EmulatedBridge | null = null;
let client: BridgeClient | null = null;

async function waitFor(pred: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function setup(opts: EmulatedBridgeOptions = {}) {
  bridge = await new EmulatedBridge({
    ...opts,
    nanovna: { msPerPoint: 0.2, errorTerms: () => IDENTITY_TERMS, ...opts.nanovna },
  }).start();
  client = new BridgeClient(new WebSocketTransport(bridge.url));
  client.start();
  await waitFor(() => client!.link === "open" && !!client!.device?.connected, "NanoVNA ready");
  return { bridge, client };
}

import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(async () => {
  client?.stop();
  client = null;
  await bridge?.stop();
  bridge = null;
});

describe("app ↔ C bridge ↔ emulated NanoVNA", () => {
  it("probes the device and reports it to the app", async () => {
    const { client, bridge } = await setup();
    expect(client.device).toMatchObject({
      connected: true,
      model: "NanoVNA-H 4",
      firmware: "1.2.40-emu",
      maxPoints: 401,
    });
    await bridge.waitForLog(/binary scans/);
    expect(bridge.nanovna.history.slice(0, 3)).toEqual(["info", "version", "help"]);
  });

  it("checks a well-tuned 20m dipole: good verdict", async () => {
    const { client, bridge } = await setup();
    const progress: number[] = [];
    const sweep = await client.scan({ ...scanRangeFor(band20), points: 201 }, (p) => progress.push(p.received));
    expect(sweep.freqHz).toHaveLength(201);
    expect(progress.at(-1)).toBe(201);
    const r = checkBand(sweep, band20);
    expect(r.level).toBe("good");
    expect(r.metrics.resonanceHz! / 1e6).toBeCloseTo(14.175, 2);
    // One binary scan, device calibration and e-delay skipped (mask 0x9b = 155).
    expect(bridge.nanovna.history.at(-1)).toMatch(/^scan \d+ \d+ 201 155$/);
  });

  it("segments scans for classic 101-point firmware and parses text output", async () => {
    const { client, bridge } = await setup({ nanovna: { dialect: "classic" } });
    expect(client.device).toMatchObject({ model: "NanoVNA", maxPoints: 101 });
    const sweep = await client.scan({ ...scanRangeFor(band20), points: 301 });
    expect(sweep.freqHz).toHaveLength(301);
    const scans = bridge.nanovna.history.filter((h) => h.startsWith("scan "));
    expect(scans).toHaveLength(3);
    expect(scans.every((s) => s.endsWith(" 27"))).toBe(true); // text mask
    for (let i = 1; i < sweep.freqHz.length; i++) expect(sweep.freqHz[i]!).toBeGreaterThan(sweep.freqHz[i - 1]!);
    expect(checkBand(sweep, band20).level).toBe("good");
  });

  it("calibrates out realistic raw errors (open, short, load) and gets the true verdict", async () => {
    const { client, bridge } = await setup({ nanovna: { errorTerms: typicalNanoVnaErrorTerms, noise: 0.0005 } });
    const nano = bridge.nanovna;
    const range = scanRangeFor(band20);

    // Uncalibrated, the raw data misplaces the antenna's resonance.
    const rawSweep = await client.scan({ ...range, points: 201 });
    const rawRes = checkBand(rawSweep, band20).metrics.resonanceHz;
    const rawErr = rawRes === null ? Infinity : Math.abs(rawRes - good20.f0Hz) / good20.f0Hz;

    // Guided calibration: 1001 points over 1–60 MHz (three device scans each).
    const cal = { startHz: 1_000_000, stopHz: 60_000_000, points: 1001 };
    nano.options.port1 = { kind: "open" };
    const open = await client.scan(cal);
    nano.options.port1 = { kind: "short" };
    const short = await client.scan(cal);
    nano.options.port1 = { kind: "load" };
    const load = await client.scan(cal);
    const calibration = buildCalibration(open.freqHz, open.s11, short.s11, load.s11);

    nano.options.port1 = { kind: "antenna", antenna: good20 };
    const raw = await client.scan({ ...range, points: 201 });
    const corrected: Sweep = { freqHz: raw.freqHz, s11: correctSweep(calibration, raw.freqHz, raw.s11) };
    const r = checkBand(corrected, band20);
    expect(r.level).toBe("good");
    const calErr = Math.abs(r.metrics.resonanceHz! - good20.f0Hz) / good20.f0Hz;
    expect(calErr).toBeLessThan(0.001);
    expect(rawErr).toBeGreaterThan(calErr * 3);
  });

  it("streams the NanoVNA's screen (307 KB) through the bridge", async () => {
    const { client } = await setup();
    await client.scan({ startHz: 14_000_000, stopHz: 14_350_000, points: 101 });
    const cap = await client.capture();
    expect(cap).toMatchObject({ width: 480, height: 320 });
    expect(cap.data.length).toBe(480 * 320 * 2);
    // The yellow sweep trace (RGB565 0xFF20 for 255,230,0) is in there somewhere.
    let yellow = 0;
    for (let i = 0; i < cap.data.length; i += 2) if (cap.data[i] === 0xff && cap.data[i + 1] === 0x20) yellow++;
    expect(yellow).toBeGreaterThan(100);
    // And the bridge is free for the next scan.
    expect((await client.scan({ startHz: 14_000_000, stopHz: 14_350_000, points: 11 })).freqHz).toHaveLength(11);
  });

  it("relays console commands", async () => {
    const { client } = await setup();
    expect(await client.raw("version")).toBe("1.2.40-emu");
    expect(await client.raw("bogus")).toBe("bogus?");
  });

  it("reports an unplugged NanoVNA mid-scan and recovers when it's plugged back in", async () => {
    const { client, bridge } = await setup({ nanovna: { msPerPoint: 5 } });
    const scan = client.scan({ ...scanRangeFor(band20), points: 201 });
    await new Promise((r) => setTimeout(r, 100));
    bridge.detach();
    await expect(scan).rejects.toMatchObject({ code: "no_device" });
    await waitFor(() => client.device?.connected === false, "disconnected status");

    bridge.attach();
    await waitFor(() => client.device?.connected === true, "reconnected status");
    bridge.nanovna.options.msPerPoint = 0.2;
    const sweep = await client.scan({ ...scanRangeFor(band20), points: 51 });
    expect(sweep.freqHz).toHaveLength(51);
  });

  it("cancels a scan and runs the next one", async () => {
    const { client, bridge } = await setup({ nanovna: { msPerPoint: 3 } });
    const first = client.scan({ startHz: 1_000_000, stopHz: 30_000_000, points: 1001 });
    await new Promise((r) => setTimeout(r, 50));
    client.cancelScan();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
    bridge.nanovna.options.msPerPoint = 0.2;
    const second = await client.scan({ ...scanRangeFor(band20), points: 101 });
    expect(second.freqHz).toHaveLength(101);
    expect(checkBand(second, band20).level).toBe("good");
  });

  it("times out on a hung NanoVNA, then re-syncs", async () => {
    const { client, bridge } = await setup();
    bridge.nanovna.options.hung = true;
    const mark = bridge.logs.length;
    await expect(client.scan({ startHz: 14_000_000, stopHz: 14_350_000, points: 11 })).rejects.toMatchObject({
      code: "timeout",
    });
    await waitFor(() => client.device?.connected === false, "not-ready status during resync");
    bridge.nanovna.options.hung = false;
    await bridge.waitForLog(/NanoVNA ready/, 8000, mark);
    await waitFor(() => !!client.device?.connected, "ready after resync", 8000);
    const sweep = await client.scan({ startHz: 14_000_000, stopHz: 14_350_000, points: 11 });
    expect(sweep.freqHz).toHaveLength(11);
  });

  it("runs the live SWR meter's tiny scans back to back, on both dialects", async () => {
    const { MeterSession } = await import("../../app/src/meter");
    for (const dialect of ["nanovna-d", "classic"] as const) {
      const { client, bridge } = await setup({ nanovna: { dialect } });
      const meter = new MeterSession(good20.f0Hz, () => null);
      for (let i = 0; i < 5; i++) await meter.measure(client);
      expect(meter.history).toHaveLength(5);
      expect(meter.reading!.swr).toBeLessThan(1.2);
      expect(bridge.nanovna.history.filter((h) => h.startsWith("scan "))).toHaveLength(5);
      client.stop();
      await bridge.stop();
    }
  });

  it("rejects bad requests with a clear error", async () => {
    const { client } = await setup();
    await expect(client.scan({ startHz: 2_000_000, stopHz: 1_000_000, points: 11 })).rejects.toMatchObject({
      code: "bad_request",
    });
  });
});

describe("app calibration flow over the C bridge", () => {
  it("guided session + check gives the true verdict with realistic raw errors", async () => {
    const { CalibrationSession } = await import("../../app/src/cal");
    const { checkOneBand } = await import("../../app/src/check");
    const { client, bridge } = await setup({ nanovna: { errorTerms: typicalNanoVnaErrorTerms, noise: 0.0005 } });
    const session = new CalibrationSession();
    for (const kind of ["open", "short", "load"] as const) {
      bridge.nanovna.options.port1 = { kind };
      expect((await session.measure(client, kind)).ok).toBe(true);
    }
    bridge.nanovna.options.port1 = { kind: "antenna", antenna: good20 };
    const check = await checkOneBand(client, band20, session.finish());
    expect(check.calibrated).toBe(true);
    expect(check.result.level).toBe("good");
    expect(Math.abs(check.result.metrics.resonanceHz! - good20.f0Hz) / good20.f0Hz).toBeLessThan(0.001);
  });

  it("uploads a firmware image through the C bridge, byte for byte", async () => {
    const otaDir = mkdtempSync(join(tmpdir(), "resonance-ota-"));
    const { client, bridge } = await setup({ otaDir });
    const img = new Uint8Array(50_000).map((_, i) => (i * 131 + 7) & 0xff);
    img[0] = 0xe9;
    let last = 0;
    await client.update("firmware", img, (sent) => (last = sent));
    expect(last).toBe(img.length);
    await bridge.waitForLog(/ota\.end ok/, 2000);
    expect(new Uint8Array(readFileSync(join(otaDir, "firmware.bin")))).toEqual(img);
  });

  it("rejects a non-LittleFS file as the web app and keeps nothing", async () => {
    const otaDir = mkdtempSync(join(tmpdir(), "resonance-ota-"));
    const { client } = await setup({ otaDir });
    const img = new Uint8Array(9000).fill(0x41);
    await expect(client.update("app", img)).rejects.toMatchObject({ code: "bad_request" });
    expect(existsSync(join(otaDir, "app.bin"))).toBe(false);
    expect(existsSync(join(otaDir, "app.bin.part"))).toBe(false);
    // The bridge still scans afterwards.
    const sweep = await client.scan({ startHz: 14e6, stopHz: 14.35e6, points: 51 });
    expect(sweep.freqHz).toHaveLength(51);
  });
});
