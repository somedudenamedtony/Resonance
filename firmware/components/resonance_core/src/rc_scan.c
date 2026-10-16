#include "rc_scan.h"

#include <stdlib.h>
#include <string.h>

uint16_t rc_scan_segment_count(uint32_t points, uint16_t max_points)
{
    if (max_points < 2) max_points = 2;
    if (points <= max_points) return 1;
    return (uint16_t)((points + max_points - 1) / max_points);
}

uint32_t rc_scan_freq(uint32_t start_hz, uint32_t stop_hz, uint32_t points, uint32_t i)
{
    if (points < 2) return start_hz;
    uint64_t span = (uint64_t)(stop_hz - start_hz);
    // Round to nearest: start + span * i / (points - 1)
    uint64_t num = span * i * 2 + (points - 1);
    return start_hz + (uint32_t)(num / (2 * (uint64_t)(points - 1)));
}

rc_segment_t rc_scan_segment(uint32_t start_hz, uint32_t stop_hz, uint32_t points, uint16_t n, uint16_t k)
{
    rc_segment_t s;
    uint32_t base = points / n;
    uint32_t extra = points % n;  // first `extra` segments get one more point
    uint32_t offset = k * base + (k < extra ? k : extra);
    uint32_t count = base + (k < extra ? 1 : 0);
    s.offset = (uint16_t)offset;
    s.count = (uint16_t)count;
    s.start_hz = rc_scan_freq(start_hz, stop_hz, points, offset);
    s.stop_hz = rc_scan_freq(start_hz, stop_hz, points, offset + count - 1);
    return s;
}

uint16_t rc_scan_mask(bool s21, bool binary)
{
    uint16_t m = RC_MASK_FREQ | RC_MASK_S11 | RC_MASK_NO_CALIBRATION | RC_MASK_NO_EDELAY;
    if (s21) m |= RC_MASK_S21 | RC_MASK_NO_S21OFFS;
    if (binary) m |= RC_MASK_BINARY;
    return m;
}

static uint32_t rd_u32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static float rd_f32(const uint8_t *p)
{
    uint32_t u = rd_u32(p);
    float f;
    memcpy(&f, &u, sizeof f);
    return f;
}

int rc_scan_parse_bin(const uint8_t *body, size_t len, rc_point_t *out, size_t cap)
{
    if (len < 4) return -1;
    uint16_t mask = (uint16_t)(body[0] | (body[1] << 8));
    uint16_t points = (uint16_t)(body[2] | (body[3] << 8));
    size_t rec = 0;
    if (mask & RC_MASK_FREQ) rec += 4;
    if (mask & RC_MASK_S11) rec += 8;
    if (mask & RC_MASK_S21) rec += 8;
    if (rec == 0 || len != 4 + (size_t)points * rec) return -1;
    if (points > cap) return -1;
    const uint8_t *p = body + 4;
    for (uint16_t i = 0; i < points; i++) {
        rc_point_t *o = &out[i];
        memset(o, 0, sizeof *o);
        if (mask & RC_MASK_FREQ) {
            o->freq_hz = (double)rd_u32(p);
            p += 4;
        }
        if (mask & RC_MASK_S11) {
            o->s11_re = rd_f32(p);
            o->s11_im = rd_f32(p + 4);
            p += 8;
        }
        if (mask & RC_MASK_S21) {
            o->s21_re = rd_f32(p);
            o->s21_im = rd_f32(p + 4);
            p += 8;
        }
    }
    return points;
}

int rc_scan_parse_text(const char *text, size_t len, uint16_t mask, rc_point_t *out, size_t cap)
{
    // Work on a bounded copy so strtod can't run off the end.
    char line[160];
    size_t n = 0;
    size_t i = 0;
    while (i < len) {
        size_t j = i;
        while (j < len && text[j] != '\n') j++;
        size_t l = j - i;
        while (l > 0 && (text[i + l - 1] == '\r' || text[i + l - 1] == ' ')) l--;
        if (l > 0) {
            if (l >= sizeof line) return -1;
            memcpy(line, text + i, l);
            line[l] = 0;
            if (n >= cap) return -1;
            rc_point_t *o = &out[n];
            memset(o, 0, sizeof *o);
            char *p = line;
            char *end;
            if (mask & RC_MASK_FREQ) {
                o->freq_hz = strtod(p, &end);
                if (end == p) return -1;
                p = end;
            }
            if (mask & RC_MASK_S11) {
                o->s11_re = strtof(p, &end);
                if (end == p) return -1;
                p = end;
                o->s11_im = strtof(p, &end);
                if (end == p) return -1;
                p = end;
            }
            if (mask & RC_MASK_S21) {
                o->s21_re = strtof(p, &end);
                if (end == p) return -1;
                p = end;
                o->s21_im = strtof(p, &end);
                if (end == p) return -1;
                p = end;
            }
            while (*p == ' ') p++;
            if (*p != 0) return -1;
            n++;
        }
        i = j + 1;
    }
    return (int)n;
}

size_t rc_frame_record_size(bool s21)
{
    return s21 ? 24 : 16;
}

size_t rc_frame_max_records(bool s21)
{
    return (RC_FRAME_MAX - RC_FRAME_HEADER) / rc_frame_record_size(s21);
}

static void wr_u16(uint8_t *p, uint16_t v)
{
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
}

static void wr_u32(uint8_t *p, uint32_t v)
{
    for (int i = 0; i < 4; i++) p[i] = (uint8_t)(v >> (8 * i));
}

static void wr_u64(uint8_t *p, uint64_t v)
{
    for (int i = 0; i < 8; i++) p[i] = (uint8_t)(v >> (8 * i));
}

static void wr_f32(uint8_t *p, float f)
{
    uint32_t u;
    memcpy(&u, &f, sizeof u);
    wr_u32(p, u);
}

static void wr_f64(uint8_t *p, double d)
{
    uint64_t u;
    memcpy(&u, &d, sizeof u);
    wr_u64(p, u);
}

size_t rc_frame_encode(uint8_t *out, size_t cap, uint16_t scan_id, uint16_t offset, bool s21,
                       const rc_point_t *pts, size_t n)
{
    size_t rec = rc_frame_record_size(s21);
    size_t total = RC_FRAME_HEADER + n * rec;
    if (total > cap || n > 0xffff) return 0;
    out[0] = RC_FRAME_SCAN;
    out[1] = s21 ? RC_FRAME_FLAG_S21 : 0;
    wr_u16(out + 2, scan_id);
    wr_u16(out + 4, offset);
    wr_u16(out + 6, (uint16_t)n);
    uint8_t *p = out + RC_FRAME_HEADER;
    for (size_t i = 0; i < n; i++) {
        wr_f64(p, pts[i].freq_hz);
        wr_f32(p + 8, pts[i].s11_re);
        wr_f32(p + 12, pts[i].s11_im);
        if (s21) {
            wr_f32(p + 16, pts[i].s21_re);
            wr_f32(p + 20, pts[i].s21_im);
        }
        p += rec;
    }
    return total;
}
