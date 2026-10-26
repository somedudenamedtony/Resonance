import { describe, expect, it } from "vitest";
import { checkBand, findBand, scanRangeFor, US_BAND_PLAN } from "@resonance/analysis";
import { BridgeClient } from "../src/bridge/client";
import { SimulatedTransport } from "../src/bridge/simulator";
import { bandView, checkView, deviceView, meterView, tuneView } from "../src/mirror";

const band20 = findBand(US_BAND_PLAN, "20m")!;

describe("NanoVNA screen views", () => {
  it("rounds, keeps markers inside the range and drops near-duplicates", () => {
    const v = deviceView({ startHz: 14_000_000.4, stopHz: 14_350_000 }, [14_175_000.6, 14_175_500, null, 13e6, 14_300_000, 14_200_000, 14_250_000]);
    expect(v.startHz).toBe(14_000_000);
    // 14_175_500 is within one device point (3.5 kHz) of the first marker; 13 MHz is off-screen.
    expect(v.markersHz).toEqual([14_175_001, 14_300_000, 14_200_000, 14_250_000]);
    expect(v.traces).toEqual(["swr", "smith"]);
  });

  it("shows a band, a check result, the trim target and the meter frequency", async () => {
    expect(bandView(band20)).toMatchObject({ ...scanRangeFor(band20), markersHz: [] });

    const sim = new SimulatedTransport();
    sim.configure({ msPer100Points: 0, noise: 0 });
    const client = new BridgeClient(sim);
    client.start();
    await new Promise<void>((r) => (client.onChange = () => client.device?.connected && r()));
    const sweep = await client.scan({ ...scanRangeFor(band20), points: 201 });
    client.stop();
    const result = checkBand(sweep, band20);
    const v = checkView({ result, sweep, calibrated: false, at: 0 });
    expect(v.markersHz![0]).toBe(result.metrics.min.freqHz);
    expect(v.startHz).toBe(scanRangeFor(band20).startHz);

    expect(tuneView(14_200_000, null).markersHz).toEqual([14_200_000]);
    expect(tuneView(14_200_000, 13_900_000).markersHz).toEqual([14_200_000, 13_900_000]);

    const m = meterView(14_074_000, band20);
    expect(m).toMatchObject({ markersHz: [14_074_000], traces: ["swr"] });
    expect(meterView(100e6, undefined)).toMatchObject({ startHz: 98e6, stopHz: 102e6 });
  });
});
