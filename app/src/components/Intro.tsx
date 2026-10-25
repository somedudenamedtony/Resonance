import { useState } from "preact/hooks";
import { go, settings, updateSettings } from "../state";
import { Icon, type IconName } from "./Icon";

const STEPS: { icon: IconName; title: string; text: string }[] = [
  {
    icon: "antenna",
    title: "Connect",
    text: "Plug the NanoVNA into the bridge and join the bridge's Wi-Fi. The strip at the top of every screen shows whether the NanoVNA is ready; tap it for details.",
  },
  {
    icon: "calibrate",
    title: "Calibrate",
    text: "Put the open, short and load on the end of the cable you'll use for the antenna. It takes about a minute and covers every band from 160m to 6m.",
  },
  {
    icon: "meter",
    title: "Check",
    text: "Pick where you operate and a band. You get a plain-English verdict and the SWR curve. Drag across the chart to read any frequency, and tap any number to see what it means.",
  },
];

/** First-run walkthrough: three cards, then straight into the first job. */
export function Intro() {
  const [i, setI] = useState(0);
  const done = (then?: () => void) => {
    void updateSettings({ ...settings.value, introSeen: true });
    then?.();
  };
  const step = STEPS[i]!;
  const last = i === STEPS.length - 1;
  return (
    <section class="intro" aria-label="Quick start">
      <div class="intro-head">
        <span class="muted small">
          Quick start, {i + 1} of {STEPS.length}
        </span>
        <button class="link-btn" onClick={() => done()}>
          Skip
        </button>
      </div>
      <div class="intro-step">
        <span class="job-icon">
          <Icon name={step.icon} />
        </span>
        <h2>{step.title}</h2>
      </div>
      <p>{step.text}</p>
      <div class="intro-dots" aria-hidden="true">
        {STEPS.map((_, k) => (
          <span key={k} class={k === i ? "on" : ""} />
        ))}
      </div>
      <div class="actions">
        {last ? (
          <>
            <button class="btn primary" onClick={() => done(() => go({ name: "calibrate" }))}>
              Calibrate now
            </button>
            <button class="btn" onClick={() => done(() => go({ name: "learn" }))}>
              Learn the basics
            </button>
          </>
        ) : (
          <>
            <button class="btn primary" onClick={() => setI(i + 1)}>
              Next
            </button>
            {i > 0 && (
              <button class="btn" onClick={() => setI(i - 1)}>
                Back
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
