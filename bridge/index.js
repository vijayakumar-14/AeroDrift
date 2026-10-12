import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getDatabase, ServerValue } from 'firebase-admin/database';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';

const here = path.dirname(fileURLToPath(import.meta.url));
const serialPath = process.env.SERIAL_PORT;
const baudRate = Number(process.env.SERIAL_BAUD || 115200);
const databaseURL = process.env.FIREBASE_DATABASE_URL;
const credentialPathRaw = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './service-account.json';
const credentialPath = path.isAbsolute(credentialPathRaw) ? credentialPathRaw : path.resolve(here, credentialPathRaw);
const historyMinIntervalMs = Math.max(1000, Number(process.env.HISTORY_MIN_INTERVAL_MS || 2000));

if (!serialPath || !databaseURL || databaseURL.includes('YOUR_DATABASE_NAME')) {
  console.error('Setup needed: set SERIAL_PORT and FIREBASE_DATABASE_URL in bridge/.env.');
  process.exit(1);
}
if (!fs.existsSync(credentialPath)) {
  console.error(`Firebase service-account JSON not found at: ${credentialPath}`);
  console.error('Download a service-account key from Firebase Console and keep it private.');
  process.exit(1);
}

let serviceAccount;
try { serviceAccount = JSON.parse(fs.readFileSync(credentialPath, 'utf8')); }
catch (error) { console.error('Could not read service-account JSON:', error.message); process.exit(1); }

const firebaseApp = initializeApp({ credential: cert(serviceAccount), databaseURL });
const db = getDatabase(firebaseApp);
const latestRef = db.ref('telemetry/latest');
const historyRef = db.ref('telemetry/history');
const bridgeRef = db.ref('system/bridge');

let serial;
let packetCount = 0;
let previousSequence = null;
let packetsLost = 0;
let historyWriteAt = 0;
let writeQueue = Promise.resolve();
let shuttingDown = false;

function stampNow() { return ServerValue.TIMESTAMP; }
function logStatus(message) { console.log(`[AERODRIFT ${new Date().toISOString()}] ${message}`); }
function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function setBridgeStatus(extra = {}) {
  try {
    await bridgeRef.update({
      serialPort: serialPath,
      serialOpen: Boolean(serial && serial.isOpen),
      packetCount,
      packetsLost,
      updatedAt: stampNow(),
      ...extra
    });
  } catch (error) { logStatus(`Firebase status write failed: ${error.message}`); }
}

async function handleTelemetry(input) {
  const now = Date.now();
  packetCount += 1;
  const sequence = Number(input.sequence);
  if (Number.isFinite(sequence) && previousSequence !== null) {
    const delta = (sequence - previousSequence) >>> 0;
    if (delta > 1 && delta < 100000) packetsLost += delta - 1;
  }
  if (Number.isFinite(sequence)) previousSequence = sequence;

  const gpsFix = Boolean(input.gpsFix) && numOrNull(input.lat) !== null && numOrNull(input.lon) !== null;
  const record = {
    sequence: Number.isFinite(sequence) ? sequence : null,
    uptimeMs: numOrNull(input.uptimeMs),
    gpsFix,
    lat: gpsFix ? numOrNull(input.lat) : null,
    lon: gpsFix ? numOrNull(input.lon) : null,
    gpsAltitudeM: numOrNull(input.gpsAltitudeM),
    pressureHpa: numOrNull(input.pressureHpa),
    temperatureC: numOrNull(input.temperatureC),
    pressureAltitudeM: numOrNull(input.pressureAltitudeM),
    bmpOk: Boolean(input.bmpOk),
    packetCount,
    packetsLost,
    estimatedPacketLossPct: packetCount + packetsLost > 0 ? (100 * packetsLost / (packetCount + packetsLost)) : 0,
    receivedAt: stampNow()
  };

  writeQueue = writeQueue.then(async () => {
    await latestRef.set(record);
    if (now - historyWriteAt >= historyMinIntervalMs) {
      await historyRef.push(record);
      historyWriteAt = now;
    }
    await bridgeRef.update({
      serialPort: serialPath,
      serialOpen: Boolean(serial && serial.isOpen),
      packetCount,
      packetsLost,
      lastPacketAt: stampNow(),
      updatedAt: stampNow(),
      lastSequence: record.sequence
    });
  }).catch((error) => logStatus(`Firebase write failed: ${error.message}`));
}

function connectSerial() {
  serial = new SerialPort({ path: serialPath, baudRate, autoOpen: false });
  const parser = serial.pipe(new ReadlineParser({ delimiter: '\n' }));
  serial.on('open', () => { logStatus(`USB serial opened: ${serialPath} @ ${baudRate}`); void setBridgeStatus({ lastError: null }); });
  serial.on('close', () => { logStatus('USB serial closed. Check cable, port, or whether another serial monitor has it open.'); void setBridgeStatus({ serialOpen: false }); });
  serial.on('error', (error) => { logStatus(`Serial error: ${error.message}`); void setBridgeStatus({ lastError: error.message }); });
  parser.on('data', (rawLine) => {
    const line = String(rawLine).trim();
    if (!line.startsWith('{') || !line.endsWith('}')) return;
    let message;
    try { message = JSON.parse(line); }
    catch { logStatus(`Ignored malformed JSON line: ${line.slice(0, 100)}`); return; }
    if (message.type === 'telemetry') {
      void handleTelemetry(message);
    } else if (message.type === 'status') {
      logStatus(`Receiver status: ${message.event || 'event'} ${message.detail || message.mac || ''}`);
    }
  });
  serial.open((error) => {
    if (error) {
      logStatus(`Could not open ${serialPath}: ${error.message}`);
      logStatus('Close Arduino Serial Monitor/Plotter and check the port name in .env.');
      void setBridgeStatus({ serialOpen: false, lastError: error.message });
      process.exitCode = 1;
    }
  });
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  logStatus('Stopping bridge…');
  try { await writeQueue; await setBridgeStatus({ serialOpen: false, stoppedAt: stampNow() }); } catch (_) {}
  if (serial && serial.isOpen) serial.close();
  try { await firebaseApp.delete(); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

logStatus('Starting local serial → Firebase bridge. Keep service-account credentials private.');
connectSerial();
setInterval(() => { if (!shuttingDown) void setBridgeStatus(); }, 15000);
