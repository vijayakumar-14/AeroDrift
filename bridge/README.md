# AERODRIFT local serial bridge

Reads newline-delimited JSON from the ground ESP32 USB serial connection and writes `/telemetry/latest`, `/telemetry/history`, and `/system/bridge` in Firebase Realtime Database.

1. Install Node.js 20+.
2. Run `npm install`.
3. Copy `.env.example` to `.env`; set the serial port and database URL.
4. Store a Firebase service-account JSON securely and set its path in `.env`.
5. Close Arduino Serial Monitor/Plotter so this process can own the port, then run `npm start`.

The service account bypasses Firebase database rules. Keep it private, grant it access only to this project, and never commit the credential or `.env` file.
