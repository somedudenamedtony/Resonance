#include "ota.h"

#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "web.h"

static const char *TAG = "ota";

#define SECTOR 4096
#define PROBATION_US (5LL * 60 * 1000 * 1000)

static enum { T_NONE, T_FIRMWARE, T_APP } s_target = T_NONE;
static esp_ota_handle_t s_handle;
static const esp_partition_t *s_part;
static const esp_partition_t *s_staged;  // verified firmware waiting for ota_commit
static uint32_t s_size, s_written, s_erased;

static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
static bool s_reserved;      // the GitHub updater owns the writer
static bool s_upload;        // a file upload owns the writer
static bool s_probation;
static char s_rolled_back[32];
static esp_timer_handle_t s_probation_timer;

static void restart_cb(void *arg)
{
    esp_restart();
}

// Reboot a moment later so the final `ok` reaches the app.
static void schedule_restart(void)
{
    static esp_timer_handle_t t;
    const esp_timer_create_args_t args = {.callback = restart_cb, .name = "ota_restart"};
    if (!t && esp_timer_create(&args, &t) != ESP_OK) esp_restart();
    esp_timer_start_once(t, 1500 * 1000);
}

static void reset(void)
{
    if (s_target == T_FIRMWARE) esp_ota_abort(s_handle);
    if (s_target == T_APP && s_written > 0) {
        ESP_LOGW(TAG, "web app update interrupted; /update stays available to retry");
    }
    s_target = T_NONE;
}

static bool begin(const char *target, uint32_t size, char *err, size_t cap)
{
    reset();
    s_size = size;
    s_written = s_erased = 0;
    if (strcmp(target, "firmware") == 0) {
        s_part = esp_ota_get_next_update_partition(NULL);
        if (!s_part) {
            snprintf(err, cap, "No spare firmware slot on this board.");
            return false;
        }
        if (size > s_part->size) {
            snprintf(err, cap, "Firmware is %lu KB; the slot holds %lu KB.", (unsigned long)size / 1024,
                     (unsigned long)s_part->size / 1024);
            return false;
        }
        esp_err_t e = esp_ota_begin(s_part, size, &s_handle);
        if (e != ESP_OK) {
            snprintf(err, cap, "Couldn't start the update (%s).", esp_err_to_name(e));
            return false;
        }
        s_target = T_FIRMWARE;
    } else {
        s_part = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, "littlefs");
        if (!s_part) {
            snprintf(err, cap, "No web app partition on this board.");
            return false;
        }
        if (size > s_part->size) {
            snprintf(err, cap, "Web app image is %lu KB; the partition holds %lu KB.", (unsigned long)size / 1024,
                     (unsigned long)s_part->size / 1024);
            return false;
        }
        s_target = T_APP;  // the filesystem is unmounted on the first (checked) chunk
    }
    ESP_LOGI(TAG, "update %s: %lu bytes into %s", target, (unsigned long)size, s_part->label);
    return true;
}

bool ota_begin(void *user, const char *target, uint32_t size, char *err, size_t cap)
{
    taskENTER_CRITICAL(&s_mux);
    bool free_ = !s_reserved;
    if (free_) s_upload = true;
    taskEXIT_CRITICAL(&s_mux);
    if (!free_) {
        snprintf(err, cap, "The bridge is installing an update from GitHub.");
        return false;
    }
    s_staged = NULL;
    if (begin(target, size, err, cap)) return true;
    s_upload = false;
    return false;
}

bool ota_write(void *user, const uint8_t *data, size_t len, char *err, size_t cap)
{
    esp_err_t e = ESP_OK;
    if (s_target == T_FIRMWARE) {
        e = esp_ota_write(s_handle, data, len);
    } else if (s_target == T_APP) {
        if (s_written == 0) web_unmount_app();
        // Erase sectors just ahead of the data, so a refused file never touches flash.
        while (s_erased < s_written + len) {
            if ((e = esp_partition_erase_range(s_part, s_erased, SECTOR)) != ESP_OK) break;
            s_erased += SECTOR;
        }
        if (e == ESP_OK) e = esp_partition_write(s_part, s_written, data, len);
    } else {
        snprintf(err, cap, "No update in progress.");
        return false;
    }
    if (e != ESP_OK) {
        snprintf(err, cap, "Flash write failed (%s).", esp_err_to_name(e));
        return false;
    }
    s_written += len;
    return true;
}

bool ota_finish(char *err, size_t cap)
{
    if (s_target == T_FIRMWARE) {
        s_target = T_NONE;
        esp_err_t e = esp_ota_end(s_handle);  // verifies the image (and its hash)
        if (e != ESP_OK) {
            snprintf(err, cap, "The firmware didn't verify (%s). Still running the old one.", esp_err_to_name(e));
            return false;
        }
        s_staged = s_part;
    } else if (s_target == T_APP) {
        s_target = T_NONE;
        // Clear the rest of the partition so LittleFS sees no stale blocks.
        if (s_erased < s_part->size) esp_partition_erase_range(s_part, s_erased, s_part->size - s_erased);
    } else {
        snprintf(err, cap, "No update in progress.");
        return false;
    }
    return true;
}

void ota_commit(void)
{
    if (s_staged) {
        esp_err_t e = esp_ota_set_boot_partition(s_staged);
        if (e != ESP_OK) ESP_LOGE(TAG, "couldn't switch to the new firmware (%s)", esp_err_to_name(e));
        s_staged = NULL;
    }
    ESP_LOGI(TAG, "update written, restarting");
    schedule_restart();
}

bool ota_end(void *user, char *err, size_t cap)
{
    s_upload = false;
    if (!ota_finish(err, cap)) {
        s_staged = NULL;
        return false;
    }
    ota_commit();
    return true;
}

void ota_abort(void *user)
{
    if (!s_upload) return;  // the GitHub updater's write isn't ours to cancel
    reset();
    s_upload = false;
}

bool ota_reserve(void)
{
    taskENTER_CRITICAL(&s_mux);
    bool ok = !s_reserved && !s_upload;
    if (ok) s_reserved = true;
    taskEXIT_CRITICAL(&s_mux);
    if (ok) s_staged = NULL;
    return ok;
}

void ota_release(void)
{
    reset();
    s_staged = NULL;
    taskENTER_CRITICAL(&s_mux);
    s_reserved = false;
    taskEXIT_CRITICAL(&s_mux);
}

bool ota_begin_reserved(const char *target, uint32_t size, char *err, size_t cap)
{
    if (!s_reserved) {
        snprintf(err, cap, "Not reserved.");
        return false;
    }
    return begin(target, size, err, cap);
}

// ---- rollback ----

static void probation_expired(void *arg)
{
    ESP_LOGE(TAG, "the new firmware never got on Wi-Fi; going back to the previous one");
    esp_ota_mark_app_invalid_rollback_and_reboot();
}

void ota_boot_check(void)
{
    const esp_partition_t *bad = esp_ota_get_last_invalid_partition();
    esp_app_desc_t desc;
    if (bad && esp_ota_get_partition_description(bad, &desc) == ESP_OK) {
        snprintf(s_rolled_back, sizeof s_rolled_back, "%s", desc.version);
        ESP_LOGW(TAG, "firmware %s didn't start properly and was rolled back", s_rolled_back);
    }

    esp_ota_img_states_t st;
    if (esp_ota_get_state_partition(esp_ota_get_running_partition(), &st) != ESP_OK ||
        st != ESP_OTA_IMG_PENDING_VERIFY)
        return;
    s_probation = true;
    const esp_timer_create_args_t args = {.callback = probation_expired, .name = "ota_probation"};
    if (esp_timer_create(&args, &s_probation_timer) == ESP_OK) esp_timer_start_once(s_probation_timer, PROBATION_US);
    ESP_LOGI(TAG, "new firmware on probation until it gets on Wi-Fi or an app connects");
}

static void keep_cb(void *arg)
{
    esp_err_t e = esp_ota_mark_app_valid_cancel_rollback();
    ESP_LOGI(TAG, "new firmware kept (%s): %s", (const char *)arg, esp_err_to_name(e));
}

void ota_mark_healthy(const char *why)
{
    taskENTER_CRITICAL(&s_mux);
    bool was = s_probation;
    s_probation = false;
    taskEXIT_CRITICAL(&s_mux);
    if (!was) return;
    if (s_probation_timer) esp_timer_stop(s_probation_timer);
    // Write otadata from the timer task: the Wi-Fi event loop's stack is small.
    static esp_timer_handle_t t;
    const esp_timer_create_args_t args = {.callback = keep_cb, .arg = (void *)why, .name = "ota_keep"};
    if (esp_timer_create(&args, &t) == ESP_OK) esp_timer_start_once(t, 1000);
    else keep_cb((void *)why);
}

const char *ota_rolled_back_version(void)
{
    return s_rolled_back;
}
