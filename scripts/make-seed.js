#!/usr/bin/env node
// Helper: builds the SEED_USERS JSON you paste into Render.
// Usage: node scripts/make-seed.js alice esp-001 bob esp-002 ...
// Generates a strong random password and device secret for each pair.
'use strict';
const crypto = require('crypto');

const args = process.argv.slice(2);
if (args.length === 0 || args.length % 2 !== 0) {
  console.error('Usage: node scripts/make-seed.js <username> <deviceId> [<username> <deviceId> ...]');
  process.exit(1);
}

const out = [];
for (let i = 0; i < args.length; i += 2) {
  out.push({
    username: args[i],
    password: crypto.randomBytes(9).toString('base64url'),   // ~12 chars, give to the user
    deviceId: args[i + 1],
    deviceSecret: crypto.randomBytes(32).toString('hex'),     // flash into the ESP32
  });
}

console.log('── Paste this (one line) into Render env var SEED_USERS ──\n');
console.log(JSON.stringify(out));
console.log('\n── Human-readable copy (store in a password manager) ──\n');
for (const u of out) {
  console.log(`user: ${u.username}\n  password:      ${u.password}\n  deviceId:      ${u.deviceId}\n  deviceSecret:  ${u.deviceSecret}\n`);
}
