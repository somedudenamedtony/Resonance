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
  release,
  reloadFromStore,
  settings,
  store,
  updateSettings,
  wifi,
} from "../state";
import { APP_VERSION } from "../version";


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

      <h3 class="section-title">NanoVNA screen</h3>
      <Segmented<"on" | "off">
        label="NanoVNA screen"
        value={s.mirrorScreen ? "on" : "off"}
        options={[
          ["on", "Follow the app"],
          ["off", "Leave it alone"],
        ]}
        onChange={(v) => void save({ ...s, mirrorScreen: v === "on" })}
      />
      <p class="muted small">
        {d?.connected && !client.canDisplay
          ? "Update the bridge to use this: its firmware can't set the NanoVNA's screen yet."
          : "Follow the app sets the NanoVNA to the band you're looking at, with SWR and Smith traces and markers on the best SWR and resonance. It catches up a moment after each scan."}
      </p>

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

const BRIDGE_NAME = "resonance.local";
const HOTSPOT_ADDRESS = "192.168.4.1";

function WifiStatusRows({ w }: { w: WifiStatus }) {
  const tone = w.state === "connected" ? "ok" : w.state === "failed" ? "bad" : "warn";
  const text =
    w.mode === "ap"
      ? "Hotspot only"
      : w.state === "connected"
        ? `Connected to ${w.ssid}`
        : w.state === "failed"
          ? "Couldn't connect"
          : w.ssid
            ? `Joining ${w.ssid}…`
            : "Looking for a saved network…";
  return (
    <>
      <div class="rows wifi-status">
        <div class="row">
          <span>Status</span>
          <span class="value wifi-state">
            {w.mode === "sta" && <span class={`status-dot ${tone}`} aria-hidden="true" />}
            {text}
          </span>
        </div>
        {w.state === "connected" && w.ip && (
          <div class="row">
            <span>Address</span>
            <span class="value wifi-address">
              {w.networks && (
                <a class="num" href={`http://${BRIDGE_NAME}/`}>
                  {BRIDGE_NAME}
                </a>
              )}
              <a class="num" href={`http://${w.ip}/`}>
                {w.ip}
              </a>
            </span>
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
          {w.ssid && !w.reason?.startsWith("None") ? `${w.ssid}: ` : ""}
          {w.reason ?? "The bridge couldn't join your Wi-Fi."} It keeps trying in the background.
        </p>
      )}
      {w.state === "connected" && w.ip && (
        <p class="muted">
          With your phone on {w.ssid}, open{" "}
          <span class="num">{w.networks ? `http://${BRIDGE_NAME}/` : `http://${w.ip}/`}</span> to reach the bridge
          {w.networks ? `, or http://${w.ip}/ if that name doesn't open` : ""}. Your antennas and sweeps are saved
          per address, so a new address starts empty: move them with Download backup and Restore backup below.
        </p>
      )}
    </>
  );
}

/** The bridge's own network: what to join when none of the saved networks is around. */
function HotspotRows({ w }: { w: WifiStatus }) {
  const [shown, setShown] = useState(false);
  return (
    <>
      <h4 class="sub-title">Bridge's own network</h4>
      <div class="rows">
        <div class="row">
          <span>Name</span>
          <span class="value">{w.apSsid}</span>
        </div>
        {w.apPassword && (
          <div class="row">
            <span>Password</span>
            <span class="value">
              {shown ? (
                <span class="num">{w.apPassword}</span>
              ) : (
                <button class="link-btn" onClick={() => setShown(true)}>
                  Show
                </button>
              )}
            </span>
          </div>
        )}
        <div class="row">
          <span>Then open</span>
          <span class="value num">http://{HOTSPOT_ADDRESS}/</span>
        </div>
      </div>
      <p class="muted">
        Always on, for places none of your saved networks reach. It has no internet, so your phone may hop back to
        another network; saving that network here avoids the hop.
      </p>
    </>
  );
}

function WifiSettings() {
  const w = wifi.value;
  const saved = w ? (w.networks ?? (w.mode === "sta" && w.ssid ? [w.ssid] : [])) : [];
  const multi = client.canSaveNetworks;
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const online = link.value === "open";
  const name = ssid.trim();
  const updating = saved.includes(name);
  const full = multi && !updating && saved.length >= 5;

  const run = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    setStatus(null);
    try {
      await fn();
      setStatus({ text: done });
      return true;
    } catch (e) {
      setStatus({ text: (e as Error).message, error: true });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!name) {
      setStatus({ text: "Enter the Wi-Fi network's name.", error: true });
      return;
    }
    if (password && (password.length < 8 || password.length > 64)) {
      setStatus({ text: "Wi-Fi passwords are 8 to 63 characters. Leave it empty for an open network.", error: true });
      return;
    }
    const ok = await run(
      () => client.addWifiNetwork(name, password),
      multi
        ? updating
          ? `Saved the new password for ${name}.`
          : `Saved ${name}. The bridge joins it whenever it's in range and no other saved network is joined.`
        : "Saved. The bridge is restarting and will join your Wi-Fi. Its own Resonance network stays on too.",
    );
    if (ok) {
      setSsid("");
      setPassword("");
    }
  };

  const forget = (net: string) =>
    void run(
      () => client.forgetWifiNetwork(net),
      multi ? `Removed ${net}.` : "Removed. The bridge is restarting as a hotspot only.",
    );

  return (
    <>
      <h3 class="section-title">Bridge Wi-Fi</h3>
      <p class="muted">
        Save the Wi-Fi networks you use, like home and the RV. The bridge joins whichever one is in range, so your
        phone can stay on a network with internet and still reach the bridge.
      </p>
      {w && <WifiStatusRows w={w} />}
      {!w && online && (
        <p class="muted">This bridge firmware doesn't report its Wi-Fi status. Update the bridge to see it here.</p>
      )}

      {saved.length > 0 && (
        <>
          <h4 class="sub-title">Saved networks</h4>
          <div class="rows saved-networks">
            {saved.map((net) => (
              <div class="row" key={net}>
                <span class="wifi-state">
                  {net}
                  {w?.state === "connected" && w.ssid === net && <span class="tag">In use</span>}
                </span>
                <button class="link-btn danger" disabled={!online || busy} onClick={() => forget(net)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      {w && !multi && saved.length > 0 && (
        <p class="muted">Update the bridge to save more than one network. This firmware remembers only one.</p>
      )}

      <h4 class="sub-title">{saved.length ? "Add a network" : "Join a network"}</h4>
      <label class="field">
        <span>Wi-Fi name</span>
        <input
          type="text"
          autocapitalize="off"
          autocomplete="off"
          spellcheck={false}
          maxLength={32}
          value={ssid}
          onInput={(e) => setSsid((e.target as HTMLInputElement).value)}
        />
      </label>
      <label class="field">
        <span>Password</span>
        <input
          type="password"
          autocomplete="new-password"
          maxLength={64}
          value={password}
          onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
        />
      </label>
      <p class="muted">The bridge only sees 2.4 GHz Wi-Fi. Passwords stay on the bridge and aren't shown again.</p>
      {full && <p class="field-error">The bridge can save up to 5 networks. Remove one first.</p>}
      {status && (
        <p class={status.error ? "field-error" : "saved"} role="status">
          {status.text}
        </p>
      )}
      <div class="actions single">
        <button class="btn primary" disabled={!online || busy || full} onClick={() => void add()}>
          {updating ? "Update password" : "Save network"}
        </button>
      </div>

      {w && <HotspotRows w={w} />}
    </>
  );
}

const TARGET_NAME: Record<UpdateTarget, string> = { firmware: "bridge firmware", app: "web app" };

/** The latest GitHub release: the bridge checks and downloads it itself over home Wi-Fi. */
function ReleaseUpdate() {
  const r = release.value;
  const w = wifi.value;
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<string | null>(null);

  // Once installed, the bridge restarts with a new copy of this app: load it when it's back.
  useEffect(() => {
    if (r?.state === "done") setInstalled(r.latest ?? "");
  }, [r?.state]);
  useEffect(() => {
    if (installed !== null && link.value === "open" && r && r.state !== "done" && !isSimulator) window.location.reload();
  }, [installed, link.value, r?.state]);

  if (installed !== null && (link.value !== "open" || r?.state === "done")) {
    return (
      <p class="saved" role="status">
        Installed {installed}. The bridge is restarting; this page reloads when it's back, in about a minute.
      </p>
    );
  }
  if (!r) return null;

  const online = !w || w.state === "connected"; // the simulator has no Wi-Fi to report
  const busy = r.state === "checking" || r.state === "installing";
  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const progress = r.state === "installing" && r.total ? (r.received ?? 0) / r.total : null;
  // The app on the bridge can lag its firmware (e.g. after installing only resonance-bridge.bin
  // from a file). Installing the release again rewrites both, so offer it then too.
  const appBehind = r.latest !== undefined && APP_VERSION !== "dev" && APP_VERSION !== r.latest && r.latest === r.current;
  const canInstall =
    r.latest !== undefined && (r.latest !== r.current || appBehind) && (r.state === "available" || r.state === "failed" || appBehind);
  return (
    <>
      <div class="rows">
        <div class="row">
          <span>This bridge</span>
          <span class="value num">{r.current}</span>
        </div>
        <div class="row">
          <span>Latest release</span>
          <span class="value num">{r.latest ?? "Not checked yet"}</span>
        </div>
      </div>
      {r.rolledBack && (
        <p class="field-error" role="status">
          Version {r.rolledBack} didn't start up properly, so the bridge went back to {r.current}.
        </p>
      )}
      {!online && (
        <p class="muted">The bridge checks GitHub for updates when it's on your home Wi-Fi. Set that up above.</p>
      )}
      {r.state === "checking" && <p class="muted">Checking GitHub…</p>}
      {r.state === "current" && <p class="saved">Up to date.</p>}
      {r.state === "available" && <p class="saved">Version {r.latest} is ready to install.</p>}
      {appBehind && r.state !== "installing" && (
        <p class="saved">
          The firmware is {r.current}, but this app is from {APP_VERSION}. Install {r.latest} to bring the app up to date too.
        </p>
      )}
      {r.state === "installing" && (
        <p class="muted">
          Downloading {r.step === "app" ? "the app" : "the firmware"}. The bridge keeps working until it restarts at
          the end.
        </p>
      )}
      {progress !== null && (
        <div class="meter" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div class="meter-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      {r.state === "failed" && r.message && (
        <p class="field-error" role="status">
          {r.message}
        </p>
      )}
      {error && (
        <p class="field-error" role="status">
          {error}
        </p>
      )}
      {r.state !== "installing" && (
        <div class={canInstall ? "actions" : "actions single"}>
          {canInstall && (
            <button class="btn primary" disabled={!online || link.value !== "open"} onClick={() => void run(() => client.installUpdate())}>
              Install {r.latest}
            </button>
          )}
          <button class="btn" disabled={!online || busy || link.value !== "open"} onClick={() => void run(() => client.checkForUpdate())}>
            Check for updates
          </button>
        </div>
      )}
    </>
  );
}

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
      <ReleaseUpdate />
      <p class={release.value ? "muted from-file" : "muted"}>
        {release.value ? "Or install from a file: " : "Install "}a new <b>resonance-bridge.bin</b> (firmware) or{" "}
        <b>littlefs.bin</b> (this app) from a release. If an app update ever goes wrong, open{" "}
        <span class="num">/update</span> on the bridge to try again.
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
