// Resonance bridge: NanoVNA (USB host) <-> bridge core <-> phone (Wi-Fi WebSocket).
// Hardware-free tests of the same core run on the host: see firmware/host and emulator/.
#include "bridge_task.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "status_led.h"
#include "usb_link.h"
#include "web.h"
#include "wifi.h"

void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    ESP_LOGI("resonance", "Resonance bridge %s starting", RC_BRIDGE_VERSION);
    bridge_task_start();
    status_led_start();
    wifi_start();
    web_start();
    usb_link_start();
}
