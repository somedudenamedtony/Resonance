// Updates from GitHub releases, in bridge mode (the bridge needs the internet through home
// Wi-Fi). Checks soon after joining home Wi-Fi and twice a day after that; installs when asked.
// Firmware and web app are downloaded and written together, then the bridge restarts once.
#pragma once

#include <stdbool.h>
#include <stddef.h>

#include "rc_bridge.h"

void release_update_start(void);
// Each starts the work in the background; false (with `err`) if it can't start now.
bool release_update_check(char *err, size_t cap);
bool release_update_install(char *err, size_t cap);
// Safe to call from any task.
void release_update_status(rc_update_status_t *out);
