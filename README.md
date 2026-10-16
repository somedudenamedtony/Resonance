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

### M1 — bridge talks (code complete, waiting on hardware)

Exit: type `version` in a browser console page, get the NanoVNA's reply over Wi-Fi.

- [x] Bridge core in portable C: shell session, probe, scan (binary + text), segmentation,
      cancel/queue, console, timeouts, detach; C unit tests under ASan/UBSan
- [x] NanoVNA emulator (NanoVNA-D and classic dialects) + end-to-end tests with the app client
- [x] ESP32 platform layer: USB host CDC-ACM, Wi-Fi AP, HTTP + WebSocket, LittleFS, LED;
      builds in CI, flashable images uploaded as artifacts
- [ ] Run on hardware: follow the first-flash checklist in [`firmware/README.md`](firmware/README.md)

Also done ahead of M2/M3: binary streaming, segmenting, app hosting from LittleFS, and the
calibration math validated end to end against emulated raw data.

### Next without hardware

- M3 app work: guided Calibrate flow and applying calibration in Check (the math is done
  and proven in `emulator/test/e2e.test.ts`).
- M4: Tune screen with the trim coach and live re-sweep, against the emulator.

### Trying the app

`npm run dev`, open http://localhost:5173 at phone width. Tap the status strip to open
Connection, where the in-browser simulator lets you pick a pretend antenna or unplug the
NanoVNA. For the full stack use `npm run emulate` and open the URL it prints.

### Hardware

- ESP32-S3-DevKitC-1 N16R8. Its **USB** port goes to the NanoVNA; the **UART** port is for
  programming and power.
- If the NanoVNA doesn't enumerate, bridge the board's **IN-OUT** pad so the USB port
  supplies 5 V.
