#include "fake_nanovna.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void out(fake_nanovna_t *f, const void *data, size_t len)
{
    if (f->out_len + len > sizeof f->out) return;
    memcpy(f->out + f->out_len, data, len);
    f->out_len += len;
}

static void outs(fake_nanovna_t *f, const char *s)
{
    out(f, s, strlen(s));
}

void fake_init(fake_nanovna_t *f, bool binary, uint16_t max_points)
{
    memset(f, 0, sizeof *f);
    f->binary = binary;
    f->max_points = max_points;
    outs(f, "\r\nNanoVNA Shell\r\nch> ");
}

void fake_s11(double f_hz, float *re, float *im)
{
    *re = (float)(0.5 - f_hz * 1e-9);
    *im = (float)(f_hz * 1e-9);
}

static void put_u16(fake_nanovna_t *f, uint16_t v)
{
    uint8_t b[2] = {(uint8_t)v, (uint8_t)(v >> 8)};
    out(f, b, 2);
}

static void put_u32(fake_nanovna_t *f, uint32_t v)
{
    uint8_t b[4] = {(uint8_t)v, (uint8_t)(v >> 8), (uint8_t)(v >> 16), (uint8_t)(v >> 24)};
    out(f, b, 4);
}

static void put_f32(fake_nanovna_t *f, float x)
{
    uint32_t u;
    memcpy(&u, &x, 4);
    put_u32(f, u);
}

static void cmd_scan(fake_nanovna_t *f, int argc, char **argv)
{
    if (argc < 3 || argc > 5) {
        outs(f, "usage: scan {start(Hz)} {stop(Hz)} [points] [outmask]\r\n");
        return;
    }
    uint32_t start = (uint32_t)strtoul(argv[1], NULL, 0);
    uint32_t stop = (uint32_t)strtoul(argv[2], NULL, 0);
    uint32_t points = argc >= 4 ? (uint32_t)strtoul(argv[3], NULL, 0) : 101;
    uint32_t mask = argc >= 5 ? (uint32_t)strtoul(argv[4], NULL, 0) : 0;
    if (start == 0 || stop == 0 || start > stop) {
        outs(f, "frequency range is invalid\r\n");
        return;
    }
    if (points == 0 || points > f->max_points) {
        char m[64];
        snprintf(m, sizeof m, "sweep points exceeds range %u\r\n", f->max_points);
        outs(f, m);
        return;
    }
    if (!f->binary) mask &= 0x7f;  // classic firmware has no binary output
    f->scans++;
    if (mask & 0x80) {
        put_u16(f, (uint16_t)mask);
        put_u16(f, (uint16_t)points);
    }
    for (uint32_t i = 0; i < points; i++) {
        uint32_t fr = points > 1 ? start + (uint32_t)(((uint64_t)(stop - start) * i) / (points - 1)) : start;
        float re, im;
        fake_s11(fr, &re, &im);
        if (mask & 0x80) {
            if (mask & 1) put_u32(f, fr);
            if (mask & 2) {
                put_f32(f, re);
                put_f32(f, im);
            }
            if (mask & 4) {
                put_f32(f, 0.1f);
                put_f32(f, -0.1f);
            }
        } else {
            char line[96];
            int n = 0;
            if (mask & 1) n += snprintf(line + n, sizeof line - n, "%u ", fr);
            if (mask & 2) n += snprintf(line + n, sizeof line - n, "%f %f ", re, im);
            if (mask & 4) n += snprintf(line + n, sizeof line - n, "%f %f ", 0.1, -0.1);
            snprintf(line + n, sizeof line - n, "\r\n");
            outs(f, line);
        }
    }
}

static void execute(fake_nanovna_t *f)
{
    char *argv[8];
    int argc = 0;
    snprintf(f->last_cmd, sizeof f->last_cmd, "%s", f->line);
    if (f->nlog < 64) snprintf(f->log[f->nlog++], sizeof f->log[0], "%s", f->line);
    char *save = NULL;
    for (char *t = strtok_r(f->line, " ", &save); t && argc < 8; t = strtok_r(NULL, " ", &save)) argv[argc++] = t;
    if (argc == 0) return;
    if (!strcmp(argv[0], "version")) {
        outs(f, "1.2.40-fake\r\n");
    } else if (!strcmp(argv[0], "info")) {
        char m[160];
        snprintf(m, sizeof m, "Board: NanoVNA-H 4\r\nLicensed under GPL.\r\nVersion: 1.2.40 [p:%u, IF:12k, ADC:384k, Lcd:32x24]\r\n",
                 f->max_points);
        outs(f, m);
    } else if (!strcmp(argv[0], "help")) {
        outs(f, f->binary ? "Commands: scan scan_bin data version info help\r\n" : "Commands: scan data version info help\r\n");
    } else if (!strcmp(argv[0], "scan")) {
        cmd_scan(f, argc, argv);
    } else if (!strcmp(argv[0], "capture")) {
        // 32x24 RGB565: a byte pattern that includes "ch> " to make sure it's read by length.
        for (int i = 0; i < 32 * 24 * 2; i++) {
            uint8_t b = (i % 100 < 4) ? (uint8_t)"ch> "[i % 100] : (uint8_t)(i * 7);
            out(f, &b, 1);
        }
    } else if (!strcmp(argv[0], "pause") || !strcmp(argv[0], "resume") || !strcmp(argv[0], "sweep") ||
               !strcmp(argv[0], "trace") || !strcmp(argv[0], "marker")) {
        // no output
    } else {
        char m[96];
        snprintf(m, sizeof m, "%s?\r\n", argv[0]);
        outs(f, m);
    }
}

void fake_input(fake_nanovna_t *f, const uint8_t *data, size_t len)
{
    if (f->silent) return;
    for (size_t i = 0; i < len; i++) {
        uint8_t c = data[i];
        if (c == '\r') {
            outs(f, "\r\n");
            f->line[f->line_len] = 0;
            execute(f);
            f->line_len = 0;
            outs(f, "ch> ");
        } else if (c >= ' ' && f->line_len < 63) {
            out(f, &c, 1);  // echo
            f->line[f->line_len++] = (char)c;
        }
    }
}
