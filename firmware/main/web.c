#include "web.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

#include "bridge_task.h"
#include "esp_http_server.h"
#include "esp_littlefs.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char *TAG = "web";

#define FS_BASE "/www"
#define MAX_CLIENTS 4

static httpd_handle_t s_server = NULL;
static SemaphoreHandle_t s_lock;
static int s_clients[MAX_CLIENTS] = {-1, -1, -1, -1};

// ---- client list ----

static void add_client(int fd)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    int slot = -1;
    for (int i = 0; i < MAX_CLIENTS; i++) {
        if (s_clients[i] == fd) slot = i;
        else if (slot < 0 && s_clients[i] < 0) slot = i;
    }
    if (slot < 0) {
        // Full: the newest client takes over the oldest slot.
        httpd_sess_trigger_close(s_server, s_clients[0]);
        slot = 0;
    }
    s_clients[slot] = fd;
    xSemaphoreGive(s_lock);
}

static void remove_client(int fd)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    for (int i = 0; i < MAX_CLIENTS; i++)
        if (s_clients[i] == fd) s_clients[i] = -1;
    xSemaphoreGive(s_lock);
}

static void on_close(httpd_handle_t hd, int fd)
{
    remove_client(fd);
    close(fd);  // with a close_fn set, closing the socket is ours to do
}

static void broadcast(httpd_ws_type_t type, const uint8_t *data, size_t len)
{
    if (!s_server) return;
    httpd_ws_frame_t frame = {.final = true, .type = type, .payload = (uint8_t *)data, .len = len};
    xSemaphoreTake(s_lock, portMAX_DELAY);
    for (int i = 0; i < MAX_CLIENTS; i++) {
        int fd = s_clients[i];
        if (fd < 0) continue;
        if (httpd_ws_get_fd_info(s_server, fd) != HTTPD_WS_CLIENT_WEBSOCKET) {
            s_clients[i] = -1;
            continue;
        }
        if (httpd_ws_send_frame_async(s_server, fd, &frame) != ESP_OK) {
            ESP_LOGW(TAG, "send to client %d failed", fd);
        }
    }
    xSemaphoreGive(s_lock);
}

void web_broadcast_text(const char *json)
{
    broadcast(HTTPD_WS_TYPE_TEXT, (const uint8_t *)json, strlen(json));
}

void web_broadcast_binary(const uint8_t *data, size_t len)
{
    broadcast(HTTPD_WS_TYPE_BINARY, data, len);
}

// ---- WebSocket ----

static esp_err_t ws_handler(httpd_req_t *req)
{
    if (req->method == HTTP_GET) {
        // Handshake complete.
        add_client(httpd_req_to_sockfd(req));
        bridge_post_client_connected();
        return ESP_OK;
    }
    httpd_ws_frame_t pkt = {0};
    esp_err_t err = httpd_ws_recv_frame(req, &pkt, 0);  // length only
    if (err != ESP_OK) return err;
    if (pkt.len > 4096) return ESP_FAIL;
    uint8_t *buf = malloc(pkt.len + 1);
    if (!buf) return ESP_ERR_NO_MEM;
    pkt.payload = buf;
    err = httpd_ws_recv_frame(req, &pkt, pkt.len);
    if (err == ESP_OK && pkt.type == HTTPD_WS_TYPE_TEXT) {
        buf[pkt.len] = 0;
        bridge_post_client_text((const char *)buf, pkt.len);
    }
    free(buf);
    return err;
}

// ---- static files ----

static const char *content_type(const char *path)
{
    const char *ext = strrchr(path, '.');
    if (!ext) return "application/octet-stream";
    if (!strcmp(ext, ".html")) return "text/html; charset=utf-8";
    if (!strcmp(ext, ".js")) return "text/javascript";
    if (!strcmp(ext, ".css")) return "text/css";
    if (!strcmp(ext, ".svg")) return "image/svg+xml";
    if (!strcmp(ext, ".png")) return "image/png";
    if (!strcmp(ext, ".json")) return "application/json";
    if (!strcmp(ext, ".webmanifest")) return "application/manifest+json";
    return "application/octet-stream";
}

static bool is_file(const char *path)
{
    struct stat st;
    return stat(path, &st) == 0 && S_ISREG(st.st_mode);
}

static esp_err_t file_handler(httpd_req_t *req)
{
    char uri[128];
    size_t n = strcspn(req->uri, "?#");
    if (n >= sizeof uri) return httpd_resp_send_err(req, HTTPD_414_URI_TOO_LONG, "URI too long");
    memcpy(uri, req->uri, n);
    uri[n] = 0;
    if (strstr(uri, "..")) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad path");

    char path[160];
    snprintf(path, sizeof path, FS_BASE "%s", strcmp(uri, "/") == 0 ? "/index.html" : uri);
    if (!is_file(path)) snprintf(path, sizeof path, FS_BASE "/index.html");  // single-page app
    FILE *f = fopen(path, "rb");
    if (!f) {
        httpd_resp_set_type(req, "text/plain");
        return httpd_resp_sendstr(req, "Resonance bridge is running, but the web app isn't on flash yet.\n"
                                       "Build it (npm run build) and flash the littlefs partition.\n");
    }
    httpd_resp_set_type(req, content_type(path));
    // Hashed asset names change on every build, so they can be cached hard.
    if (strstr(path, "/assets/")) httpd_resp_set_hdr(req, "Cache-Control", "public, max-age=31536000, immutable");
    else httpd_resp_set_hdr(req, "Cache-Control", "no-cache");

    char chunk[2048];
    size_t r;
    esp_err_t err = ESP_OK;
    while ((r = fread(chunk, 1, sizeof chunk, f)) > 0) {
        if ((err = httpd_resp_send_chunk(req, chunk, r)) != ESP_OK) break;
    }
    fclose(f);
    if (err == ESP_OK) err = httpd_resp_send_chunk(req, NULL, 0);
    return err;
}

void web_start(void)
{
    s_lock = xSemaphoreCreateMutex();

    esp_vfs_littlefs_conf_t fs = {
        .base_path = FS_BASE,
        .partition_label = "littlefs",
        .format_if_mount_failed = false,
        .dont_mount = false,
    };
    esp_err_t err = esp_vfs_littlefs_register(&fs);
    if (err != ESP_OK) ESP_LOGW(TAG, "web app partition not mounted (%s); serving a placeholder", esp_err_to_name(err));

    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.uri_match_fn = httpd_uri_match_wildcard;
    cfg.close_fn = on_close;
    cfg.lru_purge_enable = true;
    cfg.max_open_sockets = 7;
    cfg.stack_size = 8192;
    ESP_ERROR_CHECK(httpd_start(&s_server, &cfg));

    const httpd_uri_t ws = {
        .uri = "/ws",
        .method = HTTP_GET,
        .handler = ws_handler,
        .is_websocket = true,
    };
    const httpd_uri_t files = {.uri = "/*", .method = HTTP_GET, .handler = file_handler};
    httpd_register_uri_handler(s_server, &ws);
    httpd_register_uri_handler(s_server, &files);
    ESP_LOGI(TAG, "HTTP on port 80, WebSocket at /ws");
}
