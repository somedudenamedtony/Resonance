// Wi-Fi: always runs an access point (Resonance-XXXX). If home Wi-Fi is configured it also
// joins it (AP+STA), so the bridge stays reachable in the field and at home.
#pragma once

#include <stdbool.h>

void wifi_start(void);
// Save new settings to NVS and restart shortly after. Returns false on a storage error.
bool wifi_save_and_restart(bool sta, const char *ssid, const char *password);
