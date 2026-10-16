#include "ota.h"

#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "web.h"

static const char *TAG = "ota";

#define SECTOR 4096

static enum { T_NONE, T_FIRMWARE, T_APP } s_target = T_NONE;
static esp_ota_handle_t s_handle;
static const esp_partition_t *s_part;
static uint32_t s_size, s_written, s_erased;

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

bool ota_begin(void *user, const char *target, uint32_t size, char *err, size_t cap)
{
    ota_abort(user);
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

bool ota_end(void *user, char *err, size_t cap)
{
    if (s_target == T_FIRMWARE) {
        s_target = T_NONE;
        esp_err_t e = esp_ota_end(s_handle);  // verifies the image (and its hash)
        if (e == ESP_OK) e = esp_ota_set_boot_partition(s_part);
        if (e != ESP_OK) {
            snprintf(err, cap, "The firmware didn't verify (%s). Still running the old one.", esp_err_to_name(e));
            return false;
        }
    } else if (s_target == T_APP) {
        s_target = T_NONE;
        // Clear the rest of the partition so LittleFS sees no stale blocks.
        if (s_erased < s_part->size) esp_partition_erase_range(s_part, s_erased, s_part->size - s_erased);
    } else {
        snprintf(err, cap, "No update in progress.");
        return false;
    }
    ESP_LOGI(TAG, "update written, restarting");
    schedule_restart();
    return true;
}

void ota_abort(void *user)
{
    if (s_target == T_FIRMWARE) esp_ota_abort(s_handle);
    if (s_target == T_APP && s_written > 0) {
        ESP_LOGW(TAG, "web app update interrupted; /update stays available to retry");
    }
    s_target = T_NONE;
}
