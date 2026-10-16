#include "rc_bridge.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"

#define PROBE_TIMEOUT_MS 1500
#define PROBE_RETRY_MS 1000
#define SYNC_SETTLE_MS 150
#define RAW_TIMEOUT_MS 5000
#define DEFAULT_MAX_POINTS 101

enum { PROBE_SYNC = 0, PROBE_INFO, PROBE_VERSION, PROBE_HELP, PROBE_DONE };

static void pump(rc_bridge_t *b);
static void on_shell_done(void *ctx, rc_shell_status_t st, const uint8_t *body, size_t len, bool is_text);

// ---------- output helpers ----------

static void logf_(rc_bridge_t *b, const char *fmt, ...)
{
    if (!b->io.log) return;
    char msg[160];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(msg, sizeof msg, fmt, ap);
    va_end(ap);
    b->io.log(b->io.user, msg);
}

static void send_json(rc_bridge_t *b, cJSON *obj)
{
    char *s = cJSON_PrintUnformatted(obj);
    if (s) {
        b->io.send_text(b->io.user, s);
        cJSON_free(s);
    }
    cJSON_Delete(obj);
}

static cJSON *msg(const char *type)
{
    cJSON *o = cJSON_CreateObject();
    cJSON_AddNumberToObject(o, "v", 1);
    cJSON_AddStringToObject(o, "type", type);
    return o;
}

static void send_error(rc_bridge_t *b, const char *code, const char *message, int id)
{
    cJSON *o = msg("error");
    cJSON_AddStringToObject(o, "code", code);
    cJSON_AddStringToObject(o, "message", message);
    if (id >= 0) cJSON_AddNumberToObject(o, "id", id);
    send_json(b, o);
}

static void send_device(rc_bridge_t *b)
{
    cJSON *o = msg("device");
    bool ready = b->dev == RC_DEV_READY;
    cJSON_AddBoolToObject(o, "connected", ready);
    if (ready) {
        cJSON_AddStringToObject(o, "model", b->model);
        cJSON_AddStringToObject(o, "firmware", b->firmware);
        cJSON_AddNumberToObject(o, "maxPoints", b->max_points);
    }
    cJSON_AddStringToObject(o, "bridgeVersion", RC_BRIDGE_VERSION);
    send_json(b, o);
}

// ---------- info parsing ----------

static void copy_trimmed(char *dst, size_t cap, const char *src, size_t n)
{
    while (n > 0 && (src[0] == ' ' || src[0] == '\t')) {
        src++;
        n--;
    }
    while (n > 0 && (src[n - 1] == ' ' || src[n - 1] == '\r' || src[n - 1] == '\n')) n--;
    if (n >= cap) n = cap - 1;
    memcpy(dst, src, n);
    dst[n] = 0;
}

void rc_bridge_parse_info(const char *text, char *model, size_t model_cap, uint16_t *max_points)
{
    const char *board = strstr(text, "Board:");
    if (board) {
        board += 6;
        const char *eol = strpbrk(board, "\r\n");
        size_t n = eol ? (size_t)(eol - board) : strlen(board);
        copy_trimmed(model, model_cap, board, n);
    }
    const char *p = strstr(text, "p:");
    // Only trust "p:NNN" inside the version line's bracket, e.g. "[p:401, IF:12k, ...".
    const char *bracket = strstr(text, "[p:");
    if (bracket) p = bracket + 1;
    else p = NULL;
    if (p) {
        long v = strtol(p + 2, NULL, 10);
        if (v >= 2 && v <= 65535) *max_points = (uint16_t)v;
    }
}

// ---------- device lifecycle ----------

static void send_device(rc_bridge_t *b);

static void start_probe(rc_bridge_t *b, uint32_t delay_ms)
{
    bool was_ready = b->dev == RC_DEV_READY;
    b->dev = RC_DEV_PROBING;
    if (was_ready) send_device(b);  // tell the app the device isn't usable while we resync
    b->probe_step = PROBE_SYNC;
    b->job = RC_JOB_PROBE;
    b->job_waiting = true;
    b->next_action_ms = b->now + delay_ms;
}

void rc_bridge_init(rc_bridge_t *b, const rc_bridge_io_t *io, uint32_t now_ms)
{
    memset(b, 0, sizeof *b);
    b->io = *io;
    b->now = now_ms;
    b->max_points = DEFAULT_MAX_POINTS;
    rc_shell_init(&b->shell, b->shell_buf, sizeof b->shell_buf, b->io.serial_write, b->io.user);
}

void rc_bridge_device_attached(rc_bridge_t *b, uint32_t now_ms)
{
    b->now = now_ms;
    rc_shell_reset(&b->shell);
    b->probe_failures = 0;
    b->model[0] = 0;
    b->firmware[0] = 0;
    b->max_points = DEFAULT_MAX_POINTS;
    b->binary = false;
    logf_(b, "NanoVNA attached, probing");
    // Give the device a moment to print its banner before we press Enter.
    start_probe(b, 200);
}

static void fail_active_job(rc_bridge_t *b, const char *code, const char *message)
{
    if (b->job == RC_JOB_SCAN && !b->scan_cancelled) send_error(b, code, message, b->scan.id);
    if (b->job == RC_JOB_RAW) send_error(b, code, message, -1);
    b->job = RC_JOB_NONE;
    b->job_waiting = false;
}

void rc_bridge_device_detached(rc_bridge_t *b, uint32_t now_ms)
{
    b->now = now_ms;
    b->dev = RC_DEV_ABSENT;  // set first so the abort callback knows why
    rc_shell_abort(&b->shell);
    fail_active_job(b, "no_device", "The NanoVNA was disconnected.");
    if (b->has_queued_scan) {
        send_error(b, "no_device", "The NanoVNA was disconnected.", b->queued_scan.id);
        b->has_queued_scan = false;
    }
    logf_(b, "NanoVNA detached");
    send_device(b);
}

void rc_bridge_serial_rx(rc_bridge_t *b, const uint8_t *data, size_t len, uint32_t now_ms)
{
    b->now = now_ms;
    rc_shell_feed(&b->shell, data, len);
    pump(b);
}

void rc_bridge_client_connected(rc_bridge_t *b, uint32_t now_ms)
{
    b->now = now_ms;
    send_device(b);
}

void rc_bridge_tick(rc_bridge_t *b, uint32_t now_ms)
{
    b->now = now_ms;
    rc_shell_tick(&b->shell, now_ms);
    pump(b);
}

// ---------- jobs ----------

static uint32_t scan_timeout_ms(uint16_t count)
{
    return 3000 + (uint32_t)count * 30;
}

static void send_probe_step(rc_bridge_t *b)
{
    static const char *cmds[] = {"", "info", "version", "help"};
    rc_shell_send(&b->shell, cmds[b->probe_step], RC_RESP_TEXT, 0, 0, b->now, PROBE_TIMEOUT_MS, on_shell_done, b);
}

static void send_scan_segment(rc_bridge_t *b)
{
    rc_segment_t s = rc_scan_segment(b->scan.start_hz, b->scan.stop_hz, b->scan.points, b->seg_count, b->seg_index);
    uint16_t mask = rc_scan_mask(b->scan.s21, b->binary);
    char cmd[64];
    snprintf(cmd, sizeof cmd, "scan %lu %lu %u %u", (unsigned long)s.start_hz, (unsigned long)s.stop_hz,
             (unsigned)s.count, (unsigned)mask);
    rc_shell_send(&b->shell, cmd, b->binary ? RC_RESP_SCAN_BIN : RC_RESP_TEXT, mask, s.count, b->now,
                  scan_timeout_ms(s.count), on_shell_done, b);
}

static void start_scan(rc_bridge_t *b, const rc_scan_req_t *req)
{
    b->scan = *req;
    b->scan_cancelled = false;
    uint16_t maxp = b->max_points;
    if (maxp > RC_MAX_SEGMENT_POINTS) maxp = RC_MAX_SEGMENT_POINTS;
    b->seg_count = rc_scan_segment_count(req->points, maxp);
    b->seg_index = 0;
    b->delivered = 0;
    b->scan_started_ms = b->now;
    b->job = RC_JOB_SCAN;
    b->job_waiting = false;

    cJSON *o = msg("scan.begin");
    cJSON_AddNumberToObject(o, "id", req->id);
    cJSON_AddNumberToObject(o, "points", req->points);
    cJSON_AddStringToObject(o, "ports", req->s21 ? "s11+s21" : "s11");
    send_json(b, o);
}

static void pump(rc_bridge_t *b)
{
    if (b->shell.busy) return;
    if (b->job_waiting) {
        if ((int32_t)(b->now - b->next_action_ms) < 0) return;
        b->job_waiting = false;
        if (b->job == RC_JOB_PROBE) {
            send_probe_step(b);
            return;
        }
    }
    if (b->job == RC_JOB_NONE && b->has_queued_scan && b->dev == RC_DEV_READY) {
        b->has_queued_scan = false;
        start_scan(b, &b->queued_scan);
    }
    if (b->job == RC_JOB_SCAN && !b->shell.busy) send_scan_segment(b);
}

static void finish_probe(rc_bridge_t *b)
{
    b->dev = RC_DEV_READY;
    b->job = RC_JOB_NONE;
    if (!b->model[0]) snprintf(b->model, sizeof b->model, "NanoVNA");
    logf_(b, "NanoVNA ready: %s, firmware %s, %u points, %s scans", b->model, b->firmware, b->max_points,
          b->binary ? "binary" : "text");
    send_device(b);
}

static void handle_probe(rc_bridge_t *b, rc_shell_status_t st, const char *text)
{
    if (st != RC_SHELL_OK) {
        b->probe_failures++;
        logf_(b, "probe step %d failed (%d), retrying", b->probe_step, (int)st);
        start_probe(b, PROBE_RETRY_MS);
        return;
    }
    switch (b->probe_step) {
    case PROBE_SYNC:
        // Let any late banner or extra prompts drain before the first real command.
        b->probe_step = PROBE_INFO;
        b->job_waiting = true;
        b->next_action_ms = b->now + SYNC_SETTLE_MS;
        return;
    case PROBE_INFO:
        rc_bridge_parse_info(text, b->model, sizeof b->model, &b->max_points);
        break;
    case PROBE_VERSION: {
        const char *eol = strpbrk(text, "\r\n");
        copy_trimmed(b->firmware, sizeof b->firmware, text, eol ? (size_t)(eol - text) : strlen(text));
        break;
    }
    case PROBE_HELP:
        b->binary = strstr(text, "scan_bin") != NULL;
        finish_probe(b);
        return;
    }
    b->probe_step++;
    send_probe_step(b);
}

static void emit_points(rc_bridge_t *b, const rc_point_t *pts, size_t n)
{
    size_t per = rc_frame_max_records(b->scan.s21);
    size_t i = 0;
    while (i < n) {
        size_t k = n - i < per ? n - i : per;
        size_t sz = rc_frame_encode(b->frame, sizeof b->frame, b->scan.id, (uint16_t)b->delivered, b->scan.s21,
                                    pts + i, k);
        if (sz) b->io.send_binary(b->io.user, b->frame, sz);
        b->delivered += (uint32_t)k;
        i += k;
    }
}

static void handle_scan(rc_bridge_t *b, rc_shell_status_t st, const uint8_t *body, size_t len, bool is_text)
{
    if (b->scan_cancelled) {
        b->job = RC_JOB_NONE;
        return;
    }
    if (st == RC_SHELL_TIMEOUT) {
        fail_active_job(b, "timeout", "The NanoVNA didn't finish the scan. Check it's on and not busy.");
        start_probe(b, PROBE_RETRY_MS);  // resync the shell
        return;
    }
    if (st != RC_SHELL_OK) {
        fail_active_job(b, "internal", "The scan response from the NanoVNA was too large.");
        return;
    }
    rc_segment_t seg = rc_scan_segment(b->scan.start_hz, b->scan.stop_hz, b->scan.points, b->seg_count, b->seg_index);
    int n;
    if (b->binary && !is_text) {
        n = rc_scan_parse_bin(body, len, b->points, RC_MAX_SEGMENT_POINTS);
    } else {
        uint16_t mask = rc_scan_mask(b->scan.s21, false);
        n = rc_scan_parse_text((const char *)body, len, mask, b->points, RC_MAX_SEGMENT_POINTS);
    }
    if (n != seg.count) {
        char m[120];
        if (n < 0) {
            char snippet[48];
            copy_trimmed(snippet, sizeof snippet, (const char *)body, len < 47 ? len : 47);
            snprintf(m, sizeof m, "The NanoVNA rejected the scan: %s", snippet);
        } else {
            snprintf(m, sizeof m, "The NanoVNA returned %d of %u points.", n, (unsigned)seg.count);
        }
        fail_active_job(b, "internal", m);
        return;
    }
    emit_points(b, b->points, (size_t)n);
    b->seg_index++;
    if (b->seg_index >= b->seg_count) {
        cJSON *o = msg("scan.end");
        cJSON_AddNumberToObject(o, "id", b->scan.id);
        cJSON_AddNumberToObject(o, "durationMs", (double)(uint32_t)(b->now - b->scan_started_ms));
        send_json(b, o);
        b->job = RC_JOB_NONE;
    }
    // Otherwise pump() sends the next segment.
}

static void handle_raw(rc_bridge_t *b, rc_shell_status_t st, const char *text)
{
    b->job = RC_JOB_NONE;
    if (st == RC_SHELL_TIMEOUT) {
        send_error(b, "timeout", "No reply from the NanoVNA.", -1);
        start_probe(b, PROBE_RETRY_MS);
        return;
    }
    if (st != RC_SHELL_OK) {
        send_error(b, "internal", "The reply was too large.", -1);
        return;
    }
    size_t n = strlen(text);
    while (n > 0 && (text[n - 1] == '\r' || text[n - 1] == '\n')) n--;
    char *trimmed = malloc(n + 1);
    if (!trimmed) return;
    memcpy(trimmed, text, n);
    trimmed[n] = 0;
    cJSON *o = msg("raw.reply");
    cJSON_AddStringToObject(o, "command", b->raw_cmd);
    cJSON_AddStringToObject(o, "text", trimmed);
    free(trimmed);
    send_json(b, o);
}

static void on_shell_done(void *ctx, rc_shell_status_t st, const uint8_t *body, size_t len, bool is_text)
{
    rc_bridge_t *b = ctx;
    if (st == RC_SHELL_ABORTED) return;  // detach handles reporting

    // Text handlers want a NUL-terminated copy; the shell buffer may be full, so copy.
    char *text = NULL;
    if (b->job != RC_JOB_SCAN || is_text || !b->binary) {
        text = malloc(len + 1);
        if (!text) return;
        if (len) memcpy(text, body, len);
        text[len] = 0;
    }

    switch (b->job) {
    case RC_JOB_PROBE:
        handle_probe(b, st, text ? text : "");
        break;
    case RC_JOB_SCAN:
        handle_scan(b, st, text ? (const uint8_t *)text : body, len, is_text);
        break;
    case RC_JOB_RAW:
        handle_raw(b, st, text ? text : "");
        break;
    case RC_JOB_NONE:
        break;
    }
    free(text);
}

// ---------- client messages ----------

static bool get_number(const cJSON *o, const char *key, double *out)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, key);
    if (!cJSON_IsNumber(v)) return false;
    *out = v->valuedouble;
    return true;
}

static const char *get_string(const cJSON *o, const char *key)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, key);
    return cJSON_IsString(v) ? v->valuestring : NULL;
}

static void handle_scan_msg(rc_bridge_t *b, const cJSON *o)
{
    double id, start, stop, points;
    if (!get_number(o, "id", &id) || !get_number(o, "startHz", &start) || !get_number(o, "stopHz", &stop) ||
        !get_number(o, "points", &points)) {
        send_error(b, "bad_request", "scan needs id, startHz, stopHz and points", -1);
        return;
    }
    int iid = (int)id;
    const char *ports = get_string(o, "ports");
    bool s21 = ports && strcmp(ports, "s11+s21") == 0;
    if (id < 0 || id > 65535 || id != floor(id) || start < 1 || stop <= start || stop > 4294967295.0 || points < 2 ||
        points > RC_MAX_SCAN_POINTS || points != floor(points) || (ports && !s21 && strcmp(ports, "s11") != 0)) {
        send_error(b, "bad_request", "invalid scan parameters", iid);
        return;
    }
    if (b->dev != RC_DEV_READY) {
        send_error(b, "no_device", b->dev == RC_DEV_PROBING ? "The NanoVNA is still starting up." : "NanoVNA not detected.",
                   iid);
        return;
    }
    rc_scan_req_t req = {(uint16_t)iid, (uint32_t)start, (uint32_t)stop, (uint32_t)points, s21};
    bool shell_free = !b->shell.busy && b->job == RC_JOB_NONE;
    if (shell_free) {
        start_scan(b, &req);
        pump(b);
    } else if (b->job == RC_JOB_NONE || (b->job == RC_JOB_SCAN && b->scan_cancelled)) {
        // The previous (cancelled) scan's reply is still draining; run this one next.
        if (b->has_queued_scan) send_error(b, "busy", "A scan is already queued.", iid);
        else {
            b->queued_scan = req;
            b->has_queued_scan = true;
        }
    } else {
        send_error(b, "busy", "A scan is already running.", iid);
    }
}

static void handle_cancel(rc_bridge_t *b, const cJSON *o)
{
    double id;
    if (!get_number(o, "id", &id)) return;
    if (b->has_queued_scan && b->queued_scan.id == (uint16_t)id) {
        b->has_queued_scan = false;
    } else if (b->job == RC_JOB_SCAN && b->scan.id == (uint16_t)id && !b->scan_cancelled) {
        b->scan_cancelled = true;  // the in-flight device scan finishes and is discarded
    } else {
        return;
    }
    cJSON *r = msg("scan.end");
    cJSON_AddNumberToObject(r, "id", id);
    cJSON_AddNumberToObject(r, "durationMs", 0);
    cJSON_AddBoolToObject(r, "cancelled", true);
    send_json(b, r);
}

static void handle_raw_msg(rc_bridge_t *b, const cJSON *o)
{
    const char *cmd = get_string(o, "command");
    if (!cmd || !cmd[0] || strlen(cmd) > 60 || strpbrk(cmd, "\r\n")) {
        send_error(b, "bad_request", "raw needs a single-line command of 1-60 characters", -1);
        return;
    }
    if (strncmp(cmd, "scan_bin", 8) == 0 || strncmp(cmd, "capture", 7) == 0) {
        send_error(b, "bad_request", "Binary commands aren't supported in the console.", -1);
        return;
    }
    if (b->dev != RC_DEV_READY) {
        send_error(b, "no_device", "NanoVNA not detected.", -1);
        return;
    }
    if (b->shell.busy || b->job != RC_JOB_NONE) {
        send_error(b, "busy", "The NanoVNA is busy. Try again in a moment.", -1);
        return;
    }
    snprintf(b->raw_cmd, sizeof b->raw_cmd, "%s", cmd);
    b->job = RC_JOB_RAW;
    if (!rc_shell_send(&b->shell, b->raw_cmd, RC_RESP_TEXT, 0, 0, b->now, RAW_TIMEOUT_MS, on_shell_done, b)) {
        b->job = RC_JOB_NONE;
        send_error(b, "bad_request", "That command can't be sent.", -1);
    }
}

static void handle_wifi(rc_bridge_t *b, const cJSON *o)
{
    const char *mode = get_string(o, "mode");
    if (!mode || (strcmp(mode, "ap") != 0 && strcmp(mode, "sta") != 0)) {
        send_error(b, "bad_request", "wifi.set needs mode ap or sta", -1);
        return;
    }
    bool sta = strcmp(mode, "sta") == 0;
    const char *ssid = get_string(o, "ssid");
    const char *pw = get_string(o, "password");
    if (sta && (!ssid || !ssid[0])) {
        send_error(b, "bad_request", "Station mode needs an SSID.", -1);
        return;
    }
    if (!b->io.wifi_set || !b->io.wifi_set(b->io.user, sta, ssid ? ssid : "", pw ? pw : "")) {
        send_error(b, "internal", "Couldn't save the Wi-Fi settings.", -1);
        return;
    }
    cJSON *r = msg("ok");
    cJSON_AddStringToObject(r, "for", "wifi.set");
    send_json(b, r);
}

void rc_bridge_client_text(rc_bridge_t *b, const char *json, size_t len, uint32_t now_ms)
{
    b->now = now_ms;
    cJSON *o = cJSON_ParseWithLength(json, len);
    if (!o) {
        send_error(b, "bad_request", "invalid JSON", -1);
        return;
    }
    double v;
    const char *type = get_string(o, "type");
    if (!get_number(o, "v", &v) || v != 1 || !type) {
        send_error(b, "bad_request", "unsupported protocol version or missing type", -1);
    } else if (strcmp(type, "hello") == 0) {
        send_device(b);
    } else if (strcmp(type, "scan") == 0) {
        handle_scan_msg(b, o);
    } else if (strcmp(type, "cancel") == 0) {
        handle_cancel(b, o);
    } else if (strcmp(type, "raw") == 0) {
        handle_raw_msg(b, o);
    } else if (strcmp(type, "wifi.set") == 0) {
        handle_wifi(b, o);
    } else if (strcmp(type, "ota.begin") == 0) {
        send_error(b, "internal", "Updates over Wi-Fi aren't supported yet.", -1);
    } else {
        send_error(b, "bad_request", "unknown message type", -1);
    }
    cJSON_Delete(o);
}
