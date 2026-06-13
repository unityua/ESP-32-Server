// ─────────────────────────────────────────────────────────────────
// db.js — SQLite storage layer (better-sqlite3)
//
//   users    : username, bcrypt password hash, owned device
//   devices  : deviceId, shared HMAC secret, desired LED state
//   sessions : SHA-256 hash of the bearer token (never the token itself)
//
// NOTE for Render FREE plan: the filesystem is EPHEMERAL — the DB file
// is wiped on every deploy/restart. That is why seedFromEnv() exists:
// on boot, if the users table is empty, it re-creates users/devices
// from the SEED_USERS environment variable. State like "led on/off"
// resets on redeploy, which is fine for testing.
// On a paid plan you can attach a Persistent Disk and point DB_PATH
// at it — then seeding only ever runs once.
// ─────────────────────────────────────────────────────────────────
'use strict';

const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username      TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    device_id     TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS devices (
    device_id  TEXT PRIMARY KEY,
    secret     TEXT NOT NULL,          -- shared HMAC key (see README: protect this file!)
    owner      TEXT NOT NULL,
    led        INTEGER NOT NULL DEFAULT 0,
    last_seen  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,       -- sha256(token), so a stolen DB ≠ stolen sessions
    username   TEXT NOT NULL,
    expires    INTEGER NOT NULL
  );
`);

// ── Seeding from environment (for Render's ephemeral disk) ────────
// SEED_USERS is a JSON array, e.g.
// [{"username":"alice","password":"S0me-Long-Pass!","deviceId":"esp-001","deviceSecret":"64-hex-chars..."}]
function seedFromEnv() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;

  const raw = process.env.SEED_USERS;
  if (!raw) {
    console.warn('[db] users table empty and SEED_USERS not set — nobody can log in.');
    return;
  }

  let list;
  try { list = JSON.parse(raw); }
  catch (e) { console.error('[db] SEED_USERS is not valid JSON:', e.message); return; }

  const insUser = db.prepare(
    'INSERT INTO users (username, password_hash, device_id) VALUES (?, ?, ?)');
  const insDev = db.prepare(
    'INSERT INTO devices (device_id, secret, owner) VALUES (?, ?, ?)');

  const tx = db.transaction((items) => {
    for (const u of items) {
      if (!u.username || !u.password || !u.deviceId || !u.deviceSecret) {
        throw new Error('each SEED_USERS entry needs username, password, deviceId, deviceSecret');
      }
      const hash = bcrypt.hashSync(u.password, 12);
      insUser.run(u.username, hash, u.deviceId);
      insDev.run(u.deviceId, u.deviceSecret, u.username);
    }
  });
  tx(list);
  console.log(`[db] seeded ${list.length} user(s) from SEED_USERS`);
}
seedFromEnv();

// ── Queries ───────────────────────────────────────────────────────
module.exports = {
  db,

  getUser: (username) =>
    db.prepare('SELECT * FROM users WHERE username = ?').get(username),

  getDevice: (deviceId) =>
    db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId),

  // ── Admin helpers ───────────────────────────────────────────────
  // Full fleet view: one row per user joined to their device. The
  // password hash and HMAC secret are deliberately NOT selected here —
  // the admin dashboard shows operational data, not credential material.
  listUsersWithDevices: () =>
    db.prepare(`
      SELECT u.username, u.device_id AS deviceId,
             d.led, d.last_seen AS lastSeen, d.owner
      FROM users u
      LEFT JOIN devices d ON d.device_id = u.device_id
      ORDER BY u.username
    `).all(),

  userCount: () => db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
  deviceExists: (deviceId) =>
    !!db.prepare('SELECT 1 FROM devices WHERE device_id = ?').get(deviceId),

  // Atomically create a user + their device. Throws on duplicate
  // username or deviceId (SQLite UNIQUE/PRIMARY KEY constraints), so
  // the caller can surface a clean error instead of a half-write.
  createUserWithDevice: ({ username, passwordHash, deviceId, deviceSecret }) => {
    const tx = db.transaction(() => {
      db.prepare('INSERT INTO users (username, password_hash, device_id) VALUES (?, ?, ?)')
        .run(username, passwordHash, deviceId);
      db.prepare('INSERT INTO devices (device_id, secret, owner) VALUES (?, ?, ?)')
        .run(deviceId, deviceSecret, username);
    });
    tx();
  },

  setLed: (deviceId, on) =>
    db.prepare('UPDATE devices SET led = ? WHERE device_id = ?')
      .run(on ? 1 : 0, deviceId),

  touchDevice: (deviceId) =>
    db.prepare('UPDATE devices SET last_seen = ? WHERE device_id = ?')
      .run(Date.now(), deviceId),

  createSession: (tokenHash, username, expires) =>
    db.prepare('INSERT INTO sessions (token_hash, username, expires) VALUES (?, ?, ?)')
      .run(tokenHash, username, expires),

  getSession: (tokenHash) =>
    db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash),

  deleteSession: (tokenHash) =>
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash),

  purgeExpiredSessions: () =>
    db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()),
};
