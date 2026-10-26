# Resonance spec

Oct 16, 2026 · Tony Shepherd (W7LIT)

> Exported from the living spec doc (with wireframes and diagrams):
> https://claude.ai/code/artifact/513467b5-04cd-4520-8c95-f5330bd9ff70
> When the two disagree, update both. Implementation status lives in the root README.

## Overview

Resonance turns a NanoVNA into a guided antenna tool: pick a job on your phone, get a plain-English answer, with raw data one tap away.

**Problem.** The NanoVNA is cheap and capable, but its tiny screen and deep menus expose measurement primitives (traces, formats, S-parameters), not answers. Most hams want to know "is my antenna good on 20m, and what do I cut?" They end up doing calibration from memory and length math by hand.

**Users.**

- **Primary:** a licensed ham with a NanoVNA who builds or tunes wire, vertical and mobile antennas, often in the field.
- **Secondary:** a new ham who owns a NanoVNA but can't read a Smith chart yet.
- **Out of scope for v1:** lab or RF-engineering users who want full two-port analysis.

**Goals.**

1. Answer "is it good?" for a chosen band in one tap after calibration.
2. Coach tuning to resonance with a concrete trim instruction and live re-sweep.
3. Make calibration guided and hard to get wrong.
4. Keep every sweep, so an antenna's health can be compared over time.
5. Run fully offline in the field: NanoVNA, ESP32 bridge, phone. No internet, no install.

**Non-goals (v1).** Native iOS/Android apps, cloud accounts or sync, NanoVNA firmware changes, filter and component design tools, multi-user use.

**Success criteria.**

- From power-on to first verdict in under 60 seconds with a saved calibration.
- A new ham completes calibration and an antenna check without reading a manual.
- Verdict SWR matches NanoVNA-Saver within ±0.05 on the same sweep.
- Trim coach brings a dipole to resonance within 3 cut cycles on a typical HF band.

## System architecture

Three parts, with all logic in the phone so the firmware stays small and rarely changes.

```
┌──────────────────────────┐            ┌──────────────────────────┐                      ┌──────────────────────────┐
│ NanoVNA                  │ USB serial │ ESP32-S3 bridge          │ Wi-Fi: HTTP + WS     │ iPhone web app           │
│ Sweeps, measures S11/S21 │◀──────────▶│ USB host to the NanoVNA  │◀────────────────────▶│ Calibration and analysis │
│ Text shell over USB      │            │ Wi-Fi AP or home network │                      │ Jobs, verdicts, trim     │
│ On-device cal turned off │            │ Serves app from flash    │                      │ History in IndexedDB     │
│                          │            │ Relays, no RF math       │                      │ Home-screen, offline     │
└──────────────────────────┘            └──────────────────────────┘                      └──────────────────────────┘
```

**Why this shape.** iOS can't open a USB serial port, so the ESP32-S3 bridges USB to Wi-Fi. The app is served by the bridge itself, because Safari blocks an HTTPS-hosted page from opening a plain `ws://` connection to a local device. Putting calibration and analysis in the app means one TypeScript codebase to test, and the same app runs against a simulator on a desktop browser.

## Bridge firmware

The ESP32-S3 is a thin, reliable relay: it owns the USB link and Wi-Fi, serves the app, and does no RF math.

**Target.** ESP32-S3-DevKitC-1 N16R8 (16 MB flash, 8 MB PSRAM). Framework: ESP-IDF via PlatformIO, for its USB host CDC-ACM driver. Arduino is acceptable if a maintained CDC host library proves stable.

**Responsibilities.**

| Area | Behavior |
| --- | --- |
| USB host | Enumerate the NanoVNA as CDC-ACM on the native USB port. Detect connect and disconnect; reconnect automatically. |
| Command queue | Serialize commands: one in flight at a time, per-command timeout (default 5 s), drain the `ch>` prompt between commands. |
| Wi-Fi | AP mode by default (SSID `Resonance-XXXX`, WPA2, address 192.168.4.1). Optional station mode joins home Wi-Fi; falls back to AP if it can't connect within 15 s. |
| mDNS | Advertise `resonance.local` in station mode. |
| HTTP server | Serve the web app's static files from LittleFS, gzip-compressed, with a service worker for instant reloads. |
| WebSocket | One endpoint, `/ws`. JSON control messages, binary frames for sweep data. Up to 2 clients; the newest client takes control. |
| Storage | LittleFS partition (~10 MB) holds the app bundle. NVS holds Wi-Fi settings. Calibration and history live on the phone (see Data model). |
| Updates | In bridge mode the bridge checks GitHub releases and installs firmware and app together from the Settings screen; a file upload works offline. New firmware rolls back if it never gets back on Wi-Fi. |
| Status | Onboard RGB LED: blue blinking = no NanoVNA, green = ready, amber pulse = sweeping, red = error. |

**Power.** 5 V from the UART port or the 5V pin. The USB host port may need the IN-OUT pad bridged to supply VBUS to the NanoVNA (see Open questions).

**Out of scope for the bridge.** Calibration math, SWR conversion, verdicts. Keeping logic in the web app means one codebase to change and test, and the bridge rarely needs reflashing.

## Protocols

The app talks JSON over one WebSocket; the bridge translates to NanoVNA shell commands and streams sweep data back as binary. Exact wire format: [`PROTOCOL.md`](PROTOCOL.md).

### NanoVNA commands used

| Command | Purpose | Notes |
| --- | --- | --- |
| `info`, `version` | Identify model and firmware | Picks the command dialect at connect |
| `help` | Detect binary scan support | `scan_bin` listed means the binary outmask bit (0x80) works |
| `scan <start> <stop> <points> <mask>` | Sweep and return frequency + S11 (+ S21) | Mask 0x1b (+0x80 binary): frequency, S11, skip device calibration (0x08) and electrical delay (0x10), so the device's own settings are left alone; text fallback on older firmware |
| `sweep` + `data 0` / `data 1` | Fallback sweep path | For older firmware without `scan` |
| `pause`, `resume` | Stop the device's own sweeping | `scan` pauses sweeping itself on NanoVNA-D |
| `capture` | Device screenshot | Advanced view only |

Max points per scan varies by model (101 on original, 401+ on H4/DiSlord builds). The bridge splits larger requests into segments and stitches them.

### Bridge WebSocket API

**App to bridge (JSON).**

| Message | Fields | Result |
| --- | --- | --- |
| `hello` | `appVersion` | `device` status reply |
| `scan` | `id`, `startHz`, `stopHz`, `points`, `ports` (`s11` or `s11+s21`) | `scan.begin`, binary chunks, `scan.end` |
| `cancel` | `id` | Aborts the scan in progress |
| `raw` | `command` | `raw.reply` text (Advanced console) |
| `wifi.set` | `mode`, `ssid`, `password` | Saves and reboots Wi-Fi |
| `ota.begin` | `target` (`firmware` or `app`), `size` | Ready for binary upload |
| `update.check` / `update.install` | — | `update` status: latest GitHub release, install progress |

**Bridge to app.**

| Message | Fields |
| --- | --- |
| `device` | `connected`, `model`, `firmware`, `maxPoints`, `bridgeVersion` |
| `scan.begin` | `id`, `points`, `ports` |
| Binary frame | Header (scan id, offset, count), then per point: freq (u32 Hz), S11 re/im (f32), optional S21 re/im (f32) |
| `scan.end` | `id`, `durationMs` |
| `error` | `code` (`no_device`, `timeout`, `busy`, `bad_request`), `message` |

All messages carry a protocol `v: 1` so app and firmware can update independently.

## Data model

All user data lives on the phone in IndexedDB; the bridge stores only Wi-Fi settings. Export and import as a single JSON file covers backup.

| Entity | Key fields | Notes |
| --- | --- | --- |
| `Calibration` | id, createdAt, startHz, stopHz, points, terms (Ed, Es, Er per point), standard (`nanovna-kit` or custom), deviceSerial, temperatureNote | One active per device. Stale after 7 days or a device change. |
| `Sweep` | id, takenAt, startHz, stopHz, points, s11[] (complex), s21[]?, calibrationId, profileId?, job, note | Raw corrected data. Everything else is derived from it. |
| `AntennaProfile` | id, name, type (dipole, EFHW, vertical, mobile, other), bands[], feedline (coax type, length m), baselineSweepId?, photo? | e.g. "Backyard EFHW" |
| `CheckResult` | sweepId, band, verdict (`good`, `usable`, `poor`), minSwr, resonantHz, bandwidth2to1Hz, notes[] | Cached analysis for history lists. |
| `CoaxResult` | sweepId, coaxType, velocityFactor, lengthM, lossDb?, faultAtM? | |
| `BandPlan` | name, region, bands[] (name, startHz, stopHz, segments) | US (FCC) bundled; editable. |
| `Settings` | units (m or ft), region, swrThresholds, theme, bridgeHost | |

**Bundled coax table.** RG-58, RG-8X, RG-213, LMR-240, LMR-400, LMR-600, 450-ohm ladder line, each with velocity factor and loss per 100 ft at reference frequencies. User can add custom entries.

**Retention.** Keep all sweeps by default (~6 KB each at 201 points). Show storage used in Settings; allow pruning by age.

## Analysis

All analysis runs in the web app, in a pure TypeScript module (`analysis/`) with no UI dependencies, so it can be unit-tested against NanoVNA-Saver output.

### Calibration (app-side, 1-port OSL)

Resonance does its own calibration so one cal covers every band. The app scans open, short and load across 50 kHz to 60 MHz at 1001 points, solves three error terms per point, and interpolates them (complex, linear) for any later scan inside that range.

```
Γ = (Γm − Ed) / (Er + Es·(Γm − Ed))
```

Γm is the measured reflection, Ed directivity, Es source match, Er reflection tracking. v1 assumes ideal standards; custom standard definitions are a later option.

### Derived values

```
Z = Z0 · (1 + Γ) / (1 − Γ)      SWR = (1 + |Γ|) / (1 − |Γ|)      RL = −20·log10|Γ|
```

Z0 = 50 ohms by default, settable for 75-ohm or ladder-line systems.

- **Minimum SWR point:** frequency and value of the lowest SWR in the scan.
- **Resonance:** frequency where reactance X crosses zero nearest the minimum SWR. Reported separately, because a mismatched antenna can be resonant at a high SWR.
- **Usable bandwidth:** continuous span around the minimum where SWR is at or below 2.0 (and 1.5).

### Verdict rules (per band)

| Verdict | Rule | Example message |
| --- | --- | --- |
| Good | Max SWR across the band ≤ 1.5 | "Good on 20m: under 1.5:1 across the whole band" |
| Usable | Max SWR ≤ 2.0 across the band, or ≤ 1.5 across the user's chosen segment | "Usable on 40m: under 2:1, best at 7.150" |
| Poor | Anything else | "Resonant at 13.80 MHz, below 20m. Antenna is too long." |

Every verdict adds one cause line when it can tell: too long (resonance below band), too short (above), mismatch (resonant but SWR high, shown with R at resonance), or no resonance in scan (widen the scan).

### Trim coach

Resonant frequency scales inversely with element length, so the cut is a ratio.

```
ΔL = L · (1 − f_res / f_target) · k
```

L is the current element length per leg (entered, or estimated as 71.3 / f MHz meters per leg for a half-wave dipole). The damping factor k = 0.8 by default undershoots on purpose, because you can always cut more. Negative ΔL means add wire. After each cut the app re-sweeps and recomputes. Target defaults to the band center or the user's chosen segment.

### Coax test

- **Length:** with the far end open, find the first frequency where the line looks like a short (quarter wave). Length = VF × c / (4 × f).
- **Fault location:** inverse FFT of S11 over a wide scan gives a reflection-versus-distance plot (TDR). Peaks other than the far end are flagged with their distance.
- **Loss:** with the far end open, matched-line loss in dB is half the return loss at that frequency.

## Features

Six jobs make up v1; each starts from Home and ends in a result screen that can be saved to an antenna profile.

### 1. Connect

Open the app, see bridge and NanoVNA status, fix problems in plain words.

- [ ] Status bar shows bridge reachable, NanoVNA connected (model + firmware), and calibration age
- [ ] Disconnects show a cause and fix ("NanoVNA not detected. Check the cable is in the ESP32 port labeled USB.")
- [ ] Auto-reconnects within 3 s after a cable re-plug or Wi-Fi blip

### 2. Calibrate

Guided open, short, load, with a picture per step.

- [ ] Three steps, each showing which standard to attach and where, with a big Measure button
- [ ] Each step validates its standard (open looks open, short looks short, load near 50 ohms) and rejects a wrong one with a retry hint
- [ ] Saves the cal; Home nags when it's older than 7 days or the device changed
- [ ] Completes in under 90 s

### 3. Check antenna

Pick an antenna profile (or "quick check") and a band; get a verdict.

- [ ] Band picker shows the profile's bands first; scan range = band edges plus 25% margin each side, 201 points
- [ ] Result screen leads with verdict card, then SWR curve with band shading, min SWR, resonance and 2:1 bandwidth
- [ ] "Scan all bands" runs every band in the profile and shows a one-line verdict per band
- [ ] Save attaches the sweep to the profile; first save becomes the baseline

### 4. Tune antenna

Trim coach loop: sweep, instruction, cut, re-sweep.

- [ ] Asks antenna type and current length once (or estimates it, labeled as an estimate)
- [ ] Shows one instruction in large type: "Shorten each leg 4.2 cm" or "Add 6 cm per leg"
- [ ] Live mode re-sweeps every 2 s and moves a marker toward the target with a trend arrow
- [ ] Stops with "Done: resonant at 14.175 MHz, SWR 1.2" when within 0.5% of target
- [ ] Keeps a cut log for the session

### 5. Test coax

- [ ] Asks coax type (sets velocity factor) and far-end state (open or connected to the antenna)
- [ ] Reports length in m or ft, loss at a chosen frequency, and any fault with its distance
- [ ] Shows a reflection-versus-distance plot with the far end and any fault labeled

### 6. History

- [ ] Per profile: list of sweeps with date, band, verdict chip
- [ ] Overlay any two sweeps (before/after, today vs baseline)
- [ ] Drift note when min SWR rose more than 0.3 or resonance moved more than 1% from baseline

### Advanced view (on every result)

- [ ] Smith chart with plain-language zones ("too long: inductive", "too short: capacitive")
- [ ] Return loss, R and X, |Z| plots; draggable markers with readouts
- [ ] Raw command console and device screenshot
- [ ] Export sweep as Touchstone (.s1p) and CSV

## UI/UX

The app is built around one question per screen and a verdict before any graph. Wireframes for Home, Check result and Tune are in the living spec doc (link at top).

### Principles

1. **Answer first.** Every result opens with a one-line verdict in plain words. Graphs support it.
2. **Jobs, not settings.** Users pick what they're doing; frequency range, points and format follow from that.
3. **Field-proof.** Big type, big targets, high contrast, one-handed, works with gloves.
4. **Teach in place.** Every number has a tap-to-explain ("SWR 1.4: about 3% of your power reflects back").
5. **Nothing hidden, just tucked.** Advanced is one tap from any result.

### Navigation

Three tabs: **Home** (jobs), **Antennas** (profiles and history), **Settings**. Jobs open as full-screen flows with a close button; results offer Save, Re-scan and Advanced. A status bar on every screen shows bridge, NanoVNA and cal state; tapping it opens Connect.

### Screens

| Screen | Purpose | Key elements |
| --- | --- | --- |
| Home | Start a job | Status bar, cal reminder, 5 job tiles, recent result card |
| Connect | Fix the link | Bridge, NanoVNA, firmware rows with fix hints; join-Wi-Fi help |
| Calibrate | Guided OSL | Step dots, picture of the standard on the port, Measure button, pass/retry feedback |
| Band picker | Choose band | Profile bands first, then all bands; "Scan all" |
| Check result | Verdict | Verdict card, SWR curve with band shading, 3 stat chips, cause line, Save / Re-scan / Advanced |
| Tune | Trim coach | Huge instruction, resonance marker vs target on a slim scale, trend arrow, live toggle, cut log |
| Coax result | Line health | Length, loss, fault distance; reflection-vs-distance plot |
| Antennas | Profiles | Profile cards with last verdict per band and a drift dot |
| Profile detail | History | Sweep list, overlay picker, baseline marker |
| Advanced | Raw data | Smith chart with zones, R/X and return-loss plots, markers, console, export |
| Settings | Setup | Units, region band plan, SWR thresholds, Wi-Fi mode, firmware/app update, storage |

### States

- **No bridge:** full-screen "Join the Resonance Wi-Fi" with the SSID and steps.
- **No NanoVNA:** status bar turns amber; jobs disabled with the fix hint inline.
- **No or stale cal:** jobs still run, but results carry an "uncalibrated" badge and a Calibrate button.
- **Scanning:** curve draws progressively as binary chunks arrive; Cancel always visible.
- **Error:** one sentence on what happened and one action ("Retry scan").

### Visual language

- **Verdict colors with words, never color alone:** green Good, amber Usable, red Poor, each with an icon and label.
- **SWR curve:** fixed 1 to 3 y-axis (clipped above, with a marker), band shaded, 2:1 line dashed, min-SWR dot labeled.
- **Type:** system font; verdict 28 px, values 20 px tabular numerals, body 16 px.
- **Themes:** light, dark and a high-contrast "Sunlight" theme (black on white, heavier strokes).
- **Motion:** only to show live data (curve drawing, marker moving); none decorative.

## Non-functional requirements

| Area | Requirement |
| --- | --- |
| Speed | 201-point band scan to verdict in under 2 s on an H4. Live tune re-sweep at 0.5 Hz or faster. |
| Offline | Works with no internet. App bundle served by the bridge; no CDN fonts or scripts. |
| App size | Gzipped bundle under 1 MB so it fits LittleFS with room for OTA. |
| Platforms | iOS Safari 17+ added to home screen (primary), desktop Chrome and Safari (secondary). |
| Reliability | No crash or hang on cable pull mid-scan; scan fails with a clear error and recovers. |
| Accuracy | SWR within ±0.05 and resonance within 0.1% of NanoVNA-Saver on the same device and cal. |
| Outdoors | Readable in sunlight: high-contrast theme, verdict text 28 px+, tap targets 48 px+. Works with gloves (no fine gestures required). |
| Accessibility | Every verdict and value available as text, not color alone. VoiceOver labels on all controls. |
| Security | WPA2 on the AP with a per-device password printed on first boot. No external network calls. |
| Testability | Analysis module unit-tested against recorded `.s1p` fixtures. A simulated NanoVNA mode in the app for UI work without hardware. |

## Milestones

Build hardware-risk first, then the one job that proves the concept, then breadth. Each milestone ends on a demo.

1. **M0, repo and simulator.** Monorepo (`firmware/`, `app/`, `analysis/`), CI, simulated NanoVNA in the app.
   - Exit: app runs in a desktop browser against the simulator and plots a fake SWR curve.
2. **M1, bridge talks.** ESP32-S3 enumerates the NanoVNA over USB host, AP mode up, `/ws` relays `raw` commands.
   - Exit: type `version` in a browser console page, get the NanoVNA's reply over Wi-Fi.
3. **M2, first real sweep.** `scan` with binary streaming and segmenting; app served from LittleFS; uncalibrated SWR plot on the iPhone.
   - Exit: an SWR curve of a real antenna on the phone, home-screen app, no internet.
4. **M3, calibrate and check.** Guided calibration, analysis module with fixtures, Check antenna job with verdicts and band shading.
   - Exit: verdict matches NanoVNA-Saver within spec on three antennas.
5. **M4, tune.** Trim coach with live mode and cut log.
   - Exit: tune a dipole to resonance in 3 cuts or fewer, in the field, on battery.
6. **M5, profiles and history.** Antenna profiles, saved sweeps, overlays, drift notes, export.
7. **M6, coax and advanced.** Coax test with TDR, Smith chart view, console, Touchstone export, OTA updates.
8. **M7, field build.** Battery, enclosure, status LED, station mode and mDNS polish.

## Open questions and risks

| Item | Risk | Plan |
| --- | --- | --- |
| NanoVNA model and firmware | Command set, `scan` binary support and max points differ | Identify Tony's unit at M1; support DiSlord and original firmware dialects |
| USB host power | Board may not supply VBUS; NanoVNA may not enumerate | Test at M1; bridge the IN-OUT pad if needed |
| CDC host stability | ESP-IDF CDC-ACM host may need tuning for the NanoVNA's descriptors | Spike first in M1 before building anything else |
| App-side calibration accuracy | Interpolating cal terms over a wide range can drift from on-device cal | Compare against NanoVNA-Saver; fall back to per-band cal if error exceeds spec |
| iOS home-screen web app limits | Storage eviction, WebSocket suspend when backgrounded | Persistent storage request, export reminder, reconnect on resume |
| Trim coach estimates | Unknown lengths and end effects make first cut imprecise | Damping factor, label estimates, learn per profile from the cut log |
| Sunlight readability | Phone screens wash out in the field | High-contrast theme as a first-class mode, tested outdoors at M4 |
| Power and enclosure | Deferred | Decide at M7; candidate IP5306 + 18650 |
