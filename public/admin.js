// Admin console logic. Mirrors app.js conventions:
//  - admin token lives only in this JS variable (never localStorage),
//    so closing the tab logs out.
//  - every admin API call sends Authorization: Bearer <token>.
let token = null;

const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (token) opts.headers.Authorization = 'Bearer ' + token;
  const r = await fetch(path, opts);
  if (r.status === 401 && token) { logout(); throw new Error('session expired'); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || ('HTTP ' + r.status));
  return r.json();
}

function setLoginLoading(loading) {
  const btn = $('loginBtn');
  if (loading) { btn.classList.add('loading'); btn.disabled = true; $('ap').disabled = true; }
  else { btn.classList.remove('loading'); btn.disabled = false; $('ap').disabled = false; }
}

async function login() {
  $('loginErr').textContent = '';
  setLoginLoading(true);
  try {
    const data = await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password: $('ap').value }),
    });
    token = data.token;
    $('ap').value = '';
    $('loginCard').classList.add('hidden');
    $('dashCard').classList.remove('hidden');
    await loadUsers();
  } catch (e) {
    $('loginErr').textContent = 'Sign-in failed: ' + e.message;
    setLoginLoading(false);
  }
}

function fmtSeen(ms) {
  if (!ms) return 'never';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function renderUsers(list) {
  const box = $('userList');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="empty">No users yet. Register one above.</div>';
    return;
  }
  for (const u of list) {
    const row = document.createElement('div');
    row.className = 'urow';
    const dot = u.online ? 'var(--green)' : 'var(--red)';
    const led = u.led ? 'ON' : 'OFF';
    const ledColor = u.led ? 'var(--green)' : 'var(--dim)';
    row.innerHTML =
      '<span class="udot" style="background:' + dot + '"></span>' +
      '<span class="uname"></span>' +
      '<span class="udev"></span>' +
      '<span class="uled" style="color:' + ledColor + '">LED ' + led + '</span>' +
      '<span class="useen">' + fmtSeen(u.lastSeen) + '</span>';
    row.querySelector('.uname').textContent = u.username;
    row.querySelector('.udev').textContent = u.deviceId || '(none)';
    box.appendChild(row);
  }
}

async function loadUsers() {
  $('dashErr').textContent = '';
  const btn = $('refreshBtn');
  if (btn) { btn.classList.add('spinning'); btn.disabled = true; }
  try {
    const data = await api('/api/admin/users');
    $('count').textContent = '(' + data.count + ')';
    renderUsers(data.users);
  } catch (e) {
    $('dashErr').textContent = e.message;
  } finally {
    if (btn) {
      btn.disabled = false;
      // Remove class after animation completes so it can re-trigger
      btn.addEventListener('animationend', () => btn.classList.remove('spinning'), { once: true });
    }
  }
}

function genPassword() {
  // 16 url-safe chars from the browser CSPRNG
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  $('np').value = b64;
}

let lastResult = null;

async function register() {
  $('regErr').textContent = '';
  const username = $('nu').value.trim();
  const password = $('np').value;
  const btn = $('regBtn');
  btn.disabled = true; btn.classList.add('loading');
  try {
    const data = await api('/api/admin/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    lastResult = data;
    $('rUser').textContent = data.username;
    $('rPass').textContent = data.password;
    $('rId').textContent = data.deviceId;
    $('rSecret').textContent = data.deviceSecret;
    // Convenience: the exact lines to paste into the ESP32 serial prompt
    $('rProv').textContent = 'ID=' + data.deviceId + '  SECRET=' + data.deviceSecret;
    $('resultPanel').classList.remove('hidden');
    $('nu').value = ''; $('np').value = '';
    await loadUsers();
  } catch (e) {
    $('regErr').textContent = e.message;
  } finally {
    btn.disabled = false; btn.classList.remove('loading');
  }
}

function copyResult() {
  if (!lastResult) return;
  const r = lastResult;
  const text =
    'username: ' + r.username + '\n' +
    'password: ' + r.password + '\n' +
    'deviceId: ' + r.deviceId + '\n' +
    'deviceSecret: ' + r.deviceSecret + '\n';
  navigator.clipboard.writeText(text).then(() => {
    const b = $('copyBtn');
    const old = b.textContent;
    b.textContent = 'Copied ✓';
    setTimeout(() => { b.textContent = old; }, 1500);
  }).catch(() => {});
}

async function logout() {
  try { if (token) await fetch('/api/admin/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }); } catch (e) {}
  token = null; lastResult = null;
  $('dashCard').classList.add('hidden');
  $('resultPanel').classList.add('hidden');
  $('loginCard').classList.remove('hidden');
  $('ap').value = '';
  setLoginLoading(false);
}

$('loginBtn').onclick = login;
$('ap').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
$('regBtn').onclick = register;
$('genPw').onclick = genPassword;
$('copyBtn').onclick = copyResult;
$('dismissBtn').onclick = () => $('resultPanel').classList.add('hidden');
$('logoutBtn').onclick = logout;
$('refreshBtn').onclick = loadUsers;