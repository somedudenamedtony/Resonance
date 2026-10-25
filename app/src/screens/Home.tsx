import { Icon, Logo } from "../components/Icon";
import { calLabel } from "../components/StatusBar";
import { calStatus, device, go, lastCheck } from "../state";

export function Home() {
  const last = lastCheck.value;
  const cal = calStatus.value;
  return (
    <>
      <header class="brand">
        <Logo />
        <span>Resonance</span>
      </header>
      <h1 class="home-title">What are you working on?</h1>
      {device.value?.connected && cal.state !== "ok" && (
        <button class="nudge" onClick={() => go({ name: "calibrate" })}>
          <strong>{calLabel(cal)}</strong>
          <span>Calibrate first so verdicts are accurate. Takes about a minute.</span>
        </button>
      )}
      <div class="jobs">
        <button class="job primary" onClick={() => go({ name: "check" })}>
          <span class="job-icon">
            <Icon name="antenna" size={26} />
          </span>
          <strong>Check my antenna</strong>
          <span>Pick a band, get a verdict</span>
          <svg class="job-wave" viewBox="0 0 200 60" preserveAspectRatio="none" aria-hidden="true">
            <path d="M0 12C50 12 70 52 100 52S150 12 200 12" />
          </svg>
        </button>
        <button class="job" onClick={() => go({ name: "tune" })}>
          <span class="job-icon">
            <Icon name="tune" />
          </span>
          <strong>Tune</strong>
          <span>What to cut</span>
        </button>
        <button class="job" onClick={() => go({ name: "meter" })}>
          <span class="job-icon">
            <Icon name="meter" />
          </span>
          <strong>SWR meter</strong>
          <span>Live, for your tuner</span>
        </button>
        <button class="job" onClick={() => go({ name: "calibrate" })}>
          <span class="job-icon">
            <Icon name="calibrate" />
          </span>
          <strong>Calibrate</strong>
          <span>Open, short, load</span>
        </button>
        <button class="job" onClick={() => go({ name: "coax" })}>
          <span class="job-icon">
            <Icon name="coax" />
          </span>
          <strong>Test coax</strong>
          <span>Length and faults</span>
        </button>
        <button class="job" onClick={() => go({ name: "antennas" })}>
          <span class="job-icon">
            <Icon name="history" />
          </span>
          <strong>Antennas</strong>
          <span>History and changes</span>
        </button>
      </div>
      {last && (
        <button class="recent" onClick={() => go({ name: "check" })}>
          <div class="label">
            Last check <Icon name="chevron" size={16} />
          </div>
          <div class="headline">{last.result.headline}</div>
          <div class="muted num">
            Lowest SWR {last.result.metrics.min.swr.toFixed(2)} at {(last.result.metrics.min.freqHz / 1e6).toFixed(3)} MHz
          </div>
        </button>
      )}
    </>
  );
}
