// NanoVNA shell session: sends one command at a time and collects its response.
//
// The NanoVNA shell (NanoVNA-D and the original firmware) works like this:
//   - Every received character is echoed. '\r' ends the line; the device answers "\r\n".
//   - The command's output follows, lines ending "\r\n".
//   - When the command finishes, the device prints the prompt "ch> ".
// So a response is: <echo of command> "\r\n" <body> "ch> ".
//
// Binary scans ("scan ... <mask|0x80>") put a length-determined binary body between the
// echo line and the prompt, which may itself contain the bytes "ch> ", so they are read by
// length, not by searching for the prompt.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define RC_SHELL_PROMPT "ch> "
#define RC_SHELL_PROMPT_LEN 4

typedef enum {
    RC_SHELL_OK = 0,
    RC_SHELL_TIMEOUT,
    RC_SHELL_OVERFLOW,
    RC_SHELL_ABORTED,
} rc_shell_status_t;

typedef enum {
    RC_RESP_TEXT = 0,   // body ends at the prompt
    RC_RESP_SCAN_BIN,   // body = u16 mask, u16 points, records; then the prompt
    RC_RESP_STREAM,     // body = exactly expect_len bytes, handed to stream_cb as they arrive
} rc_resp_mode_t;

// Receives a streamed body in order. `offset` counts from the start of the body.
typedef void (*rc_shell_stream_fn)(void *ctx, const uint8_t *data, size_t len, size_t offset);

// Called once per command. For RC_RESP_TEXT the body has the echo line and the trailing
// prompt removed. For RC_RESP_SCAN_BIN it is the binary payload starting at the mask, unless
// the device answered with text instead (e.g. a usage message); then `is_text` is true.
typedef void (*rc_shell_done_fn)(void *ctx, rc_shell_status_t status, const uint8_t *body, size_t len,
                                 bool is_text);

typedef void (*rc_shell_write_fn)(void *io, const uint8_t *data, size_t len);

typedef struct {
    rc_shell_write_fn write;
    void *io;

    uint8_t *buf;
    size_t cap;
    size_t len;

    bool busy;
    rc_resp_mode_t mode;
    uint32_t deadline_ms;
    uint16_t expect_mask;    // binary mode: mask we asked for
    uint16_t expect_points;  // binary mode: points we asked for
    char echo[64];           // the command, to find its echo line
    size_t expect_len;       // stream mode: body length
    size_t streamed;         // stream mode: bytes delivered so far
    rc_shell_stream_fn stream;
    rc_shell_done_fn done;
    void *done_ctx;
} rc_shell_t;

void rc_shell_init(rc_shell_t *sh, uint8_t *buf, size_t cap, rc_shell_write_fn write, void *io);

// Drop any partial response and in-flight command without calling its callback.
void rc_shell_reset(rc_shell_t *sh);

// Send `cmd` followed by '\r'. `cmd` may be empty (just presses Enter, useful to sync on a
// prompt). Returns false if a command is already in flight or `cmd` is too long (> 63).
bool rc_shell_send(rc_shell_t *sh, const char *cmd, rc_resp_mode_t mode, uint16_t expect_mask,
                   uint16_t expect_points, uint32_t now_ms, uint32_t timeout_ms, rc_shell_done_fn done,
                   void *ctx);

// Send a command whose body is exactly `expect_len` bytes (e.g. `capture`), streamed to `stream`
// as it arrives instead of buffered. `done` gets body NULL / len expect_len when complete.
bool rc_shell_send_stream(rc_shell_t *sh, const char *cmd, size_t expect_len, uint32_t now_ms, uint32_t timeout_ms,
                          rc_shell_stream_fn stream, rc_shell_done_fn done, void *ctx);

// Feed bytes received from the device.
void rc_shell_feed(rc_shell_t *sh, const uint8_t *data, size_t len);

// Check the timeout.
void rc_shell_tick(rc_shell_t *sh, uint32_t now_ms);

// Abort the in-flight command, calling its callback with RC_SHELL_ABORTED.
void rc_shell_abort(rc_shell_t *sh);

// Record size in bytes for a NanoVNA binary scan mask (freq u32, S11 2xf32, S21 2xf32).
size_t rc_shell_bin_record_size(uint16_t mask);

#ifdef __cplusplus
}
#endif
