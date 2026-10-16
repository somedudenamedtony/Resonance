#include "rc_shell.h"

#include <string.h>

#define MASK_FREQ 0x01
#define MASK_S11 0x02
#define MASK_S21 0x04

size_t rc_shell_bin_record_size(uint16_t mask)
{
    size_t n = 0;
    if (mask & MASK_FREQ) n += 4;
    if (mask & MASK_S11) n += 8;
    if (mask & MASK_S21) n += 8;
    return n;
}

void rc_shell_init(rc_shell_t *sh, uint8_t *buf, size_t cap, rc_shell_write_fn write, void *io)
{
    memset(sh, 0, sizeof(*sh));
    sh->buf = buf;
    sh->cap = cap;
    sh->write = write;
    sh->io = io;
}

void rc_shell_reset(rc_shell_t *sh)
{
    sh->len = 0;
    sh->busy = false;
    sh->done = NULL;
    sh->done_ctx = NULL;
}

static void finish(rc_shell_t *sh, rc_shell_status_t st, const uint8_t *body, size_t len, bool is_text)
{
    rc_shell_done_fn done = sh->done;
    void *ctx = sh->done_ctx;
    sh->busy = false;
    sh->done = NULL;
    sh->done_ctx = NULL;
    if (done) done(ctx, st, body, len, is_text);
    // The callback may have sent the next command; only clear the buffer if it didn't.
    if (!sh->busy) sh->len = 0;
}

bool rc_shell_send(rc_shell_t *sh, const char *cmd, rc_resp_mode_t mode, uint16_t expect_mask,
                   uint16_t expect_points, uint32_t now_ms, uint32_t timeout_ms, rc_shell_done_fn done,
                   void *ctx)
{
    if (sh->busy) return false;
    size_t n = strlen(cmd);
    if (n > 63) return false;
    for (size_t i = 0; i < n; i++) {
        if ((unsigned char)cmd[i] < 0x20) return false;  // the shell drops control chars
    }
    sh->busy = true;
    sh->mode = mode;
    sh->expect_mask = expect_mask;
    sh->expect_points = expect_points;
    sh->deadline_ms = now_ms + timeout_ms;
    sh->done = done;
    sh->done_ctx = ctx;
    memcpy(sh->echo, cmd, n);
    sh->echo[n] = 0;
    sh->stream = NULL;
    sh->expect_len = 0;
    sh->streamed = 0;
    sh->len = 0;  // discard anything that arrived while idle (banner, stray prompts)
    if (n) sh->write(sh->io, (const uint8_t *)cmd, n);
    sh->write(sh->io, (const uint8_t *)"\r", 1);
    return true;
}

bool rc_shell_send_stream(rc_shell_t *sh, const char *cmd, size_t expect_len, uint32_t now_ms, uint32_t timeout_ms,
                          rc_shell_stream_fn stream, rc_shell_done_fn done, void *ctx)
{
    if (!rc_shell_send(sh, cmd, RC_RESP_STREAM, 0, 0, now_ms, timeout_ms, done, ctx)) return false;
    sh->stream = stream;
    sh->expect_len = expect_len;
    return true;
}

// Index just after the echo line ("<cmd>\r\n"), or 0 if it hasn't arrived yet. Matching the
// command text skips stray output from before the command (a late banner or prompt).
static size_t echo_end(const rc_shell_t *sh)
{
    size_t n = strlen(sh->echo);
    for (size_t i = 0; i + n + 1 < sh->len; i++) {
        if (n && memcmp(sh->buf + i, sh->echo, n) != 0) continue;
        if (sh->buf[i + n] == '\r' && sh->buf[i + n + 1] == '\n') return i + n + 2;
    }
    return 0;
}

static bool ends_with_prompt(const uint8_t *p, size_t len)
{
    return len >= RC_SHELL_PROMPT_LEN && memcmp(p + len - RC_SHELL_PROMPT_LEN, RC_SHELL_PROMPT, RC_SHELL_PROMPT_LEN) == 0;
}

static uint16_t rd_u16(const uint8_t *p)
{
    return (uint16_t)(p[0] | (p[1] << 8));
}

static void try_complete(rc_shell_t *sh)
{
    size_t e = echo_end(sh);
    if (e == 0) return;
    const uint8_t *body = sh->buf + e;
    size_t avail = sh->len - e;

    if (sh->mode == RC_RESP_STREAM) {
        // Hand body bytes over as they come, then drop them so the buffer never fills.
        size_t want = sh->expect_len - sh->streamed;
        size_t n = avail < want ? avail : want;
        if (n > 0) {
            if (sh->stream) sh->stream(sh->done_ctx, body, n, sh->streamed);
            sh->streamed += n;
            memmove(sh->buf + e, body + n, avail - n);
            sh->len -= n;
            avail -= n;
        }
        if (sh->streamed < sh->expect_len) return;
        if (avail < RC_SHELL_PROMPT_LEN) return;
        if (memcmp(body, RC_SHELL_PROMPT, RC_SHELL_PROMPT_LEN) == 0) finish(sh, RC_SHELL_OK, NULL, sh->expect_len, false);
        else finish(sh, RC_SHELL_OK, body, avail, true);  // unexpected trailing text
        return;
    }

    if (sh->mode == RC_RESP_SCAN_BIN) {
        if (avail < 4) return;
        uint16_t mask = rd_u16(body);
        uint16_t points = rd_u16(body + 2);
        if (mask == sh->expect_mask && points == sh->expect_points) {
            size_t total = 4 + (size_t)points * rc_shell_bin_record_size(mask);
            if (avail < total + RC_SHELL_PROMPT_LEN) return;
            if (memcmp(body + total, RC_SHELL_PROMPT, RC_SHELL_PROMPT_LEN) != 0) {
                // Length didn't line up with a prompt: treat what we have as text so the
                // caller can report it instead of waiting for a timeout.
                finish(sh, RC_SHELL_OK, body, avail, true);
                return;
            }
            finish(sh, RC_SHELL_OK, body, total, false);
            return;
        }
        // Not our binary header: the device answered in text (usage, error). Fall through.
    }

    if (ends_with_prompt(body, avail)) {
        finish(sh, RC_SHELL_OK, body, avail - RC_SHELL_PROMPT_LEN, sh->mode == RC_RESP_SCAN_BIN);
    }
}

void rc_shell_feed(rc_shell_t *sh, const uint8_t *data, size_t len)
{
    if (!sh->busy) return;  // idle output (banner, prompt) is ignored
    while (len > 0 && sh->busy) {
        size_t room = sh->cap - sh->len;
        if (room == 0) {
            finish(sh, RC_SHELL_OVERFLOW, NULL, 0, false);
            return;
        }
        size_t n = len < room ? len : room;
        memcpy(sh->buf + sh->len, data, n);
        sh->len += n;
        data += n;
        len -= n;
        try_complete(sh);
    }
}

void rc_shell_tick(rc_shell_t *sh, uint32_t now_ms)
{
    if (sh->busy && (int32_t)(now_ms - sh->deadline_ms) >= 0) {
        finish(sh, RC_SHELL_TIMEOUT, NULL, 0, false);
    }
}

void rc_shell_abort(rc_shell_t *sh)
{
    if (sh->busy) finish(sh, RC_SHELL_ABORTED, NULL, 0, false);
    sh->len = 0;
}
