// Updates over Wi-Fi: firmware into the inactive OTA slot, or the web app into the LittleFS
// partition. Called from the bridge core's ota_* hooks (see rc_bridge.h).
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

bool ota_begin(void *user, const char *target, uint32_t size, char *err, size_t cap);
bool ota_write(void *user, const uint8_t *data, size_t len, char *err, size_t cap);
bool ota_end(void *user, char *err, size_t cap);
void ota_abort(void *user);
