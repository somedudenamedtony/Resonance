import { useEffect, useState } from "preact/hooks";
import { ModePicker } from "../components/ModePicker";
import { calLabel } from "../components/StatusBar";
import { exportBackup, importBackup, type Settings as AppSettings, storageUsed, type Theme, type Units } from "../history";
import { detectUpdateTarget, type UpdateTarget, type WifiStatus } from "../bridge/protocol";
import { STORES } from "../storage";
import {
  activeCal,
  calStatus,
  clearCalibration,
  client,
  device,
  go,
  isSimulator,
  link,
  reloadFromStore,
  settings,
  store,
  updateSettings,
  wifi,
} from "../state";

const APP_VERSION = "0.2.0";

export function Settings() {
  const s = settings.value;
  const [good, setGood] = useState(String(s.thresholds.good));
  const [usable, setUsable] = useState(String(s.thresholds.usable));
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [used, setUsed] = useState<number | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    void storageUsed(store).then(setUsed);
  }, []);

  const save = async (next: AppSettings, done?: string) => {
    try {
      await updateSettings(next);
      if (done) setMessage({ text: done });
    } catch (e) {
      setMessage({ text: (e as Error).message, error: true });
    }
  };

  const saveLimits = () => {
    const g = Number(good);
    const u = Number(usable);
    if (!(g >= 1 && g <= 5 && u >= g && u <= 10)) {
      setMessage({ text: "Use a good limit of 1 to 5 and a usable limit at least that high.", error: true });
      return;
    }
    void save({ ...s, thresholds: { good: g, usable: u } }, "SWR limits saved.");
  };

  const download = async () => {
    const data = await exportBackup(store);
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `resonance-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    setMessage({ text: "Backup downloaded." });
  };

  const restore = async (file: File) => {
    try {
      const counts = await importBackup(store, JSON.parse(await file.text()));
      await reloadFromStore();
      setUsed(await storageUsed(store));
      setMessage({ text: `Restored ${counts.profiles} antennas, ${counts.sweeps} sweeps, ${counts.calibrations} calibrations.` });
    } catch (e) {
      setMessage({ text: e instanceof SyntaxError ? "That file isn't valid JSON." : (e as Error).message, error: true });
    }
  };

  const clearAll = async () => {
    for (const name of STORES) await store.clear(name);
    await reloadFromStore();
    setUsed(await storageUsed(store));
    setConfirmClear(false);
    setMessage({ text: "All data on this phone was cleared." });
  };

  const d = device.value;
  const cal = calStatus.value;

  return (
    <>
      <div class="flow-head">
        <h2>Settings</h2>
      </div>

      {message && (
        <p class={message.error ? "field-error" : "saved"} role="status">
          {message.text}
        </p>
      )}

      <h3 class="section-title first">Units</h3>
      <Segmented<Units>
        label="Units"
        value={s.units}
        options={[
          ["metric", "Meters and cm"],
          ["imperial", "Feet and inches"],
        ]}
        onChange={(units) => void save({ ...s, units })}
      />

      <h3 class="section-title">Theme</h3>
      <Segmented<Theme>
        label="Theme"
        value={s.theme}
        options={[
          ["auto", "Auto"],
          ["light", "Light"],
          ["dark", "Dark"],
          ["sunlight", "Sunlight"],
        ]}
        onChange={(theme) => void save({ ...s, theme })}
      />
      <p class="muted small">Sunlight is black on white with heavier lines, for using the app outdoors.</p>

      <h3 class="section-title">SWR limits</h3>
      <div class="two-fields">
        <label class="field compact">
          <span>Good at or under</span>
          <input type="text" inputMode="decimal" value={good} onInput={(e) => setGood((e.target as HTMLInputElement).value)} />
        </label>
        <label class="field compact">
          <span>Usable at or under</span>
          <input type="text" inputMode="decimal" value={usable} onInput={(e) => setUsable((e.target as HTMLInputElement).value)} />
        </label>
      </div>
      <div class="actions single">
        <button class="btn" onClick={saveLimits}>
          Save SWR limits
        </button>
      </div>

      <h3 class="section-title">Where you operate</h3>
      <ModePicker />
      <p class="muted small">Checks judge this part of each band. Pick Whole band to judge everything.</p>

      <h3 class="section-title">Calibration</h3>
      <div class="rows">
        <div class="row">
          <span>Status</span>
          <span class="value">{calLabel(cal)}</span>
        </div>
        {activeCal.value && (
          <div class="row">
            <span>Made</span>
            <span class="value num">{new Date(activeCal.value.createdAt).toLocaleString()}</span>
          </div>
        )}
        {activeCal.value?.device.model && (
          <div class="row">
            <span>On</span>
            <span class="value">
              {activeCal.value.device.model}, firmware {activeCal.value.device.firmware}
            </span>
          </div>
        )}
      </div>
      <div class="actions">
        <button class="btn primary" onClick={() => go({ name: "calibrate" })}>
          Calibrate now
        </button>
        <button class="btn" disabled={!activeCal.value} onClick={() => void clearCalibration()}>
          Forget calibration
        </button>
      </div>

      {!isSimulator && <WifiSettings />}

      <UpdateSettings />

      <h3 class="section-title">Your data</h3>
      <p class="muted">
        Antennas, sweeps and calibrations live only on this phone
        {used !== null ? `, using about ${Math.max(1, Math.round(used / 1024))} KB` : ""}. Download a backup now and then.
      </p>
      <div class="actions">
        <button class="btn" onClick={download}>
          Download backup
        </button>
        <label class="btn file-btn">
          Restore backup
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (f) void restore(f);
              (e.target as HTMLInputElement).value = "";
            }}
          />
        </label>
      </div>
      <div class="actions single">
        {confirmClear ? (
          <button class="btn danger" onClick={clearAll}>
            Erase all antennas, sweeps and calibrations
          </button>
        ) : (
          <button class="btn" onClick={() => setConfirmClear(true)}>
            Clear all data
          </button>
        )}
      </div>

      <h3 class="section-title">About</h3>
      <div class="rows">
        <div class="row">
          <span>App</span>
          <span class="value num">Resonance {APP_VERSION}</span>
        </div>
        <div class="row">
          <span>Bridge</span>
          <span class="value num">{link.value === "open" ? `${d?.bridgeVersion ?? "unknown"}${isSimulator ? " (simulator)" : ""}` : "not connected"}</span>
        </div>
        {d?.connected && (
          <div class="row">
            <span>NanoVNA</span>
            <span class="value num">
              {d.model}, {d.firmware}, {d.maxPoints} points
            </span>
          </div>
        )}
      </div>
      <div class="actions">
        <button class="btn" onClick={() => go({ name: "learn" })}>
          Learn the basics
        </button>
        <button class="btn" onClick={() => void save({ ...s, introSeen: false }).then(() => go({ name: "home" }))}>
          Show quick start
        </button>
      </div>
    </>
  );
}

function signalLabel(rssi: number): string {
  if (rssi >= -60) return "Strong";
  if (rssi >= -70) return "Good";
  if (rssi >= -80) return "Weak";
  return "Very weak";
}

const WIFI_STATE: Record<NonNullable<WifiStatus["state"]>, { tone: "ok" | "warn" | "bad"; text: string }> = {
  connected: { tone: "ok", text: "Connected" },
  connecting: { tone: "warn", text: "Connecting…" },
  failed: { tone: "bad", text: "Couldn't connect" },
};

function WifiStatusRows({ w }: { w: WifiStatus }) {
  const st = w.mode === "sta" && w.state ? WIFI_STATE[w.state] : null;
  return (
    <>
      <div class="rows wifi-status">
        <div class="row">
          <span>Bridge network</span>
          <span class="value">{w.apSsid}</span>
        </div>
        <div class="row">
          <span>Home Wi-Fi</span>
          <span class="value">{w.mode === "sta" ? w.ssid : "Not set up (hotspot only)"}</span>
        </div>
        {st && (
          <div class="row">
            <span>Status</span>
            <span class="value wifi-state">
              <span class={`status-dot ${st.tone}`} aria-hidden="true" />
              {st.text}
            </span>
          </div>
        )}
        {w.state === "connected" && w.ip && (
          <div class="row">
            <span>IP address</span>
            <a class="value num" href={`http://${w.ip}/`}>
              {w.ip}
            </a>
          </div>
        )}
        {w.state === "connected" && w.rssi !== undefined && (
          <div class="row">
            <span>Signal</span>
            <span class="value num">
              {signalLabel(w.rssi)} ({w.rssi} dBm)
            </span>
          </div>
        )}
      </div>
      {w.state === "failed" && (
        <p class="field-error" role="status">
          {w.reason ?? "The bridge couldn't join your Wi-Fi."} It keeps trying in the background.
        </p>
      )}
      {w.state === "connected" && w.ip && (
        <p class="muted">
          On your home Wi-Fi, open <span class="num">http://{w.ip}/</span> to reach the bridge.
        </p>
      )}
    </>
  );
}

function WifiSettings() {
  const w = wifi.value;
  const [ssid, setSsid] = useState("");
  // Fill in the saved network name once the bridge reports it.
  useEffect(() => {
    if (w?.ssid) setSsid((cur) => cur || w.ssid!);
  }, [w?.ssid]);
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const send = async (mode: "ap" | "sta") => {
    if (mode === "sta" && !ssid.trim()) {
      setStatus({ text: "Enter your home Wi-Fi name.", error: true });
      return;
    }
    try {
      await client.setWifi(mode, mode === "sta" ? ssid.trim() : undefined, mode === "sta" ? password : undefined);
      setStatus({
        text:
          mode === "sta"
            ? "Saved. The bridge is restarting and will join your Wi-Fi. Its own Resonance network stays on too."
            : "Saved. The bridge is restarting as a hotspot only.",
      });
    } catch (e) {
      setStatus({ text: (e as Error).message, error: true });
    }
  };
  return (
    <>
      <h3 class="section-title">Bridge Wi-Fi</h3>
      <p class="muted">
        The bridge always runs its own Resonance network. It can also join your home Wi-Fi, so you can reach it
        from your home network without switching networks.
      </p>
      {w && <WifiStatusRows w={w} />}
      {!w && link.value === "open" && (
        <p class="muted">This bridge firmware doesn't report its Wi-Fi status. Update the bridge to see it here.</p>
      )}
      <label class="field">
        <span>Home Wi-Fi name</span>
        <input type="text" autocapitalize="off" value={ssid} onInput={(e) => setSsid((e.target as HTMLInputElement).value)} />
      </label>
      <label class="field">
        <span>Password</span>
        <input type="password" value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
      </label>
      {status && (
        <p class={status.error ? "field-error" : "saved"} role="status">
          {status.text}
        </p>
      )}
      <div class="actions">
        <button class="btn" disabled={link.value !== "open"} onClick={() => send("sta")}>
          Join home Wi-Fi
        </button>
        <button class="btn" disabled={link.value !== "open"} onClick={() => send("ap")}>
          Hotspot only
        </button>
      </div>
    </>
  );
}

const TARGET_NAME: Record<UpdateTarget, string> = { firmware: "bridge firmware", app: "web app" };

function UpdateSettings() {
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array; target: UpdateTarget } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);

  const pick = async (f: File) => {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const target = detectUpdateTarget(bytes);
    setProgress(null);
    if (!target) {
      setFile(null);
      setStatus({ text: "That file isn't a Resonance update. Use resonance-bridge.bin or littlefs.bin.", error: true });
      return;
    }
    setFile({ name: f.name, bytes, target });
    setStatus({ text: `${f.name}: ${TARGET_NAME[target]}, ${Math.round(bytes.length / 1024)} KB.` });
  };

  const install = async () => {
    if (!file) return;
    setStatus(null);
    setProgress(0);
    try {
      await client.update(file.target, file.bytes, (sent, total) => setProgress(sent / total));
      setStatus({
        text: isSimulator
          ? "Installed (simulator: nothing restarts)."
          : "Installed. The bridge is restarting; this page reconnects in a few seconds.",
      });
      setFile(null);
    } catch (e) {
      setProgress(null);
      setStatus({ text: (e as Error).message, error: true });
    }
  };

  const busy = progress !== null && progress < 1 && !status;
  return (
    <>
      <h3 class="section-title">Update the bridge</h3>
      <p class="muted">
        Install a new <b>resonance-bridge.bin</b> (firmware) or <b>littlefs.bin</b> (this app) from a release. If an
        app update ever goes wrong, open <span class="num">/update</span> on the bridge to try again.
      </p>
      <div class="actions">
        <label class={`btn file-btn${busy ? " disabled" : ""}`}>
          Choose file
          <input
            type="file"
            accept=".bin,application/octet-stream"
            disabled={busy}
            onChange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (f) void pick(f);
              (e.target as HTMLInputElement).value = "";
            }}
          />
        </label>
        <button class="btn primary" disabled={!file || busy || link.value !== "open"} onClick={() => void install()}>
          Install
        </button>
      </div>
      {progress !== null && (
        <div class="meter" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div class="meter-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      {status && (
        <p class={status.error ? "field-error" : "saved"} role="status">
          {status.text}
        </p>
      )}
    </>
  );
}

function Segmented<T extends string>(props: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div class="segmented" role="radiogroup" aria-label={props.label}>
      {props.options.map(([v, text]) => (
        <button key={v} role="radio" aria-checked={v === props.value} class={v === props.value ? "on" : ""} onClick={() => props.onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}
