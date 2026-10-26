#include "rc_bridge.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "rc_update.h"

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

static const char *wifi_state_name(rc_wifi_state_t s)
{
    switch (s) {
    case RC_WIFI_CONNECTING:
        return "connecting";
    case RC_WIFI_CONNECTED:
        return "connected";
    case RC_WIFI_FAILED:
        return "failed";
    case RC_WIFI_OFF:
        break;
    }
    return "off";
}

static void send_wifi(rc_bridge_t *b, const rc_wifi_status_t *st)
{
    cJSON *o = msg("wifi");
    bool sta = st->ssid[0] != 0;
    cJSON_AddStringToObject(o, "mode", sta ? "sta" : "ap");
    cJSON_AddStringToObject(o, "apSsid", st->ap_ssid);
    if (sta) {
        cJSON_AddStringToObject(o, "ssid", st->ssid);
        cJSON_AddStringToObject(o, "state", wifi_state_name(st->state));
        if (st->state == RC_WIFI_CONNECTED) {
            cJSON_AddStringToObject(o, "ip", st->ip);
            if (st->rssi) cJSON_AddNumberToObject(o, "rssi", st->rssi);
        }
        if (st->reason[0] && st->state != RC_WIFI_CONNECTED) cJSON_AddStringToObject(o, "reason", st->reason);
    }
    send_json(b, o);
}

// Ask the platform for the Wi-Fi status; send it if `force`, or if it changed since last sent.
// Signal strength alone doesn't count as a change, so the app isn't flooded with updates.
static void poll_wifi(rc_bridge_t *b, bool force)
{
    if (!b->io.wifi_status) return;
    rc_wifi_status_t st;
    memset(&st, 0, sizeof st);
    b->io.wifi_status(b->io.user, &st);
    st.ap_ssid[sizeof st.ap_ssid - 1] = 0;
    st.ssid[sizeof st.ssid - 1] = 0;
    st.ip[sizeof st.ip - 1] = 0;
    st.reason[sizeof st.reason - 1] = 0;
    const rc_wifi_status_t *w = &b->wifi;
    bool changed = !b->wifi_sent || st.state != w->state || strcmp(st.ap_ssid, w->ap_ssid) != 0 ||
                   strcmp(st.ssid, w->ssid) != 0 || strcmp(st.ip, w->ip) != 0 || strcmp(st.reason, w->reason) != 0;
    b->wifi = st;
    b->wifi_sent = true;
    b->wifi_next_ms = b->now + RC_WIFI_POLL_MS;
    if (force || changed) send_wifi(b, &st);
}

static const char *update_state_name(rc_update_state_t s)
{
    switch (s) {
    case RC_UPDATE_CHECKING:
        return "checking";
    case RC_UPDATE_CURRENT:
        return "current";
    case RC_UPDATE_AVAILABLE:
        return "available";
    case RC_UPDATE_INSTALLING:
        return "installing";
    case RC_UPDATE_DONE:
        return "done";
    case RC_UPDATE_FAILED:
        return "failed";
    case RC_UPDATE_IDLE:
        break;
    }
    return "idle";
}

static void send_update(rc_bridge_t *b, const rc_update_status_t *st)
{
    cJSON *o = msg("update");
    cJSON_AddStringToObject(o, "state", update_state_name(st->state));
    cJSON_AddStringToObject(o, "current", RC_BRIDGE_VERSION);
    if (st->latest[0]) cJSON_AddStringToObject(o, "latest", st->latest);
    if (st->state == RC_UPDATE_INSTALLING) {
        cJSON_AddStringToObject(o, "step", st->step);
        cJSON_AddNumberToObject(o, "received", st->received);
        cJSON_AddNumberToObject(o, "total", st->total);
    }
    if (st->state == RC_UPDATE_FAILED && st->message[0]) cJSON_AddStringToObject(o, "message", st->message);
    if (st->rolled_back[0]) cJSON_AddStringToObject(o, "rolledBack", st->rolled_back);
    send_json(b, o);
}

// Same idea as poll_wifi, for the release update. Progress counts as a change.
static void poll_update(rc_bridge_t *b, bool force)
{
    if (!b->io.update_status) return;
    rc_update_status_t st;
    memset(&st, 0, sizeof st);
    b->io.update_status(b->io.user, &st);
    st.latest[sizeof st.latest - 1] = 0;
    st.step[sizeof st.step - 1] = 0;
    st.message[sizeof st.message - 1] = 0;
    st.rolled_back[sizeof st.rolled_back - 1] = 0;
    const rc_update_status_t *u = &b->update;
    bool changed = !b->update_sent || st.state != u->state || st.received != u->received || st.total != u->total ||
                   strcmp(st.latest, u->latest) != 0 || strcmp(st.step, u->step) != 0 ||
                   strcmp(st.message, u->message) != 0 || strcmp(st.rolled_back, u->rolled_back) != 0;
    b->update = st;
    b->update_sent = true;
    if (force || changed) send_update(b, &st);
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

void rc_bridge_parse_info(const char *text, char *model, size_t model_cap, uint16_t *max_points, uint16_t *lcd_w,
                          uint16_t *lcd_h)
{
    const char *lcd = strstr(text, "Lcd:");
    if (lcd) {
        char *end;
        long w = strtol(lcd + 4, &end, 10);
        if (*end == 'x') {
            long h = strtol(end + 1, NULL, 10);
            if (w > 0 && w <= 2048 && h > 0 && h <= 2048) {
                *lcd_w = (uint16_t)w;
                *lcd_h = (uint16_t)h;
            }
        }
    }
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
    b->lcd_w = 320;  // original NanoVNA screen; NanoVNA-D reports its size in `info`
    b->lcd_h = 240;
    logf_(b, "NanoVNA attached, probing");
    // Give the device a moment to print its banner before we press Enter.
    start_probe(b, 200);
}

static void fail_active_job(rc_bridge_t *b, const char *code, const char *message)
{
    if (b->job == RC_JOB_SCAN && !b->scan_cancelled) send_error(b, code, message, b->scan.id);
    if (b->job == RC_JOB_RAW || b->job == RC_JOB_CAPTURE) send_error(b, code, message, -1);
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
    poll_wifi(b, true);
    poll_update(b, true);
}

static void ota_fail(rc_bridge_t *b, const char *code, const char *message);

void rc_bridge_tick(rc_bridge_t *b, uint32_t now_ms)
{
    b->now = now_ms;
    if (b->ota_active && (uint32_t)(now_ms - b->ota_last_ms) > RC_OTA_IDLE_TIMEOUT_MS) {
        ota_fail(b, "timeout", "The update stalled and was cancelled. Nothing was changed.");
    }
    rc_shell_tick(&b->shell, now_ms);
    pump(b);
    if ((int32_t)(now_ms - b->wifi_next_ms) >= 0) {
        poll_wifi(b, false);
        poll_update(b, false);
        b->wifi_next_ms = now_ms + RC_WIFI_POLL_MS;
    }
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
        rc_bridge_parse_info(text, b->model, sizeof b->model, &b->max_points, &b->lcd_w, &b->lcd_h);
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

static void flush_capture(rc_bridge_t *b)
{
    if (b->cap_fill == 0) return;
    uint8_t *f = b->frame;
    f[0] = RC_FRAME_CAPTURE;
    f[1] = 0;
    f[2] = 0;
    f[3] = 0;
    for (int i = 0; i < 4; i++) f[4 + i] = (uint8_t)(b->cap_offset >> (8 * i));
    b->io.send_binary(b->io.user, f, RC_FRAME_HEADER + b->cap_fill);
    b->cap_offset += (uint32_t)b->cap_fill;
    b->cap_fill = 0;
}

static void on_capture_bytes(void *ctx, const uint8_t *data, size_t len, size_t offset)
{
    rc_bridge_t *b = ctx;
    const size_t room = RC_FRAME_MAX - RC_FRAME_HEADER;
    while (len > 0) {
        size_t n = room - b->cap_fill < len ? room - b->cap_fill : len;
        memcpy(b->frame + RC_FRAME_HEADER + b->cap_fill, data, n);
        b->cap_fill += n;
        data += n;
        len -= n;
        if (b->cap_fill == room) flush_capture(b);
    }
}

static void handle_capture_done(rc_bridge_t *b, rc_shell_status_t st, bool is_text)
{
    b->job = RC_JOB_NONE;
    if (st == RC_SHELL_TIMEOUT) {
        send_error(b, "timeout", "The NanoVNA didn't send its screen.", -1);
        start_probe(b, PROBE_RETRY_MS);
        return;
    }
    if (st != RC_SHELL_OK || is_text) {
        send_error(b, "internal", "The screen capture didn't come through cleanly.", -1);
        return;
    }
    flush_capture(b);
    cJSON *o = msg("capture.end");
    cJSON_AddNumberToObject(o, "bytes", b->cap_offset);
    send_json(b, o);
}

static void on_shell_done(void *ctx, rc_shell_status_t st, const uint8_t *body, size_t len, bool is_text)
{
    rc_bridge_t *b = ctx;
    if (st == RC_SHELL_ABORTED) return;  // detach handles reporting
    if (b->job == RC_JOB_CAPTURE) {
        handle_capture_done(b, st, is_text);
        return;
    }

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
    case RC_JOB_CAPTURE:  // handled above
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

static void handle_capture_msg(rc_bridge_t *b)
{
    if (b->dev != RC_DEV_READY) {
        send_error(b, "no_device", "NanoVNA not detected.", -1);
        return;
    }
    if (b->shell.busy || b->job != RC_JOB_NONE) {
        send_error(b, "busy", "The NanoVNA is busy. Try again in a moment.", -1);
        return;
    }
    size_t bytes = (size_t)b->lcd_w * b->lcd_h * 2;
    b->job = RC_JOB_CAPTURE;
    b->cap_fill = 0;
    b->cap_offset = 0;
    if (!rc_shell_send_stream(&b->shell, "capture", bytes, b->now, 4000 + (uint32_t)(bytes / 50), on_capture_bytes,
                              on_shell_done, b)) {
        b->job = RC_JOB_NONE;
        send_error(b, "busy", "The NanoVNA is busy. Try again in a moment.", -1);
        return;
    }
    cJSON *o = msg("capture.begin");
    cJSON_AddNumberToObject(o, "width", b->lcd_w);
    cJSON_AddNumberToObject(o, "height", b->lcd_h);
    cJSON_AddStringToObject(o, "format", "rgb565be");
    send_json(b, o);
}

// ---------- updates over Wi-Fi ----------

static void ota_fail(rc_bridge_t *b, const char *code, const char *message)
{
    if (b->ota_active && b->io.ota_abort) b->io.ota_abort(b->io.user);
    b->ota_active = false;
    send_error(b, code, message, -1);
    logf_(b, "update failed: %s", message);
}

static void handle_ota_begin(rc_bridge_t *b, const cJSON *o)
{
    double size;
    const char *target = get_string(o, "target");
    if (!target || (strcmp(target, "firmware") != 0 && strcmp(target, "app") != 0) || !get_number(o, "size", &size) ||
        size < 1 || size > RC_OTA_MAX_SIZE || size != floor(size)) {
        send_error(b, "bad_request", "ota.begin needs target firmware or app and a size", -1);
        return;
    }
    if (!b->io.ota_begin || !b->io.ota_write || !b->io.ota_end) {
        send_error(b, "internal", "This bridge can't update over Wi-Fi.", -1);
        return;
    }
    if (b->ota_active && b->io.ota_abort) b->io.ota_abort(b->io.user);  // a new begin replaces a stalled one
    b->ota_active = false;
    char err[96] = "";
    if (!b->io.ota_begin(b->io.user, target, (uint32_t)size, err, sizeof err)) {
        send_error(b, "internal", err[0] ? err : "Couldn't start the update.", -1);
        return;
    }
    snprintf(b->ota_target, sizeof b->ota_target, "%s", target);
    b->ota_active = true;
    b->ota_size = (uint32_t)size;
    b->ota_received = 0;
    b->ota_last_ms = b->now;
    logf_(b, "update started: %s, %lu bytes", target, (unsigned long)b->ota_size);
    cJSON *r = msg("ok");
    cJSON_AddStringToObject(r, "for", "ota.begin");
    send_json(b, r);
}

void rc_bridge_client_binary(rc_bridge_t *b, const uint8_t *data, size_t len, uint32_t now_ms)
{
    b->now = now_ms;
    if (len < RC_FRAME_HEADER || data[0] != RC_FRAME_OTA) return;  // nothing else is sent app → bridge
    if (!b->ota_active) {
        send_error(b, "bad_request", "No update in progress. Send ota.begin first.", -1);
        return;
    }
    uint32_t offset = (uint32_t)data[4] | ((uint32_t)data[5] << 8) | ((uint32_t)data[6] << 16) | ((uint32_t)data[7] << 24);
    const uint8_t *chunk = data + RC_FRAME_HEADER;
    size_t n = len - RC_FRAME_HEADER;
    if (offset != b->ota_received) {
        ota_fail(b, "bad_request", "Update data arrived out of order. Nothing was changed.");
        return;
    }
    if (n == 0 || offset + n > b->ota_size) {
        ota_fail(b, "bad_request", "The update is larger than announced.");
        return;
    }
    if (offset == 0 && !rc_image_magic_ok(b->ota_target, chunk, n)) {
        ota_fail(b, "bad_request",
                 strcmp(b->ota_target, "firmware") == 0 ? "That isn't an ESP32 firmware image (resonance-bridge.bin)."
                                                       : "That isn't a LittleFS web app image (littlefs.bin).");
        return;
    }
    char err[96] = "";
    if (!b->io.ota_write(b->io.user, chunk, n, err, sizeof err)) {
        ota_fail(b, "internal", err[0] ? err : "Writing the update failed. Nothing was changed.");
        return;
    }
    b->ota_received += (uint32_t)n;
    b->ota_last_ms = now_ms;
    cJSON *ack = msg("ota.ack");
    cJSON_AddNumberToObject(ack, "received", b->ota_received);
    send_json(b, ack);
    if (b->ota_received == b->ota_size) {
        b->ota_active = false;
        if (!b->io.ota_end(b->io.user, err, sizeof err)) {
            send_error(b, "internal", err[0] ? err : "The update didn't verify. Nothing was changed.", -1);
            return;
        }
        logf_(b, "update finished: %s", b->ota_target);
        cJSON *r = msg("ok");
        cJSON_AddStringToObject(r, "for", "ota.end");
        send_json(b, r);
    }
}

// update.check / update.install: the platform does the work and reports through `update`.
static void handle_update(rc_bridge_t *b, bool install)
{
    bool (*fn)(void *, char *, size_t) = install ? b->io.update_install : b->io.update_check;
    if (!fn || !b->io.update_status) {
        send_error(b, "internal", "This bridge can't update from GitHub. Install the update from a file.", -1);
        return;
    }
    if (install && b->ota_active) {
        send_error(b, "busy", "An update from a file is already running.", -1);
        return;
    }
    char err[96] = "";
    if (!fn(b->io.user, err, sizeof err)) {
        send_error(b, "busy", err[0] ? err : "An update is already running.", -1);
        return;
    }
    poll_update(b, true);
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
        poll_wifi(b, true);
        poll_update(b, true);
    } else if (strcmp(type, "scan") == 0) {
        handle_scan_msg(b, o);
    } else if (strcmp(type, "cancel") == 0) {
        handle_cancel(b, o);
    } else if (strcmp(type, "raw") == 0) {
        handle_raw_msg(b, o);
    } else if (strcmp(type, "capture") == 0) {
        handle_capture_msg(b);
    } else if (strcmp(type, "wifi.set") == 0) {
        handle_wifi(b, o);
    } else if (strcmp(type, "ota.begin") == 0) {
        handle_ota_begin(b, o);
    } else if (strcmp(type, "update.check") == 0) {
        handle_update(b, false);
    } else if (strcmp(type, "update.install") == 0) {
        handle_update(b, true);
    } else {
        send_error(b, "bad_request", "unknown message type", -1);
    }
    cJSON_Delete(o);
}
