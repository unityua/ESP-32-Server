// ─────────────────────────────────────────────────────────────────
// ESP32 LED Control Server — HARDENED (Render edition)
//
// Security model:
//   • All traffic rides on HTTPS (TLS) — Render terminates TLS for
//     you on *.onrender.com, so nothing is sniffable on the wire.
//   • Users: bcrypt-hashed passwords in SQLite, random 256-bit
//     session tokens (only their SHA-256 hash is stored), 12h expiry,
//     login rate-limited per IP.
//   • Devices: NEVER send their secret over the network. Each poll is
//     signed with HMAC-SHA256(secret, deviceId|timestamp|nonce).
//     The server rejects stale timestamps (>60s skew) and replayed
//     nonces, so a captured request is useless to an attacker.
//   • Impersonating the SERVER to a device is blocked on the device
//     side: the ESP32 pins the public root CAs and verifies the
//     certificate of esp-32-server-xxxx.onrender.com.
// ─────────────────────────────────────────────────────────────────
'use strict';

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const path = require('path');
const store = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_TTL = 12 * 60 * 60 * 1000;     // 12h
const DEVICE_TS_WINDOW = 60;                 // seconds of allowed clock skew
const NONCE_TTL = 5 * 60 * 1000;             // remember nonces for 5 min

// ── Admin config ──────────────────────────────────────────────────
// The admin is NOT a row in the users table — it's a separate account
// gated by the ADMIN_PASSWORD env var, so it can never own/control a
// device and never collides with a registered user. If ADMIN_PASSWORD
// is unset, the entire admin surface is disabled (fail closed).
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_SESSION_TTL = 60 * 60 * 1000;    // 1h — admin sessions are short-lived
const adminSessions = new Map();              // sha256(token) -> expiry (in-memory only)

// Render sits behind a proxy/load balancer
app.set('trust proxy', 1);

// helmet's DEFAULT Content-Security-Policy is `script-src 'self'`, which
// blocks inline <script> blocks — that's what silently killed the login
// page. The UI's JS/CSS now live in external files (public/app.js,
// public/styles.css), which 'self' allows, and we declare the policy
// explicitly so nothing is left to defaults:
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],                              // our app.js
      styleSrc: ["'self'", "https://fonts.googleapis.com"], // our styles.css + Google Fonts CSS
      fontSrc: ["'self'", "https://fonts.gstatic.com"],     // the font files themselves
      connectSrc: ["'self'"],                              // fetch() to our own API
      imgSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
}));
app.use(express.json({ limit: '4kb' }));

// Force HTTPS BEFORE serving anything (Render forwards the original
// scheme in this header). This used to sit after express.static, so
// static files skipped the redirect.
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' &&
      req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, 'https://' + req.headers.host + req.url);
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.disable('x-powered-by');

// ── Helpers ───────────────────────────────────────────────────────
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Dummy hash so login takes the same time whether or not the user exists
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 12);

// ── User auth middleware ──────────────────────────────────────────
function authUser(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  const s = store.getSession(sha256(token));
  if (!s || s.expires < Date.now()) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.username = s.username;
  next();
}

// ── Login (rate-limited: 8 attempts / 10 min / IP) ────────────────
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many login attempts, try again later' },
});

app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' ||
      username.length > 64 || password.length > 128) {
    return res.status(400).json({ error: 'bad request' });
  }

  const user = store.getUser(username);
  const hash = user ? user.password_hash : DUMMY_HASH;
  const ok = bcrypt.compareSync(password, hash);

  if (!user || !ok) {
    return res.status(401).json({ error: 'invalid credentials' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  store.createSession(sha256(token), username, Date.now() + SESSION_TTL);
  res.json({ token, username, deviceId: user.device_id });
});

app.post('/api/logout', authUser, (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  store.deleteSession(sha256(token));
  res.json({ ok: true });
});

// ── User-facing device control ────────────────────────────────────
app.get('/api/me', authUser, (req, res) => {
  const user = store.getUser(req.username);
  const dev = user && store.getDevice(user.device_id);
  if (!user || !dev) return res.status(401).json({ error: 'unauthorized' });
  res.json({
    username: req.username,
    deviceId: user.device_id,
    led: !!dev.led,
    online: Date.now() - dev.last_seen < 15000,
    lastSeen: dev.last_seen,
  });
});

app.post('/api/led', authUser, (req, res) => {
  const user = store.getUser(req.username);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const on = !!(req.body && req.body.on);
  store.setLed(user.device_id, on);
  res.json({ deviceId: user.device_id, led: on });
});

// ── Admin: auth middleware ────────────────────────────────────────
function authAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(404).json({ error: 'not found' });
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  const exp = adminSessions.get(sha256(token));
  if (!exp || exp < Date.now()) {
    adminSessions.delete(sha256(token));
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// Tighter limiter for admin login: 5 attempts / 15 min / IP
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many attempts, try again later' },
});

// ── Admin: login ──────────────────────────────────────────────────
app.post('/api/admin/login', adminLoginLimiter, (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(404).json({ error: 'not found' });
  const { password } = req.body || {};
  if (typeof password !== 'string' || password.length > 256) {
    return res.status(400).json({ error: 'bad request' });
  }
  // constant-time compare against the configured password
  if (!safeEqual(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(sha256(token), Date.now() + ADMIN_SESSION_TTL);
  res.json({ token });
});

app.post('/api/admin/logout', authAdmin, (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  adminSessions.delete(sha256(token));
  res.json({ ok: true });
});

// ── Admin: list all users + their devices ─────────────────────────
app.get('/api/admin/users', authAdmin, (_req, res) => {
  const rows = store.listUsersWithDevices().map((r) => ({
    username: r.username,
    deviceId: r.deviceId,
    led: !!r.led,
    online: r.lastSeen ? (Date.now() - r.lastSeen < 15000) : false,
    lastSeen: r.lastSeen || 0,
  }));
  res.json({ count: rows.length, users: rows });
});

// ── Admin: register a new user (server generates device id+secret) ─
// Admin supplies username + password. The server mints a unique device
// id and a 256-bit secret, stores everything, and returns the secret
// + password ONCE so the admin can record them. The secret is never
// retrievable again (it's only used server-side for HMAC checks).
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;

function nextDeviceId() {
  // esp-001, esp-002, ... find the lowest unused number
  for (let i = 1; i < 100000; i++) {
    const id = 'esp-' + String(i).padStart(3, '0');
    if (!store.deviceExists(id)) return id;
  }
  // fallback: random suffix
  return 'esp-' + crypto.randomBytes(3).toString('hex');
}

app.post('/api/admin/register', authAdmin, (req, res) => {
  const { username, password } = req.body || {};

  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return res.status(400).json({
      error: 'username must be 3-32 chars: letters, digits, . _ -',
    });
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    return res.status(400).json({ error: 'password must be 8-128 characters' });
  }
  if (store.getUser(username)) {
    return res.status(409).json({ error: 'username already exists' });
  }

  const deviceId = nextDeviceId();
  const deviceSecret = crypto.randomBytes(32).toString('hex');  // 64 hex chars
  const passwordHash = bcrypt.hashSync(password, 12);

  try {
    store.createUserWithDevice({ username, passwordHash, deviceId, deviceSecret });
  } catch (e) {
    // UNIQUE constraint race or similar
    return res.status(409).json({ error: 'could not create user (duplicate?)' });
  }

  // Returned ONCE. password echoed so admin can hand it to the user;
  // deviceSecret must be flashed into that user's ESP32.
  res.json({ username, password, deviceId, deviceSecret });
});

// ── Device-facing endpoint (HMAC-signed polling) ──────────────────
// The ESP32 sends:
//   X-Device-Id   : esp-001
//   X-Timestamp   : unix seconds (from NTP)
//   X-Nonce       : random hex, unique per request
//   X-Signature   : hex( HMAC-SHA256(secret, "deviceId|timestamp|nonce") )
// The secret itself never travels over the network.
const seenNonces = new Map(); // nonce -> expiry ts
setInterval(() => {
  const now = Date.now();
  for (const [n, exp] of seenNonces) if (exp < now) seenNonces.delete(n);
  for (const [h, exp] of adminSessions) if (exp < now) adminSessions.delete(h);
  store.purgeExpiredSessions();
}, 60 * 1000);

app.get('/command', (req, res) => {
  const deviceId = req.headers['x-device-id'];
  const ts = req.headers['x-timestamp'];
  const nonce = req.headers['x-nonce'];
  const sig = req.headers['x-signature'];

  if (!deviceId || !ts || !nonce || !sig) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const dev = store.getDevice(deviceId);
  if (!dev) return res.status(403).json({ error: 'forbidden' });

  // 1) freshness: timestamp must be within ±60s of server time
  const skew = Math.abs(Math.floor(Date.now() / 1000) - parseInt(ts, 10));
  if (!Number.isFinite(skew) || skew > DEVICE_TS_WINDOW) {
    return res.status(403).json({ error: 'forbidden' });
  }

  // 2) uniqueness: nonce may be used only once
  if (seenNonces.has(nonce)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  // 3) authenticity: HMAC must match
  const expected = crypto.createHmac('sha256', dev.secret)
    .update(`${deviceId}|${ts}|${nonce}`).digest('hex');
  if (!safeEqual(sig, expected)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  seenNonces.set(nonce, Date.now() + NONCE_TTL);
  store.touchDevice(deviceId);
  res.json({ led: !!dev.led });
});

// ── Health check (used by Render and by the ESP's net check) ─────
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Default 404 — no stack traces, no info leaks
app.use((_req, res) => res.status(404).json({ error: 'not found' }));

app.listen(PORT, () => {
  console.log(`ESP32 control server listening on :${PORT}`);
});
