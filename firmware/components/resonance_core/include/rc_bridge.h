// Resonance bridge core: protocol v1 (docs/PROTOCOL.md) on one side, the NanoVNA shell on the
// other. Platform-independent: the ESP32 build and the host emulator build both drive it.
//
// The platform calls in:
//   rc_bridge_device_attached / _detached   when the NanoVNA's USB serial appears or goes
//   rc_bridge_serial_rx                     with bytes from the NanoVNA
//   rc_bridge_client_text                   with a JSON text message from the app
//   rc_bridge_client_connected              when an app connects (sends a device message)
//   rc_bridge_tick                          every ~10–50 ms
// and receives calls out through rc_bridge_io_t.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "rc_scan.h"
#include "rc_shell.h"

#ifdef __cplusplus
extern "C" {
#endif

#define RC_BRIDGE_VERSION "0.3.0"
#define RC_SHELL_BUF_SIZE 32768
#define RC_MAX_SCAN_POINTS 10001
#define RC_MAX_SEGMENT_POINTS 401

// Wi-Fi as the platform sees it, reported to the app in a `wifi` message.
typedef enum {
    RC_WIFI_OFF = 0,     // hotspot only, no home Wi-Fi configured
    RC_WIFI_CONNECTING,  // joining home Wi-Fi (associating or waiting for an address)
    RC_WIFI_CONNECTED,   // joined, has an IP address
    RC_WIFI_FAILED,      // the last attempt failed (`reason` says why); still retrying
} rc_wifi_state_t;

typedef struct {
    rc_wifi_state_t state;
    char ap_ssid[33];  // the bridge's own network
    char ssid[33];     // home Wi-Fi, empty when hotspot only
    char ip[16];       // address on home Wi-Fi, empty unless connected
    int8_t rssi;       // dBm, 0 unless connected
    char reason[64];   // why the last attempt failed, empty otherwise
} rc_wifi_status_t;

typedef struct {
    void (*serial_write)(void *user, const uint8_t *data, size_t len);
    void (*send_text)(void *user, const char *json);
    void (*send_binary)(void *user, const uint8_t *data, size_t len);
    // Optional. Return true if the settings were accepted.
    bool (*wifi_set)(void *user, bool sta, const char *ssid, const char *password);
    // Optional. Fill in the current Wi-Fi status; polled about once a second.
    void (*wifi_status)(void *user, rc_wifi_status_t *out);
    // Optional log sink.
    void (*log)(void *user, const char *msg);
    // Optional updates over Wi-Fi. `target` is "firmware" or "app" (the LittleFS image).
    // Each returns false (and may fill `err`) to refuse/abort.
    bool (*ota_begin)(void *user, const char *target, uint32_t size, char *err, size_t err_cap);
    bool (*ota_write)(void *user, const uint8_t *data, size_t len, char *err, size_t err_cap);
    bool (*ota_end)(void *user, char *err, size_t err_cap);
    void (*ota_abort)(void *user);
    void *user;
} rc_bridge_io_t;

typedef enum {
    RC_DEV_ABSENT = 0,
    RC_DEV_PROBING,
    RC_DEV_READY,
} rc_dev_state_t;

typedef enum {
    RC_JOB_NONE = 0,
    RC_JOB_PROBE,
    RC_JOB_SCAN,
    RC_JOB_RAW,
    RC_JOB_CAPTURE,
} rc_job_t;

typedef struct {
    uint16_t id;
    uint32_t start_hz;
    uint32_t stop_hz;
    uint32_t points;
    bool s21;
} rc_scan_req_t;

typedef struct rc_bridge {
    rc_bridge_io_t io;
    rc_shell_t shell;
    uint8_t shell_buf[RC_SHELL_BUF_SIZE];
    rc_point_t points[RC_MAX_SEGMENT_POINTS];
    uint8_t frame[RC_FRAME_MAX];

    uint32_t now;

    // Device
    rc_dev_state_t dev;
    char model[48];
    char firmware[32];
    uint16_t max_points;
    bool binary;
    uint16_t lcd_w, lcd_h;  // screen size for `capture`
    int probe_step;
    int probe_failures;
    uint32_t next_action_ms;  // probe retry / settle timer

    // Current job
    rc_job_t job;
    bool job_waiting;  // waiting on next_action_ms before sending the next command

    // Scan
    rc_scan_req_t scan;
    bool scan_cancelled;
    uint16_t seg_count;
    uint16_t seg_index;
    uint32_t delivered;
    uint32_t scan_started_ms;
    bool has_queued_scan;
    rc_scan_req_t queued_scan;

    // Raw
    char raw_cmd[64];

    // Capture: screen bytes accumulate after the frame header until a frame is full
    size_t cap_fill;
    uint32_t cap_offset;

    // Update over Wi-Fi
    bool ota_active;
    char ota_target[12];
    uint32_t ota_size;
    uint32_t ota_received;
    uint32_t ota_last_ms;

    // Wi-Fi status last sent to the app
    rc_wifi_status_t wifi;
    bool wifi_sent;
    uint32_t wifi_next_ms;
} rc_bridge_t;

void rc_bridge_init(rc_bridge_t *b, const rc_bridge_io_t *io, uint32_t now_ms);

void rc_bridge_device_attached(rc_bridge_t *b, uint32_t now_ms);
void rc_bridge_device_detached(rc_bridge_t *b, uint32_t now_ms);
void rc_bridge_serial_rx(rc_bridge_t *b, const uint8_t *data, size_t len, uint32_t now_ms);

void rc_bridge_client_connected(rc_bridge_t *b, uint32_t now_ms);
void rc_bridge_client_text(rc_bridge_t *b, const char *json, size_t len, uint32_t now_ms);
// A binary WebSocket frame from the app (update chunks, kind 0x02).
void rc_bridge_client_binary(rc_bridge_t *b, const uint8_t *data, size_t len, uint32_t now_ms);

void rc_bridge_tick(rc_bridge_t *b, uint32_t now_ms);

// Parse a NanoVNA `info` reply: model from "Board: ...", max points from "[p:NNN", screen size
// from "Lcd:WxH" (left unchanged when absent).
void rc_bridge_parse_info(const char *text, char *model, size_t model_cap, uint16_t *max_points, uint16_t *lcd_w,
                          uint16_t *lcd_h);

#define RC_FRAME_CAPTURE 0x03
#define RC_FRAME_OTA 0x02
#define RC_OTA_IDLE_TIMEOUT_MS 30000
#define RC_WIFI_POLL_MS 1000
#define RC_OTA_MAX_SIZE (12u * 1024u * 1024u)

#ifdef __cplusplus
}
#endif
