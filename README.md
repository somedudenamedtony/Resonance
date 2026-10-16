# Resonance

Makes the NanoVNA understandable. Pick a job on your phone ("check my antenna on 20m"),
get a plain-English verdict, with raw data one tap away.

```
NanoVNA ──USB serial──▶ ESP32-S3 bridge ──Wi-Fi (HTTP + WebSocket)──▶ iPhone web app
```

- **`analysis/`** — pure TypeScript RF math: calibration (1-port OSL), SWR, impedance,
  resonance, bandwidth, verdicts, trim coach. No UI dependencies; unit-tested with Vitest.
- **`app/`** — Preact + Vite web app. Served by the bridge in the field; runs against a
  built-in simulated NanoVNA on a desktop browser for development.
- **`firmware/`** — ESP32-S3 bridge (PlatformIO, ESP-IDF): USB host CDC to the NanoVNA,
  Wi-Fi AP, static file server, WebSocket relay. No RF math.
- **`docs/`** — the spec and the bridge protocol.

The full product spec lives in [`docs/SPEC.md`](docs/SPEC.md).

## Getting started

```bash
npm install
npm test          # analysis unit tests
npm run dev       # app at http://localhost:5173 against the simulator
npm run check     # typecheck + test + build (what CI runs)
```

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

### Next: M1 — bridge talks

Exit: type `version` in a browser console page, get the NanoVNA's reply over Wi-Fi.
The plan is in [`firmware/README.md`](firmware/README.md). Start with the USB host CDC
spike; it is the biggest risk. The app's Connection screen already has a command console
that sends `raw` messages, so open the app with `?bridge=ws://192.168.4.1/ws` to test it.

### Trying the app

`npm run dev`, open http://localhost:5173 at phone width. Tap the status strip to open
Connection, where the simulator lets you pick a pretend antenna (well tuned, too long,
too short, poor match) or unplug the NanoVNA.

### Hardware

- ESP32-S3-DevKitC-1 N16R8. Its **USB** port goes to the NanoVNA; the **UART** port is for
  programming and power.
- If the NanoVNA doesn't enumerate, bridge the board's **IN-OUT** pad so the USB port
  supplies 5 V.
