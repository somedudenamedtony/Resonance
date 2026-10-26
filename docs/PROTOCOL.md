# Bridge protocol, v1

The app and the ESP32-S3 bridge talk over one WebSocket at `ws://<bridge>/ws`.
Text frames carry JSON control messages; binary frames carry sweep data.
The TypeScript source of truth is [`app/src/bridge/protocol.ts`](../app/src/bridge/protocol.ts);
the firmware must match this document byte for byte.

## JSON messages

Every JSON message has `v` (protocol version, currently `1`) and `type`.

### App → bridge

| `type` | Fields | Bridge replies with |
| --- | --- | --- |
| `hello` | `appVersion: string` | `device` |
| `scan` | `id: u16`, `startHz: number`, `stopHz: number`, `points: number`, `ports: "s11" \| "s11+s21"` | `scan.begin`, binary frames, `scan.end` (or `error`) |
| `cancel` | `id: u16` | `scan.end` with `cancelled: true` |
| `raw` | `command: string` | `raw.reply` |
| `capture` | — | `capture.begin`, binary frames of kind `0x03`, `capture.end` |
| `wifi.set` | `mode: "ap" \| "sta"`, `ssid?: string`, `password?: string` | `ok`, then the bridge restarts Wi-Fi |
| `ota.begin` | `target: "firmware" \| "app"`, `size: number` | `ok`; app then sends the image as binary frames of kind `0x02`; each gets `ota.ack`; the last gets `ok` `for: "ota.end"` (or `error`) |
| `update.check` | — | `update` (`checking`, then `current`, `available` or `failed`), or `error` `busy` |
| `update.install` | — | `update` (`checking`, `installing` with progress, then `done` and a restart, or `failed`), or `error` |

### Bridge → app

| `type` | Fields |
| --- | --- |
| `device` | `connected: boolean`, `model?: string`, `firmware?: string`, `maxPoints?: number`, `bridgeVersion: string` |
| `wifi` | `mode: "ap" \| "sta"`, `apSsid: string`, `ssid?: string`, `state?: "connecting" \| "connected" \| "failed"`, `ip?: string`, `rssi?: number` (dBm), `reason?: string` |
| `scan.begin` | `id`, `points`, `ports` |
| `scan.end` | `id`, `durationMs`, `cancelled?: boolean` |
| `raw.reply` | `command`, `text` |
| `capture.begin` | `width`, `height`, `format: "rgb565be"` |
| `capture.end` | `bytes` |
| `ota.ack` | `received` (bytes so far) |
| `update` | `state: "idle" \| "checking" \| "current" \| "available" \| "installing" \| "done" \| "failed"`, `current: string`, `latest?: string`, `step?: "firmware" \| "app"`, `received?: number`, `total?: number`, `message?: string`, `rolledBack?: string` |
| `ok` | `for: string` (the request `type`) |
| `error` | `code: "no_device" \| "timeout" \| "busy" \| "bad_request" \| "internal"`, `message`, `id?` |

The bridge sends `device` unsolicited whenever the NanoVNA connects or disconnects.

The bridge sends `wifi` after `device` when an app connects or says `hello`, and again whenever
its Wi-Fi changes (signal strength alone doesn't count). With `mode: "sta"` it is also joining
home Wi-Fi `ssid`: `state` says how that is going, `ip` and `rssi` are present once connected, and
`reason` says in plain words why the last attempt failed (it keeps retrying). Older firmware
never sends `wifi`.

The bridge sends `update` after `wifi` when an app connects or says `hello`, and again whenever
it changes (about once a second while installing). It describes the latest GitHub release, which
the bridge fetches itself over home Wi-Fi: it checks about 20 s after joining and every 12 hours,
and on `update.check`. `current` is the bridge's version and `latest` the newest release once
known. While `installing`, `received` of `total` counts bytes of firmware plus app. `message` says
why it `failed`. `rolledBack` names a version that didn't start properly, so the bootloader went
back to `current`. `update.install` installs the latest release whatever its version (the app only
offers it when newer). Older firmware never sends `update`.

Only one scan runs at a time. A `scan` while one is in flight gets `error` `busy`.

## Binary frames

All integers and floats are **little-endian**.

### Header (8 bytes)

| Offset | Type | Field |
| --- | --- | --- |
| 0 | u8 | `kind`: `0x01` = scan data, `0x02` = OTA chunk, `0x03` = screen capture |
| 1 | u8 | `flags`: bit 0 = record includes S21 |
| 2 | u16 | `scanId` |
| 4 | u16 | `offset`: index of the first point in this frame |
| 6 | u16 | `count`: number of points in this frame |

Capture frames (`0x03`) reuse the header differently: bytes 4–7 are a `u32` byte offset into
the screen image, and the payload (up to 4088 bytes) is raw screen data: `width × height`
pixels of big-endian RGB565, row by row, exactly as NanoVNA-D's `capture` sends it.

### Scan record

Repeated `count` times after the header.

| Offset | Type | Field |
| --- | --- | --- |
| 0 | f64 | frequency, Hz |
| 8 | f32 | S11 real |
| 12 | f32 | S11 imaginary |
| 16 | f32 | S21 real (only if flags bit 0) |
| 20 | f32 | S21 imaginary (only if flags bit 0) |

Record size is 16 bytes (S11 only) or 24 bytes (with S21). Frames should stay under
4 KB, so a frame carries at most 255 S11 records (170 with S21). Frames for one scan arrive in order of
`offset` and together cover `0 .. points-1` exactly once.

Values are **raw** (uncorrected): the bridge's scan mask sets the NanoVNA-D "no
calibration" and "no electrical delay" bits (0x08, 0x10), and the app applies its own
calibration. The device's stored calibration is never changed.

### Update chunk (kind `0x02`, app → bridge)

Header bytes 4–7 are a u32 byte offset; the payload (≤ 4088 bytes) is the next slice of the
image. Rules:

- Chunks must arrive in order (`offset` == bytes received so far) and not exceed `size`.
- The first chunk is checked: firmware must start with `0xE9` (ESP image), the app image must
  be LittleFS (`"littlefs"` at byte 8). A wrong file is refused before anything is written.
- 30 s without a chunk cancels the update. Any failure leaves the running image untouched.
- `firmware` (`resonance-bridge.bin`) goes to the inactive OTA slot; after `ok` the bridge
  reboots into it. `app` (`littlefs.bin`) rewrites the web app partition, then the bridge reboots.
- A new firmware is on probation until it joins home Wi-Fi or an app connects. If it restarts
  first, or 5 minutes pass, the bootloader goes back to the previous firmware.

## Updates from GitHub releases

Merging a change to `RC_BRIDGE_VERSION` into `main` makes CI publish release `v<version>` with
`resonance-bridge.bin` and `littlefs.bin` attached. The bridge reads
`api.github.com/repos/<owner>/<repo>/releases/latest` over HTTPS, compares `tag_name` with its
version, and on `update.install` downloads both files (following GitHub's redirect to its storage
host). Firmware goes into the spare slot first, then the app is written; only when both succeed
does the bridge switch to the new firmware and restart. A failed firmware download changes
nothing; a failed app download leaves the old firmware running and the app partition half
written, so install again (the built-in `/update` page has a button for this).

## How the bridge talks to the NanoVNA

Implemented in `firmware/components/resonance_core` (`rc_shell.c`, `rc_bridge.c`), checked
against NanoVNA-D's `main.c`:

- On attach: press Enter to sync on a prompt, then `info` (model from `Board:`, max points
  from `[p:NNN`), `version`, `help` (binary support if `scan_bin` is listed).
- Each command's response is `<echo>\r\n<body>ch> `. The bridge finds the body by matching
  the echoed command, so stray banners and prompts are ignored.
- Binary scans are read by length (`u16 mask`, `u16 points`, then records), never by
  searching for `ch> `, since float bytes can contain it.
- Requests larger than the device's max points are split into even segments with matching
  frequencies; frames to the app always count offsets across the whole sweep.
- While the bridge re-syncs after a timeout it reports `device` with `connected: false`.
