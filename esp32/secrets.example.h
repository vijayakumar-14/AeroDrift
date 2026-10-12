#pragma once
#include <stdint.h>

// Copy this file to secrets.h and edit it before compiling.
// The ESP32 sketches only need the wireless channel and the ground receiver MAC.
// Keep this header out of public Git repositories.

#define ESPNOW_WIFI_CHANNEL 6

// Replace these six bytes with the ground receiver ESP32 station MAC address
// printed by ground_receiver.ino at startup, e.g. {0xAA, 0xBB, 0xCC, 0x11, 0x22, 0x33}.
static const uint8_t GROUND_RECEIVER_MAC[6] = {0xAA, 0xBB, 0xCC, 0x11, 0x22, 0x33};
