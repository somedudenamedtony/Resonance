import type { CheckResult } from "@resonance/analysis";
import { go } from "../state";

const LEVEL_TEXT = { good: "Good", usable: "Usable", poor: "Needs work" } as const;
const LEVEL_MARK = { good: "✓", usable: "~", poor: "!" } as const;

export function Verdict({ result, calibrated }: { result: CheckResult; calibrated: boolean }) {
  return (
    <section class={`verdict ${result.level}`} aria-live="polite">
      <span class="level">
        <span aria-hidden="true">{LEVEL_MARK[result.level]}</span>
        {LEVEL_TEXT[result.level]}
      </span>
      <h1>{result.headline}</h1>
      <p class="detail">{result.detail}</p>
      {result.causeText && <p class="cause">{result.causeText}</p>}
      {!calibrated && (
        <p class="uncal">
          <span class="badge">Uncalibrated</span>
          <button class="link-btn" onClick={() => go({ name: "calibrate" })}>
            Calibrate for accurate results
          </button>
        </p>
      )}
    </section>
  );
}

export function Readings({ result }: { result: CheckResult }) {
  const m = result.metrics;
  const mhz = (hz: number) => (hz / 1e6).toFixed(3);
  const khz = (hz: number) => `${Math.round(hz / 1e3)}`;
  return (
    <div class="readings">
      <div class="reading">
        <strong class="num">{m.min.swr.toFixed(2)}</strong>
        <span>lowest SWR</span>
      </div>
      <div class="reading">
        <strong class="num">{m.resonanceHz !== null ? mhz(m.resonanceHz) : "none"}</strong>
        <span>resonant, MHz</span>
      </div>
      <div class="reading">
        <strong class="num">
          {m.bw2 ? khz(m.bw2.widthHz) : "0"}
          {m.bw2?.clipped ? "+" : ""}
        </strong>
        <span>2:1 width, kHz</span>
      </div>
    </div>
  );
}
