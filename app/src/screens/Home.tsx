import { calLabel } from "../components/StatusBar";
import { calStatus, device, go, lastCheck } from "../state";

export function Home() {
  const last = lastCheck.value;
  const cal = calStatus.value;
  return (
    <>
      <h1 class="home-title">What are you working on?</h1>
      {device.value?.connected && cal.state !== "ok" && (
        <button class="nudge" onClick={() => go({ name: "calibrate" })}>
          <strong>{calLabel(cal)}</strong>
          <span>Calibrate first so verdicts are accurate. Takes about a minute.</span>
        </button>
      )}
      <div class="jobs">
        <button class="job primary" onClick={() => go({ name: "check" })}>
          <strong>Check my antenna</strong>
          <span>Pick a band, get a verdict</span>
        </button>
        <button class="job" onClick={() => go({ name: "soon", job: "Tune my antenna", milestone: "M4" })}>
          <strong>Tune</strong>
          <span>What to cut</span>
        </button>
        <button class="job" onClick={() => go({ name: "calibrate" })}>
          <strong>Calibrate</strong>
          <span>Open, short, load</span>
        </button>
        <button class="job" onClick={() => go({ name: "soon", job: "Test my coax", milestone: "M6" })}>
          <strong>Test coax</strong>
          <span>Length and faults</span>
        </button>
        <button class="job" onClick={() => go({ name: "soon", job: "History", milestone: "M5" })}>
          <strong>History</strong>
          <span>Saved sweeps</span>
        </button>
      </div>
      {last && (
        <button class="recent" onClick={() => go({ name: "check" })}>
          <div class="label">Last check</div>
          <div class="headline">{last.result.headline}</div>
          <div class="muted num">
            Lowest SWR {last.result.metrics.min.swr.toFixed(2)} at {(last.result.metrics.min.freqHz / 1e6).toFixed(3)} MHz
          </div>
        </button>
      )}
    </>
  );
}
