# Resonance

Makes the NanoVNA understandable. Pick a job on your phone ("check my antenna on 20m"),
get a plain-English verdict, with raw data one tap away.

```
NanoVNA ──USB serial──▶ ESP32-S3 bridge ──Wi-Fi (HTTP + WebSocket)──▶ iPhone web app
```

- **`analysis/`** — pure TypeScript RF math: calibration (1-port OSL), SWR, impedance,
  resonance, bandwidth, verdicts, trim coach. No UI dependencies; unit-tested with Vitest.
- **`app/`** — Preact + Vite web app. Served by the bridge in the field.
- **`firmware/`** — ESP32-S3 bridge (native ESP-IDF). The protocol and NanoVNA logic live in
  a portable C core (`firmware/components/resonance_core`) that also runs on the host.
- **`emulator/`** — hardware-free test stack: an emulated NanoVNA shell (modeled on
  NanoVNA-D) driving the real C bridge core, exposed over a real WebSocket.
- **`docs/`** — the spec and the bridge protocol.

The full product spec lives in [`docs/SPEC.md`](docs/SPEC.md).

### Testing without hardware

```
app (BridgeClient) ──WebSocket──▶ Node harness ──stdio──▶ resonance-bridge-host (C core)
                                                              │ serial fd
                                                              ▼
                                                   emulated NanoVNA (TypeScript)
```

The end-to-end tests run the app's real client against the real C core: probe, binary and
text scans, segmentation for 101-point firmware, a full open/short/load calibration round
trip with realistic raw errors, unplug/replug mid-scan, cancel, hung-device timeout.

## Getting started

```bash
npm install
npm run test:c    # C bridge core unit tests (needs cmake + a C compiler)
npm test          # TypeScript unit tests + end-to-end against the emulated NanoVNA
npm run dev       # app at http://localhost:5173 against the in-browser simulator
npm run emulate   # real C bridge + emulated NanoVNA at ws://127.0.0.1:8080/ws
npm run check     # typecheck + test + build
```

`npm run emulate -- --antenna long20 --dialect classic --raw` picks a pretend antenna,
older 101-point firmware, and realistic uncalibrated errors. Type `detach`, `attach`,
`antenna <id>` or `port open|short|load` at its prompt.

## Status

Milestones are defined in the spec. Work in progress is tracked here so any contributor
(human or AI) can pick up where the last one stopped.

### M0 — repo and simulator ✅ done

Exit: app runs in a desktop browser against the simulator and plots a fake SWR curve.

- [x] Monorepo scaffold (npm workspaces: `analysis`, `app`)
- [x] `analysis`: complex math, SWR/Z/RL, OSL calibration, standard check, metrics, band plan
- [x] `analysis`: verdict rules, trim coach, coax length, unit tests
- [x] `app`: protocol types, simulated bridge, Home + Check flow with SWR plot
- [x] `firmware`: PlatformIO skeleton (builds in M1)
- [x] `docs`: SPEC.md, PROTOCOL.md
- [x] CI: typecheck, test, build on push

### M1 — bridge talks (running on hardware)

Exit: type `version` in a browser console page, get the NanoVNA's reply over Wi-Fi.

- [x] Bridge core in portable C: shell session, probe, scan (binary + text), segmentation,
      cancel/queue, console, timeouts, detach; C unit tests under ASan/UBSan
- [x] NanoVNA emulator (NanoVNA-D and classic dialects) + end-to-end tests with the app client
- [x] ESP32 platform layer: USB host CDC-ACM, Wi-Fi AP, HTTP + WebSocket, LittleFS, LED;
      builds in CI, flashable images uploaded as artifacts
- [x] Runs on hardware (2026-10-25): flashed from the CI build, Wi-Fi AP + app load on iPhone, NanoVNA-H (fw 1.2.27, 101 points, binary scans) enumerates over USB host and probes OK

Also done ahead of M2/M3: binary streaming, segmenting, app hosting from LittleFS, and the
calibration math validated end to end against emulated raw data.

### M3 — calibrate and check (app done; accuracy check needs hardware)

- [x] On-phone storage (IndexedDB, memory fallback): `app/src/storage.ts`
- [x] Calibration model, staleness (7 days or device change), apply-if-covered: `app/src/cal.ts`
- [x] Guided Calibrate screen: open/short/load, pictures, wrong-standard rejection
- [x] Check applies calibration; Uncalibrated badge links to Calibrate; Home nudge
- [x] Scan all bands (160m–6m) with one-line verdicts; tap-to-explain readings
- [x] Tests: guided calibration vs simulator and vs the C bridge + emulator
- [ ] Hardware: verdicts match NanoVNA-Saver within ±0.05 SWR on three antennas

### M4 — tune ✅ app done (field test needs hardware)

- [x] Trim coach session (`app/src/tune.ts`): ±15% sweep, resonance or "beyond the edge",
      one cut instruction, trend, SWR at target, cut log, known-length tracking
- [x] Tune screen: setup (band, antenna type, target, optional length), big instruction,
      target scale, live re-sweep every 2 s, cut log
- [x] Simulator applies cuts; test: too-long 20m dipole reaches resonance in ≤3 cuts
- [ ] Hardware: tune a real dipole in ≤3 cuts in the field

### M5 — profiles and history ✅ done

- [x] Data layer (`app/src/history.ts`): profiles, saved sweeps, baselines, drift notes
      (SWR +0.3 or resonance ±1%), settings, JSON backup/restore, units
- [x] Antennas tab: add antennas, latest verdict per band, Changed badge; detail with
      latest-vs-baseline overlay, drift note, history, compare any two, make baseline, delete
- [x] Check: pick an antenna, save to it, instant drift note
- [x] Settings: units (metric/imperial, used by Tune), SWR limits, themes incl. high-contrast
      Sunlight, calibration info, bridge home Wi-Fi (`wifi.set`), storage used, backup,
      restore, clear data, versions

### M6 — coax and advanced ✅ done (on-device update needs hardware)

- [x] Coax analysis: TDR, length (TDR + quarter wave), loss, faults; Touchstone/CSV export
- [x] Test coax screen: cable type, far end open/antenna, length, loss vs typical, faults,
      reflection-vs-distance plot; simulator and emulator (`port coax`) have a pretend cable
- [x] Advanced view: Smith chart with zones, R/X and return loss, marker slider with
      readouts (SWR, RL, R, X, |Z|, Γ, equivalent L or C), Touchstone/CSV download
- [x] Device screen: `capture` streamed by the bridge (C core streaming mode, 4 KB frames
      of kind 0x03), shown on the Connection screen; C, app and end-to-end tests
- [x] Updates over Wi-Fi: Settings → Update the bridge (firmware `resonance-bridge.bin` or web app `littlefs.bin` from the CI artifact), plus a built-in `/update` recovery page

### Trying the app

`npm run dev`, open http://localhost:5173 at phone width. Tap the status strip to open
Connection, where the in-browser simulator lets you pick a pretend antenna or unplug the
NanoVNA. For the full stack use `npm run emulate` and open the URL it prints.

### Home screen app

On the iPhone, join the bridge's Wi-Fi, open the bridge's address in Safari, tap Share, then
**Add to Home Screen**. It opens full screen with its own icon (`app/public/manifest.webmanifest`
and the Apple meta tags in `app/index.html`). The service worker (`app/public/sw.js`) only
registers in a secure context (HTTPS or localhost), so it runs in dev and preview but not from
the bridge's plain-HTTP address; the home-screen app works there without it. Icons are rendered
from `app/public/icon.svg` with `node app/scripts/icons.cjs`.

### Hardware

- ESP32-S3-DevKitC-1 N16R8. Its **USB** port goes to the NanoVNA; the **UART** port is for
  programming and power.
- If the NanoVNA doesn't enumerate, bridge the board's **IN-OUT** pad so the USB port
  supplies 5 V.
