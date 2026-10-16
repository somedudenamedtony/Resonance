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

#define RC_BRIDGE_VERSION "0.2.0"
#define RC_SHELL_BUF_SIZE 32768
#define RC_MAX_SCAN_POINTS 10001
#define RC_MAX_SEGMENT_POINTS 401

typedef struct {
    void (*serial_write)(void *user, const uint8_t *data, size_t len);
    void (*send_text)(void *user, const char *json);
    void (*send_binary)(void *user, const uint8_t *data, size_t len);
    // Optional. Return true if the settings were accepted.
    bool (*wifi_set)(void *user, bool sta, const char *ssid, const char *password);
    // Optional log sink.
    void (*log)(void *user, const char *msg);
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
} rc_bridge_t;

void rc_bridge_init(rc_bridge_t *b, const rc_bridge_io_t *io, uint32_t now_ms);

void rc_bridge_device_attached(rc_bridge_t *b, uint32_t now_ms);
void rc_bridge_device_detached(rc_bridge_t *b, uint32_t now_ms);
void rc_bridge_serial_rx(rc_bridge_t *b, const uint8_t *data, size_t len, uint32_t now_ms);

void rc_bridge_client_connected(rc_bridge_t *b, uint32_t now_ms);
void rc_bridge_client_text(rc_bridge_t *b, const char *json, size_t len, uint32_t now_ms);

void rc_bridge_tick(rc_bridge_t *b, uint32_t now_ms);

// Parse a NanoVNA `info` reply: model from "Board: ...", max points from "[p:NNN", screen size
// from "Lcd:WxH" (left unchanged when absent).
void rc_bridge_parse_info(const char *text, char *model, size_t model_cap, uint16_t *max_points, uint16_t *lcd_w,
                          uint16_t *lcd_h);

#define RC_FRAME_CAPTURE 0x03

#ifdef __cplusplus
}
#endif
