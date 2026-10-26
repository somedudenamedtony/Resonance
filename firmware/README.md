# Resonance bridge firmware

ESP32-S3-DevKitC-1 N16R8 · native ESP-IDF (v5.3+).

**Status:** the bridge core is fully tested on the host against an emulated NanoVNA. The ESP32
platform layer compiles in CI but **has not run on hardware yet** — expect to debug USB host
enumeration and Wi-Fi on first flash (see "First flash checklist").

## Layout

```
firmware/
├── components/resonance_core/   portable C: everything that talks protocol or NanoVNA
│   ├── src/rc_shell.c           NanoVNA shell session (echo, prompt, binary-by-length)
│   ├── src/rc_scan.c            segmentation, text/binary scan parsing, frame encoding
│   ├── src/rc_bridge.c          the state machine: probe, scan, cancel, console, errors
│   ├── src/rc_update.c          release JSON, version compare (for updates from GitHub)
│   └── third_party/cjson        cJSON 1.7.18 (MIT)
├── main/                        ESP32-only glue, no protocol logic
│   ├── bridge_task.c            one task owns the core; everything else posts events
│   ├── usb_link.c               USB host CDC-ACM to the NanoVNA
│   ├── wifi.c                   AP "Resonance-XXXX" (+ optional home Wi-Fi)
│   ├── web.c                    app from LittleFS, WebSocket at /ws
│   ├── ota.c                    writes updates; rollback probation for new firmware
│   ├── release_update.c         checks GitHub releases and installs them
│   └── status_led.c             onboard RGB LED
└── host/                        the same core on Linux/macOS
    ├── bridge_host.c            resonance-bridge-host, used by emulator/
    └── test/core_tests.c        C unit tests with a scripted fake NanoVNA
```

## Testing without hardware

From the repo root:

```bash
npm run test:c      # C unit tests (ASan + UBSan)
npm test            # includes end-to-end: app ↔ C bridge ↔ emulated NanoVNA
npm run emulate     # run the stack and use the app against it
```

## Build and flash

```bash
npm run build                        # web app → app/dist (goes on the LittleFS partition)
cd firmware
idf.py set-target esp32s3
idf.py build
idf.py -p /dev/ttyUSB0 flash monitor # use the board's UART port
```

CI uploads ready-made images (artifact `resonance-bridge-esp32s3`) on every push. To flash
those without ESP-IDF: `pip install esptool`, then from the artifact folder run
`esptool.py --chip esp32s3 -p <port> -b 460800 write_flash @flash_args`.

## Updates

Once the bridge is on home Wi-Fi it checks GitHub for a newer release and the app offers it in
**Settings → Update the bridge**. Tap Install: the bridge downloads the firmware and the app
itself, writes both, and restarts once. A file upload in the same place still works without
internet.

To publish a release, bump `RC_BRIDGE_VERSION` in
`components/resonance_core/include/rc_bridge.h` and merge to `main`. When CI passes it creates
release `v<version>` with the images attached.

New firmware is kept only once it joins home Wi-Fi or an app connects. If it crashes or
restarts first, or 5 minutes pass without either, the bootloader goes back to the previous
firmware and the app says so. Rollback is a bootloader feature, so a board first flashed with
an older build needs **one USB flash** (bootloader included) to get it. Partition table
changes can never go over the air.

The serial log prints the Wi-Fi name and password on boot:

```
 Wi-Fi network: Resonance-3F2A
 Password:      k7wmq2rx
 Then open:     http://192.168.4.1/
```

## Wiring

- **USB** port (native USB) → NanoVNA. The ESP32 is the USB host.
- **UART** port → computer for flashing and logs, and 5 V power.
- If the NanoVNA doesn't enumerate, bridge the board's **IN-OUT** pad so the USB port
  supplies 5 V.

## First flash checklist (M1 exit: `version` over Wi-Fi)

1. Flash, open the monitor, note the Wi-Fi password.
2. Plug in the NanoVNA. Expect `NanoVNA connected`, the device descriptor dump, then
   `NanoVNA ready: <model>, firmware <x>, <n> points, binary scans`.
   - Nothing at all: power. Bridge IN-OUT, or power the NanoVNA from its own battery.
   - Connected but no "ready": the shell probe failed. Look for `probe step N failed`.
3. Join the Resonance Wi-Fi from the phone, open http://192.168.4.1/, tap the status strip,
   send `version` in the console.
4. Run Check my antenna. The verdict is uncalibrated until M3.

If the LED stays dark, try `RESONANCE_LED_GPIO=38` (some board revisions).
