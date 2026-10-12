# AERODRIFT — Firebase + Vercel Ground Dashboard

Space-themed flight telemetry dashboard for the TRINITY balloon-drift/recovery research project described in the proposal PDF. This starter replaces Streamlit with a static HTML/CSS/JavaScript dashboard hosted on Vercel, Firebase Realtime Database for live data, and a small Node.js bridge running on the ground-station laptop.

## Architecture

```text
NEO-6M GPS ─┐
             ├─ Airborne ESP32 -- ESP-NOW --> Ground ESP32 -- USB serial --> Laptop Node bridge
BMP280 ──────┘                                                            │
                                                                          ▼
                                                            Firebase Realtime Database
                                                                          │
                                                                          ▼
                                                       AERODRIFT dashboard hosted on Vercel
```

The local bridge uses a private Firebase Admin service-account credential; the Vercel page uses the public Firebase Web App config plus Firebase Authentication. **Never upload the service-account JSON or local `.env` file to GitHub or Vercel.** Dashboard users can read telemetry, but browser-side writes are denied by the supplied database rules.

## Included files

- `index.html`, `styles.css`, `app.js` — responsive space-centric dashboard with GPS map, altitude graph, sensor cards, live-link health, operator login and clearly marked simulation preview.
- `firebase-config.js` — public Firebase Web App config placeholders.
- `database.rules.json`, `firebase.json` — Realtime Database rules and Firebase CLI config.
- `vercel.json` — static-site settings for deployment.
- `esp32/airborne_transmitter.ino` — reads GPS + BMP280 and sends telemetry by ESP-NOW.
- `esp32/ground_receiver.ino` — receives telemetry and prints newline-delimited JSON over USB serial.
- `esp32/secrets.example.h` — example channel and receiver MAC configuration.
- `bridge/` — local serial-to-Firebase bridge and package/env setup.

## 1. Firebase project setup

1. Create a Firebase project at the Firebase Console.
2. Add a **Web App** in Project settings. Copy its config into `firebase-config.js` (replace every `YOUR_...` placeholder with the exact value from your project).
3. Create a **Realtime Database**. Use the exact database URL shown in the console; its domain can vary by region.
4. In Authentication → Sign-in method, enable **Email/Password**. Create one or more operator accounts for the dashboard. The app does not have a public self-registration screen.
5. Apply the rules in `database.rules.json` using Realtime Database → Rules, or from this folder run `firebase deploy --only database` after installing/configuring the Firebase CLI.
6. To authorize the laptop bridge, create a service-account key from Firebase project settings / service accounts. Store the downloaded JSON **outside the public website repository** if possible. Do not paste it into `firebase-config.js`, either ESP32 sketch, or any Vercel environment variable.

The rules intentionally deny browser writes. The authenticated bridge writes via Firebase Admin SDK, which uses the private service-account key on the laptop and bypasses client rules. Only give dashboard access to trusted team members.

## 2. Deploy the dashboard to Vercel

1. Put the contents of this `aerodrift` folder in a Git repository.
2. Fill in `firebase-config.js` with the Firebase Web App config.
3. Push the repository to GitHub/GitLab, import it in Vercel, and deploy as a static site. No build command is required; the project root is the output directory.
4. Open the Vercel URL and sign in with an operator account from Firebase Authentication.
5. Use **SIM PREVIEW** to preview the UI without inventing a live Firebase feed. It is explicitly labelled as synthetic sample data.

Firebase web API keys are identifiers used by the client SDK, not Admin credentials. Security depends on Authentication and the database rules, not hiding the Web App config.

## 3. Proposed pin map

The circuit diagram on page 3 of the proposal shows which modules connect, but it does not specify exact GPIO numbers. These sketches use this proposed map for a **classic ESP32-WROOM-32 DevKit**:

| Module pin | ESP32 pin | Notes |
|---|---|---|
| NEO-6M TX | GPIO16 / RX2 | GPS serial data into ESP32 |
| NEO-6M RX | GPIO17 / TX2 | Optional GPS configuration output |
| GPS VCC | 3V3 or breakout-approved supply | Check the exact module board's voltage requirements |
| GPS GND | GND | Common ground |
| BMP280 SDA | GPIO21 | I²C data |
| BMP280 SCL | GPIO22 | I²C clock |
| BMP280 VCC/VIN | 3V3 | Check board pin labels; bare sensor chips are not 5 V tolerant |
| BMP280 GND | GND | Common ground |
| Ground ESP32 | USB to laptop | 115200 baud serial stream |

Many BMP280 breakouts use address `0x76`; the transmitter tries `0x76` and `0x77`. Use the wiring and power requirements printed on your exact breakout board. Do not assume every module has the same voltage regulator or pinout.

### ESP-NOW channel / receiver MAC

ESP-NOW must use the same 2.4 GHz channel on both boards. The included example sets channel `6`; change it in your copied `esp32/secrets.h` only after checking your local radio environment. The ground sketch prints its station MAC on serial as a JSON status line during startup. Copy that MAC into `GROUND_RECEIVER_MAC` in `secrets.h`, then upload both sketches. Close Arduino Serial Monitor/Plotter before opening the port from the laptop bridge—only one app can own a serial port at a time.

## 4. Upload the ESP32 sketches

1. In Arduino IDE, install an ESP32 board package (Arduino-ESP32 **3.x** recommended for the callback signature used here), `TinyGPSPlus`, and `Adafruit BMP280 Library` (with its `Adafruit Unified Sensor` dependency).
2. Copy `esp32/secrets.example.h` to `esp32/secrets.h` and edit `ESPNOW_WIFI_CHANNEL` and `GROUND_RECEIVER_MAC`.
3. Open `airborne_transmitter.ino`, select your airborne ESP32 board/port, compile and upload.
4. Open `ground_receiver.ino`, select the ground ESP32 board/port, compile and upload. Open its serial monitor at 115200 once to read the receiver MAC; then close it.
5. Set the receiver MAC in `secrets.h`, re-upload the airborne sketch, and restart both devices.

The packet reports GPS fix state, coordinates, GPS altitude, BMP280 pressure/temperature, a rough pressure-altitude estimate, sequence count and packet-loss estimate. Pressure altitude is **not calibrated altitude**; GPS altitude is shown separately. A fresh GPS fix may take time and may be unavailable indoors.

**Safety scope:** these sketches are telemetry-only. They do not include relay, nichrome-wire, payload release, or cutdown control. Validate the electronics on a bench and use appropriate supervision and approvals for any outdoor aerospace test.

## 5. Start the laptop bridge

Requires Node.js 20 or newer. The laptop needs internet access to reach Firebase, and the ground receiver must be connected by USB.

```bash
cd bridge
npm install
cp .env.example .env
```

Edit `.env`:

- `SERIAL_PORT`: Windows example `COM5`; Linux example `/dev/ttyUSB0`; macOS example `/dev/cu.usbserial-0001`.
- `FIREBASE_DATABASE_URL`: exact Realtime Database URL from the Firebase console.
- `FIREBASE_SERVICE_ACCOUNT_PATH`: path to your private service-account JSON file.
- `SERIAL_BAUD=115200`.

Start the bridge:

```bash
npm start
```

Keep that terminal running while using the dashboard. The bridge writes the latest packet to `/telemetry/latest`, sampled flight points to `/telemetry/history`, and link status to `/system/bridge`. It stores history at a limited interval to avoid an unnecessary write for every incoming radio packet; change `HISTORY_MIN_INTERVAL_MS` if needed.

## 6. Data contract

`/telemetry/latest` and each item under `/telemetry/history` contain fields similar to:

```json
{
  "sequence": 123,
  "gpsFix": true,
  "lat": 13.0827,
  "lon": 80.2707,
  "gpsAltitudeM": 142.4,
  "pressureHpa": 996.4,
  "temperatureC": 27.1,
  "pressureAltitudeM": 141.0,
  "packetCount": 123,
  "packetsLost": 2,
  "estimatedPacketLossPct": 1.6,
  "receivedAt": 1791800000000
}
```

The values above are an **example schema only**, not project telemetry. A value may be `null` until the GPS fix or sensor is available.

The landing panel watches `/prediction/current` for a future validated prediction process to publish:

```json
{
  "lat": 13.09,
  "lon": 80.28,
  "radiusM": 12000,
  "note": "Prediction model/version and input assumptions"
}
```

This starter does **not** calculate a landing prediction; the panel remains clear that no model is connected until a real model writes values. Do not interpret an arbitrary coordinate or an unvalidated uncertainty radius as a flight-safety guarantee.

## Troubleshooting

- **Config needed / sign-in fails:** verify the Firebase Web App config, database URL, enabled Email/Password provider, and operator account.
- **Firebase permission denied:** re-check that the rules are deployed and the dashboard user is signed in. Do not fix this by opening the database to public reads/writes.
- **No serial packets:** close the Arduino Serial Monitor, use the correct COM/tty port and 115200 baud, and check both ESP32s use the same ESP-NOW channel and correct receiver MAC.
- **No GPS fix:** test the GPS with a clear view of the sky and give it time to acquire satellites.
- **No BMP280 data:** check 3V3/GND/SDA/SCL, correct breakout pin labels, and I²C address `0x76`/`0x77`.
- **Map tiles absent:** verify browser connectivity; Leaflet map tiles are served by OpenStreetMap and are not bundled offline.
