#include "wifi.h"

#include <stdio.h>
#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "mdns.h"
#include "nvs.h"
#include "ota.h"

static const char *TAG = "wifi";
static const char *NS = "resonance";

// Events of our own, so every decision about which network to join runs on the event loop task.
ESP_EVENT_DEFINE_BASE(RC_WIFI_EVENT);
enum { RC_WIFI_EVENT_KICK };

#define RETRY_MIN_MS 2000
#define RETRY_MAX_MS 60000
#define SCAN_MAX_RECORDS 24

typedef struct {
    char ssid[33];
    char pass[65];
} network_t;

// Shared between the bridge task (add/forget, status) and the event loop.
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;
static rc_wifi_status_t s_status;
static network_t s_nets[RC_WIFI_MAX_NETWORKS];
static int s_n_nets;
static bool s_list_changed;  // add/forget happened; the event loop rechecks what it's joined to

// Event loop only.
static bool s_scanning;
static bool s_joining;      // esp_wifi_connect issued, waiting for an address or a disconnect
static bool s_connected;    // has an IP address
static char s_joined[33];   // the network being joined or joined
static uint8_t s_fails[RC_WIFI_MAX_NETWORKS];  // consecutive failures, so a bad one doesn't block the rest
static int s_rotate;        // next network to try blind when a scan sees none (hidden networks)
static uint32_t s_retry_ms;
static esp_timer_handle_t s_retry_timer;

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

// The hotspot password is fixed so anyone can join without the serial log. Bridges from
// 0.5.0 and earlier stored a random one under "ap_pass"; drop it so they switch too.
#define AP_PASSWORD "Resonance"

static void forget_old_ap_password(nvs_handle_t h)
{
    if (nvs_erase_key(h, "ap_pass") == ESP_OK) nvs_commit(h);
}

// ---- saved networks (NVS) ----
//
// "n_count" and "n<i>_ssid"/"n<i>_pass" hold the list. "mode", "sta_ssid" and "sta_pass" are the
// single network older firmware used: they're read once to migrate, and kept pointing at the
// first network so a rollback to older firmware still joins one of them.

static void key(char *out, int i, const char *what)
{
    snprintf(out, 12, "n%d_%s", i, what);
}

static void load_networks(nvs_handle_t h)
{
    uint8_t count = 0;
    if (nvs_get_u8(h, "n_count", &count) == ESP_OK) {
        for (int i = 0; i < count && i < RC_WIFI_MAX_NETWORKS; i++) {
            char k[12];
            key(k, i, "ssid");
            load_str(h, k, s_nets[s_n_nets].ssid, sizeof s_nets[0].ssid);
            key(k, i, "pass");
            load_str(h, k, s_nets[s_n_nets].pass, sizeof s_nets[0].pass);
            if (s_nets[s_n_nets].ssid[0]) s_n_nets++;
        }
        return;
    }
    char mode[8];
    load_str(h, "mode", mode, sizeof mode);
    load_str(h, "sta_ssid", s_nets[0].ssid, sizeof s_nets[0].ssid);
    load_str(h, "sta_pass", s_nets[0].pass, sizeof s_nets[0].pass);
    if (strcmp(mode, "sta") == 0 && s_nets[0].ssid[0]) {
        s_n_nets = 1;
        ESP_LOGI(TAG, "moved saved network %s into the list", s_nets[0].ssid);
    }
}

static bool save_networks(const network_t *nets, int n)
{
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return false;
    bool ok = true;
    for (int i = 0; i < RC_WIFI_MAX_NETWORKS; i++) {
        char k[12];
        if (i < n) {
            key(k, i, "ssid");
            ok = ok && nvs_set_str(h, k, nets[i].ssid) == ESP_OK;
            key(k, i, "pass");
            ok = ok && nvs_set_str(h, k, nets[i].pass) == ESP_OK;
        } else {
            key(k, i, "ssid");
            nvs_erase_key(h, k);
            key(k, i, "pass");
            nvs_erase_key(h, k);
        }
    }
    ok = ok && nvs_set_u8(h, "n_count", (uint8_t)n) == ESP_OK;
    ok = ok && nvs_set_str(h, "mode", n ? "sta" : "ap") == ESP_OK;
    if (n) {
        ok = ok && nvs_set_str(h, "sta_ssid", nets[0].ssid) == ESP_OK;
        ok = ok && nvs_set_str(h, "sta_pass", nets[0].pass) == ESP_OK;
    }
    ok = ok && nvs_commit(h) == ESP_OK;
    nvs_close(h);
    return ok;
}

// ---- joining (event loop) ----

// Plain words for why joining a network failed.
static void describe_reason(uint8_t reason, char *out, size_t cap)
{
    switch (reason) {
    case WIFI_REASON_NO_AP_FOUND:
        snprintf(out, cap, "Network not found. Check the name, and that it's 2.4 GHz.");
        break;
    case WIFI_REASON_AUTH_FAIL:
    case WIFI_REASON_AUTH_EXPIRE:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_MIC_FAILURE:
        snprintf(out, cap, "The network rejected the password.");
        break;
    case WIFI_REASON_BEACON_TIMEOUT:
        snprintf(out, cap, "Lost the network. The signal may be too weak.");
        break;
    case WIFI_REASON_ASSOC_FAIL:
    case WIFI_REASON_CONNECTION_FAIL:
        snprintf(out, cap, "The network refused the connection.");
        break;
    default:
        snprintf(out, cap, "Disconnected (reason %u).", (unsigned)reason);
        break;
    }
}

static void set_status(rc_wifi_state_t state, const char *ssid, const char *reason)
{
    taskENTER_CRITICAL(&s_lock);
    s_status.state = state;
    copy_field((uint8_t *)s_status.ssid, sizeof s_status.ssid - 1, ssid);
    s_status.ssid[sizeof s_status.ssid - 1] = 0;
    if (state != RC_WIFI_CONNECTED) s_status.ip[0] = 0;
    if (reason) {
        copy_field((uint8_t *)s_status.reason, sizeof s_status.reason - 1, reason);
        s_status.reason[sizeof s_status.reason - 1] = 0;
    }
    taskEXIT_CRITICAL(&s_lock);
}

static void kick(void)
{
    esp_event_post(RC_WIFI_EVENT, RC_WIFI_EVENT_KICK, NULL, 0, 0);
}

static void retry_cb(void *arg)
{
    kick();
}

// Look again after a pause that grows while nothing works, so scans don't keep interrupting
// phones on the bridge's own network.
static void retry_later(void)
{
    if (s_retry_ms < RETRY_MIN_MS) s_retry_ms = RETRY_MIN_MS;
    esp_timer_stop(s_retry_timer);
    esp_timer_start_once(s_retry_timer, (uint64_t)s_retry_ms * 1000);
    s_retry_ms = s_retry_ms * 2 > RETRY_MAX_MS ? RETRY_MAX_MS : s_retry_ms * 2;
}

static int find_net(const network_t *nets, int n, const char *ssid)
{
    for (int i = 0; i < n; i++)
        if (strcmp(nets[i].ssid, ssid) == 0) return i;
    return -1;
}

static void join(const network_t *net)
{
    wifi_config_t sta = {0};
    copy_field(sta.sta.ssid, sizeof sta.sta.ssid, net->ssid);
    copy_field(sta.sta.password, sizeof sta.sta.password, net->pass);
    sta.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
    sta.sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;
    snprintf(s_joined, sizeof s_joined, "%s", net->ssid);
    esp_wifi_set_config(WIFI_IF_STA, &sta);
    if (esp_wifi_connect() == ESP_OK) {
        s_joining = true;
        set_status(RC_WIFI_CONNECTING, net->ssid, NULL);
        ESP_LOGI(TAG, "joining %s", net->ssid);
    } else {
        retry_later();
    }
}

// Decide what to do next: nothing, drop a network that was forgotten, or look for one to join.
static void on_kick(void)
{
    network_t nets[RC_WIFI_MAX_NETWORKS];
    taskENTER_CRITICAL(&s_lock);
    int n = s_n_nets;
    memcpy(nets, s_nets, sizeof nets);
    bool changed = s_list_changed;
    s_list_changed = false;
    taskEXIT_CRITICAL(&s_lock);
    if (changed) {
        memset(s_fails, 0, sizeof s_fails);
        s_retry_ms = 0;
    }

    if (s_joining || s_connected) {
        if (find_net(nets, n, s_joined) >= 0) return;  // still saved: stay on it
        ESP_LOGI(TAG, "leaving %s, it was forgotten", s_joined);
        s_joined[0] = 0;
        esp_wifi_disconnect();  // the disconnect event comes back here
        return;
    }
    if (n == 0) {
        esp_timer_stop(s_retry_timer);
        set_status(RC_WIFI_OFF, "", "");
        return;
    }
    if (s_scanning) return;
    wifi_scan_config_t scan = {.show_hidden = false};
    if (esp_wifi_scan_start(&scan, false) == ESP_OK) {
        s_scanning = true;
        taskENTER_CRITICAL(&s_lock);
        if (s_status.state == RC_WIFI_OFF) s_status.state = RC_WIFI_CONNECTING;
        taskEXIT_CRITICAL(&s_lock);
    } else {
        retry_later();
    }
}

// Join the saved network in range that has failed least recently, strongest signal first.
static void on_scan_done(void)
{
    s_scanning = false;
    static wifi_ap_record_t recs[SCAN_MAX_RECORDS];
    uint16_t count = SCAN_MAX_RECORDS;
    if (esp_wifi_scan_get_ap_records(&count, recs) != ESP_OK) count = 0;

    network_t nets[RC_WIFI_MAX_NETWORKS];
    taskENTER_CRITICAL(&s_lock);
    int n = s_n_nets;
    memcpy(nets, s_nets, sizeof nets);
    taskEXIT_CRITICAL(&s_lock);
    if (n == 0 || s_joining || s_connected) return;

    int best = -1;
    int8_t best_rssi = -128;
    for (int r = 0; r < count; r++) {
        int i = find_net(nets, n, (const char *)recs[r].ssid);
        if (i < 0) continue;
        if (best < 0 || s_fails[i] < s_fails[best] || (s_fails[i] == s_fails[best] && recs[r].rssi > best_rssi)) {
            best = i;
            best_rssi = recs[r].rssi;
        }
    }
    if (best >= 0) {
        join(&nets[best]);
        return;
    }
    // None seen. A hidden network doesn't show up in scans, so try one directly now and then.
    s_rotate %= n;
    join(&nets[s_rotate++]);
}

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == RC_WIFI_EVENT && id == RC_WIFI_EVENT_KICK) {
        on_kick();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_SCAN_DONE) {
        on_scan_done();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *e = data;
        bool was_connected = s_connected;
        s_joining = false;
        s_connected = false;
        if (!s_joined[0]) {  // left on purpose (forgotten)
            set_status(RC_WIFI_CONNECTING, "", "");
            kick();
            return;
        }
        char why[sizeof s_status.reason];
        describe_reason(e->reason, why, sizeof why);
        taskENTER_CRITICAL(&s_lock);
        int i = find_net(s_nets, s_n_nets, s_joined);
        int n = s_n_nets;
        taskEXIT_CRITICAL(&s_lock);
        if (i >= 0 && s_fails[i] < 255) s_fails[i]++;
        if (e->reason == WIFI_REASON_NO_AP_FOUND && n > 1)
            snprintf(why, sizeof why, "None of the saved networks are in range.");
        set_status(RC_WIFI_FAILED, s_joined, why);
        ESP_LOGW(TAG, "%s: %s", s_joined, why);
        if (was_connected) s_retry_ms = 0;  // dropped after working: look again soon
        retry_later();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = data;
        char ip[sizeof s_status.ip];
        snprintf(ip, sizeof ip, IPSTR, IP2STR(&e->ip_info.ip));
        s_joining = false;
        s_connected = true;
        s_retry_ms = 0;
        memset(s_fails, 0, sizeof s_fails);
        taskENTER_CRITICAL(&s_lock);
        s_status.state = RC_WIFI_CONNECTED;
        memcpy(s_status.ip, ip, sizeof ip);
        s_status.reason[0] = 0;
        taskEXIT_CRITICAL(&s_lock);
        ESP_LOGI(TAG, "joined %s as %s (also http://resonance.local/)", s_joined, ip);
        ota_mark_healthy("joined Wi-Fi");
        kick();  // in case the network was forgotten while joining
    } else if (base == IP_EVENT && id == IP_EVENT_STA_LOST_IP) {
        taskENTER_CRITICAL(&s_lock);
        if (s_status.state == RC_WIFI_CONNECTED) s_status.state = RC_WIFI_CONNECTING;
        s_status.ip[0] = 0;
        taskEXIT_CRITICAL(&s_lock);
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_AP_STACONNECTED) {
        ESP_LOGI(TAG, "a phone joined the Resonance network");
    }
}

// resonance.local on whichever network the bridge is on, so the address doesn't change between
// home, the RV and the bridge's own network.
static void start_mdns(void)
{
    if (mdns_init() != ESP_OK) {
        ESP_LOGW(TAG, "mDNS didn't start; use the IP address instead");
        return;
    }
    mdns_hostname_set("resonance");
    mdns_instance_name_set("Resonance antenna analyzer");
    mdns_service_add(NULL, "_http", "_tcp", 80, NULL, 0);
}

void wifi_start(void)
{
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_ap();
    esp_netif_t *sta_netif = esp_netif_create_default_wifi_sta();
    esp_netif_set_hostname(sta_netif, "resonance");
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_LOST_IP, on_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(RC_WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL));
    const esp_timer_create_args_t targs = {.callback = retry_cb, .name = "wifi_retry"};
    ESP_ERROR_CHECK(esp_timer_create(&targs, &s_retry_timer));

    nvs_handle_t h;
    ESP_ERROR_CHECK(nvs_open(NS, NVS_READWRITE, &h));
    const char *ap_pass = AP_PASSWORD;
    forget_old_ap_password(h);
    load_networks(h);
    nvs_close(h);

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

    taskENTER_CRITICAL(&s_lock);
    snprintf(s_status.ap_ssid, sizeof s_status.ap_ssid, "%s", ssid);
    snprintf(s_status.ap_pass, sizeof s_status.ap_pass, "%s", ap_pass);
    s_status.state = s_n_nets ? RC_WIFI_CONNECTING : RC_WIFI_OFF;
    taskEXIT_CRITICAL(&s_lock);

    // Always AP+STA: networks can be added at any time without a restart.
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap));
    ESP_ERROR_CHECK(esp_wifi_start());
    start_mdns();
    kick();

    ESP_LOGI(TAG, "----------------------------------------------");
    ESP_LOGI(TAG, " Wi-Fi network: %s", ssid);
    ESP_LOGI(TAG, " Password:      %s", ap_pass);
    ESP_LOGI(TAG, " Then open:     http://192.168.4.1/");
    ESP_LOGI(TAG, " Saved networks to join: %d", s_n_nets);
    ESP_LOGI(TAG, "----------------------------------------------");
}

void wifi_get_status(rc_wifi_status_t *out)
{
    taskENTER_CRITICAL(&s_lock);
    *out = s_status;
    out->n_networks = (uint8_t)s_n_nets;
    for (int i = 0; i < s_n_nets; i++) memcpy(out->networks[i], s_nets[i].ssid, sizeof out->networks[i]);
    taskEXIT_CRITICAL(&s_lock);
    out->rssi = 0;
    wifi_ap_record_t ap;
    if (out->state == RC_WIFI_CONNECTED && esp_wifi_sta_get_ap_info(&ap) == ESP_OK) out->rssi = ap.rssi;
}

// Called from the bridge task only, so the list can't change between the copy and the save.
bool wifi_add_network(const char *ssid, const char *password, char *err, size_t err_cap)
{
    network_t nets[RC_WIFI_MAX_NETWORKS];
    taskENTER_CRITICAL(&s_lock);
    int n = s_n_nets;
    memcpy(nets, s_nets, sizeof nets);
    taskEXIT_CRITICAL(&s_lock);

    int i = find_net(nets, n, ssid);
    if (i < 0) {
        if (n >= RC_WIFI_MAX_NETWORKS) {
            snprintf(err, err_cap, "The bridge can save up to %d networks. Remove one first.", RC_WIFI_MAX_NETWORKS);
            return false;
        }
        i = n++;
    }
    snprintf(nets[i].ssid, sizeof nets[i].ssid, "%s", ssid);
    snprintf(nets[i].pass, sizeof nets[i].pass, "%s", password);
    if (!save_networks(nets, n)) {
        snprintf(err, err_cap, "Couldn't save the Wi-Fi network.");
        return false;
    }
    taskENTER_CRITICAL(&s_lock);
    memcpy(s_nets, nets, sizeof nets);
    s_n_nets = n;
    s_list_changed = true;
    taskEXIT_CRITICAL(&s_lock);
    kick();
    return true;
}

bool wifi_forget_network(const char *ssid)
{
    network_t nets[RC_WIFI_MAX_NETWORKS];
    taskENTER_CRITICAL(&s_lock);
    int n = s_n_nets;
    memcpy(nets, s_nets, sizeof nets);
    taskEXIT_CRITICAL(&s_lock);

    if (!ssid[0]) {
        n = 0;
    } else {
        int i = find_net(nets, n, ssid);
        if (i < 0) return true;  // already gone
        memmove(&nets[i], &nets[i + 1], (size_t)(n - i - 1) * sizeof nets[0]);
        n--;
    }
    memset(&nets[n], 0, (size_t)(RC_WIFI_MAX_NETWORKS - n) * sizeof nets[0]);
    if (!save_networks(nets, n)) return false;
    taskENTER_CRITICAL(&s_lock);
    memcpy(s_nets, nets, sizeof nets);
    s_n_nets = n;
    s_list_changed = true;
    taskEXIT_CRITICAL(&s_lock);
    kick();
    return true;
}
