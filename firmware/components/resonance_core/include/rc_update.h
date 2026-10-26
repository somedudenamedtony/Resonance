// Updates from GitHub releases: the pieces that don't need a network, so the host tests cover
// them. The ESP32 side (firmware/main/release_update.c) does the fetching and flashing.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Release assets the bridge installs, by file name.
#define RC_ASSET_FIRMWARE "resonance-bridge.bin"
#define RC_ASSET_APP "littlefs.bin"

typedef struct {
    char url[256];
    uint32_t size;
} rc_asset_t;

typedef struct {
    char version[24];  // tag without the leading "v"
    rc_asset_t firmware;
    rc_asset_t app;
} rc_release_t;

// Compare dotted versions ("0.4.0", "v0.10.1"). A pre-release ("0.4.0-beta") sorts before the
// release itself. Returns <0, 0 or >0 like strcmp.
int rc_version_compare(const char *a, const char *b);

// Read GitHub's "latest release" JSON. False (with `err` filled) if it isn't usable: no tag,
// or either asset missing.
bool rc_release_parse(const char *json, size_t len, rc_release_t *out, char *err, size_t err_cap);

// Cheap check on an image's first bytes, so a wrong file is refused before anything is erased.
// `target` is "firmware" or "app".
bool rc_image_magic_ok(const char *target, const uint8_t *d, size_t n);

#ifdef __cplusplus
}
#endif
