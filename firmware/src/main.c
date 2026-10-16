// Resonance bridge — M0 placeholder.
//
// M1 replaces this with: USB host CDC-ACM to the NanoVNA, Wi-Fi AP, HTTP server for the
// app bundle on LittleFS, and a WebSocket relay at /ws. See firmware/README.md and
// docs/PROTOCOL.md. Not yet built or flashed on hardware.

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "resonance";

void app_main(void)
{
    ESP_LOGI(TAG, "Resonance bridge firmware placeholder (M0)");
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(5000));
        ESP_LOGI(TAG, "alive");
    }
}
