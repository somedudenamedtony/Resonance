// Unit tests for the bridge core. Run with ctest, or ./core_tests directly.
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "fake_nanovna.h"
#include "rc_bridge.h"
#include "rc_scan.h"
#include "rc_shell.h"

static int g_failures = 0;
static int g_checks = 0;

#define CHECK(cond)                                                              \
    do {                                                                         \
        g_checks++;                                                              \
        if (!(cond)) {                                                           \
            g_failures++;                                                        \
            fprintf(stderr, "  FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);   \
        }                                                                        \
    } while (0)

#define RUN(fn)                          \
    do {                                 \
        int before = g_failures;         \
        fn();                            \
        printf("%s %s\n", g_failures == before ? "ok  " : "FAIL", #fn); \
    } while (0)

// ---------------------------------------------------------------- shell

typedef struct {
    char written[256];
    size_t wlen;
    int calls;
    rc_shell_status_t st;
    char body[512];
    size_t blen;
    bool is_text;
} shell_ctx_t;

static void sh_write(void *io, const uint8_t *d, size_t n)
{
    shell_ctx_t *c = io;
    memcpy(c->written + c->wlen, d, n);
    c->wlen += n;
}

static void sh_done(void *ctx, rc_shell_status_t st, const uint8_t *body, size_t len, bool is_text)
{
    shell_ctx_t *c = ctx;
    c->calls++;
    c->st = st;
    c->blen = len < sizeof c->body ? len : sizeof c->body;
    if (body) memcpy(c->body, body, c->blen);
    c->is_text = is_text;
}

static void feed_str(rc_shell_t *sh, const char *s)
{
    rc_shell_feed(sh, (const uint8_t *)s, strlen(s));
}

static void test_shell_text_response(void)
{
    static uint8_t buf[1024];
    shell_ctx_t c = {0};
    rc_shell_t sh;
    rc_shell_init(&sh, buf, sizeof buf, sh_write, &c);
    CHECK(rc_shell_send(&sh, "version", RC_RESP_TEXT, 0, 0, 0, 1000, sh_done, &c));
    CHECK(c.wlen == 8 && memcmp(c.written, "version\r", 8) == 0);
    CHECK(!rc_shell_send(&sh, "info", RC_RESP_TEXT, 0, 0, 0, 1000, sh_done, &c));  // busy
    // Stray prompt from before the command, then the echo arriving in pieces.
    feed_str(&sh, "ch> ver");
    feed_str(&sh, "sion\r\n1.2.40\r");
    CHECK(c.calls == 0);
    feed_str(&sh, "\nch> ");
    CHECK(c.calls == 1);
    CHECK(c.st == RC_SHELL_OK);
    CHECK(c.blen == 8 && memcmp(c.body, "1.2.40\r\n", 8) == 0);
    CHECK(!sh.busy);
}

static void test_shell_binary_with_prompt_bytes_inside(void)
{
    static uint8_t buf[1024];
    shell_ctx_t c = {0};
    rc_shell_t sh;
    rc_shell_init(&sh, buf, sizeof buf, sh_write, &c);
    uint16_t mask = 0x80 | 0x02;  // S11 only, binary: 8 bytes per point
    CHECK(rc_shell_send(&sh, "scan 1 2 2 130", RC_RESP_SCAN_BIN, mask, 2, 0, 1000, sh_done, &c));
    uint8_t resp[64];
    size_t n = 0;
    memcpy(resp, "scan 1 2 2 130\r\n", 16);
    n = 16;
    resp[n++] = (uint8_t)mask;
    resp[n++] = 0;
    resp[n++] = 2;
    resp[n++] = 0;
    memcpy(resp + n, "ch> ch> ", 8);  // record data that looks like prompts
    n += 8;
    memcpy(resp + n, "abcdefgh", 8);
    n += 8;
    rc_shell_feed(&sh, resp, n);
    CHECK(c.calls == 0);  // must not stop at the fake prompts
    feed_str(&sh, "ch> ");
    CHECK(c.calls == 1 && c.st == RC_SHELL_OK && !c.is_text);
    CHECK(c.blen == 20);
}

static void test_shell_binary_answered_with_text(void)
{
    static uint8_t buf[1024];
    shell_ctx_t c = {0};
    rc_shell_t sh;
    rc_shell_init(&sh, buf, sizeof buf, sh_write, &c);
    CHECK(rc_shell_send(&sh, "scan 9 1 5 131", RC_RESP_SCAN_BIN, 131, 5, 0, 1000, sh_done, &c));
    feed_str(&sh, "scan 9 1 5 131\r\nfrequency range is invalid\r\nch> ");
    CHECK(c.calls == 1 && c.is_text);
    CHECK(strncmp(c.body, "frequency range is invalid", 26) == 0);
}

static void test_shell_timeout_and_abort(void)
{
    static uint8_t buf[256];
    shell_ctx_t c = {0};
    rc_shell_t sh;
    rc_shell_init(&sh, buf, sizeof buf, sh_write, &c);
    CHECK(rc_shell_send(&sh, "info", RC_RESP_TEXT, 0, 0, 100, 500, sh_done, &c));
    rc_shell_tick(&sh, 599);
    CHECK(c.calls == 0);
    rc_shell_tick(&sh, 600);
    CHECK(c.calls == 1 && c.st == RC_SHELL_TIMEOUT);
    CHECK(rc_shell_send(&sh, "info", RC_RESP_TEXT, 0, 0, 0, 500, sh_done, &c));
    rc_shell_abort(&sh);
    CHECK(c.calls == 2 && c.st == RC_SHELL_ABORTED && !sh.busy);
    CHECK(!rc_shell_send(&sh, "this command is far too long for the nanovna shell line buffer!!!", RC_RESP_TEXT, 0, 0,
                         0, 500, sh_done, &c));
}

// ---------------------------------------------------------------- scan

static void test_segments_cover_sweep_exactly(void)
{
    uint32_t start = 13850000, stop = 14500000, points = 201;
    uint16_t n = rc_scan_segment_count(points, 101);
    CHECK(n == 2);
    uint32_t next = 0;
    for (uint16_t k = 0; k < n; k++) {
        rc_segment_t s = rc_scan_segment(start, stop, points, n, k);
        CHECK(s.offset == next);
        CHECK(s.count >= 2 && s.count <= 101);
        CHECK(s.start_hz == rc_scan_freq(start, stop, points, s.offset));
        CHECK(s.stop_hz == rc_scan_freq(start, stop, points, s.offset + s.count - 1));
        next += s.count;
    }
    CHECK(next == points);
    CHECK(rc_scan_segment_count(401, 401) == 1);
    CHECK(rc_scan_segment_count(402, 401) == 2);
    CHECK(rc_scan_freq(1000, 2000, 3, 1) == 1500);
    CHECK(rc_scan_freq(1000, 2000, 3, 2) == 2000);
}

static void test_mask(void)
{
    CHECK(rc_scan_mask(false, false) == 0x1b);
    CHECK(rc_scan_mask(false, true) == 0x9b);
    CHECK(rc_scan_mask(true, true) == 0xbf);
}

static void test_parse_text_and_bin(void)
{
    rc_point_t p[4];
    const char *t = "14000000 0.250000 -0.500000 \r\n14100000 0.125000 0.750000 \r\n";
    CHECK(rc_scan_parse_text(t, strlen(t), 0x1b, p, 4) == 2);
    CHECK(p[1].freq_hz == 14100000.0 && fabsf(p[1].s11_im - 0.75f) < 1e-6f);
    CHECK(rc_scan_parse_text("garbage\r\n", 9, 0x1b, p, 4) == -1);
    CHECK(rc_scan_parse_text("usage: scan\r\n", 13, 0x1b, p, 4) == -1);

    uint8_t b[4 + 2 * 12];
    uint16_t mask = 0x83;
    b[0] = (uint8_t)mask;
    b[1] = 0;
    b[2] = 2;
    b[3] = 0;
    uint32_t f0 = 7000000, f1 = 7300000;
    float v[4] = {0.5f, -0.25f, 0.125f, 1.0f};
    memcpy(b + 4, &f0, 4);
    memcpy(b + 8, &v[0], 8);
    memcpy(b + 16, &f1, 4);
    memcpy(b + 20, &v[2], 8);
    CHECK(rc_scan_parse_bin(b, sizeof b, p, 4) == 2);
    CHECK(p[0].freq_hz == 7000000.0 && p[0].s11_im == -0.25f && p[1].s11_im == 1.0f);
    CHECK(rc_scan_parse_bin(b, sizeof b - 1, p, 4) == -1);
}

static void test_frame_layout(void)
{
    rc_point_t pts[2] = {{14000000.0, 0.25f, -0.5f, 0, 0}, {14350000.0, -0.125f, 0.75f, 0, 0}};
    uint8_t out[64];
    size_t n = rc_frame_encode(out, sizeof out, 513, 40, false, pts, 2);
    CHECK(n == 8 + 32);
    CHECK(out[0] == 0x01 && out[1] == 0x00);
    CHECK(out[2] == 0x01 && out[3] == 0x02);  // 513 LE
    CHECK(out[4] == 40 && out[5] == 0 && out[6] == 2 && out[7] == 0);
    double f;
    memcpy(&f, out + 8 + 16, 8);
    CHECK(f == 14350000.0);
    float im;
    memcpy(&im, out + 8 + 16 + 12, 4);
    CHECK(im == 0.75f);
    CHECK(rc_frame_max_records(false) == 255 && rc_frame_max_records(true) == 170);
    CHECK(rc_frame_encode(out, 10, 1, 0, false, pts, 2) == 0);
}

static void test_parse_info(void)
{
    char model[48] = {0};
    uint16_t maxp = 101, w = 320, hh = 240;
    rc_bridge_parse_info("Board: NanoVNA-H 4\r\nVersion: 1.2.40 [p:401, IF:12k, Lcd:480x320]\r\n", model, sizeof model,
                         &maxp, &w, &hh);
    CHECK(strcmp(model, "NanoVNA-H 4") == 0);
    CHECK(maxp == 401);
    CHECK(w == 480 && hh == 320);
    maxp = 101;
    model[0] = 0;
    w = 320;
    hh = 240;
    rc_bridge_parse_info("Kernel: 4.0.0\r\n", model, sizeof model, &maxp, &w, &hh);
    CHECK(model[0] == 0 && maxp == 101 && w == 320 && hh == 240);
}

// ---------------------------------------------------------------- bridge + fake device

typedef struct {
    rc_bridge_t *b;
    fake_nanovna_t dev;
    bool attached;
    uint32_t now;
    char texts[64][512];
    int ntexts;
    rc_point_t pts[2048];
    uint32_t npts;
    int frames;
    bool frame_order_ok;
    uint8_t cap[4096];
    uint32_t cap_len;
    bool cap_order_ok;
    size_t chunk;  // deliver device output in chunks of this size
} harness_t;

static void h_serial_write(void *u, const uint8_t *d, size_t n)
{
    harness_t *h = u;
    if (h->attached) fake_input(&h->dev, d, n);
}

static void h_send_text(void *u, const char *json)
{
    harness_t *h = u;
    if (h->ntexts < 64) snprintf(h->texts[h->ntexts++], 512, "%s", json);
}

static void h_send_binary(void *u, const uint8_t *d, size_t n)
{
    harness_t *h = u;
    if (d[0] == RC_FRAME_CAPTURE) {
        uint32_t off = (uint32_t)d[4] | ((uint32_t)d[5] << 8) | ((uint32_t)d[6] << 16) | ((uint32_t)d[7] << 24);
        if (off != h->cap_len) h->cap_order_ok = false;
        size_t k = n - 8;
        if (h->cap_len + k <= sizeof h->cap) memcpy(h->cap + h->cap_len, d + 8, k);
        h->cap_len += (uint32_t)k;
        return;
    }
    h->frames++;
    uint16_t offset = (uint16_t)(d[4] | (d[5] << 8));
    uint16_t count = (uint16_t)(d[6] | (d[7] << 8));
    if (offset != h->npts) h->frame_order_ok = false;
    for (uint16_t i = 0; i < count && h->npts < 2048; i++) {
        const uint8_t *r = d + 8 + i * 16;
        rc_point_t *p = &h->pts[h->npts++];
        memcpy(&p->freq_hz, r, 8);
        memcpy(&p->s11_re, r + 8, 4);
        memcpy(&p->s11_im, r + 12, 4);
    }
}

static harness_t *h_new(bool binary, uint16_t max_points)
{
    harness_t *h = calloc(1, sizeof *h);
    h->b = calloc(1, sizeof *h->b);
    h->frame_order_ok = true;
    h->cap_order_ok = true;
    h->chunk = 37;
    rc_bridge_io_t io = {h_serial_write, h_send_text, h_send_binary, NULL, NULL, h};
    rc_bridge_init(h->b, &io, 0);
    fake_init(&h->dev, binary, max_points);
    return h;
}

static void h_free(harness_t *h)
{
    free(h->b);
    free(h);
}

// Advance time, delivering device output in small chunks.
static void h_run(harness_t *h, uint32_t ms)
{
    for (uint32_t t = 0; t < ms; t += 10) {
        h->now += 10;
        while (h->attached && h->dev.out_len > 0) {
            uint8_t tmp[65536];
            size_t n = h->dev.out_len;
            memcpy(tmp, h->dev.out, n);
            h->dev.out_len = 0;
            for (size_t i = 0; i < n; i += h->chunk) {
                size_t k = n - i < h->chunk ? n - i : h->chunk;
                rc_bridge_serial_rx(h->b, tmp + i, k, h->now);
            }
        }
        rc_bridge_tick(h->b, h->now);
    }
}

static void h_attach(harness_t *h)
{
    h->attached = true;
    rc_bridge_device_attached(h->b, h->now);
    h_run(h, 1000);
}

static void h_client(harness_t *h, const char *json)
{
    rc_bridge_client_text(h->b, json, strlen(json), h->now);
}

// Find the last text message of a type; returns parsed JSON (caller deletes) or NULL.
static cJSON *h_last(harness_t *h, const char *type)
{
    for (int i = h->ntexts - 1; i >= 0; i--) {
        cJSON *o = cJSON_Parse(h->texts[i]);
        const cJSON *t = cJSON_GetObjectItem(o, "type");
        if (cJSON_IsString(t) && strcmp(t->valuestring, type) == 0) return o;
        cJSON_Delete(o);
    }
    return NULL;
}

static double num(const cJSON *o, const char *k)
{
    const cJSON *v = cJSON_GetObjectItem(o, k);
    return cJSON_IsNumber(v) ? v->valuedouble : NAN;
}

static const char *str(const cJSON *o, const char *k)
{
    const cJSON *v = cJSON_GetObjectItem(o, k);
    return cJSON_IsString(v) ? v->valuestring : "";
}

static void test_bridge_probe_binary_device(void)
{
    harness_t *h = h_new(true, 401);
    h_client(h, "{\"v\":1,\"type\":\"hello\",\"appVersion\":\"t\"}");
    cJSON *d = h_last(h, "device");
    CHECK(d && cJSON_IsFalse(cJSON_GetObjectItem(d, "connected")));
    cJSON_Delete(d);

    h_attach(h);
    CHECK(h->b->dev == RC_DEV_READY);
    CHECK(h->b->binary);
    d = h_last(h, "device");
    CHECK(d && cJSON_IsTrue(cJSON_GetObjectItem(d, "connected")));
    CHECK(strcmp(str(d, "model"), "NanoVNA-H 4") == 0);
    CHECK(strcmp(str(d, "firmware"), "1.2.40-fake") == 0);
    CHECK(num(d, "maxPoints") == 401);
    cJSON_Delete(d);
    h_free(h);
}

static void check_full_scan(harness_t *h, uint32_t start, uint32_t stop, uint32_t points)
{
    char req[160];
    snprintf(req, sizeof req, "{\"v\":1,\"type\":\"scan\",\"id\":7,\"startHz\":%u,\"stopHz\":%u,\"points\":%u,\"ports\":\"s11\"}",
             start, stop, points);
    h_client(h, req);
    h_run(h, 3000);
    cJSON *end = h_last(h, "scan.end");
    CHECK(end != NULL);
    CHECK(end && num(end, "id") == 7);
    cJSON_Delete(end);
    CHECK(h->npts == points);
    CHECK(h->frame_order_ok);
    bool freqs_ok = true, data_ok = true;
    for (uint32_t i = 0; i < h->npts; i++) {
        double want = rc_scan_freq(start, stop, points, i);
        if (fabs(h->pts[i].freq_hz - want) > 1.0) freqs_ok = false;
        float re, im;
        fake_s11(h->pts[i].freq_hz, &re, &im);
        if (fabsf(h->pts[i].s11_re - re) > 1e-5f || fabsf(h->pts[i].s11_im - im) > 1e-5f) data_ok = false;
    }
    CHECK(freqs_ok);
    CHECK(data_ok);
}

static void test_bridge_scan_binary_single_segment(void)
{
    harness_t *h = h_new(true, 401);
    h_attach(h);
    check_full_scan(h, 13850000, 14500000, 201);
    CHECK(h->dev.scans == 1);
    CHECK(strstr(h->dev.last_cmd, " 155") != NULL);  // 0x9b: freq, s11, no cal, no edelay, binary
    h_free(h);
}

static void test_bridge_scan_text_segmented(void)
{
    harness_t *h = h_new(false, 101);  // classic firmware: 101 points, text only
    h_attach(h);
    CHECK(!h->b->binary && h->b->max_points == 101);
    check_full_scan(h, 6800000, 7500000, 301);
    CHECK(h->dev.scans == 3);
    CHECK(strstr(h->dev.last_cmd, " 27") != NULL);  // 0x1b text
    h_free(h);
}

static void test_bridge_large_scan_many_frames(void)
{
    harness_t *h = h_new(true, 401);
    h_attach(h);
    check_full_scan(h, 1000000, 30000000, 1001);
    CHECK(h->dev.scans == 3);
    CHECK(h->frames >= 4);  // 1001 points need at least 4 frames of 255
    h_free(h);
}

static void test_bridge_errors(void)
{
    harness_t *h = h_new(true, 401);
    h_client(h, "{\"v\":1,\"type\":\"scan\",\"id\":1,\"startHz\":1000000,\"stopHz\":2000000,\"points\":11}");
    cJSON *e = h_last(h, "error");
    CHECK(e && strcmp(str(e, "code"), "no_device") == 0 && num(e, "id") == 1);
    cJSON_Delete(e);

    h_attach(h);
    h_client(h, "{not json");
    e = h_last(h, "error");
    CHECK(e && strcmp(str(e, "code"), "bad_request") == 0);
    cJSON_Delete(e);

    h_client(h, "{\"v\":2,\"type\":\"hello\"}");
    e = h_last(h, "error");
    CHECK(e && strcmp(str(e, "code"), "bad_request") == 0);
    cJSON_Delete(e);

    h_client(h, "{\"v\":1,\"type\":\"scan\",\"id\":2,\"startHz\":2000000,\"stopHz\":1000000,\"points\":11}");
    e = h_last(h, "error");
    CHECK(e && strcmp(str(e, "code"), "bad_request") == 0 && num(e, "id") == 2);
    cJSON_Delete(e);

    // Busy: second scan while the first is running.
    h->ntexts = 0;
    h_client(h, "{\"v\":1,\"type\":\"scan\",\"id\":3,\"startHz\":1000000,\"stopHz\":2000000,\"points\":101}");
    h_client(h, "{\"v\":1,\"type\":\"scan\",\"id\":4,\"startHz\":1000000,\"stopHz\":2000000,\"points\":101}");
    e = h_last(h, "error");
    CHECK(e && strcmp(str(e, "code"), "busy") == 0 && num(e, "id") == 4);
    cJSON_Delete(e);
    h_run(h, 1000);
    e = h_last(h, "scan.end");
    CHECK(e && num(e, "id") == 3);
    cJSON_Delete(e);
    h_free(h);
}

static void test_bridge_cancel_then_rescan(void)
{
    harness_t *h = h_new(true, 401);
    h_attach(h);
    h_client(h, "{\"v\":1,\"type\":\"scan\",\"id\":10,\"startHz\":1000000,\"stopHz\":30000000,\"points\":1001}");
    h_client(h, "{\"v\":1,\"type\":\"cancel\",\"id\":10}");
    cJSON *e = h_last(h, "scan.end");
    CHECK(e && num(e, "id") == 10 && cJSON_IsTrue(cJSON_GetObjectItem(e, "cancelled")));
    cJSON_Delete(e);
    // Rescan immediately: queued behind the draining cancelled scan.
    h->npts = 0;
    h->frames = 0;
    h_client(h, "{\"v\":1,\"type\":\"scan\",\"id\":11,\"startHz\":14000000,\"stopHz\":14350000,\"points\":201}");
    h_run(h, 2000);
    e = h_last(h, "scan.end");
    CHECK(e && num(e, "id") == 11);
    cJSON_Delete(e);
    CHECK(h->npts == 201);
    CHECK(h->frame_order_ok);
    h_free(h);
}

static void test_bridge_detach_mid_scan(void)
{
    harness_t *h = h_new(true, 401);
    h_attach(h);
    h->dev.silent = true;  // device stops answering, then gets unplugged
    h_client(h, "{\"v\":1,\"type\":\"scan\",\"id\":20,\"startHz\":1000000,\"stopHz\":2000000,\"points\":101}");
    h_run(h, 50);
    h->attached = false;
    rc_bridge_device_detached(h->b, h->now);
    cJSON *e = h_last(h, "error");
    CHECK(e && strcmp(str(e, "code"), "no_device") == 0 && num(e, "id") == 20);
    cJSON_Delete(e);
    cJSON *d = h_last(h, "device");
    CHECK(d && cJSON_IsFalse(cJSON_GetObjectItem(d, "connected")));
    cJSON_Delete(d);
    CHECK(h->b->job == RC_JOB_NONE && !h->b->shell.busy);
    h_free(h);
}

static void test_bridge_timeout_then_recovers(void)
{
    harness_t *h = h_new(true, 401);
    h_attach(h);
    h->dev.silent = true;
    h_client(h, "{\"v\":1,\"type\":\"scan\",\"id\":30,\"startHz\":1000000,\"stopHz\":2000000,\"points\":101}");
    h_run(h, 8000);
    cJSON *e = h_last(h, "error");
    CHECK(e && strcmp(str(e, "code"), "timeout") == 0 && num(e, "id") == 30);
    cJSON_Delete(e);
    cJSON *d = h_last(h, "device");
    CHECK(d && cJSON_IsFalse(cJSON_GetObjectItem(d, "connected")));  // not usable while resyncing
    cJSON_Delete(d);
    h->dev.silent = false;
    h_run(h, 3000);  // re-probe succeeds
    CHECK(h->b->dev == RC_DEV_READY);
    h->npts = 0;
    check_full_scan(h, 14000000, 14350000, 51);
    h_free(h);
}

static void test_bridge_raw(void)
{
    harness_t *h = h_new(true, 401);
    h_attach(h);
    h_client(h, "{\"v\":1,\"type\":\"raw\",\"command\":\"version\"}");
    h_run(h, 200);
    cJSON *r = h_last(h, "raw.reply");
    CHECK(r && strcmp(str(r, "command"), "version") == 0 && strcmp(str(r, "text"), "1.2.40-fake") == 0);
    cJSON_Delete(r);
    h_client(h, "{\"v\":1,\"type\":\"raw\",\"command\":\"bogus\"}");
    h_run(h, 200);
    r = h_last(h, "raw.reply");
    CHECK(r && strcmp(str(r, "text"), "bogus?") == 0);
    cJSON_Delete(r);
    h_client(h, "{\"v\":1,\"type\":\"raw\",\"command\":\"capture\"}");
    r = h_last(h, "error");
    CHECK(r && strcmp(str(r, "code"), "bad_request") == 0);
    cJSON_Delete(r);
    h_free(h);
}

static void test_bridge_capture(void)
{
    harness_t *h = h_new(true, 401);
    h_attach(h);
    CHECK(h->b->lcd_w == 32 && h->b->lcd_h == 24);
    h_client(h, "{\"v\":1,\"type\":\"capture\"}");
    cJSON *b = h_last(h, "capture.begin");
    CHECK(b && num(b, "width") == 32 && num(b, "height") == 24 && strcmp(str(b, "format"), "rgb565be") == 0);
    cJSON_Delete(b);
    h_run(h, 500);
    cJSON *e = h_last(h, "capture.end");
    CHECK(e && num(e, "bytes") == 32 * 24 * 2);
    cJSON_Delete(e);
    CHECK(h->cap_len == 32 * 24 * 2 && h->cap_order_ok);
    bool same = true;
    for (int i = 0; i < 32 * 24 * 2; i++) {
        uint8_t want = (i % 100 < 4) ? (uint8_t)"ch> "[i % 100] : (uint8_t)(i * 7);
        if (h->cap[i] != want) same = false;
    }
    CHECK(same);
    // The shell is free again: a scan works right after.
    h->npts = 0;
    check_full_scan(h, 14000000, 14350000, 51);
    h_free(h);
}

int main(void)
{
    RUN(test_shell_text_response);
    RUN(test_shell_binary_with_prompt_bytes_inside);
    RUN(test_shell_binary_answered_with_text);
    RUN(test_shell_timeout_and_abort);
    RUN(test_segments_cover_sweep_exactly);
    RUN(test_mask);
    RUN(test_parse_text_and_bin);
    RUN(test_frame_layout);
    RUN(test_parse_info);
    RUN(test_bridge_probe_binary_device);
    RUN(test_bridge_scan_binary_single_segment);
    RUN(test_bridge_scan_text_segmented);
    RUN(test_bridge_large_scan_many_frames);
    RUN(test_bridge_errors);
    RUN(test_bridge_cancel_then_rescan);
    RUN(test_bridge_detach_mid_scan);
    RUN(test_bridge_timeout_then_recovers);
    RUN(test_bridge_raw);
    RUN(test_bridge_capture);
    printf("\n%d checks, %d failures\n", g_checks, g_failures);
    return g_failures ? 1 : 0;
}
