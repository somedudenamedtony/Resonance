// Scan planning, NanoVNA scan output parsing, and protocol v1 binary frame encoding.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// NanoVNA `scan` outmask bits (NanoVNA-D main.c).
#define RC_MASK_FREQ 0x01
#define RC_MASK_S11 0x02
#define RC_MASK_S21 0x04
#define RC_MASK_NO_CALIBRATION 0x08
#define RC_MASK_NO_EDELAY 0x10
#define RC_MASK_NO_S21OFFS 0x20
#define RC_MASK_BINARY 0x80

typedef struct {
    double freq_hz;
    float s11_re, s11_im;
    float s21_re, s21_im;
} rc_point_t;

// One device scan that covers points [offset, offset + count) of the requested sweep.
typedef struct {
    uint32_t start_hz;
    uint32_t stop_hz;
    uint16_t count;
    uint16_t offset;
} rc_segment_t;

// Number of device scans needed for `points` when the device takes at most `max_points`.
uint16_t rc_scan_segment_count(uint32_t points, uint16_t max_points);

// Frequency of point `i` of an evenly spaced sweep, rounded to whole Hz.
uint32_t rc_scan_freq(uint32_t start_hz, uint32_t stop_hz, uint32_t points, uint32_t i);

// Segment `k` of `n` (from rc_scan_segment_count). Segments are as even as possible and never
// have fewer than 2 points when points >= 2.
rc_segment_t rc_scan_segment(uint32_t start_hz, uint32_t stop_hz, uint32_t points, uint16_t n, uint16_t k);

// The outmask the bridge sends: frequency + S11 (+ S21), device calibration and electrical
// delay off (the app calibrates), binary when the device supports it.
uint16_t rc_scan_mask(bool s21, bool binary);

// Parse a binary scan body (u16 mask, u16 points, records). Returns points parsed, or -1 if
// malformed. Writes at most `cap` points to `out`.
int rc_scan_parse_bin(const uint8_t *body, size_t len, rc_point_t *out, size_t cap);

// Parse text scan output: one line per point, "freq re im [re im]" per the mask. Returns
// points parsed, or -1 on a malformed line.
int rc_scan_parse_text(const char *text, size_t len, uint16_t mask, rc_point_t *out, size_t cap);

// ---- Protocol v1 binary frames (docs/PROTOCOL.md) ----
#define RC_FRAME_SCAN 0x01
#define RC_FRAME_FLAG_S21 0x01
#define RC_FRAME_HEADER 8
#define RC_FRAME_MAX 4096

size_t rc_frame_record_size(bool s21);
size_t rc_frame_max_records(bool s21);

// Encode a scan-data frame into `out`. Returns bytes written, or 0 if `cap` is too small.
size_t rc_frame_encode(uint8_t *out, size_t cap, uint16_t scan_id, uint16_t offset, bool s21,
                       const rc_point_t *pts, size_t n);

#ifdef __cplusplus
}
#endif
