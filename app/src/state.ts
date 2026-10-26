import { computed, signal } from "@preact/signals";
import type { Calibration, CheckResult, Sweep } from "@resonance/analysis";
import { BridgeClient, type LinkState } from "./bridge/client";
import type { DeviceStatus, ReleaseUpdateStatus, WifiStatus } from "./bridge/protocol";
import { SimulatedTransport } from "./bridge/simulator";
import { isBridgeHost, type Transport, WebSocketTransport } from "./bridge/transport";
import { calState, loadForm, type SavedCalibration } from "./cal";
import {
  type AntennaProfile,
  DEFAULT_SETTINGS,
  listProfiles,
  loadSettings,
  saveSettings,
  type Settings,
  type Theme,
} from "./history";
import type { LearnTopic } from "./learn";
import { MemoryStore, openStore, type Store } from "./storage";

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
  if (isBridgeHost(loc.hostname)) return new WebSocketTransport(`ws://${loc.host}/ws`);
  return new SimulatedTransport();
}

export type Route =
  | { name: "home" }
  | { name: "connect" }
  | { name: "check" }
  | { name: "calibrate" }
  | { name: "tune"; targetHz?: number }
  | { name: "find"; targetHz?: number; profileId?: string }
  | { name: "meter" }
  | { name: "antennas" }
  | { name: "profile"; id: string }
  | { name: "settings" }
  | { name: "coax" }
  | { name: "advanced" }
  | { name: "learn"; topic?: LearnTopic; back?: Route }
  | { name: "soon"; job: string; milestone: string };

export const client = new BridgeClient(chooseTransport());
export const isSimulator = client.transport instanceof SimulatedTransport;

export const link = signal<LinkState>(client.link);
export const device = signal<DeviceStatus | null>(client.device);
export const wifi = signal<WifiStatus | null>(client.wifi);
export const release = signal<ReleaseUpdateStatus | null>(client.release);
export const route = signal<Route>({ name: "home" });

export interface LastCheck {
  result: CheckResult;
  sweep: Sweep;
  calibrated: boolean;
  at: number;
}
export const lastCheck = signal<LastCheck | null>(null);

// ---- storage and calibration ----

export let store: Store = new MemoryStore();
export const activeCal = signal<SavedCalibration | null>(null);
/** Ticks every minute so calibration age stays current. */
const clock = signal(Date.now());

let cachedCal: { id: string; cal: Calibration } | null = null;
export const calibration = computed<Calibration | null>(() => {
  const saved = activeCal.value;
  if (!saved) return null;
  if (cachedCal?.id !== saved.id) cachedCal = { id: saved.id, cal: loadForm(saved) };
  return cachedCal.cal;
});
export const calStatus = computed(() => calState(activeCal.value, device.value, clock.value));

const ACTIVE_CAL_KEY = "activeCalibration";

export async function saveCalibration(saved: SavedCalibration): Promise<void> {
  await store.put("calibrations", saved);
  await store.put("kv", { id: ACTIVE_CAL_KEY, value: saved.id });
  activeCal.value = saved;
}

export const settings = signal<Settings>(DEFAULT_SETTINGS);
/** False until settings come back from storage, so first-run UI doesn't flash for returning users. */
export const settingsLoaded = signal(false);
export const profiles = signal<AntennaProfile[]>([]);
/** Antenna the next check is for; null = quick check. */
export const checkProfileId = signal<string | null>(null);

export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

export async function updateSettings(next: Settings): Promise<void> {
  await saveSettings(store, next);
  settings.value = next;
  applyTheme(next.theme);
}

/** Forget the active calibration (the record stays in the backup until data is cleared). */
export async function clearCalibration(): Promise<void> {
  await store.delete("kv", ACTIVE_CAL_KEY);
  activeCal.value = null;
}

export async function reloadFromStore(): Promise<void> {
  settings.value = await loadSettings(store);
  settingsLoaded.value = true;
  applyTheme(settings.value.theme);
  await refreshProfiles();
  const pointer = await store.get<{ id: string; value: string }>("kv", ACTIVE_CAL_KEY);
  activeCal.value = pointer ? ((await store.get<SavedCalibration>("calibrations", pointer.value)) ?? null) : null;
}

export async function refreshProfiles(): Promise<void> {
  profiles.value = await listProfiles(store);
}

export async function initState(): Promise<void> {
  store = await openStore();
  await reloadFromStore();
  setInterval(() => (clock.value = Date.now()), 60_000);
}

client.onChange = () => {
  link.value = client.link;
  device.value = client.device ? { ...client.device } : null;
  wifi.value = client.wifi ? { ...client.wifi } : null;
  release.value = client.release ? { ...client.release } : null;
};

export const go = (r: Route) => {
  route.value = r;
  window.scrollTo(0, 0);
};
