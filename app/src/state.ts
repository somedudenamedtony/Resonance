import { signal } from "@preact/signals";
import type { CheckResult, Sweep } from "@resonance/analysis";
import { BridgeClient, type LinkState } from "./bridge/client";
import type { DeviceStatus } from "./bridge/protocol";
import { SimulatedTransport } from "./bridge/simulator";
import { type Transport, WebSocketTransport } from "./bridge/transport";

/**
 * Pick the transport:
 *   ?bridge=ws://host/ws  → that bridge
 *   ?sim                  → simulator
 *   served by the bridge  → ws://<same host>/ws
 *   anything else (dev)   → simulator
 */
export function chooseTransport(loc: Location = window.location): Transport {
  const params = new URLSearchParams(loc.search);
  const explicit = params.get("bridge");
  if (explicit) return new WebSocketTransport(explicit);
  if (params.has("sim")) return new SimulatedTransport();
  const bridgeHosts = ["192.168.4.1", "resonance.local"];
  if (bridgeHosts.includes(loc.hostname)) return new WebSocketTransport(`ws://${loc.host}/ws`);
  return new SimulatedTransport();
}

export type Route =
  | { name: "home" }
  | { name: "connect" }
  | { name: "check" }
  | { name: "soon"; job: string; milestone: string };

export const client = new BridgeClient(chooseTransport());

export const link = signal<LinkState>(client.link);
export const device = signal<DeviceStatus | null>(client.device);
export const route = signal<Route>({ name: "home" });
export const lastCheck = signal<{ result: CheckResult; sweep: Sweep; at: number } | null>(null);
/** No calibration flow until M3, so every result is uncalibrated for now. */
export const calibrated = signal(false);

client.onChange = () => {
  link.value = client.link;
  device.value = client.device ? { ...client.device } : null;
};

export const go = (r: Route) => {
  route.value = r;
  window.scrollTo(0, 0);
};
