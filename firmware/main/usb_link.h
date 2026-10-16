// USB host link to the NanoVNA (CDC-ACM) on the ESP32-S3's native USB port.
#pragma once

#include <stddef.h>
#include <stdint.h>

void usb_link_start(void);
// Write to the NanoVNA; no-op when it isn't connected.
void usb_link_write(const uint8_t *data, size_t len);
