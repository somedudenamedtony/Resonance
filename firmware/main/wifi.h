// Wi-Fi: always runs an access point (Resonance-XXXX). It also remembers up to
// RC_WIFI_MAX_NETWORKS other networks (home, RV, ...) and joins whichever is in range (AP+STA),
// so the bridge stays reachable in the field and wherever the phone has internet. It answers to
// resonance.local (mDNS) on every network.
#pragma once

#include <stdbool.h>
#include <stddef.h>

#include "rc_bridge.h"

void wifi_start(void);
// Save a network (or a new password for a saved one) and join it if nothing is joined yet. No
// restart. Returns false and fills `err` if the list is full or storage failed.
bool wifi_add_network(const char *ssid, const char *password, char *err, size_t err_cap);
// Forget a saved network, leaving it if it's joined; "" forgets them all. No restart.
bool wifi_forget_network(const char *ssid);
// Current Wi-Fi status for the app: saved networks, which one is joined, its IP, and why not if
// it didn't. Safe to call from any task.
void wifi_get_status(rc_wifi_status_t *out);
