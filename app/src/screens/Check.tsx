import { useEffect, useState } from "preact/hooks";
import {
  type Band,
  checkBand,
  findBand,
  scanRangeFor,
  type Sweep,
  swrSeries,
  US_BAND_PLAN,
} from "@resonance/analysis";
import { SwrChart } from "../components/SwrChart";
import { Readings, Verdict } from "../components/Verdict";
import { applyCalibration } from "../cal";
import { calibration, client, device, go, lastCheck, link } from "../state";

const POINTS = 201;

type Phase =
  | { kind: "pick" }
  | { kind: "scanning"; band: Band; partial: Sweep | null; received: number }
  | { kind: "done"; band: Band }
  | { kind: "error"; band: Band; message: string };

export function Check() {
  const last = lastCheck.value;
  const [phase, setPhase] = useState<Phase>(last ? { kind: "done", band: last.result.band } : { kind: "pick" });
  const ready = link.value === "open" && !!device.value?.connected;

  useEffect(() => () => client.cancelScan(), []);

  async function run(band: Band) {
    const range = scanRangeFor(band);
    setPhase({ kind: "scanning", band, partial: null, received: 0 });
    try {
      const cal = calibration.value;
      const raw = await client.scan({ ...range, points: POINTS }, (p) =>
        setPhase({
          kind: "scanning",
          band,
          partial: applyCalibration(cal, { freqHz: [...p.partial.freqHz], s11: [...p.partial.s11] }).sweep,
          received: p.received,
        }),
      );
      const { sweep, calibrated } = applyCalibration(cal, raw);
      const result = checkBand(sweep, band);
      lastCheck.value = { result, sweep, calibrated, at: Date.now() };
      setPhase({ kind: "done", band });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "cancelled") setPhase({ kind: "pick" });
      else setPhase({ kind: "error", band, message: (e as Error).message });
    }
  }

  const close = () => {
    client.cancelScan();
    go({ name: "home" });
  };

  return (
    <>
      <div class="flow-head">
        <h2>Check my antenna</h2>
        <button class="icon-btn" onClick={close}>
          Close
        </button>
      </div>

      {phase.kind === "pick" && <BandPicker ready={ready} onPick={run} />}

      {phase.kind === "scanning" && (
        <>
          <p class="muted">
            Scanning {phase.band.name}, {Math.round((phase.received / POINTS) * 100)}%
          </p>
          <div class="chart">
            <SwrChart
              {...scanRangeFor(phase.band)}
              freqHz={phase.partial?.freqHz ?? []}
              swr={phase.partial ? swrSeries(phase.partial) : []}
              band={phase.band}
            />
          </div>
          <div class="actions">
            <button class="btn" onClick={() => client.cancelScan()}>
              Cancel scan
            </button>
          </div>
        </>
      )}

      {phase.kind === "done" && last && (
        <>
          <Verdict result={last.result} calibrated={last.calibrated} />
          <div class="chart">
            <SwrChart
              {...scanRangeFor(last.result.band)}
              freqHz={last.sweep.freqHz}
              swr={last.result.metrics.swr}
              band={last.result.band}
              min={last.result.metrics.min}
            />
          </div>
          <Readings result={last.result} />
          <div class="actions">
            <button class="btn primary" disabled={!ready} onClick={() => run(last.result.band)}>
              Scan again
            </button>
            <button class="btn" onClick={() => setPhase({ kind: "pick" })}>
              Another band
            </button>
          </div>
        </>
      )}

      {phase.kind === "error" && (
        <>
          <div class="error" role="alert">
            <p>{phase.message}</p>
          </div>
          <div class="actions">
            <button class="btn primary" disabled={!ready} onClick={() => run(phase.band)}>
              Retry scan
            </button>
            <button class="btn" onClick={() => go({ name: "connect" })}>
              Check connection
            </button>
          </div>
        </>
      )}
    </>
  );
}

const HF_FIRST = ["20m", "40m", "80m", "15m", "10m", "17m", "30m", "12m", "160m", "60m", "6m", "2m"];

function BandPicker({ ready, onPick }: { ready: boolean; onPick: (b: Band) => void }) {
  const bands = HF_FIRST.map((id) => findBand(US_BAND_PLAN, id)).filter((b): b is Band => !!b);
  return (
    <>
      {!ready && (
        <div class="error" role="alert">
          <p>The NanoVNA isn't ready. Check the connection, then pick a band.</p>
        </div>
      )}
      <p class="muted" style={{ margin: "4px 0 12px" }}>
        Which band?
      </p>
      <div class="bands">
        {bands.map((b) => (
          <button key={b.id} class="band" disabled={!ready} onClick={() => onPick(b)}>
            <strong>{b.name}</strong>
            <span class="num">
              {(b.startHz / 1e6).toFixed(b.startHz < 1e7 ? 1 : 0)}–{(b.stopHz / 1e6).toFixed(b.stopHz < 1e7 ? 1 : 2).replace(/\.?0+$/, "")}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}
