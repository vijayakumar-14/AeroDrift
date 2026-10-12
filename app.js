import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { getDatabase, ref, onValue, query, orderByKey, limitToLast } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

const $ = (id) => document.getElementById(id);
const hasConfig = firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("YOUR_") && firebaseConfig.projectId && !firebaseConfig.projectId.startsWith("YOUR_");
let auth = null;
let database = null;
let map = null;
let liveMarker = null;
let liveCircle = null;
let trackLine = null;
let altitudeChart = null;
let historyPoints = [];
let latestTelemetry = null;
let lastPacketAt = null;
let demoMode = false;
let demoTimer = null;
let firebaseUnsubs = [];
let predictionPoint = null;
let serialStatus = null;

function formatNumber(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(Number(value)) || Number(value) < -900) return "--";
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
function formatClock(date = new Date()) { return date.toLocaleTimeString("en-GB", { hour12: false, timeZone: "UTC" }) + " UTC"; }
function isFix(data) { return Boolean(data && data.gpsFix && Number.isFinite(Number(data.lat)) && Number.isFinite(Number(data.lon)) && Math.abs(Number(data.lat)) <= 90 && Math.abs(Number(data.lon)) <= 180); }
function setSystemStatus(id, label, kind = "wait") {
  const el = $(id); if (!el) return;
  el.textContent = label;
  el.classList.remove("status-wait", "status-good", "status-bad");
  el.classList.add(kind === "good" ? "status-good" : kind === "bad" ? "status-bad" : "status-wait");
}
function initMap() {
  if (map || !window.L) return;
  map = L.map("flight-map", { zoomControl: true, scrollWheelZoom: true, attributionControl: true }).setView([20.5937, 78.9629], 4);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>'
  }).addTo(map);
  trackLine = L.polyline([], { color: "#65e1ff", weight: 3, opacity: 0.9, lineCap: "round" }).addTo(map);
  liveMarker = L.circleMarker([0, 0], { radius: 7, color: "#c5f6ff", weight: 2, fillColor: "#65e1ff", fillOpacity: 1 });
  liveCircle = L.circle([0, 0], { radius: 5000, color: "#a78bfa", weight: 1, dashArray: "4 6", fillColor: "#a78bfa", fillOpacity: 0.08 });
  setTimeout(() => map && map.invalidateSize(), 100);
}
function initChart() {
  if (altitudeChart || !window.Chart) return;
  const ctx = $("altitude-chart").getContext("2d");
  altitudeChart = new Chart(ctx, {
    type: "line",
    data: { labels: [], datasets: [{ label: "GPS altitude", data: [], borderColor: "#65e1ff", backgroundColor: "rgba(101,225,255,.08)", borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, fill: true, tension: 0.28 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { intersect: false, mode: "index" },
      plugins: { legend: { display: false }, tooltip: { backgroundColor: "#091127", borderColor: "rgba(101,225,255,.3)", borderWidth: 1, titleFont: { family: "DM Mono" }, bodyFont: { family: "DM Mono" }, callbacks: { label: (context) => `${context.parsed.y.toFixed(1)} m` } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: "#6f81a3", maxTicksLimit: 5, font: { family: "DM Mono", size: 8 } }, border: { display: false } },
        y: { grid: { color: "rgba(142,165,205,.1)" }, ticks: { color: "#6f81a3", maxTicksLimit: 5, font: { family: "DM Mono", size: 8 } }, border: { display: false } }
      }
    }
  });
}
function showMapFix(data, points = historyPoints) {
  initMap();
  const valid = isFix(data);
  $("map-no-fix").classList.toggle("hidden", valid);
  if (!map) return;
  if (valid) {
    const pos = [Number(data.lat), Number(data.lon)];
    liveMarker.setLatLng(pos).bindPopup(`<b>AERODRIFT · Latest GPS</b><br>${pos[0].toFixed(6)}, ${pos[1].toFixed(6)}<br>Altitude: ${formatNumber(data.gpsAltitudeM)} m`).addTo(map);
    const coords = points.filter(isFix).map((p) => [Number(p.lat), Number(p.lon)]);
    if (!coords.some((p) => Math.abs(p[0] - pos[0]) < 0.000001 && Math.abs(p[1] - pos[1]) < 0.000001)) coords.push(pos);
    trackLine.setLatLngs(coords);
    $("map-coordinate").textContent = `${pos[0].toFixed(5)}, ${pos[1].toFixed(5)}`;
    $("map-points-count").textContent = `${coords.length} TRACK POINT${coords.length === 1 ? "" : "S"}`;
  } else {
    liveMarker.remove(); trackLine.setLatLngs([]);
    $("map-coordinate").textContent = "Awaiting GPS fix";
    $("map-points-count").textContent = "0 TRACK POINTS";
  }
  if (predictionPoint && Number.isFinite(Number(predictionPoint.lat)) && Number.isFinite(Number(predictionPoint.lon))) {
    liveCircle.setLatLng([Number(predictionPoint.lat), Number(predictionPoint.lon)]);
    const radius = Number(predictionPoint.radiusM);
    if (Number.isFinite(radius) && radius > 0) liveCircle.setRadius(radius).addTo(map); else liveCircle.remove();
  } else { liveCircle.remove(); }
}
function updatePrediction(prediction) {
  predictionPoint = prediction && Number.isFinite(Number(prediction.lat)) && Number.isFinite(Number(prediction.lon)) ? prediction : null;
  if (!predictionPoint) {
    $("prediction-state").textContent = "NO MODEL DATA";
    $("prediction-title").textContent = "Prediction feed not connected";
    $("prediction-description").textContent = "This panel will display a landing estimate and uncertainty radius only when a validated prediction service writes data to Firebase.";
    $("prediction-lat").textContent = "--"; $("prediction-lon").textContent = "--"; $("prediction-radius").textContent = "--";
  } else {
    $("prediction-state").textContent = "MODEL OUTPUT RECEIVED";
    $("prediction-title").textContent = "Predicted landing region available";
    $("prediction-description").textContent = predictionPoint.note || "Prediction values supplied by the connected model. Check timestamp, wind input and model version before operational use.";
    $("prediction-lat").textContent = Number(predictionPoint.lat).toFixed(5);
    $("prediction-lon").textContent = Number(predictionPoint.lon).toFixed(5);
    $("prediction-radius").textContent = Number.isFinite(Number(predictionPoint.radiusM)) ? `${Math.round(Number(predictionPoint.radiusM)).toLocaleString()} m` : "--";
  }
  if (latestTelemetry) showMapFix(latestTelemetry);
}
function renderHistory(points) {
  historyPoints = points.filter((p) => p && typeof p === "object");
  const validAlt = historyPoints.filter((p) => Number.isFinite(Number(p.gpsAltitudeM)) && Number(p.gpsAltitudeM) > -900);
  initChart();
  if (altitudeChart) {
    altitudeChart.data.labels = validAlt.map((p) => {
      const ts = Number(p.receivedAt || p.timestamp || 0);
      return ts ? new Date(ts).toLocaleTimeString("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
    });
    altitudeChart.data.datasets[0].data = validAlt.map((p) => Number(p.gpsAltitudeM));
    altitudeChart.update("none");
  }
  $("chart-point-count").textContent = String(validAlt.length);
  $("chart-empty").classList.toggle("hidden", validAlt.length > 0);
  $("chart-latest-altitude").innerHTML = `${formatNumber(validAlt.length ? validAlt[validAlt.length - 1].gpsAltitudeM : null)} <small>m</small>`;
  showMapFix(latestTelemetry, historyPoints);
}
function renderTelemetry(data) {
  if (!data || typeof data !== "object") return;
  latestTelemetry = data;
  lastPacketAt = Number(data.receivedAt || data.timestamp || Date.now());
  $("altitude-value").textContent = formatNumber(data.gpsAltitudeM, 1);
  $("pressure-value").textContent = formatNumber(data.pressureHpa, 1);
  $("temperature-value").textContent = formatNumber(data.temperatureC, 1);
  const fix = isFix(data);
  $("gps-status").textContent = fix ? "GPS FIX" : "NO FIX";
  $("altitude-status").textContent = fix ? "GPS FIX" : "NO FIX";
  $("position-value").textContent = fix ? `${Number(data.lat).toFixed(5)}, ${Number(data.lon).toFixed(5)}` : "No valid GPS fix";
  $("last-update-label").textContent = `LAST UPDATE ${new Date(lastPacketAt).toLocaleTimeString("en-GB", { timeZone: "UTC", hour12: false })} UTC`;
  const packetCount = data.packetCount;
  if (Number.isFinite(Number(packetCount))) $("packets-received").textContent = Number(packetCount).toLocaleString();
  const loss = Number(data.estimatedPacketLossPct);
  $("packet-loss").textContent = Number.isFinite(loss) ? `${loss.toFixed(1)}%` : "--";
  $("sidebar-telemetry-state").textContent = fix ? "GPS FIX" : "PACKET RECEIVED";
  $("sidebar-telemetry-state").style.color = fix ? "var(--green)" : "var(--amber)";
  showMapFix(data);
}
function renderBridgeStatus(status) {
  serialStatus = status || null;
  const last = status && Number(status.lastPacketAt || 0);
  const recent = Boolean(status && status.serialOpen && last && Date.now() - last < 12000);
  setSystemStatus("bridge-status", recent ? "ACTIVE" : "STALE", recent ? "good" : "wait");
  $("bridge-detail").textContent = recent ? "Laptop serial bridge recently received telemetry" : "No recent serial telemetry from laptop bridge";
}
function renderLinkState() {
  const recent = lastPacketAt && Date.now() - lastPacketAt < 8000;
  $("flight-state").textContent = demoMode ? "SIMULATION" : recent ? "TELEMETRY LIVE" : latestTelemetry ? "SIGNAL STALE" : "AWAITING DATA";
  $("flight-state").style.color = demoMode || recent ? "var(--green)" : "var(--amber)";
  $("flight-state-sub").textContent = demoMode ? "Local sample data — not a live flight" : recent ? "Recent telemetry packet received" : latestTelemetry ? "Waiting for next telemetry packet" : "No recent packet received";
  $("state-glyph").textContent = demoMode || recent ? "✦" : "◌";
  $("sidebar-telemetry-state").textContent = demoMode ? "SIMULATION" : recent ? "LIVE" : "STANDBY";
  setSystemStatus("espnow-status", recent || demoMode ? "ACTIVE" : "WAITING", recent || demoMode ? "good" : "wait");
  $("packet-age").textContent = demoMode ? "SIM" : lastPacketAt ? `${Math.max(0, Math.floor((Date.now() - lastPacketAt) / 1000))}s ago` : "--";
}
function clearSubscriptions() { firebaseUnsubs.forEach((fn) => { try { fn(); } catch (_) {} }); firebaseUnsubs = []; }
function startFirebaseSubscriptions(user) {
  clearSubscriptions();
  if (!database || !user) return;
  firebaseUnsubs.push(onValue(ref(database, "telemetry/latest"), (snap) => { if (!demoMode && snap.exists()) renderTelemetry(snap.val()); }, (err) => { console.error(err); setSystemStatus("firebase-status", "READ ERROR", "bad"); }));
  firebaseUnsubs.push(onValue(query(ref(database, "telemetry/history"), orderByKey(), limitToLast(120)), (snap) => {
    if (demoMode) return;
    const rows = []; snap.forEach((child) => rows.push(child.val()));
    renderHistory(rows);
  }, (err) => console.error("History subscription:", err)));
  firebaseUnsubs.push(onValue(ref(database, "system/bridge"), (snap) => { if (!demoMode) renderBridgeStatus(snap.val()); }, (err) => console.error("Bridge subscription:", err)));
  firebaseUnsubs.push(onValue(ref(database, "prediction/current"), (snap) => { if (!demoMode) updatePrediction(snap.exists() ? snap.val() : null); }, (err) => console.error("Prediction subscription:", err)));
}
function showDashboard(user) {
  $("login-panel").classList.add("hidden"); $("dashboard").classList.remove("hidden"); $("signout-button").classList.remove("hidden");
  $("firebase-status").textContent = "CONNECTED"; setSystemStatus("firebase-status", "CONNECTED", "good");
  initMap(); initChart(); setTimeout(() => map && map.invalidateSize(), 150);
  if (!demoMode) startFirebaseSubscriptions(user);
}
function showLogin() {
  clearSubscriptions(); $("dashboard").classList.add("hidden"); $("login-panel").classList.remove("hidden"); $("signout-button").classList.add("hidden");
}
function startDemo() {
  demoMode = true;
  clearInterval(demoTimer); clearSubscriptions();
  $("demo-button").innerHTML = "■ <span>EXIT SIM</span>";
  const started = Date.now();
  const demoHistory = [];
  const tick = () => {
    const t = (Date.now() - started) / 1000;
    const data = { type: "telemetry", gpsFix: true, lat: 13.0827 + Math.sin(t / 95) * .012, lon: 80.2707 + t / 80000, gpsAltitudeM: 140 + t * 1.8 + Math.sin(t / 6) * 3, pressureHpa: 996.5 - t * .025 + Math.sin(t / 15) * .12, temperatureC: 27.2 - t * .008 + Math.sin(t / 13) * .2, pressureAltitudeM: 140 + t * 1.8, sequence: Math.floor(t), packetCount: Math.floor(t) + 1, estimatedPacketLossPct: 0, receivedAt: Date.now() };
    demoHistory.push(data); if (demoHistory.length > 40) demoHistory.shift();
    renderTelemetry(data); renderHistory([...demoHistory]);
    $("prediction-state").textContent = "DEMO ONLY"; $("prediction-title").textContent = "No real prediction loaded"; $("prediction-description").textContent = "The map and sensor cards are showing synthetic UI preview values. They are not from a real flight and do not calculate a landing zone.";
    $("prediction-lat").textContent = "--"; $("prediction-lon").textContent = "--"; $("prediction-radius").textContent = "--";
    setSystemStatus("bridge-status", "SIM ONLY", "wait"); setSystemStatus("espnow-status", "SIM ONLY", "wait"); renderLinkState();
  };
  tick(); demoTimer = setInterval(tick, 1800); 
  if (auth && auth.currentUser) { $("login-panel").classList.add("hidden"); $("dashboard").classList.remove("hidden"); $("signout-button").classList.remove("hidden"); }
  else { $("login-panel").classList.add("hidden"); $("dashboard").classList.remove("hidden"); }
}
function stopDemo() {
  demoMode = false; clearInterval(demoTimer); demoTimer = null; $("demo-button").innerHTML = "▷ <span>SIM PREVIEW</span>";
  latestTelemetry = null; historyPoints = []; lastPacketAt = null;
  $("altitude-value").textContent = "--"; $("pressure-value").textContent = "--"; $("temperature-value").textContent = "--"; $("position-value").textContent = "--.------, --.------";
  $("chart-point-count").textContent = "0"; $("chart-latest-altitude").innerHTML = `-- <small>m</small>`; $("chart-empty").classList.remove("hidden");
  if (altitudeChart) { altitudeChart.data.labels = []; altitudeChart.data.datasets[0].data = []; altitudeChart.update("none"); }
  updatePrediction(null); renderLinkState();
  if (auth && auth.currentUser) startFirebaseSubscriptions(auth.currentUser); else showLogin();
}

$("utc-clock").textContent = formatClock();
setInterval(() => { $("utc-clock").textContent = formatClock(); renderLinkState(); }, 1000);
$("recenter-map").addEventListener("click", () => { if (!map) return; if (isFix(latestTelemetry)) map.setView([Number(latestTelemetry.lat), Number(latestTelemetry.lon)], Math.max(map.getZoom(), 10)); else map.setView([20.5937, 78.9629], 4); });
$("demo-button").addEventListener("click", () => demoMode ? stopDemo() : startDemo());
$("signout-button").addEventListener("click", async () => { try { if (auth) await signOut(auth); stopDemo(); } catch (error) { console.error(error); } });
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = event.currentTarget.querySelector("button"); const errorBox = $("login-error");
  if (!hasConfig || !auth) { errorBox.textContent = "Add your Firebase Web App config in firebase-config.js before signing in."; return; }
  button.disabled = true; errorBox.textContent = "Authenticating…";
  try { await signInWithEmailAndPassword(auth, $("email").value.trim(), $("password").value); errorBox.textContent = ""; }
  catch (error) { console.error(error); errorBox.textContent = error.code === "auth/invalid-credential" ? "Email or password is incorrect." : error.code === "auth/too-many-requests" ? "Too many attempts. Wait a moment and try again." : `Sign-in failed: ${error.message}`; }
  finally { button.disabled = false; }
});

if (!hasConfig) {
  $("login-error").textContent = "Setup needed: add your Firebase Web App config, or use SIM PREVIEW to inspect the layout.";
  setSystemStatus("firebase-status", "CONFIG NEEDED", "wait");
} else {
  try {
    const app = initializeApp(firebaseConfig); auth = getAuth(app); database = getDatabase(app);
    onAuthStateChanged(auth, (user) => {
      if (user) { showDashboard(user); if (demoMode) { clearSubscriptions(); } }
      else if (!demoMode) showLogin();
    });
  } catch (error) {
    console.error("Firebase initialization:", error);
    $("login-error").textContent = "Firebase setup error. Check firebase-config.js and your Realtime Database URL.";
  }
}
initMap(); initChart();
