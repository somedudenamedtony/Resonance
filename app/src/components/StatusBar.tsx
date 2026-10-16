import { calibrated, client, device, go, link } from "../state";

export function StatusBar() {
  const l = link.value;
  const d = device.value;
  const sim = client.transport.kind === "simulator";

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
    text = sim ? "Simulated NanoVNA ready" : `${d.model ?? "NanoVNA"} ready`;
  }

  return (
    <button class="status" onClick={() => go({ name: "connect" })} aria-label={`Connection: ${text}. Open connection details.`}>
      <span class={`status-dot ${tone}`} aria-hidden="true" />
      <span class="status-text">{text}</span>
      {l === "open" && d?.connected && !calibrated.value && <span class="status-cal">Not calibrated</span>}
    </button>
  );
}
