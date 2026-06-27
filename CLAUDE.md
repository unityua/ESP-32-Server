# CLAUDE.md

Update CLAUDE.md as project changes

Guidance for working in this repository.

## What this project is

A **hardened remote-control server for WT32-ETH01 (ESP32) devices**, plus the
device firmware that talks to it. A user logs into a web UI from anywhere on the
internet and toggles an output on their physical device; the device polls the
server and acts on the command.

Today the controlled outputs are **three LEDs** (LED1=GPIO 33, LED2=GPIO 5,
LED3=GPIO 17), each toggled independently. The architecture is deliberately
generic and is being expanded — the next target is controlling a **VTX (video
transmitter)** in addition to / instead of the LEDs. When adding features,
prefer generalizing the "command" the server stores per device over hardcoding
LED-specific logic (see [Roadmap](#roadmap-vtx)).

The server is built to run on **Render** (`*.onrender.com`), which terminates
TLS. The device pins public root CAs and verifies the server certificate, so the
channel is authenticated in both directions.

## Architecture at a glance

```
  Browser (user)                Server (Render / Node)              Device (WT32-ETH01)
  ┌──────────────┐   HTTPS      ┌────────────────────┐   HTTPS      ┌──────────────────┐
  │ public/*.html│ ───────────▶ │ server.js (Express)│ ◀─────────── │ wt32_main.ino    │
  │ app.js       │  Bearer tok  │ db.js  (SQLite)    │  HMAC-signed │ polls /command   │
  │ admin.js     │              │                    │   GET /cmd   │ every 3s, drives │
  └──────────────┘              └────────────────────┘              │ 3 LEDs (33/5/17) │
                                                                    └──────────────────┘
```

- **User → Server**: username/password login (bcrypt), returns a random bearer
  token. Token toggles the desired output state, which the server stores.
- **Device → Server**: the device polls `GET /command` and the server returns the
  desired state. The device never sends its secret; each poll is HMAC-signed.
- The server is the single source of truth: the UI writes desired state, the
  device reads it. They never talk directly.

## File structure

```
ESP-32-Server/
├── server.js              # Express app: auth, user API, admin API, device /command endpoint
├── db.js                  # SQLite (better-sqlite3) storage layer + env-based seeding
├── package.json           # deps + scripts (start, gen:secret, gen:seed)
├── scripts/
│   └── make-seed.js       # generates SEED_USERS JSON (passwords + device secrets) for Render
├── public/                # static frontend (served by express.static)
│   ├── index.html         # user login + device dashboard
│   ├── app.js             # user dashboard logic
│   ├── styles.css         # shared styles
│   ├── admin.html         # admin console (register users, list fleet)
│   ├── admin.js           # admin console logic
│   └── admin.css          # admin-only styles
├── data.sqlite            # runtime DB (gitignored; ephemeral on Render free plan)
└── wt32/                  # ESP32 firmware (Arduino sketches; currently untracked in git)
    ├── wt32_main/         # ★ canonical firmware — hardened, serial-provisioned
    │   ├── wt32_main.ino
    │   └── ca_certs.h      # pinned root CA bundle (ISRG X1 + GTS R1/R4)
    ├── wt32_single_led_17/ # variant: single LED on GPIO 17
    ├── wt32_test/          # scratch/test sketch
    └── wt32_test_led_04/   # test sketch, LED on GPIO 04
```

`wt32_main/` is the real firmware — start there. The other `wt32/*` folders are
experiments/variants; don't treat them as authoritative.

## Security model (don't weaken these)

- **Users**: bcrypt-hashed passwords (cost 12) in SQLite. Login is rate-limited
  (8 / 10min / IP). A dummy bcrypt compare runs on unknown usernames so login
  timing doesn't leak whether a user exists.
- **Sessions**: 256-bit random token; only its **SHA-256 hash** is stored, so a
  stolen DB ≠ stolen sessions. 12h TTL. The browser keeps the token in a JS
  variable only — never localStorage/cookies — so closing the tab logs out.
- **Devices**: the per-device secret never travels the network. Each `GET /command`
  carries `X-Device-Id`, `X-Timestamp`, `X-Nonce`, `X-Signature` where the
  signature is `HMAC-SHA256(secret, "deviceId|timestamp|nonce")`. The server
  rejects stale timestamps (>60s skew) and replayed nonces, so a captured request
  is useless.
- **Server identity**: the device pins root CAs (`ca_certs.h`) and verifies the
  server cert — blocks MITM / server impersonation.
- **Admin**: NOT a row in `users`. It's a separate account gated by the
  `ADMIN_PASSWORD` env var (constant-time compare). If `ADMIN_PASSWORD` is unset,
  the entire admin surface returns 404 (fail closed). Admin sessions are in-memory
  only, 1h TTL.
- **Headers**: `helmet` with an explicit CSP. Inline `<script>` is blocked by
  `script-src 'self'`, which is why all JS/CSS live in external files under
  `public/`. Keep them external.

## Data model (SQLite)

- `users`   — `username` (PK), `password_hash`, `device_id` (unique). One device per user.
- `devices` — `device_id` (PK), `secret` (HMAC key), `owner`, `led`/`led2`/`led3`
  (desired state of LED 1/2/3), `last_seen`.
- `sessions`— `token_hash` (sha256 of bearer token), `username`, `expires`.

> Note: `devices.led`/`led2`/`led3` are the current "command" columns (LED 1/2/3;
> `led` is LED 1, kept for backward compat). `db.js` migrates older single-`led`
> tables by `ALTER TABLE ADD COLUMN`. When generalizing to VTX, these are the
> fields that grow (e.g. more columns or a JSON state blob).

## API surface

| Method | Path                  | Auth        | Purpose                                   |
|--------|-----------------------|-------------|-------------------------------------------|
| POST   | `/api/login`          | none (RL)   | user login → bearer token                 |
| POST   | `/api/logout`         | user        | invalidate session                        |
| GET    | `/api/me`             | user        | device state (`led1/led2/led3`, online, lastSeen) |
| POST   | `/api/led`            | user        | set one LED `{led: 1\|2\|3, on: bool}`     |
| POST   | `/api/admin/login`    | none (RL)   | admin login (needs `ADMIN_PASSWORD`)      |
| POST   | `/api/admin/logout`   | admin       | invalidate admin session                  |
| GET    | `/api/admin/users`    | admin       | list all users + device status            |
| POST   | `/api/admin/register` | admin       | create user+device, returns secret **once** |
| GET    | `/command`            | HMAC sig    | device poll → `{led1, led2, led3}` (bools) |
| GET    | `/health`             | none        | health check (Render + device net probe)  |

`online` is derived: `Date.now() - last_seen < 15000` (device polls every 3s).

## Running & deploying

```bash
npm install
npm start                      # node server.js, listens on $PORT or 3000

npm run gen:secret             # print a random 32-byte hex secret
npm run gen:seed alice esp-001 # build SEED_USERS JSON (user/device pairs)
```

Key env vars:
- `PORT` — listen port (Render sets this).
- `NODE_ENV=production` — enables the HTTP→HTTPS redirect.
- `ADMIN_PASSWORD` — enables the admin surface (unset = admin disabled).
- `SEED_USERS` — JSON array of `{username, password, deviceId, deviceSecret}`.
  On boot, **if the users table is empty**, these are inserted.
- `DB_PATH` — SQLite file path (default `./data.sqlite`).

**Render free plan caveat (important):** the filesystem is ephemeral — `data.sqlite`
is wiped on every deploy/restart, and `led`/`last_seen` reset. `seedFromEnv()` in
`db.js` re-creates users from `SEED_USERS` on each boot. For persistence, attach a
Persistent Disk and point `DB_PATH` at it (then seeding runs only once).

## Device firmware (wt32/wt32_main)

- Board: **WT32-ETH01** (ESP32). Despite the Ethernet hardware, the firmware uses
  **WiFi** (GPIO 33/5/17 are free because RMII Ethernet is unused). Drives 3 LEDs.
- **Provisioning over serial @115200** (no hardcoded creds — one binary for all
  devices). Send `SSID=`, `PASS=`, `ID=`, `SECRET=`, then `SAVE`. Stored in NVS
  (survives reflash/power-cycle). Other commands: `SHOW`, `WIPE`, `HELP`.
- The 64-hex-char `SECRET` must match the server's `devices.secret` for that
  device (the admin register flow and `make-seed.js` both emit it).
- When connected, each LED follows its own command (`led1/led2/led3`) and the
  firmware logs all three on one line, e.g. `[LED1 - ON, LED2 - OFF, LED3 - ON]`.
  Connectivity problems flash all 3 LEDs together: slow blink = no WiFi; medium
  blink = no internet / awaiting NTP; fast blink = server unreachable; flutter =
  provisioning.
- `SERVER_HOST` is a constant at the top of the `.ino` — update it if the Render
  URL changes. `ca_certs.h` must contain a root the server cert chains to.
- Requires NTP-synced time (HMAC timestamps); won't sign requests until clock is valid.
- Libraries: `ArduinoJson` (Library Manager); `Preferences` is built into the ESP32 core.

## Roadmap: VTX <a id="roadmap-vtx"></a>

The project is being extended from LED-only to also control a **VTX (video
transmitter)**. When implementing:
- Generalize the per-device "command" rather than bolting on a parallel LED-style
  field — `devices.led` should become a more general desired-state representation.
- Keep the security envelope unchanged: VTX commands ride the same HMAC-signed
  `/command` poll and the same authenticated user API.
- Mirror any new server-side state in the firmware's polling/parsing
  (`fetchCommand()` in `wt32_main.ino`) and the dashboard UI.

## Conventions

- Server is `'use strict'` CommonJS, Express 4, no transpile step.
- Frontend is dependency-free vanilla JS; all logic in external `public/*.js`
  (required by the CSP). No bundler.
- Keep secrets out of git: `.gitignore` covers `data.sqlite*`, `.env`,
  `node_modules/`. Never commit real device secrets or `SEED_USERS`.
```
