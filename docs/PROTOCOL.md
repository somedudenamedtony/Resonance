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
| `wifi.set` | `mode: "ap" \| "sta"`, `ssid?: string`, `password?: string` | `ok`, then the bridge restarts Wi-Fi |
| `ota.begin` | `target: "firmware" \| "app"`, `size: number` | `ok`; app then sends the image as binary frames of type `0x02` |

### Bridge → app

| `type` | Fields |
| --- | --- |
| `device` | `connected: boolean`, `model?: string`, `firmware?: string`, `maxPoints?: number`, `bridgeVersion: string` |
| `scan.begin` | `id`, `points`, `ports` |
| `scan.end` | `id`, `durationMs`, `cancelled?: boolean` |
| `raw.reply` | `command`, `text` |
| `ok` | `for: string` (the request `type`) |
| `error` | `code: "no_device" \| "timeout" \| "busy" \| "bad_request" \| "internal"`, `message`, `id?` |

The bridge sends `device` unsolicited whenever the NanoVNA connects or disconnects.

Only one scan runs at a time. A `scan` while one is in flight gets `error` `busy`.

## Binary frames

All integers and floats are **little-endian**.

### Header (8 bytes)

| Offset | Type | Field |
| --- | --- | --- |
| 0 | u8 | `kind`: `0x01` = scan data, `0x02` = OTA chunk |
| 1 | u8 | `flags`: bit 0 = record includes S21 |
| 2 | u16 | `scanId` |
| 4 | u16 | `offset`: index of the first point in this frame |
| 6 | u16 | `count`: number of points in this frame |

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
4 KB, so a frame carries at most 250 S11 records. Frames for one scan arrive in order of
`offset` and together cover `0 .. points-1` exactly once.

Values are **raw** (uncorrected): the bridge sends `cal off` to the NanoVNA and the app
applies its own calibration.
