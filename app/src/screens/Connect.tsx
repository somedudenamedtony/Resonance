import { useRef, useState } from "preact/hooks";
import { rgb565beToRgba } from "../bridge/protocol";
import { SIM_ANTENNAS, SimulatedTransport } from "../bridge/simulator";
import { client, device, go, link } from "../state";

export function Connect() {
  const d = device.value;
  const l = link.value;
  const sim = client.transport instanceof SimulatedTransport ? client.transport : null;
  const [antennaId, setAntennaId] = useState(sim?.options.antennaId ?? "");
  const [plugged, setPlugged] = useState(sim?.options.deviceConnected ?? true);
  const [cmd, setCmd] = useState("version");
  const [reply, setReply] = useState("");

  const bridgeText = l === "open" ? "Connected" : l === "connecting" ? "Connecting" : "Not reachable";

  return (
    <>
      <div class="flow-head">
        <h2>Connection</h2>
        <button class="icon-btn" onClick={() => go({ name: "home" })}>
          Done
        </button>
      </div>

      <div class="rows">
        <div class="row">
          <span>Bridge</span>
          <span class="value">{bridgeText}</span>
        </div>
        <div class="row">
          <span>Address</span>
          <span class="value muted">{client.transport.label}</span>
        </div>
        <div class="row">
          <span>NanoVNA</span>
          <span class="value">{d?.connected ? (d.model ?? "Connected") : "Not detected"}</span>
        </div>
        {d?.connected && (
          <div class="row">
            <span>Firmware</span>
            <span class="value num">{d.firmware ?? "Unknown"}</span>
          </div>
        )}
      </div>

      {l !== "open" && !sim && (
        <p class="muted" style={{ marginTop: "12px" }}>
          Join the Resonance Wi-Fi network on this phone, then come back. The app reconnects on its own.
        </p>
      )}
      {l === "open" && !d?.connected && (
        <p class="muted" style={{ marginTop: "12px" }}>
          Plug the NanoVNA into the ESP32 port labeled USB, and turn the NanoVNA on.
        </p>
      )}

      {sim && (
        <>
          <h3 class="section-title">Simulator</h3>
          <label class="muted" for="sim-antenna">
            Pretend antenna
          </label>
          <select
            id="sim-antenna"
            value={antennaId}
            onChange={(e) => {
              const id = (e.target as HTMLSelectElement).value;
              setAntennaId(id);
              sim.configure({ antennaId: id, antenna: null });
            }}
          >
            {SIM_ANTENNAS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <label class="toggle">
            <input
              type="checkbox"
              checked={plugged}
              onChange={(e) => {
                const on = (e.target as HTMLInputElement).checked;
                setPlugged(on);
                sim.configure({ deviceConnected: on });
              }}
            />
            NanoVNA plugged in
          </label>
        </>
      )}

      <DeviceScreen ready={l === "open" && !!d?.connected} />

      <h3 class="section-title">Command console</h3>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!cmd.trim()) return;
          try {
            setReply(await client.raw(cmd.trim()));
          } catch (err) {
            setReply((err as Error).message);
          }
        }}
      >
        <input
          type="text"
          value={cmd}
          autocapitalize="off"
          autocomplete="off"
          spellcheck={false}
          aria-label="Command to send to the NanoVNA"
          onInput={(e) => setCmd((e.target as HTMLInputElement).value)}
        />
        <div class="actions">
          <button class="btn primary" type="submit" disabled={l !== "open"}>
            Send
          </button>
        </div>
      </form>
      <div class="console num" aria-live="polite">
        {reply || <span class="muted">Replies show here</span>}
      </div>
    </>
  );
}

function DeviceScreen({ ready }: { ready: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"idle" | "loading" | "shown" | { error: string }>("idle");
  const show = async () => {
    setState("loading");
    try {
      const cap = await client.capture();
      const c = canvas.current!;
      c.width = cap.width;
      c.height = cap.height;
      const ctx = c.getContext("2d")!;
      const img = ctx.createImageData(cap.width, cap.height);
      img.data.set(rgb565beToRgba(cap.data, cap.width, cap.height));
      ctx.putImageData(img, 0, 0);
      setState("shown");
    } catch (e) {
      setState({ error: (e as Error).message });
    }
  };
  return (
    <>
      <h3 class="section-title">Device screen</h3>
      <canvas ref={canvas} class="device-screen" hidden={state !== "shown"} aria-label="The NanoVNA's screen" />
      {typeof state === "object" && (
        <p class="field-error" role="alert">
          {state.error}
        </p>
      )}
      <div class="actions single">
        <button class="btn" disabled={!ready || state === "loading"} onClick={show}>
          {state === "loading" ? "Reading the screen…" : state === "shown" ? "Refresh screen" : "Show the NanoVNA's screen"}
        </button>
      </div>
    </>
  );
}
