const API = ''; // same origin
let token = null, poll = null;
// The token lives only in this JS variable — never in localStorage or
// cookies. Closing the tab logs you out. That is intentional.

const $ = id => document.getElementById(id);

async function api(path, opts={}) {
  opts.headers = Object.assign({'Content-Type':'application/json'}, opts.headers||{});
  if (token) opts.headers.Authorization = 'Bearer ' + token;
  const r = await fetch(API + path, opts);
  if (r.status === 401 && token) { logout(); throw new Error('session expired'); }
  if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error || r.status);
  return r.json();
}

function setLoginLoading(loading) {
  const btn = $('loginBtn');
  const inputs = [$('u'), $('p')];
  if (loading) {
    btn.classList.add('loading');
    btn.disabled = true;
    inputs.forEach(el => el.disabled = true);
  } else {
    btn.classList.remove('loading');
    btn.disabled = false;
    inputs.forEach(el => el.disabled = false);
  }
}

async function login() {
  $('loginErr').textContent = '';
  setLoginLoading(true);
  try {
    const data = await api('/api/login', {method:'POST',
      body: JSON.stringify({username: $('u').value.trim(), password: $('p').value})});
    token = data.token;
    $('p').value = '';
    $('loginCard').classList.add('hidden');
    $('dashCard').classList.remove('hidden');
    $('hello').textContent = data.username + "'s Device";
    refresh();
    poll = setInterval(refresh, 3000);
  } catch(e) {
    $('loginErr').textContent = 'Login failed: ' + e.message;
    setLoginLoading(false);
  }
}

function paintLed(n, led, pop) {
  const box = $('ledbox' + n), st = $('ledState' + n);
  st.textContent = led ? 'ON' : 'OFF';
  box.style.borderColor = led ? 'var(--green)' : 'var(--blue)';
  box.style.boxShadow = led
    ? '0 0 32px rgba(61,220,145,.25) inset'
    : '0 0 32px rgba(77,139,255,.2) inset';
  st.style.color = led ? 'var(--green)' : 'var(--blue)';
  if (pop) {
    box.classList.remove('pop');
    // force reflow so removing+adding the class restarts the animation
    void box.offsetWidth;
    box.classList.add('pop');
    box.addEventListener('animationend', () => box.classList.remove('pop'), { once: true });
  }
}

function paintOnline(online) {
  const dot = $('dDot');
  dot.style.background = online ? 'var(--green)' : 'var(--red)';
  $('dOnline').textContent = online ? 'online' : 'offline';
}

async function refresh() {
  try {
    const m = await api('/api/me');
    $('dUser').textContent = m.username;
    $('dId').textContent = m.deviceId;
    paintLed(1, m.led1);
    paintLed(2, m.led2);
    paintLed(3, m.led3);
    paintOnline(m.online);
  } catch(e) { $('dashErr').textContent = e.message; }
}

async function setLed(led, on) {
  $('dashErr').textContent = '';
  const box = $('ledbox' + led);
  const btnOn = $('on' + led), btnOff = $('off' + led);

  // Optimistic: flip display immediately so it feels instant
  paintLed(led, on);
  box.classList.add('pending');
  btnOn.disabled = btnOff.disabled = true;

  try {
    await api('/api/led', {method:'POST', body: JSON.stringify({led, on})});
    box.classList.remove('pending');
    btnOn.disabled = btnOff.disabled = false;
    paintLed(led, on, true);   // confirm pop
    refresh();                  // sync any drift from the poll interval
  } catch(e) {
    box.classList.remove('pending');
    btnOn.disabled = btnOff.disabled = false;
    paintLed(led, !on);         // roll back optimistic update
    $('dashErr').textContent = e.message;
  }
}

async function logout() {
  try { if (token) await fetch('/api/logout', {method:'POST',
    headers: {Authorization: 'Bearer ' + token}}); } catch(e) {}
  token = null; clearInterval(poll);
  $('dashCard').classList.add('hidden');
  $('loginCard').classList.remove('hidden');
  $('u').value = ''; $('p').value = '';
  $('dashErr').textContent = '';
  setLoginLoading(false);
}

$('loginBtn').onclick = login;
$('p').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
$('u').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
for (const n of [1, 2, 3]) {
  $('on' + n).onclick = () => setLed(n, true);
  $('off' + n).onclick = () => setLed(n, false);
}
$('logoutBtn').onclick = logout;
