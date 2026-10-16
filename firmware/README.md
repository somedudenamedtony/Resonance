# Resonance bridge firmware

ESP32-S3-DevKitC-1 N16R8 · PlatformIO · ESP-IDF.

**Status: M0 placeholder.** `src/main.c` only logs. It has not been compiled or flashed yet.

## Wiring

- **USB** port (native USB, GPIO19/20) → NanoVNA, as USB host.
- **UART** port → computer for flashing and logs, and 5 V power.
- If the NanoVNA doesn't enumerate, bridge the **IN-OUT** pad so the USB port supplies 5 V.

## M1 plan (bridge talks)

Exit: type `version` in a browser console page, get the NanoVNA's reply over Wi-Fi.

1. **USB host spike first.** ESP-IDF `usb_host` + the `espressif/usb_host_cdc_acm` component.
   Open the NanoVNA (STM32 CDC, VID 0x0483 PID 0x5740 on most units), send `version\r`,
   log the reply up to the `ch> ` prompt. This is the biggest risk; do it before anything else.
2. **Command queue.** One command in flight, 5 s timeout, read until `ch> `.
3. **Wi-Fi AP.** SSID `Resonance-XXXX` (last 2 MAC bytes), WPA2, 192.168.4.1.
4. **HTTP + WebSocket.** `esp_http_server` with `CONFIG_HTTPD_WS_SUPPORT`. Serve a tiny
   test page; `/ws` handles `hello` and `raw` per `docs/PROTOCOL.md`.
5. **Status LED** (WS2812 on GPIO48 on most DevKitC-1 boards; some clones use GPIO38).

M2 adds `scan` with binary frames, LittleFS app hosting and segmenting.

## Partition layout

Two 2 MB OTA app slots and a ~11.9 MB LittleFS partition for the web app (`partitions.csv`).
