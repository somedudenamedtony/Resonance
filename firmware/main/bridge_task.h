// The one task that owns the bridge core. Everything else posts events to it.
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "rc_bridge.h"

void bridge_task_start(void);

// Thread-safe event posting. Data is copied.
void bridge_post_serial(const uint8_t *data, size_t len);
void bridge_post_attached(void);
void bridge_post_detached(void);
void bridge_post_client_connected(void);
void bridge_post_client_text(const char *json, size_t len);
void bridge_post_client_binary(const uint8_t *data, size_t len);

// Read-only snapshot for the status LED.
rc_dev_state_t bridge_device_state(void);
bool bridge_is_scanning(void);
