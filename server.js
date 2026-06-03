// ─────────────────────────────────────────────────────────────────
// ESP32 LED Control Server
//   - Users log in (username/password) and control THEIR device
//   - ESP32 devices POLL this server for their current LED command
//   - Devices authenticate with deviceId + deviceSecret
// ─────────────────────────────────────────────────────────────────
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory store (replace with a DB later) ───────────────────────
// Each user owns exactly one device in this test setup.
// In real use, load these from a DB / env. Passwords here are PLAIN
// for the test phase — see the guide for how to harden this.
const USERS = {
  alice: {
    password: 'alice123',
    deviceId: 'esp-001',
    deviceSecret: 'secret-001-change-me',
  },
  bob: {
    password: 'bob123',
    deviceId: 'esp-002',
    deviceSecret: 'secret-002-change-me',
  },
};

// Device runtime state, keyed by deviceId
const DEVICES = {};
for (const [username, u] of Object.entries(USERS)) {
  DEVICES[u.deviceId] = {
    deviceId: u.deviceId,
    secret: u.deviceSecret,
    owner: username,
    led: false,          // desired LED state
    lastSeen: 0,         // last poll timestamp (ms)
    online: false,
  };
}

// ── Simple token-based sessions (in-memory) ─────────────────────────
const SESSIONS = {}; // token -> { username, expires }
const SESSION_TTL = 1000 * 60 * 60 * 12; // 12h

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

function authUser(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const s = SESSIONS[token];
  if (!s || s.expires < Date.now()) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.username = s.username;
  next();
}

function markDeviceOffline() {
  const now = Date.now();
  for (const d of Object.values(DEVICES)) {
    // consider offline if not polled for 15s
    d.online = now - d.lastSeen < 15000;
  }
}
setInterval(markDeviceOffline, 5000);

// ════════════════════════════════════════════════════════════════
//  USER-FACING API (frontend)
// ════════════════════════════════════════════════════════════════

// POST /api/login  { username, password }
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = USERS[username];
  if (!u || u.password !== password) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const token = makeToken();
  SESSIONS[token] = { username, expires: Date.now() + SESSION_TTL };
  res.json({ token, username, deviceId: u.deviceId });
});

// GET /api/me  -> user info + device status
app.get('/api/me', authUser, (req, res) => {
  const u = USERS[req.username];
  const d = DEVICES[u.deviceId];
  res.json({
    username: req.username,
    deviceId: u.deviceId,
    led: d.led,
    online: d.online,
    lastSeen: d.lastSeen,
  });
});

// POST /api/led  { on: true|false }  -> set desired LED state
app.post('/api/led', authUser, (req, res) => {
  const u = USERS[req.username];
  const d = DEVICES[u.deviceId];
  const on = !!(req.body && req.body.on);
  d.led = on;
  res.json({ deviceId: u.deviceId, led: d.led });
});

// ════════════════════════════════════════════════════════════════
//  DEVICE-FACING API (ESP32 polls this)
// ════════════════════════════════════════════════════════════════

// GET /command?deviceId=...&secret=...   (also accepts headers)
//   Returns { led: true|false }
app.get('/command', (req, res) => {
  const deviceId = req.query.deviceId || req.headers['x-device-id'];
  const secret = req.query.secret || req.headers['x-device-secret'];
  const d = DEVICES[deviceId];

  if (!d || d.secret !== secret) {
    return res.status(403).json({ error: 'bad device credentials' });
  }
  d.lastSeen = Date.now();
  d.online = true;
  res.json({ led: d.led });
});

// Health check for Render / keep-alive pings
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => {
  console.log(`ESP32 control server listening on :${PORT}`);
});
