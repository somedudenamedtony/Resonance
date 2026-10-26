// Updates over Wi-Fi: firmware into the inactive OTA slot, or the web app into the LittleFS
// partition. The ota_* hooks are called by the bridge core (see rc_bridge.h) for file uploads;
// release_update.c uses the same writer for updates downloaded from GitHub.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

bool ota_begin(void *user, const char *target, uint32_t size, char *err, size_t cap);
bool ota_write(void *user, const uint8_t *data, size_t len, char *err, size_t cap);
bool ota_end(void *user, char *err, size_t cap);
void ota_abort(void *user);

// For the GitHub updater, which installs firmware and app together and restarts once.
// ota_reserve keeps file uploads out until ota_release; ota_begin_reserved / ota_write /
// ota_finish then write an image without switching to it, and ota_commit switches to the
// verified firmware (if one was written) and restarts.
bool ota_reserve(void);
void ota_release(void);
bool ota_begin_reserved(const char *target, uint32_t size, char *err, size_t cap);
bool ota_finish(char *err, size_t cap);
void ota_commit(void);

// Rollback. After an update the new firmware is on probation: if it restarts before
// ota_mark_healthy, the bootloader goes back to the previous firmware, and so does a timer if
// it never becomes healthy. Healthy means reachable for another update: joined home Wi-Fi, or
// an app connected.
void ota_boot_check(void);
void ota_mark_healthy(const char *why);
// A version that didn't start properly and was rolled back, or "" (for the app).
const char *ota_rolled_back_version(void);
