import type { CheckResult } from "@resonance/analysis";
import { useState } from "preact/hooks";
import { EXPLAIN_BANDWIDTH, EXPLAIN_RESONANCE, explainSwr } from "../check";
import type { LearnTopic } from "../learn";
import { LearnLink } from "../screens/Learn";
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
      {result.causeText && (
        <p class="cause">
          {result.causeText}{" "}
          {result.cause && <LearnLink topic={result.cause === "mismatch" ? "impedance" : "resonance"}>Why?</LearnLink>}
        </p>
      )}
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

type Explained = "swr" | "res" | "bw" | null;

export function Readings({ result }: { result: CheckResult }) {
  const [open, setOpen] = useState<Explained>(null);
  const m = result.metrics;
  const mhz = (hz: number) => (hz / 1e6).toFixed(3);
  const khz = (hz: number) => `${Math.round(hz / 1e3)}`;
  const toggle = (k: Explained) => setOpen(open === k ? null : k);
  const text =
    open === "swr" ? explainSwr(m.min.swr) : open === "res" ? EXPLAIN_RESONANCE : open === "bw" ? EXPLAIN_BANDWIDTH : null;
  const topic: LearnTopic = open === "res" ? "resonance" : open === "bw" ? "bandwidth" : "swr";
  return (
    <>
      <div class="readings">
        <button class="reading" aria-expanded={open === "swr"} onClick={() => toggle("swr")}>
          <strong class="num">{m.min.swr.toFixed(2)}</strong>
          <span>lowest SWR</span>
        </button>
        <button class="reading" aria-expanded={open === "res"} onClick={() => toggle("res")}>
          <strong class="num">{m.resonanceHz !== null ? mhz(m.resonanceHz) : "none"}</strong>
          <span>resonant, MHz</span>
        </button>
        <button class="reading" aria-expanded={open === "bw"} onClick={() => toggle("bw")}>
          <strong class="num">
            {m.bw2 ? khz(m.bw2.widthHz) : "none"}
            {m.bw2?.clipped ? "+" : ""}
          </strong>
          <span>2:1 width, kHz</span>
        </button>
      </div>
      {text ? (
        <p class="explain" aria-live="polite">
          {text} <LearnLink topic={topic}>More in Learn</LearnLink>
        </p>
      ) : (
        <p class="explain-hint muted">Tap a reading to see what it means.</p>
      )}
    </>
  );
}
