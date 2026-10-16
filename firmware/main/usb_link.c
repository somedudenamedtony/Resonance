#include "usb_link.h"

#include "bridge_task.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "usb/cdc_acm_host.h"
#include "usb/usb_host.h"

static const char *TAG = "usb";

// Most NanoVNAs (STM32 virtual COM port). Any CDC-ACM device is accepted as a fallback.
#define NANOVNA_VID 0x0483
#define NANOVNA_PID 0x5740

static SemaphoreHandle_t s_lock;          // guards s_dev
static SemaphoreHandle_t s_disconnected;  // given when the device goes away
static cdc_acm_dev_hdl_t s_dev = NULL;

static bool on_rx(const uint8_t *data, size_t len, void *arg)
{
    bridge_post_serial(data, len);
    return true;
}

static void on_event(const cdc_acm_host_dev_event_data_t *event, void *arg)
{
    switch (event->type) {
    case CDC_ACM_HOST_ERROR:
        ESP_LOGE(TAG, "CDC-ACM error %d", event->data.error);
        break;
    case CDC_ACM_HOST_DEVICE_DISCONNECTED:
        ESP_LOGI(TAG, "NanoVNA disconnected");
        xSemaphoreTake(s_lock, portMAX_DELAY);
        s_dev = NULL;
        xSemaphoreGive(s_lock);
        cdc_acm_host_close(event->data.cdc_hdl);
        xSemaphoreGive(s_disconnected);
        break;
    default:
        break;
    }
}

void usb_link_write(const uint8_t *data, size_t len)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    cdc_acm_dev_hdl_t dev = s_dev;
    if (dev) {
        esp_err_t err = cdc_acm_host_data_tx_blocking(dev, data, len, 1000);
        if (err != ESP_OK) ESP_LOGW(TAG, "write failed: %s", esp_err_to_name(err));
    }
    xSemaphoreGive(s_lock);
}

static void usb_lib_task(void *arg)
{
    for (;;) {
        uint32_t flags;
        usb_host_lib_handle_events(portMAX_DELAY, &flags);
        if (flags & USB_HOST_LIB_EVENT_FLAGS_NO_CLIENTS) usb_host_device_free_all();
    }
}

static esp_err_t open_device(cdc_acm_dev_hdl_t *out)
{
    const cdc_acm_host_device_config_t cfg = {
        .connection_timeout_ms = 1000,
        .out_buffer_size = 512,
        .in_buffer_size = 0,
        .event_cb = on_event,
        .data_cb = on_rx,
        .user_arg = NULL,
    };
    esp_err_t err = cdc_acm_host_open(NANOVNA_VID, NANOVNA_PID, 0, &cfg, out);
    if (err == ESP_ERR_NOT_FOUND) err = cdc_acm_host_open(CDC_HOST_ANY_VID, CDC_HOST_ANY_PID, 0, &cfg, out);
    return err;
}

static void link_task(void *arg)
{
    for (;;) {
        cdc_acm_dev_hdl_t dev = NULL;
        if (open_device(&dev) != ESP_OK) continue;  // timed out waiting for a device; try again

        cdc_acm_line_coding_t coding = {.dwDTERate = 115200, .bCharFormat = 0, .bParityType = 0, .bDataBits = 8};
        cdc_acm_host_line_coding_set(dev, &coding);    // ignored by most NanoVNAs, harmless
        cdc_acm_host_set_control_line_state(dev, true, true);
        cdc_acm_host_desc_print(dev);

        xSemaphoreTake(s_lock, portMAX_DELAY);
        s_dev = dev;
        xSemaphoreGive(s_lock);
        ESP_LOGI(TAG, "NanoVNA connected");
        bridge_post_attached();

        xSemaphoreTake(s_disconnected, portMAX_DELAY);
        bridge_post_detached();
    }
}

void usb_link_start(void)
{
    s_lock = xSemaphoreCreateMutex();
    s_disconnected = xSemaphoreCreateBinary();

    const usb_host_config_t host_config = {
        .skip_phy_setup = false,
        .intr_flags = ESP_INTR_FLAG_LEVEL1,
    };
    ESP_ERROR_CHECK(usb_host_install(&host_config));
    xTaskCreatePinnedToCore(usb_lib_task, "usb_lib", 4096, NULL, 10, NULL, 0);
    ESP_ERROR_CHECK(cdc_acm_host_install(NULL));
    xTaskCreatePinnedToCore(link_task, "usb_link", 4096, NULL, 6, NULL, 0);
    ESP_LOGI(TAG, "USB host ready; plug the NanoVNA into the port labeled USB");
}
