// HTTP server: serves the web app from LittleFS and the protocol WebSocket at /ws.
#pragma once

#include <stddef.h>
#include <stdint.h>

void web_start(void);
void web_broadcast_text(const char *json);
void web_broadcast_binary(const uint8_t *data, size_t len);
// Unmount the web app filesystem before its partition is rewritten.
void web_unmount_app(void);
