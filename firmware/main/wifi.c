#include "wifi.h"

#include <stdio.h>
#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "nvs.h"

static const char *TAG = "wifi";
static const char *NS = "resonance";

// Copy a C string into a fixed-size Wi-Fi config field (not necessarily NUL-terminated).
static void copy_field(uint8_t *dst, size_t cap, const char *src)
{
    size_t n = strnlen(src, cap);
    memcpy(dst, src, n);
    if (n < cap) dst[n] = 0;
}

static void load_str(nvs_handle_t h, const char *key, char *out, size_t cap)
{
    size_t len = cap;
    if (nvs_get_str(h, key, out, &len) != ESP_OK) out[0] = 0;
}

// First boot: make an 8-character WPA2 password without look-alike characters.
static void ensure_ap_password(nvs_handle_t h, char *out, size_t cap)
{
    load_str(h, "ap_pass", out, cap);
    if (strlen(out) >= 8) return;
    static const char alphabet[] = "abcdefghjkmnpqrstuvwxyz23456789";
    for (int i = 0; i < 8; i++) out[i] = alphabet[esp_random() % (sizeof alphabet - 1)];
    out[8] = 0;
    nvs_set_str(h, "ap_pass", out);
    nvs_commit(h);
}

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        esp_wifi_connect();  // keep trying; the AP stays up regardless
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = data;
        ESP_LOGI(TAG, "joined home Wi-Fi as " IPSTR, IP2STR(&e->ip_info.ip));
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_AP_STACONNECTED) {
        ESP_LOGI(TAG, "a phone joined the Resonance network");
    }
}

void wifi_start(void)
{
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_ap();
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL));

    nvs_handle_t h;
    ESP_ERROR_CHECK(nvs_open(NS, NVS_READWRITE, &h));
    char ap_pass[65], sta_ssid[33], sta_pass[65], mode[8];
    ensure_ap_password(h, ap_pass, sizeof ap_pass);
    load_str(h, "sta_ssid", sta_ssid, sizeof sta_ssid);
    load_str(h, "sta_pass", sta_pass, sizeof sta_pass);
    load_str(h, "mode", mode, sizeof mode);
    nvs_close(h);
    bool use_sta = strcmp(mode, "sta") == 0 && sta_ssid[0];

    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
    wifi_config_t ap = {0};
    char ssid[16];
    snprintf(ssid, sizeof ssid, "Resonance-%02X%02X", mac[4], mac[5]);
    copy_field(ap.ap.ssid, sizeof ap.ap.ssid, ssid);
    ap.ap.ssid_len = (uint8_t)strlen(ssid);
    copy_field(ap.ap.password, sizeof ap.ap.password, ap_pass);
    ap.ap.channel = 6;
    ap.ap.max_connection = 4;
    ap.ap.authmode = WIFI_AUTH_WPA2_PSK;

    ESP_ERROR_CHECK(esp_wifi_set_mode(use_sta ? WIFI_MODE_APSTA : WIFI_MODE_AP));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap));
    if (use_sta) {
        wifi_config_t sta = {0};
        copy_field(sta.sta.ssid, sizeof sta.sta.ssid, sta_ssid);
        copy_field(sta.sta.password, sizeof sta.sta.password, sta_pass);
        ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &sta));
    }
    ESP_ERROR_CHECK(esp_wifi_start());
    if (use_sta) esp_wifi_connect();

    ESP_LOGI(TAG, "----------------------------------------------");
    ESP_LOGI(TAG, " Wi-Fi network: %s", ssid);
    ESP_LOGI(TAG, " Password:      %s", ap_pass);
    ESP_LOGI(TAG, " Then open:     http://192.168.4.1/");
    ESP_LOGI(TAG, "----------------------------------------------");
}

static void restart_cb(void *arg)
{
    esp_restart();
}

bool wifi_save_and_restart(bool sta, const char *ssid, const char *password)
{
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return false;
    bool ok = nvs_set_str(h, "mode", sta ? "sta" : "ap") == ESP_OK;
    if (sta) {
        ok = ok && nvs_set_str(h, "sta_ssid", ssid) == ESP_OK;
        ok = ok && nvs_set_str(h, "sta_pass", password) == ESP_OK;
    }
    ok = ok && nvs_commit(h) == ESP_OK;
    nvs_close(h);
    if (!ok) return false;
    // Restart after the "ok" reply has gone out.
    static esp_timer_handle_t t = NULL;
    const esp_timer_create_args_t args = {.callback = restart_cb, .name = "wifi_restart"};
    if (!t && esp_timer_create(&args, &t) != ESP_OK) return false;
    esp_timer_start_once(t, 800 * 1000);
    return true;
}
