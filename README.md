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

### M0 — repo and simulator

Exit: app runs in a desktop browser against the simulator and plots a fake SWR curve.

- [x] Monorepo scaffold (npm workspaces: `analysis`, `app`)
- [x] `analysis`: complex math, SWR/Z/RL, OSL calibration, standard check, metrics, band plan
- [x] `analysis`: verdict rules, trim coach, coax length, unit tests
- [ ] `app`: protocol types, simulated bridge, Home + Check flow with SWR plot
- [ ] `firmware`: PlatformIO skeleton (builds in M1)
- [ ] `docs`: SPEC.md, PROTOCOL.md
- [ ] CI: typecheck, test, build on push

### Hardware

- ESP32-S3-DevKitC-1 N16R8. Its **USB** port goes to the NanoVNA; the **UART** port is for
  programming and power.
- If the NanoVNA doesn't enumerate, bridge the board's **IN-OUT** pad so the USB port
  supplies 5 V.
