#include "battery.h"

#include "driver/gpio.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

// Wiring: battery + -- 100k -- GPIO1 -- 100k -- GND. Any ADC1 pin works (GPIO1-10); avoid the
// strapping pins. The divider halves the cell's 3.0-4.2 V to 1.5-2.1 V, inside the ADC's range.
#ifndef RESONANCE_BATTERY_GPIO
#define RESONANCE_BATTERY_GPIO 1
#endif
// (top + bottom) / bottom
#ifndef RESONANCE_BATTERY_DIVIDER
#define RESONANCE_BATTERY_DIVIDER 2.0f
#endif

#define SAMPLES 16
#define NOTHING_WIRED_MV 300  // at the pin, with the internal pull-down on
#define MIN_CELL_MV 2500
#define MAX_CELL_MV 4600

static const char *TAG = "battery";
static adc_oneshot_unit_handle_t s_adc;
static adc_channel_t s_chan;
static adc_cali_handle_t s_cali;
static bool s_ready;

void battery_init(void)
{
    adc_unit_t unit;
    if (adc_oneshot_io_to_channel(RESONANCE_BATTERY_GPIO, &unit, &s_chan) != ESP_OK || unit != ADC_UNIT_1) {
        ESP_LOGW(TAG, "GPIO%d isn't an ADC1 pin; no battery reading", RESONANCE_BATTERY_GPIO);
        return;
    }
    adc_oneshot_unit_init_cfg_t ucfg = {.unit_id = ADC_UNIT_1};
    if (adc_oneshot_new_unit(&ucfg, &s_adc) != ESP_OK) return;
    adc_oneshot_chan_cfg_t ccfg = {.atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_DEFAULT};
    if (adc_oneshot_config_channel(s_adc, s_chan, &ccfg) != ESP_OK) return;
    adc_cali_curve_fitting_config_t cal = {
        .unit_id = ADC_UNIT_1, .chan = s_chan, .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_DEFAULT};
    if (adc_cali_create_scheme_curve_fitting(&cal, &s_cali) != ESP_OK) s_cali = NULL;
    s_ready = true;
}

// Average voltage at the pin, mV.
static int pin_mv(void)
{
    int sum = 0, n = 0;
    for (int i = 0; i < SAMPLES; i++) {
        int raw;
        if (adc_oneshot_read(s_adc, s_chan, &raw) != ESP_OK) continue;
        int mv;
        if (!s_cali || adc_cali_raw_to_voltage(s_cali, raw, &mv) != ESP_OK) mv = raw * 3100 / 4095;
        sum += mv;
        n++;
    }
    return n ? sum / n : 0;
}

bool battery_read_mv(uint16_t *mv)
{
    if (!s_ready) return false;
    // With nothing wired the pin floats and reads anything. The internal pull-down (about 45k)
    // drags a floating pin to 0 V but only pulls a wired divider down to roughly half, so a
    // reading with it on tells the two apart.
    gpio_pulldown_en(RESONANCE_BATTERY_GPIO);
    vTaskDelay(pdMS_TO_TICKS(2));
    int pulled = pin_mv();
    gpio_pulldown_dis(RESONANCE_BATTERY_GPIO);
    vTaskDelay(pdMS_TO_TICKS(2));
    if (pulled < NOTHING_WIRED_MV) return false;
    int cell = (int)(pin_mv() * RESONANCE_BATTERY_DIVIDER + 0.5f);
    if (cell < MIN_CELL_MV || cell > MAX_CELL_MV) return false;
    *mv = (uint16_t)cell;
    return true;
}
