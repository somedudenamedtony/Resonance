// The bridge's own battery, read through a resistor divider on an ADC pin.
#pragma once

#include <stdbool.h>
#include <stdint.h>

// Set up the ADC. Safe to call with nothing wired.
void battery_init(void);

// Battery voltage in millivolts. False when no divider is wired (or the reading makes no sense).
bool battery_read_mv(uint16_t *mv);
