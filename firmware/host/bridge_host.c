// resonance-bridge-host: the bridge core running on a desktop OS, for the emulator stack.
//
// File descriptors:
//   0 (stdin)  framed messages from the harness (client JSON and control)
//   1 (stdout) framed messages to the harness (JSON, binary frames, logs)
//   3          the NanoVNA serial link, raw bytes both ways
//
// Frame: u8 kind, u32 length (little-endian), payload.
//   in : 0x00 client JSON text, 0x02 control ("attach", "detach", "client")
//   out: 0x00 JSON text, 0x01 binary scan frame, 0x03 log line
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "rc_bridge.h"

#define SERIAL_FD 3

enum { K_TEXT = 0x00, K_BINARY = 0x01, K_CONTROL = 0x02, K_LOG = 0x03 };

static rc_bridge_t g_bridge;
static bool g_attached = false;

static uint32_t now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint32_t)((uint64_t)ts.tv_sec * 1000u + (uint64_t)ts.tv_nsec / 1000000u);
}

static void write_all(int fd, const void *data, size_t len)
{
    const uint8_t *p = data;
    while (len > 0) {
        ssize_t n = write(fd, p, len);
        if (n < 0) {
            if (errno == EINTR || errno == EAGAIN) continue;
            exit(0);  // harness went away
        }
        p += n;
        len -= (size_t)n;
    }
}

static void send_frame(uint8_t kind, const void *data, size_t len)
{
    uint8_t hdr[5] = {kind, (uint8_t)len, (uint8_t)(len >> 8), (uint8_t)(len >> 16), (uint8_t)(len >> 24)};
    write_all(1, hdr, 5);
    write_all(1, data, len);
}

static void io_serial_write(void *u, const uint8_t *d, size_t n)
{
    if (g_attached) write_all(SERIAL_FD, d, n);
}

static void io_send_text(void *u, const char *json)
{
    send_frame(K_TEXT, json, strlen(json));
}

static void io_send_binary(void *u, const uint8_t *d, size_t n)
{
    send_frame(K_BINARY, d, n);
}

static bool io_wifi_set(void *u, bool sta, const char *ssid, const char *pw)
{
    char m[160];
    snprintf(m, sizeof m, "wifi.set %s ssid=%s (ignored on host)", sta ? "sta" : "ap", ssid);
    send_frame(K_LOG, m, strlen(m));
    return true;
}

static void io_log(void *u, const char *msg)
{
    send_frame(K_LOG, msg, strlen(msg));
}

// Reassemble stdin frames.
static uint8_t g_in[1 << 16];
static size_t g_in_len = 0;

static void handle_frame(uint8_t kind, const uint8_t *p, size_t len)
{
    uint32_t now = now_ms();
    if (kind == K_TEXT) {
        rc_bridge_client_text(&g_bridge, (const char *)p, len, now);
    } else if (kind == K_CONTROL) {
        if (len == 6 && memcmp(p, "attach", 6) == 0) {
            g_attached = true;
            rc_bridge_device_attached(&g_bridge, now);
        } else if (len == 6 && memcmp(p, "detach", 6) == 0) {
            g_attached = false;
            rc_bridge_device_detached(&g_bridge, now);
        } else if (len == 6 && memcmp(p, "client", 6) == 0) {
            rc_bridge_client_connected(&g_bridge, now);
        }
    }
}

static void drain_stdin_frames(void)
{
    size_t off = 0;
    while (g_in_len - off >= 5) {
        uint8_t kind = g_in[off];
        uint32_t len = (uint32_t)g_in[off + 1] | ((uint32_t)g_in[off + 2] << 8) | ((uint32_t)g_in[off + 3] << 16) |
                       ((uint32_t)g_in[off + 4] << 24);
        if (len > sizeof g_in - 5) exit(2);
        if (g_in_len - off < 5 + len) break;
        handle_frame(kind, g_in + off + 5, len);
        off += 5 + len;
    }
    memmove(g_in, g_in + off, g_in_len - off);
    g_in_len -= off;
}

int main(void)
{
    rc_bridge_io_t io = {io_serial_write, io_send_text, io_send_binary, io_wifi_set, io_log, NULL};
    rc_bridge_init(&g_bridge, &io, now_ms());
    io_log(NULL, "resonance-bridge-host " RC_BRIDGE_VERSION " ready");

    struct pollfd fds[2] = {{0, POLLIN, 0}, {SERIAL_FD, POLLIN, 0}};
    uint8_t buf[4096];
    for (;;) {
        int r = poll(fds, 2, 10);
        if (r < 0 && errno != EINTR) return 1;
        if (r > 0 && (fds[0].revents & (POLLIN | POLLHUP))) {
            ssize_t n = read(0, g_in + g_in_len, sizeof g_in - g_in_len);
            if (n <= 0) return 0;  // harness closed stdin
            g_in_len += (size_t)n;
            drain_stdin_frames();
        }
        if (r > 0 && (fds[1].revents & POLLIN)) {
            ssize_t n = read(SERIAL_FD, buf, sizeof buf);
            if (n > 0 && g_attached) rc_bridge_serial_rx(&g_bridge, buf, (size_t)n, now_ms());
            if (n == 0) fds[1].fd = -1;  // serial link closed
        }
        rc_bridge_tick(&g_bridge, now_ms());
    }
}
