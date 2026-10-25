// Wi-Fi: always runs an access point (Resonance-XXXX). If home Wi-Fi is configured it also
// joins it (AP+STA), so the bridge stays reachable in the field and at home.
#pragma once

#include <stdbool.h>

#include "rc_bridge.h"

void wifi_start(void);
// Save new settings to NVS and restart shortly after. Returns false on a storage error.
bool wifi_save_and_restart(bool sta, const char *ssid, const char *password);
// Current Wi-Fi status for the app: whether home Wi-Fi joined, its IP, and why not if it didn't.
// Safe to call from any task.
void wifi_get_status(rc_wifi_status_t *out);
