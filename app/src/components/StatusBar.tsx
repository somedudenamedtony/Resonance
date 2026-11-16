import { batteryPercent, lowestBattery } from "../battery";
import { battery, calStatus, device, go, isSimulator, link } from "../state";
import { BatteryGauge } from "./BatteryGauge";

export function calLabel(s: ReturnType<typeof calStatus.peek>): string {
  switch (s.state) {
    case "none":
      return "Not calibrated";
    case "stale":
      return s.reason === "device" ? "Recalibrate: new device" : "Calibration is old";
    case "ok":
      return s.ageDays < 1 ? "Calibrated today" : `Calibrated ${Math.floor(s.ageDays)}d ago`;
  }
}

export function StatusBar() {
  const l = link.value;
  const d = device.value;
  const cal = calStatus.value;

  let tone: "ok" | "warn" | "bad";
  let text: string;
  if (l !== "open") {
    tone = "bad";
    text = l === "connecting" ? "Connecting to the bridge" : "Bridge not reachable";
  } else if (!d?.connected) {
    tone = "warn";
    text = "NanoVNA not detected";
  } else {
    tone = "ok";
    text = isSimulator ? "Simulated NanoVNA ready" : `${d.model ?? "NanoVNA"} ready`;
  }
  const ready = l === "open" && !!d?.connected;
  const batt = l === "open" ? lowestBattery(battery.value, !!d?.connected) : null;
  const battText = batt ? ` ${batt.name} battery about ${batteryPercent(batt.mV)}%.` : "";

  return (
    <button class="status" onClick={() => go({ name: "connect" })} aria-label={`Connection: ${text}. ${calLabel(cal)}.${battText} Open connection details.`}>
      <span class={`status-dot ${tone}`} aria-hidden="true" />
      <span class="status-text">{text}</span>
      {batt && (
        <span class="status-battery num" title={`${batt.name} battery`}>
          <BatteryGauge mV={batt.mV} />
          {batteryPercent(batt.mV)}%
        </span>
      )}
      {ready && <span class={cal.state === "ok" ? "status-cal ok" : "status-cal"}>{calLabel(cal)}</span>}
    </button>
  );
}
