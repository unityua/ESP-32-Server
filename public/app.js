const API = ''; // same origin
let token = null, poll = null;
// The token lives only in this JS variable — never in localStorage or
// cookies. Closing the tab logs you out. That is intentional.

const $ = id => document.getElementById(id);

async function api(path, opts={}){
  opts.headers = Object.assign({'Content-Type':'application/json'}, opts.headers||{});
  if(token) opts.headers.Authorization = 'Bearer '+token;
  const r = await fetch(API+path, opts);
  if(r.status === 401 && token){ logout(); throw new Error('session expired'); }
  if(!r.ok) throw new Error((await r.json().catch(()=>({}))).error || r.status);
  return r.json();
}

async function login(){
  $('loginErr').textContent = '';
  try{
    const data = await api('/api/login',{method:'POST',
      body:JSON.stringify({username:$('u').value.trim(),password:$('p').value})});
    token = data.token;
    $('p').value = '';
    $('loginCard').classList.add('hidden');
    $('dashCard').classList.remove('hidden');
    $('hello').textContent = data.username + "'s Device";
    refresh();
    poll = setInterval(refresh, 3000);
  }catch(e){ $('loginErr').textContent = 'Login failed: '+e.message; }
}

function paintLed(led, online){
  const box=$('ledbox'), st=$('ledState');
  st.textContent = led ? 'ON' : 'OFF';
  box.style.borderColor = led ? 'var(--green)' : 'var(--blue)';
  box.style.boxShadow = led
    ? '0 0 32px rgba(61,220,145,.25) inset'
    : '0 0 32px rgba(77,139,255,.2) inset';
  st.style.color = led ? 'var(--green)' : 'var(--blue)';
  const dot=$('dDot');
  dot.style.background = online ? 'var(--green)' : 'var(--red)';
  $('dOnline').textContent = online ? 'online' : 'offline';
}

async function refresh(){
  try{
    const m = await api('/api/me');
    $('dUser').textContent = m.username;
    $('dId').textContent = m.deviceId;
    paintLed(m.led, m.online);
  }catch(e){ $('dashErr').textContent = e.message; }
}

async function setLed(on){
  $('dashErr').textContent='';
  try{ await api('/api/led',{method:'POST',body:JSON.stringify({on})}); refresh(); }
  catch(e){ $('dashErr').textContent = e.message; }
}

async function logout(){
  try{ if(token) await fetch('/api/logout',{method:'POST',
    headers:{Authorization:'Bearer '+token}}); }catch(e){}
  token=null; clearInterval(poll);
  $('dashCard').classList.add('hidden');
  $('loginCard').classList.remove('hidden');
  $('u').value=''; $('p').value='';
  $('dashErr').textContent='';
}

$('loginBtn').onclick = login;
$('p').addEventListener('keydown',e=>{if(e.key==='Enter')login()});
$('u').addEventListener('keydown',e=>{if(e.key==='Enter')login()});
$('onBtn').onclick = ()=>setLed(true);
$('offBtn').onclick = ()=>setLed(false);
$('logoutBtn').onclick = logout;
