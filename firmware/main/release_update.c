#include "release_update.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "ota.h"
#include "rc_update.h"
#include "wifi.h"

static const char *TAG = "release";

// Where releases come from. A fork changes this to its own repository.
#define RELEASES_URL "https://api.github.com/repos/somedudenamedtony/Resonance/releases/latest"
#define USER_AGENT "resonance-bridge/" RC_BRIDGE_VERSION
#define FIRST_CHECK_US (20LL * 1000 * 1000)        // after joining home Wi-Fi
#define RECHECK_US (12LL * 60 * 60 * 1000 * 1000)  // GitHub allows 60 unauthenticated requests an hour
#define MAX_RELEASE_JSON (96 * 1024)
#define CHUNK 4096

enum { CMD_CHECK = 1, CMD_INSTALL = 2 };

static TaskHandle_t s_task;
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;
static rc_update_status_t s_status;  // guarded by s_lock
static rc_release_t s_release;       // the updater task's own
static bool s_have_release;
static bool s_busy;  // a check or install is queued or running (guarded by s_lock)
static int64_t s_next_auto_us;

// ---- status ----

static void set_state(rc_update_state_t state, const char *message)
{
    taskENTER_CRITICAL(&s_lock);
    s_status.state = state;
    snprintf(s_status.message, sizeof s_status.message, "%s", message ? message : "");
    if (state != RC_UPDATE_INSTALLING) {
        s_status.step[0] = 0;
        s_status.received = s_status.total = 0;
    }
    taskEXIT_CRITICAL(&s_lock);
}

static void set_progress(const char *step, uint32_t received, uint32_t total)
{
    taskENTER_CRITICAL(&s_lock);
    s_status.state = RC_UPDATE_INSTALLING;
    snprintf(s_status.step, sizeof s_status.step, "%s", step);
    s_status.received = received;
    s_status.total = total;
    taskEXIT_CRITICAL(&s_lock);
}

void release_update_status(rc_update_status_t *out)
{
    taskENTER_CRITICAL(&s_lock);
    *out = s_status;
    taskEXIT_CRITICAL(&s_lock);
}

// ---- HTTP ----

// Open `url` and follow redirects (release downloads bounce to GitHub's storage host), the
// same way esp_https_ota does. Returns a client positioned at the body, or NULL with `err`.
static esp_http_client_handle_t open_url(const char *url, bool api, int64_t *length, char *err, size_t cap)
{
    esp_http_client_config_t cfg = {
        .url = url,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .user_agent = USER_AGENT,
        .timeout_ms = 20000,
        .buffer_size = 4096,
        .buffer_size_tx = 4096,  // signed download URLs are long
    };
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (!c) {
        snprintf(err, cap, "Out of memory.");
        return NULL;
    }
    if (api) {
        esp_http_client_set_header(c, "Accept", "application/vnd.github+json");
        esp_http_client_set_header(c, "X-GitHub-Api-Version", "2022-11-28");
    }
    for (int hops = 0; hops < 5; hops++) {
        esp_err_t e = esp_http_client_open(c, 0);
        if (e != ESP_OK) {
            snprintf(err, cap, "Couldn't reach GitHub (%s). Is the internet up?", esp_err_to_name(e));
            break;
        }
        int64_t len = esp_http_client_fetch_headers(c);
        int status = esp_http_client_get_status_code(c);
        if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
            if (esp_http_client_set_redirection(c) != ESP_OK) {
                snprintf(err, cap, "GitHub sent a redirect the bridge couldn't follow.");
                break;
            }
            char drain[256];
            while (esp_http_client_read(c, drain, sizeof drain) > 0) {
            }
            continue;
        }
        if (status == 404) {
            snprintf(err, cap, "There's no release on GitHub yet.");
            break;
        }
        if (status == 403 || status == 429) {
            snprintf(err, cap, "GitHub is limiting requests right now. Try again in an hour.");
            break;
        }
        if (status != 200) {
            snprintf(err, cap, "GitHub answered %d.", status);
            break;
        }
        *length = len;
        return c;
    }
    if (!err[0]) snprintf(err, cap, "Too many redirects.");
    esp_http_client_close(c);
    esp_http_client_cleanup(c);
    return NULL;
}

static void close_url(esp_http_client_handle_t c)
{
    esp_http_client_close(c);
    esp_http_client_cleanup(c);
}

// ---- check ----

static bool fetch_release(char *err, size_t cap)
{
    int64_t len = 0;
    esp_http_client_handle_t c = open_url(RELEASES_URL, true, &len, err, cap);
    if (!c) return false;
    char *buf = malloc(MAX_RELEASE_JSON);
    if (!buf) {
        close_url(c);
        snprintf(err, cap, "Out of memory.");
        return false;
    }
    int n = 0, r;
    while (n < MAX_RELEASE_JSON && (r = esp_http_client_read(c, buf + n, MAX_RELEASE_JSON - n)) > 0) n += r;
    bool complete = esp_http_client_is_complete_data_received(c);
    close_url(c);
    bool ok = false;
    if (!complete) snprintf(err, cap, "GitHub's answer was cut short.");
    else ok = rc_release_parse(buf, (size_t)n, &s_release, err, cap);
    free(buf);
    s_have_release = ok;
    return ok;
}

// `quiet` (the automatic check) leaves the status as it was if GitHub can't be reached, so a
// flaky connection doesn't show up as an error nobody asked about.
static void do_check(bool quiet)
{
    char err[96] = "";
    rc_update_status_t before;
    release_update_status(&before);
    set_state(RC_UPDATE_CHECKING, NULL);
    if (!fetch_release(err, sizeof err)) {
        ESP_LOGW(TAG, "check failed: %s", err);
        if (quiet) set_state(before.state, before.message);
        else set_state(RC_UPDATE_FAILED, err);
        return;
    }
    bool newer = rc_version_compare(s_release.version, RC_BRIDGE_VERSION) > 0;
    ESP_LOGI(TAG, "latest release %s, running %s", s_release.version, RC_BRIDGE_VERSION);
    taskENTER_CRITICAL(&s_lock);
    snprintf(s_status.latest, sizeof s_status.latest, "%s", s_release.version);
    taskEXIT_CRITICAL(&s_lock);
    set_state(newer ? RC_UPDATE_AVAILABLE : RC_UPDATE_CURRENT, NULL);
}

// ---- install ----

// Download one asset straight into flash. `done` counts bytes already written by earlier steps.
static bool install_asset(const char *target, const rc_asset_t *a, uint32_t done, uint32_t total, char *err,
                          size_t cap)
{
    int64_t len = 0;
    esp_http_client_handle_t c = open_url(a->url, false, &len, err, cap);
    if (!c) return false;
    if (len > 0 && len != a->size) {
        close_url(c);
        snprintf(err, cap, "The %s download is the wrong size.", target);
        return false;
    }
    uint8_t *buf = malloc(CHUNK);
    bool ok = buf && ota_begin_reserved(target, a->size, err, cap);
    if (!buf) snprintf(err, cap, "Out of memory.");
    uint32_t got = 0;
    while (ok && got < a->size) {
        // Fill the buffer, so the first write is big enough to check the image's magic bytes.
        size_t fill = 0, want = a->size - got < CHUNK ? a->size - got : CHUNK;
        while (fill < want) {
            int r = esp_http_client_read(c, (char *)buf + fill, want - fill);
            if (r <= 0) break;
            fill += (size_t)r;
        }
        if (fill < want) {
            snprintf(err, cap, "The %s download stopped part way. Nothing was changed.", target);
            ok = false;
        } else if (got == 0 && !rc_image_magic_ok(target, buf, fill)) {
            snprintf(err, cap, "The release's %s file isn't a valid image.", target);
            ok = false;
        } else {
            ok = ota_write(NULL, buf, fill, err, cap);
            got += (uint32_t)fill;
            set_progress(target, done + got, total);
        }
    }
    if (ok) ok = ota_finish(err, cap);
    free(buf);
    close_url(c);
    return ok;
}

static void do_install(void)
{
    char err[96] = "";
    // Always re-read the release: the cached one may be old, and its download links with it.
    set_state(RC_UPDATE_CHECKING, NULL);
    if (!fetch_release(err, sizeof err)) {
        set_state(RC_UPDATE_FAILED, err);
        return;
    }
    taskENTER_CRITICAL(&s_lock);
    snprintf(s_status.latest, sizeof s_status.latest, "%s", s_release.version);
    taskEXIT_CRITICAL(&s_lock);
    // No version gate: the app only offers Install for a newer release, and the /update page
    // uses this to put a broken web app back.
    if (!ota_reserve()) {
        set_state(RC_UPDATE_FAILED, "An update from a file is running. Try again when it's done.");
        return;
    }
    uint32_t total = s_release.firmware.size + s_release.app.size;
    ESP_LOGI(TAG, "installing %s (%lu bytes)", s_release.version, (unsigned long)total);
    set_progress("firmware", 0, total);
    // Firmware first, into the spare slot: if anything fails before the web app is rewritten,
    // the bridge keeps running exactly what it had.
    bool ok = install_asset("firmware", &s_release.firmware, 0, total, err, sizeof err);
    if (ok && !install_asset("app", &s_release.app, s_release.firmware.size, total, err, sizeof err)) {
        // The old firmware is still running, but its web app is half rewritten.
        snprintf(err, sizeof err, "The app download failed. Tap Install again before closing this page.");
        ok = false;
    }
    if (!ok) {
        ESP_LOGW(TAG, "install failed: %s", err);
        ota_release();
        set_state(RC_UPDATE_FAILED, err);
        return;
    }
    set_state(RC_UPDATE_DONE, NULL);
    ota_commit();  // switches to the new firmware and restarts
}

// ---- task ----

static void update_task(void *arg)
{
    for (;;) {
        uint32_t cmd = ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(10 * 1000));
        rc_wifi_status_t w;
        wifi_get_status(&w);
        bool online = w.state == RC_WIFI_CONNECTED;
        int64_t now = esp_timer_get_time();
        if (!online) s_next_auto_us = now + FIRST_CHECK_US;  // check a little after joining
        bool automatic = false;
        if (!cmd && online && now >= s_next_auto_us) {
            taskENTER_CRITICAL(&s_lock);
            automatic = !s_busy;  // otherwise a request is already on its way
            if (automatic) s_busy = true;
            taskEXIT_CRITICAL(&s_lock);
            if (automatic) cmd = CMD_CHECK;
        }
        if (!cmd) continue;

        if (!online) {
            set_state(RC_UPDATE_FAILED, w.ssid[0] ? "The bridge isn't on your home Wi-Fi right now."
                                                  : "Join home Wi-Fi first: the bridge downloads updates itself.");
        } else if (cmd & CMD_INSTALL) {
            do_install();
        } else {
            do_check(automatic);
        }
        s_next_auto_us = esp_timer_get_time() + RECHECK_US;
        taskENTER_CRITICAL(&s_lock);
        s_busy = false;
        taskEXIT_CRITICAL(&s_lock);
    }
}

static bool request(uint32_t cmd, char *err, size_t cap)
{
    taskENTER_CRITICAL(&s_lock);
    bool busy = s_busy;
    if (!busy) s_busy = true;
    taskEXIT_CRITICAL(&s_lock);
    if (busy) {
        snprintf(err, cap, "The bridge is already checking or installing.");
        return false;
    }
    set_state(RC_UPDATE_CHECKING, NULL);
    xTaskNotify(s_task, cmd, eSetBits);
    return true;
}

bool release_update_check(char *err, size_t cap)
{
    return request(CMD_CHECK, err, cap);
}

bool release_update_install(char *err, size_t cap)
{
    return request(CMD_INSTALL, err, cap);
}

void release_update_start(void)
{
    snprintf(s_status.rolled_back, sizeof s_status.rolled_back, "%s", ota_rolled_back_version());
    s_next_auto_us = esp_timer_get_time() + FIRST_CHECK_US;
    xTaskCreate(update_task, "update", 12288, NULL, 3, &s_task);
}
