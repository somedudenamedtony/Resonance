#include "bridge_task.h"

#include <stdlib.h>
#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/stream_buffer.h"
#include "freertos/task.h"
#include "ota.h"
#include "usb_link.h"
#include "web.h"
#include "wifi.h"

static const char *TAG = "bridge";

typedef enum { EV_ATTACH, EV_DETACH, EV_CLIENT, EV_TEXT, EV_BINARY } ev_type_t;

typedef struct {
    ev_type_t type;
    char *text;
    size_t len;
} ev_t;

static rc_bridge_t s_bridge;  // ~46 KB, lives in .bss
static QueueHandle_t s_events;
static StreamBufferHandle_t s_serial;
static volatile rc_dev_state_t s_dev_state = RC_DEV_ABSENT;
static volatile bool s_scanning = false;

static uint32_t now_ms(void)
{
    return (uint32_t)(esp_timer_get_time() / 1000);
}

// ---- io callbacks (run on the bridge task) ----

static void io_serial_write(void *u, const uint8_t *d, size_t n)
{
    usb_link_write(d, n);
}

static void io_send_text(void *u, const char *json)
{
    web_broadcast_text(json);
}

static void io_send_binary(void *u, const uint8_t *d, size_t n)
{
    web_broadcast_binary(d, n);
}

static bool io_wifi_set(void *u, bool sta, const char *ssid, const char *pw)
{
    return wifi_save_and_restart(sta, ssid, pw);
}

static void io_wifi_status(void *u, rc_wifi_status_t *out)
{
    wifi_get_status(out);
}

static void io_log(void *u, const char *msg)
{
    ESP_LOGI(TAG, "%s", msg);
}

// ---- posting ----

static void post(ev_type_t type, const char *text, size_t len)
{
    ev_t ev = {.type = type, .text = NULL, .len = len};
    if (text) {
        ev.text = malloc(len + 1);
        if (!ev.text) return;
        memcpy(ev.text, text, len);
        ev.text[len] = 0;
    }
    if (xQueueSend(s_events, &ev, pdMS_TO_TICKS(50)) != pdTRUE) {
        ESP_LOGW(TAG, "event queue full, dropping event %d", type);
        free(ev.text);
    }
}

void bridge_post_serial(const uint8_t *data, size_t len)
{
    size_t sent = xStreamBufferSend(s_serial, data, len, pdMS_TO_TICKS(20));
    if (sent < len) ESP_LOGW(TAG, "serial buffer full, dropped %u bytes", (unsigned)(len - sent));
}

void bridge_post_attached(void) { post(EV_ATTACH, NULL, 0); }
void bridge_post_detached(void) { post(EV_DETACH, NULL, 0); }
void bridge_post_client_connected(void) { post(EV_CLIENT, NULL, 0); }
void bridge_post_client_text(const char *json, size_t len) { post(EV_TEXT, json, len); }
void bridge_post_client_binary(const uint8_t *data, size_t len) { post(EV_BINARY, (const char *)data, len); }

rc_dev_state_t bridge_device_state(void) { return s_dev_state; }
bool bridge_is_scanning(void) { return s_scanning; }

// ---- task ----

static void bridge_task(void *arg)
{
    rc_bridge_io_t io = {
        .serial_write = io_serial_write,
        .send_text = io_send_text,
        .send_binary = io_send_binary,
        .wifi_set = io_wifi_set,
        .wifi_status = io_wifi_status,
        .log = io_log,
        .ota_begin = ota_begin,
        .ota_write = ota_write,
        .ota_end = ota_end,
        .ota_abort = ota_abort,
    };
    rc_bridge_init(&s_bridge, &io, now_ms());
    ESP_LOGI(TAG, "bridge core %s running", RC_BRIDGE_VERSION);

    uint8_t buf[1024];
    for (;;) {
        ev_t ev;
        if (xQueueReceive(s_events, &ev, pdMS_TO_TICKS(5)) == pdTRUE) {
            uint32_t now = now_ms();
            switch (ev.type) {
            case EV_ATTACH:
                xStreamBufferReset(s_serial);
                rc_bridge_device_attached(&s_bridge, now);
                break;
            case EV_DETACH:
                rc_bridge_device_detached(&s_bridge, now);
                break;
            case EV_CLIENT:
                rc_bridge_client_connected(&s_bridge, now);
                break;
            case EV_TEXT:
                rc_bridge_client_text(&s_bridge, ev.text, ev.len, now);
                break;
            case EV_BINARY:
                rc_bridge_client_binary(&s_bridge, (const uint8_t *)ev.text, ev.len, now);
                break;
            }
            free(ev.text);
        }
        size_t n;
        while ((n = xStreamBufferReceive(s_serial, buf, sizeof buf, 0)) > 0) {
            rc_bridge_serial_rx(&s_bridge, buf, n, now_ms());
        }
        rc_bridge_tick(&s_bridge, now_ms());
        s_dev_state = s_bridge.dev;
        s_scanning = s_bridge.job == RC_JOB_SCAN;
    }
}

void bridge_task_start(void)
{
    s_events = xQueueCreate(32, sizeof(ev_t));
    s_serial = xStreamBufferCreate(16 * 1024, 1);
    xTaskCreatePinnedToCore(bridge_task, "bridge", 8192, NULL, 5, NULL, 1);
}
