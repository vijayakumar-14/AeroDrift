/*
 * AERODRIFT — airborne telemetry transmitter
 * Board assumption: classic ESP32 DevKit (ESP32-WROOM-32), Arduino-ESP32 core 3.x
 * Modules: NEO-6M GPS + BMP280 pressure/temperature sensor
 * Link: ESP-NOW unicast to the ground receiver; no internet credentials on this board.
 *
 * IMPORTANT: Telemetry-only firmware. It does not control a relay, heater, nichrome
 * wire, payload release, or cutdown mechanism. Keep any such output disconnected
 * while validating tracking and communications.
 */
#include <Arduino.h>
#include <Wire.h>
#include <TinyGPSPlus.h>
#include <Adafruit_BMP280.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <math.h>
#include "secrets.h"

static constexpr int GPS_RX_PIN = 16;   // ESP32 RX2 <- NEO-6M TX
static constexpr int GPS_TX_PIN = 17;   // ESP32 TX2 -> NEO-6M RX (optional for read-only tracking)
static constexpr int BMP_SDA_PIN = 21;
static constexpr int BMP_SCL_PIN = 22;
static constexpr uint32_t SEND_INTERVAL_MS = 1000;
static constexpr uint32_t PACKET_MAGIC = 0xA3D01234;
static constexpr float SEA_LEVEL_PRESSURE_HPA = 1013.25f; // Standard reference only; adjust for local QNH when validated.

HardwareSerial gpsSerial(2);
TinyGPSPlus gps;
Adafruit_BMP280 bmp;
bool bmpAvailable = false;
uint32_t sequenceNumber = 0;
uint32_t lastSendMs = 0;

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

void printStatus(const char *eventName, const char *detail = "") {
  Serial.print("{\"type\":\"status\",\"event\":\"");
  Serial.print(eventName);
  Serial.print("\",\"detail\":\"");
  Serial.print(detail);
  Serial.println("\"}");
}

void setup() {
  Serial.begin(115200);
  delay(400);
  Wire.begin(BMP_SDA_PIN, BMP_SCL_PIN);
  gpsSerial.begin(9600, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);

  bmpAvailable = bmp.begin(0x76);
  if (!bmpAvailable) bmpAvailable = bmp.begin(0x77);
  if (bmpAvailable) {
    bmp.setSampling(Adafruit_BMP280::MODE_NORMAL,
                    Adafruit_BMP280::SAMPLING_X2,
                    Adafruit_BMP280::SAMPLING_X16,
                    Adafruit_BMP280::FILTER_X16,
                    Adafruit_BMP280::STANDBY_MS_250);
    printStatus("bmp280_ready", "BMP280 detected");
  } else {
    printStatus("bmp280_missing", "Check power, SDA/SCL, and address 0x76/0x77");
  }

  WiFi.mode(WIFI_STA);
  WiFi.disconnect(false, true);
  delay(100);
  esp_err_t channelResult = esp_wifi_set_channel(ESPNOW_WIFI_CHANNEL, WIFI_SECOND_CHAN_NONE);
  if (channelResult != ESP_OK) printStatus("channel_error", "Could not set ESP-NOW channel");

  if (esp_now_init() != ESP_OK) {
    printStatus("espnow_error", "ESP-NOW init failed; restart/check board support package");
    while (true) delay(1000);
  }

  esp_now_peer_info_t peerInfo = {};
  memcpy(peerInfo.peer_addr, GROUND_RECEIVER_MAC, 6);
  peerInfo.channel = ESPNOW_WIFI_CHANNEL;
  peerInfo.encrypt = false;
  if (esp_now_add_peer(&peerInfo) != ESP_OK) {
    printStatus("peer_error", "Could not add ground receiver; edit secrets.h MAC/channel");
    while (true) delay(1000);
  }

  printStatus("airborne_ready", "Telemetry-only mode; no cutdown output configured");
}

void loop() {
  while (gpsSerial.available() > 0) gps.encode(gpsSerial.read());

  const uint32_t now = millis();
  if (now - lastSendMs < SEND_INTERVAL_MS) {
    delay(2);
    return;
  }
  lastSendMs = now;

  TelemetryPacket packet = {};
  packet.magic = PACKET_MAGIC;
  packet.sequence = ++sequenceNumber;
  packet.uptimeMs = now;
  packet.gpsFix = (gps.location.isValid() && gps.location.age() < 5000) ? 1 : 0;
  packet.latitude = packet.gpsFix ? static_cast<float>(gps.location.lat()) : 0.0f;
  packet.longitude = packet.gpsFix ? static_cast<float>(gps.location.lng()) : 0.0f;
  packet.gpsAltitudeM = (packet.gpsFix && gps.altitude.isValid()) ? static_cast<float>(gps.altitude.meters()) : -999.0f;

  packet.bmpOk = bmpAvailable ? 1 : 0;
  packet.pressureHpa = -999.0f;
  packet.temperatureC = -999.0f;
  packet.pressureAltitudeM = -999.0f;
  if (bmpAvailable) {
    const float pressurePa = bmp.readPressure();
    const float pressureHpa = pressurePa / 100.0f;
    const float temperatureC = bmp.readTemperature();
    if (isfinite(pressureHpa) && pressureHpa > 0.0f && isfinite(temperatureC)) {
      packet.pressureHpa = pressureHpa;
      packet.temperatureC = temperatureC;
      // This is a rough pressure-altitude estimate using standard sea-level pressure,
      // not a calibrated altitude measurement. Prefer GPS altitude when available.
      packet.pressureAltitudeM = 44330.0f * (1.0f - powf(pressureHpa / SEA_LEVEL_PRESSURE_HPA, 0.1903f));
    }
  }

  const esp_err_t result = esp_now_send(GROUND_RECEIVER_MAC,
                                        reinterpret_cast<const uint8_t *>(&packet),
                                        sizeof(packet));
  if (result != ESP_OK) printStatus("send_error", "ESP-NOW send queue rejected packet");
}
