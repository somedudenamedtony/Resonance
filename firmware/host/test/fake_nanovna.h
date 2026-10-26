// A tiny scripted NanoVNA for C unit tests. The full-fidelity emulator is emulator/ (TypeScript).
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
    bool binary;          // NanoVNA-D style: supports scan_bin / binary outmask
    uint16_t max_points;  // 101 classic, 401 H4
    bool silent;          // stop answering (to test timeouts)
    // Output waiting to be delivered to the bridge.
    uint8_t out[65536];
    size_t out_len;
    // Input line being typed.
    char line[128];
    size_t line_len;
    int scans;            // number of scan commands executed
    char last_cmd[128];
    char log[64][128];    // every command line received, oldest first
    int nlog;
} fake_nanovna_t;

void fake_init(fake_nanovna_t *f, bool binary, uint16_t max_points);
// Bytes written by the bridge to the device.
void fake_input(fake_nanovna_t *f, const uint8_t *data, size_t len);
// Device-side S11 for a frequency (deterministic test pattern).
void fake_s11(double f_hz, float *re, float *im);
