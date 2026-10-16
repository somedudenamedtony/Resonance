#include "status_led.h"

#include "bridge_task.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "led_strip.h"

// GPIO48 on most ESP32-S3-DevKitC-1 boards (some revisions and clones use GPIO38).
#ifndef RESONANCE_LED_GPIO
#define RESONANCE_LED_GPIO 48
#endif

static led_strip_handle_t s_led;

static void set(uint8_t r, uint8_t g, uint8_t b)
{
    led_strip_set_pixel(s_led, 0, r, g, b);
    led_strip_refresh(s_led);
}

static void led_task(void *arg)
{
    for (uint32_t tick = 0;; tick++) {
        bool on = (tick % 10) < 5;  // 1 Hz blink at a 100 ms tick
        switch (bridge_device_state()) {
        case RC_DEV_ABSENT:
            if (on) set(0, 0, 24);
            else set(0, 0, 0);
            break;
        case RC_DEV_PROBING:
            set(0, 0, 24);
            break;
        case RC_DEV_READY:
            if (bridge_is_scanning()) set(on ? 40 : 12, on ? 20 : 6, 0);
            else set(0, 24, 0);
            break;
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

void status_led_start(void)
{
    led_strip_config_t strip = {
        .strip_gpio_num = RESONANCE_LED_GPIO,
        .max_leds = 1,
        .led_model = LED_MODEL_WS2812,
    };
    led_strip_rmt_config_t rmt = {
        .resolution_hz = 10 * 1000 * 1000,
    };
    if (led_strip_new_rmt_device(&strip, &rmt, &s_led) != ESP_OK) {
        ESP_LOGW("led", "status LED not available");
        return;
    }
    led_strip_clear(s_led);
    xTaskCreate(led_task, "led", 3072, NULL, 2, NULL);
}
