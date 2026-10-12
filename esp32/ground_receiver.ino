/*
 * AERODRIFT — ground station ESP-NOW receiver
 * Board assumption: classic ESP32 DevKit (ESP32-WROOM-32), Arduino-ESP32 core 3.x
 * Receives telemetry, then emits one JSON object per line over USB serial at 115200 baud.
 * A laptop bridge forwards those records to Firebase Realtime Database.
 *
 * Telemetry-only. This sketch has no payload-release/cutdown output or relay control.
 */
#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include "secrets.h"

static constexpr uint32_t PACKET_MAGIC = 0xA3D01234;
static constexpr uint32_t SERIAL_BAUD = 115200;

struct __attribute__((packed)) TelemetryPacket {
  uint32_t magic;
  uint32_t sequence;
  uint32_t uptimeMs;
  float latitude;
  float longitude;
  float gpsAltitudeM;
  float pressureHpa;
  float temperatureC;
  float pressureAltitudeM;
  uint8_t gpsFix;
  uint8_t bmpOk;
};

QueueHandle_t telemetryQueue = nullptr;
uint32_t packetsReceived = 0;
uint32_t previousSequence = 0;
uint32_t packetsLost = 0;
uint32_t windowPackets = 0;
uint32_t windowLost = 0;
uint32_t lastRateWindow = 0;
float lastLossPct = 0.0f;

void onDataReceived(const esp_now_recv_info_t *info, const uint8_t *incomingData, int len) {
  (void)info;
  if (!incomingData || len != static_cast<int>(sizeof(TelemetryPacket)) || telemetryQueue == nullptr) return;
  TelemetryPacket packet = {};
  memcpy(&packet, incomingData, sizeof(packet));
  if (packet.magic != PACKET_MAGIC) return;
  // Queue length is one; if USB/network processing is busy, keep the latest valid packet.
  xQueueOverwrite(telemetryQueue, &packet);
}

void printNumberOrNull(float value, uint8_t digits = 2) {
  if (!isfinite(value) || value < -900.0f) Serial.print("null");
  else Serial.print(value, digits);
}

void printTelemetryJson(const TelemetryPacket &packet) {
  ++packetsReceived;
  ++windowPackets;
  if (previousSequence != 0) {
    const uint32_t delta = packet.sequence - previousSequence; // unsigned arithmetic tolerates wraparound
    if (delta > 1 && delta < 100000) {
      const uint32_t missing = delta - 1;
      packetsLost += missing;
      windowLost += missing;
    }
  }
  previousSequence = packet.sequence;
  const uint32_t now = millis();
  if (now - lastRateWindow >= 10000) {
    const uint32_t total = windowPackets + windowLost;
    lastLossPct = total > 0 ? (100.0f * static_cast<float>(windowLost) / static_cast<float>(total)) : 0.0f;
    windowPackets = 0;
    windowLost = 0;
    lastRateWindow = now;
  }

  Serial.print("{\"type\":\"telemetry\",\"sequence\":"); Serial.print(packet.sequence);
  Serial.print(",\"uptimeMs\":"); Serial.print(packet.uptimeMs);
  Serial.print(",\"gpsFix\":"); Serial.print(packet.gpsFix ? "true" : "false");
  Serial.print(",\"lat\":"); if (packet.gpsFix) printNumberOrNull(packet.latitude, 6); else Serial.print("null");
  Serial.print(",\"lon\":"); if (packet.gpsFix) printNumberOrNull(packet.longitude, 6); else Serial.print("null");
  Serial.print(",\"gpsAltitudeM\":"); printNumberOrNull(packet.gpsAltitudeM, 2);
  Serial.print(",\"pressureHpa\":"); printNumberOrNull(packet.pressureHpa, 2);
  Serial.print(",\"temperatureC\":"); printNumberOrNull(packet.temperatureC, 2);
  Serial.print(",\"pressureAltitudeM\":"); printNumberOrNull(packet.pressureAltitudeM, 2);
  Serial.print(",\"bmpOk\":"); Serial.print(packet.bmpOk ? "true" : "false");
  Serial.print(",\"packetCount\":"); Serial.print(packetsReceived);
  Serial.print(",\"packetsLost\":"); Serial.print(packetsLost);
  Serial.print(",\"estimatedPacketLossPct\":"); Serial.print(lastLossPct, 2);
  Serial.print(",\"receiverUptimeMs\":"); Serial.print(now);
  Serial.println("}");
}

void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(500);
  telemetryQueue = xQueueCreate(1, sizeof(TelemetryPacket));
  if (telemetryQueue == nullptr) {
    Serial.println("{\"type\":\"status\",\"event\":\"queue_error\"}");
    while (true) delay(1000);
  }

  WiFi.mode(WIFI_STA);
  WiFi.disconnect(false, true);
  delay(100);
  if (esp_wifi_set_channel(ESPNOW_WIFI_CHANNEL, WIFI_SECOND_CHAN_NONE) != ESP_OK) {
    Serial.println("{\"type\":\"status\",\"event\":\"channel_error\"}");
  }
  if (esp_now_init() != ESP_OK) {
    Serial.println("{\"type\":\"status\",\"event\":\"espnow_init_error\"}");
    while (true) delay(1000);
  }
  esp_now_register_recv_cb(onDataReceived);

  const String mac = WiFi.macAddress();
  Serial.print("{\"type\":\"status\",\"event\":\"ground_ready\",\"mac\":\"");
  Serial.print(mac);
  Serial.print("\",\"channel\":"); Serial.print(ESPNOW_WIFI_CHANNEL);
  Serial.println("}");
}

void loop() {
  if (!telemetryQueue) { delay(20); return; }
  TelemetryPacket packet = {};
  if (xQueueReceive(telemetryQueue, &packet, pdMS_TO_TICKS(250)) == pdTRUE) {
    printTelemetryJson(packet);
  }
}
