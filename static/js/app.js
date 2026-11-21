/* SR Private Chat - client */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const BOOT = JSON.parse($('boot').textContent || '{}');
const TOKEN_KEY = 'sr_chat_token', THEME_KEY = 'sr_theme', LAST_KEY = 'sr_last_gid';
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};
const S = {
  token: ls.get(TOKEN_KEY) || '', me: null, sock: null, view: 'chat',
  groups: new Map(), gid: '', conn: 'wait', connText: 'Connecting…', pendingJoin: '', gsi: false,
  reply: null, seen: new Set(), msgs: new Map(), lastMsg: null, lastDay: '', atBottom: true, unread: 0,
  kicked: false
};

/* ------------------------------------------------------------------ helpers */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const k in props) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return el;
}
const svg = d => '<svg viewBox="0 0 24 24" aria-hidden="true">' + d + '</svg>';
const I = {
  chat: svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>'),
  video: svg('<rect x="3" y="6" width="12" height="12" rx="2.5"/><path d="m15 10 6-3.5v11L15 14"/>'),
  shield: svg('<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3z"/><path d="m9 12 2 2 4-4"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: svg('<path d="m3 3 18 18"/><path d="M10.6 5.1A9.7 9.7 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.5 6.6C3.7 8.4 2 12 2 12s3.5 7 10 7c1.5 0 2.8-.3 4-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  down: svg('<path d="M12 5v14m-6-6 6 6 6-6"/>'),
  reply: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v3"/>'),
  send: svg('<path d="M21 3 10 14"/><path d="m21 3-7 18-4-7-7-4 18-7z"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  camera: svg('<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>'),
  logout: svg('<path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4"/><path d="M16 8l4 4-4 4M20 12H9"/>'),
  moon: svg('<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3"/>'),
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  micOff: svg('<path d="m3 3 18 18"/><path d="M9 9v2a3 3 0 0 0 5 2.2M15 10V6a3 3 0 0 0-5.7-1.3"/><path d="M5 11a7 7 0 0 0 11.2 5.6M12 18v3"/>'),
  cam: svg('<rect x="3" y="6" width="12" height="12" rx="2.5"/><path d="m15 10 6-3.5v11L15 14"/>'),
  camOff: svg('<path d="m3 3 18 18"/><path d="M9.5 6H12a3 3 0 0 1 3 3v2.5M15 14.5V15a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V9a3 3 0 0 1 1.2-2.4"/><path d="m15 10 6-3.5v11l-3-1.7"/>'),
  spk: svg('<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 9a4.5 4.5 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11"/>'),
  spkOff: svg('<path d="m3 3 18 18"/><path d="M4 9v6h4l5 4V9.5M13 5v1.5"/><path d="M8 9l5-4"/>'),
  phone: svg('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>'),
  smile: svg('<circle cx="12" cy="12" r="9"/><path d="M8.5 14a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>'),
  gem: svg('<path d="M6 3h12l4 6-10 12L2 9z"/><path d="M2 9h20M9 3l-2 6 5 12 5-12-2-6"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  chev: svg('<path d="m9 6 6 6-6 6"/>'),
  refresh: svg('<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5"/>'),
  pin: svg('<path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>'),
  key: svg('<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  heart: svg('<path d="M12 21s-7.5-4.6-9.3-9.2C1.4 8.3 3.4 5 6.6 5c2 0 3.5 1.1 5.4 3 1.9-1.9 3.4-3 5.4-3 3.2 0 5.2 3.3 3.9 6.8C19.5 16.4 12 21 12 21z"/>'),
  briefcase: svg('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  end: svg('<path d="M3.5 14.5c5-4.5 12-4.5 17 0l-2.4 3a1.6 1.6 0 0 1-2.1.4l-2.1-1.3a3 3 0 0 0-3.2 0l-2.1 1.3a1.6 1.6 0 0 1-2.1-.4l-3-3z"/>')
};
const ico = name => h('span', { class: 'ico', html: I[name] });
const hue = s => { let x = 0; for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0; return x % 360; };

function setAvatar(el, u) {
  const seed = u.id || u.name || '?', hh = hue(seed);
  el.classList.add('avatar');
  el.dataset.uid = u.id || '';
  el.style.background = 'linear-gradient(135deg,hsl(' + hh + ' 68% 52%),hsl(' + ((hh + 50) % 360) + ' 68% 42%))';
  el.textContent = '';
  const initial = ([...String(u.name || '?').trim()][0] || '?').toUpperCase();
  if (u.avatar) {
    const img = h('img', { src: u.avatar, alt: '', decoding: 'async' });
    img.onerror = () => { img.remove(); el.textContent = initial; };
    el.append(img);
  } else el.textContent = initial;
  return el;
}
function avatarEl(u, size) {
  const el = h('div');
  if (size) el.style.setProperty('--s', size + 'px');
  return setAvatar(el, u);
}
function toast(msg, type = 'info', ms = 3800) {
  const t = h('div', { class: 'toast ' + type, role: 'status' }, msg);
  $('toasts').append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 260); }, ms);
}
function openModal(build) {
  const back = h('div', { class: 'modal-back', role: 'dialog', 'aria-modal': 'true' });
  const onKey = e => { if (e.key === 'Escape') close(); };
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  back.append(build(close));
  document.body.append(back);
  return close;
}
function busy(btn, on) { btn.classList.toggle('busy', !!on); btn.disabled = !!on; }
async function api(path, data) {
  let r;
  try {
    r = await fetch('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });
  } catch (e) { throw Object.assign(new Error('Cannot reach the server. Check your connection.'), { status: 0 }); }
  let d = {};
  try { d = await r.json(); } catch (e) {}
  if (!r.ok) throw Object.assign(new Error(d.error || 'Request failed (' + r.status + ')'), { status: r.status });
  return d;
}
const fmtTime = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function dayLabel(d) {
  const t = new Date(), y = new Date(Date.now() - 864e5);
  if (d.toDateString() === t.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric', year: d.getFullYear() === t.getFullYear() ? undefined : 'numeric' });
}
function linkify(text) {
  const frag = document.createDocumentFragment(), re = /https?:\/\/[^\s<]+/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    let url = m[0], trail = '';
    const t = url.match(/[),.;!?]+$/);
    if (t) { trail = t[0]; url = url.slice(0, -trail.length); }
    frag.append(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer nofollow' }, url));
    if (trail) frag.append(trail);
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

/* ------------------------------------------------------------------ theme */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  ls.set(THEME_KEY, t);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', t === 'light' ? '#f0f2f5' : '#202c33');
  document.querySelectorAll('#themeSeg button').forEach(b => b.classList.toggle('on', b.dataset.theme === t));
}

/* ------------------------------------------------------------------ auth (Google only) */
function showError(msg) { $('authError').textContent = msg || ''; }
const FB_VER = '10.14.1';
function loadScript(src) {
  return new Promise((res, rej) => {
    const el = h('script', { src }); el.onload = res; el.onerror = () => rej(new Error('Could not load Google sign-in. Check your connection and refresh.'));
    document.head.append(el);
  });
}
async function initFirebase() {
  if (S.fb) return S.fb;
  await loadScript('https://www.gstatic.com/firebasejs/' + FB_VER + '/firebase-app-compat.js');
  await loadScript('https://www.gstatic.com/firebasejs/' + FB_VER + '/firebase-auth-compat.js');
  if (!firebase.apps.length) firebase.initializeApp(BOOT.firebase);
  return (S.fb = firebase.auth());
}
async function finishFirebase(user) {
  const token = await user.getIdToken();
  try { await S.fb.signOut(); } catch (e) {}      // our own session takes over from here
  enter(await api('google', { credential: token }));
}
async function loadGoogle() {
  if (!BOOT.firebase || S.gsi) return;
  S.gsi = true;
  try {
    const auth = await initFirebase();
    const r = await auth.getRedirectResult();    // returns here after a redirect sign-in (some mobile browsers)
    if (r && r.user) { $('googleWrap').classList.add('busy'); await finishFirebase(r.user); }
  } catch (e) { showError(e.message && !e.code ? e.message : 'Google sign-in failed. Please try again.'); S.gsi = false; }
  finally { $('googleWrap').classList.remove('busy'); }
}
async function onGoogleClick() {
  showError(''); $('googleWrap').classList.add('busy');
  try {
    const auth = await initFirebase(), provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try { const r = await auth.signInWithPopup(provider); await finishFirebase(r.user); }
    catch (e) {
      if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') { await auth.signInWithRedirect(provider); return; }
      throw e;
    }
  } catch (e) {
    const c = e && e.code;
    if (c === 'auth/popup-closed-by-user' || c === 'auth/cancelled-popup-request') showError('Sign-in was cancelled.');
    else if (c === 'auth/unauthorized-domain') showError('This website address is not allowed yet. Add it under Firebase Authentication > Settings > Authorized domains.');
    else if (c === 'auth/operation-not-allowed') showError('Google sign-in is not enabled in Firebase Authentication.');
    else showError(e && !c ? e.message : 'Google sign-in failed. Please try again.');
  } finally { $('googleWrap').classList.remove('busy'); }
}
async function devLogin(e) {
  e.preventDefault();
  const name = $('devName').value.trim();
  if (!name) return showError('Enter a test name.');
  showError(''); busy($('devBtn'), true);
  try { enter(await api('dev-login', { name })); }
  catch (err) { showError(err.message); }
  finally { busy($('devBtn'), false); }
}
function showAuth() {
  $('splash').hidden = true; $('app').hidden = true; $('auth').hidden = false;
  $('googleWrap').hidden = !BOOT.firebase;
  $('devForm').hidden = !BOOT.dev_login;
  $('noAuth').hidden = !!(BOOT.firebase || BOOT.dev_login);
  loadGoogle();
}
function enter(data) {
  S.token = data.token; S.me = data.me; S.kicked = false;
  S.groups = new Map(); S.gid = ''; S.view = 'chat';
  ls.set(TOKEN_KEY, S.token);
  $('splash').hidden = true; $('auth').hidden = true; $('app').hidden = false;
  renderMe(); syncView(); renderGroupList(); updateCallUI();
  connect();
}
function renderMe() {
  const m = S.me;
  $('meBtn').replaceChildren(avatarEl(m, 36));
  $('meChip').replaceChildren(avatarEl(m, 38), h('div', { class: 'mi' }, h('b', null, nameBadge(m.name, m.verified)), h('small', { text: '@' + m.username })), h('span', { class: 'chip-stone' }, gemEl(), String(m.stones || 0)));
  setAvatar($('accAvatar'), m);
  $('accName').replaceChildren(nameBadge(m.name, m.verified));
  $('accHandle').textContent = '@' + m.username;
  $('accBio').textContent = m.bio || 'Add a short bio so people know who you are.';
  $('accBio').classList.toggle('empty', !m.bio);
  const chip = (icon, text) => h('span', { class: 'pchip' }, ico(icon), text);
  const since = m.created_at ? new Date(m.created_at).toLocaleDateString([], { month: 'short', year: 'numeric' }) : '';
  $('accChips').replaceChildren(...[
    m.gender ? chip('user', cap(m.gender)) : null, m.location ? chip('pin', m.location) : null, m.hobby ? chip('heart', m.hobby) : null,
    m.occupation ? chip('briefcase', m.occupation) : null, m.languages ? chip('chat', m.languages) : null, since ? chip('clock', 'Joined ' + since) : null].filter(Boolean));
  $('walletBal').textContent = m.stones || 0;
  $('walletHint').textContent = 'Groups created: ' + m.owned + ' of ' + m.slots;
  const o = m.order; $('walletOrder').hidden = !o;
  if (o) $('walletOrder').replaceChildren(ico('clock'), h('span', { text: 'Order pending: ' + o.pack + ' Stone. Waiting for the admin.' }));
  $('activeSwitch').checked = m.show_active !== false;
  $('adminOpenBtn').hidden = !m.is_admin;
  $('verifyText').textContent = m.verified ? 'Your account is verified.' : m.verify_requested ? 'Request sent. Waiting for admin approval.' : 'Get the blue badge next to your name.';
  $('verifyBtn').hidden = !!m.verified; $('verifyBtn').disabled = !!m.verify_requested; $('verifyBtn').textContent = m.verify_requested ? 'Pending' : 'Request';
}
const curGroup = () => S.groups.get(S.gid);
function syncView() {
  const chat = S.view === 'chat', G = curGroup();
  const mobile = matchMedia('(max-width:959px)').matches;
  $('app').classList.toggle('home', mobile && chat && !G && S.groups.size > 0);   // phone: the chat list is the main page
  $('chatView').hidden = !(chat && G);
  $('welcome').hidden = !(chat && !G);
  $('accountView').hidden = S.view !== 'account';
  $('adminView').hidden = S.view !== 'admin';
  const none = !S.groups.size;
  $('welcomeTitle').textContent = none ? 'Start your first group' : 'Select a chat';
  $('welcomeText').textContent = none ? 'Create a private group and share its invite code, find one by name, or join a friend\'s group with their code.' : 'Pick a group from the list, or create / join another one.';
  renderHeader();
}
function showView(v) {
  S.view = v; closeSide(); syncView();
  if (v === 'chat' && curGroup()) scrollBottom();
}
function firstName(u) { return String(u.name || '').split(' ')[0] || 'Member'; }
function renderHeader() {
  const G = curGroup(), chat = S.view === 'chat' && !!G;
  $('roomTitle').textContent = S.view === 'account' ? 'My account' : S.view === 'admin' ? 'Admin panel' : G ? G.name : (BOOT.title || 'Chat');
  $('grpAv').replaceChildren(G && S.view === 'chat' ? avatarEl({ id: G.id, name: G.name, avatar: G.avatar }, 40) : h('img', { class: 'logo-img hdr', src: '/static/logo.png', alt: '' }));
  $('grpBtn').disabled = !chat;
  for (const id of ['callBtn', 'voiceBtn']) $(id).hidden = !chat;
  let text = S.connText || '';
  if (S.conn === 'on') {
    if (G && S.view === 'chat') {
      const on = new Set(G.online || []);
      text = [...G.members].sort((a, b) => (on.has(b.id) - on.has(a.id)) || a.name.localeCompare(b.name))
        .map(m => m.id === S.me.id ? 'You' : firstName(m)).join(', ');
    } else text = S.view === 'account' ? 'Your profile' : S.view === 'admin' ? 'Manage Stone' : 'Online';
  }
  $('status').dataset.s = S.conn || 'wait';
  $('statusText').textContent = text;
}
const BADGE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#1d9bf0" d="M12 1.8l2.4 1.7 2.9-.2 1.1 2.7 2.6 1.4-.4 2.9L22 12l-1.4 1.9.4 2.9-2.6 1.4-1.1 2.7-2.9-.2L12 22.2l-2.4-1.7-2.9.2-1.1-2.7-2.6-1.4.4-2.9L2 12l1.4-1.9-.4-2.9 2.6-1.4 1.1-2.7 2.9.2z"/><path d="m8.2 12.3 2.6 2.6 5-5.4" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const badgeEl = () => h('span', { class: 'vbadge', title: 'Verified', html: BADGE_SVG });
const nameBadge = (name, verified) => h('span', { class: 'nb' }, name, verified ? badgeEl() : null);
const cap = t => t ? t[0].toUpperCase() + t.slice(1) : '';
function askSignOut() { confirmDialog({ title: 'Sign out?', text: 'You will need to sign in with Google again on this device. Your groups and messages stay safe.', label: 'Sign out', onConfirm: signOut }); }
function confirmDialog({ title, text, label = 'Confirm', danger = false, onConfirm }) {
  return openModal(close => {
    const go = h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), type: 'button' }, h('span', { class: 'spin' }), h('span', { class: 'label', text: label }));
    go.onclick = async () => { busy(go, true); try { await onConfirm(); close(); } catch (e) { busy(go, false); toast(e.message, 'error'); } };
    return h('div', { class: 'modal confirm' }, h('div', { class: 'cf-ico' + (danger ? ' danger' : '') }, ico(danger ? 'trash' : 'shield')),
      h('h3', { text: title }), h('p', { text }), h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), go));
  });
}
const gemEl = () => h('span', { class: 'gem', 'aria-hidden': 'true' });
function openEditProfile() {
  openModal(close => {
    const m = S.me; let avatarData;
    const file = h('input', { type: 'file', accept: 'image/*', hidden: true });
    const nameIn = h('input', { class: 'input', value: m.name, maxlength: '40', autocomplete: 'name' });
    const unameIn = h('input', { value: m.username, maxlength: '20', autocapitalize: 'none', spellcheck: 'false', autocomplete: 'off', placeholder: 'username' });
    const uHint = h('small', { class: 'fh' });
    const av = h('div', { class: 'ep-av' });
    const paintAv = () => av.replaceChildren(avatarEl({ id: m.id, name: nameIn.value || m.name, avatar: avatarData === '' ? '' : (avatarData || m.avatar) }, 72));
    nameIn.addEventListener('input', paintAv);
    file.onchange = async () => { const f = file.files[0]; file.value = ''; if (!f) return; if (!/^image\//.test(f.type)) return toast('Please choose an image file.', 'error'); try { avatarData = (await cropAvatar(f)).data; paintAv(); } catch (e) { toast(e.message, 'error'); } };
    const okU = v => /^[a-z0-9_-]{5,20}$/.test(v);
    const checkU = () => { const v = unameIn.value; uHint.textContent = !v ? '5-20 characters: a-z, 0-9, _ and -' : okU(v) ? (v === m.username ? 'This is your current username.' : 'Looks good. We check availability when you save.') : v.length < 5 ? 'Too short: at least 5 characters.' : ''; uHint.classList.toggle('bad', !!v && !okU(v)); };
    unameIn.addEventListener('input', () => { unameIn.value = unameIn.value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20); checkU(); });
    let gender = m.gender || '';
    const gBtns = [['male', 'Male'], ['female', 'Female'], ['other', 'Other'], ['', 'Hide']].map(([v, l]) => h('button', { type: 'button', class: gender === v ? 'on' : '', onclick: () => { gender = v; gBtns.forEach((b, i) => b.classList.toggle('on', ['male', 'female', 'other', ''][i] === v)); } }, l));
    const inp = (v, max, ph) => h('input', { class: 'input', value: v || '', maxlength: String(max), placeholder: ph });
    const loc = inp(m.location, 40, 'City, Country'), lang = inp(m.languages, 60, 'Bangla, English'), hobby = inp(m.hobby, 80, 'Gaming, music, travel'), occ = inp(m.occupation, 50, 'Student, designer...');
    const bio = h('textarea', { class: 'input', maxlength: '160', rows: '3', placeholder: 'Tell people a little about you' }); bio.value = m.bio || '';
    const cnt = h('small', { class: 'fh right' }); const paintCnt = () => { cnt.textContent = bio.value.length + ' / 160'; }; bio.addEventListener('input', paintCnt);
    const fld = (label, el, extra) => h('label', { class: 'field' }, h('span', { text: label }), el, extra || null);
    const err = h('div', { class: 'err' });
    const save = h('button', { class: 'btn primary', type: 'button' }, h('span', { class: 'spin' }), h('span', { class: 'label', text: 'Save changes' }));
    save.onclick = async () => {
      const name = nameIn.value.trim().replace(/\s+/g, ' ');
      if (!name) { err.textContent = 'Display name cannot be empty.'; return; }
      if (!okU(unameIn.value)) { err.textContent = 'Username must be 5-20 characters: small letters, numbers, _ or -'; return; }
      const next = { name, username: unameIn.value, gender, location: loc.value.trim(), languages: lang.value.trim(), hobby: hobby.value.trim(), occupation: occ.value.trim(), bio: bio.value.trim() };
      const payload = { token: S.token }; let changed = false;
      for (const k in next) if ((m[k] || '') !== next[k]) { payload[k] = next[k]; changed = true; }
      if (avatarData !== undefined) { payload.avatar = avatarData; changed = true; }
      if (!changed) { close(); return; }
      busy(save, true); err.textContent = '';
      try { const r = await api('profile', payload); Object.assign(S.me, r.me); renderMe(); close(); toast('Profile updated.', 'ok'); }
      catch (e) { busy(save, false); err.textContent = e.message; }
    };
    paintAv(); checkU(); paintCnt();
    return h('div', { class: 'modal sheet edit-profile' }, h('h3', { text: 'Edit profile' }),
      h('div', { class: 'sheet-body' },
        h('div', { class: 'ep-photo' }, av, h('div', null, h('div', { class: 'row left' }, h('button', { class: 'btn sm', type: 'button', onclick: () => file.click() }, ico('camera'), 'Change photo'), h('button', { class: 'btn sm', type: 'button', onclick: () => { avatarData = ''; paintAv(); } }, 'Remove')), h('small', { class: 'fh', text: 'Square photo, cropped automatically.' }), file)),
        fld('Display name', nameIn),
        fld('Username', h('div', { class: 'at-input' }, h('i', { text: '@' }), unameIn), uHint),
        h('div', { class: 'field' }, h('span', { text: 'Gender' }), h('div', { class: 'seg four' }, ...gBtns)),
        h('div', { class: 'two' }, fld('Location', loc), fld('Languages', lang)),
        fld('Hobbies & interests', hobby), fld('Occupation', occ), fld('Bio', bio, cnt), err),
      h('div', { class: 'sheet-foot' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), save));
  });
}
async function openProfile(uid) {
  if (!uid || uid === 'system') return;
  let p;
  try { p = uid === S.me.id ? { ...S.me, online: true } : (await api('user', { token: S.token, uid })).profile; }
  catch (e) { return toast(e.message, 'error'); }
  openModal(close => {
    const row = (icon, label, val) => val ? h('li', null, h('span', { class: 'pi' }, ico(icon)), h('div', null, h('small', { text: label }), h('b', { text: val }))) : null;
    const since = p.created_at ? new Date(p.created_at).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' }) : '';
    const rows = [row('user', 'Gender', cap(p.gender)), row('pin', 'Location', p.location), row('heart', 'Hobbies & interests', p.hobby), row('chat', 'Languages', p.languages), row('briefcase', 'Occupation', p.occupation), row('clock', 'Member since', since)].filter(Boolean);
    return h('div', { class: 'modal sheet pv' },
      h('div', { class: 'pv-cover' }),
      h('div', { class: 'pv-head' }, h('div', { class: 'pv-av' }, avatarEl(p, 88)),
        h('h3', null, nameBadge(p.name, p.verified)), h('p', { class: 'pv-user', text: '@' + p.username }),
        h('span', { class: 'pill ' + (p.online ? 'ok' : 'off') }, h('span', { class: 'dot' }), p.online ? 'Online' : 'Offline')),
      h('div', { class: 'sheet-body' },
        p.bio ? h('p', { class: 'pv-bio', text: p.bio }) : h('p', { class: 'pv-bio empty', text: 'No bio yet.' }),
        rows.length ? h('ul', { class: 'pv-list' }, ...rows) : null),
      h('div', { class: 'sheet-foot' }, uid === S.me.id ? h('button', { class: 'btn', type: 'button', onclick: () => { close(); openEditProfile(); } }, 'Edit profile') : null, h('button', { class: 'btn primary', type: 'button', onclick: close }, 'Close')));
  });
}
function openBuyStone(note) {
  const L = BOOT.limits || {}, packs = BOOT.packs || [10, 25, 50, 100, 250], labels = { 10: 'Starter', 25: 'Popular', 50: 'Plus', 100: 'Pro', 250: 'Mega' };
  openModal(close => {
    let pick = packs.includes(25) ? 25 : packs[0];
    const summary = n => 'Good for ' + Math.floor(n / L.slot_cost) + ' group slot' + (Math.floor(n / L.slot_cost) === 1 ? '' : 's') + ' or ' + Math.floor(n / L.members_cost) + ' member upgrade' + (Math.floor(n / L.members_cost) === 1 ? '' : 's') + '.';
    const sum = h('p', { class: 'pack-sum', text: summary(pick) });
    const cards = packs.map(n => h('button', { type: 'button', class: 'pack' + (n === pick ? ' on' : ''), onclick: () => { pick = n; cards.forEach((c, i) => c.classList.toggle('on', packs[i] === n)); sum.textContent = summary(n); } },
      n === 25 ? h('i', { class: 'pop', text: 'Popular' }) : null, gemEl(), h('b', { text: String(n) }), h('small', { text: labels[n] || 'Pack' })));
    const go = h('button', { class: 'btn primary lg block', type: 'button' }, ico('send'), h('span', { text: 'Order on Telegram' }));
    go.onclick = () => {
      const msg = 'Hi! I want to buy ' + pick + ' Stone for ' + (BOOT.title || 'Anonymous Group Chat') + '.\nUsername: @' + S.me.username + '\nUser ID: ' + S.me.id;
      window.open('https://t.me/' + (BOOT.telegram || 'developer_bhai') + '?text=' + encodeURIComponent(msg), '_blank', 'noopener');
      api('stone-order', { token: S.token, pack: pick }).then(r => { Object.assign(S.me, r.me); renderMe(); }).catch(() => {});
      close(); toast('Order sent to the admin. Finish the payment on Telegram.', 'ok', 5200);
    };
    return h('div', { class: 'modal sheet store' },
      h('div', { class: 'st-head' }, h('span', { class: 'wc-ico' }, gemEl()), h('div', null, h('h3', { text: 'Stone Store' }), h('p', { text: 'Choose a pack and order on Telegram.' })), h('span', { class: 'chip-stone big' }, gemEl(), String(S.me.stones || 0))),
      h('div', { class: 'sheet-body' },
        note ? h('p', { class: 'warnline', text: note }) : null,
        h('div', { class: 'packs' }, ...cards), sum,
        h('ol', { class: 'steps' }, h('li', null, h('b', { text: '1' }), 'Pick a pack'), h('li', null, h('b', { text: '2' }), 'Order on Telegram (@' + (BOOT.telegram || 'developer_bhai') + ')'), h('li', null, h('b', { text: '3' }), 'Admin adds Stone to your wallet')),
        h('div', { class: 'costs' },
          h('div', null, ico('plus'), h('span', { text: 'New group slot' }), h('i', { text: L.slot_cost + ' Stone' })),
          h('div', null, ico('users'), h('span', { text: '+' + L.members_step + ' members for a group' }), h('i', { text: L.members_cost + ' Stone' })))),
      h('div', { class: 'sheet-foot' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Close'), go));
  });
}
function openUnlockSlot() {
  const L = BOOT.limits || {};
  openModal(close => {
    const enough = S.me.stones >= L.slot_cost;
    const go = h('button', { class: 'btn primary', type: 'button' }, h('span', { class: 'spin' }), h('span', { class: 'label', text: enough ? 'Unlock for ' + L.slot_cost + ' Stone' : 'Buy Stone' }));
    go.onclick = async () => {
      if (!enough) { close(); return openBuyStone('You need ' + L.slot_cost + ' Stone to unlock a group slot.'); }
      busy(go, true);
      try { const r = await api('buy-slot', { token: S.token }); S.me = r.me; renderMe(); close(); toast('Group slot unlocked.', 'ok'); openGroupModal('create'); }
      catch (e) { busy(go, false); toast(e.message, 'error'); }
    };
    return h('div', { class: 'modal confirm' }, h('div', { class: 'cf-ico' }, gemEl()), h('h3', { text: 'Group limit reached' }),
      h('p', { text: 'Every user can create ' + L.free_groups + ' groups for free. Unlock one more group slot with Stone.' }),
      h('div', { class: 'bal inline' }, gemEl(), h('b', { text: String(S.me.stones) }), h('small', { text: 'Stone in your wallet' })),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Not now'), go));
  });
}
const openSide = () => { $('sidebar').classList.add('open'); };
const closeSide = () => { $('sidebar').classList.remove('open'); };

async function signOut() {
  const t = S.token;
  endCall(true);
  if (S.sock) { S.sock.disconnect(); }
  try { await api('logout', { token: t }); } catch (e) {}
  ls.del(TOKEN_KEY);
  location.reload();
}
function showKicked(code, reason) {
  if (S.kicked) return;
  S.kicked = true;
  endCall(false);
  if (S.sock) S.sock.disconnect();
  const again = code === 'other_tab';
  const el = h('div', { class: 'kicked' }, h('div', { class: 'modal' },
    h('div', { class: 'big', text: again ? '🪟' : '🔒' }),
    h('h3', { text: again ? 'Open in another window' : 'Signed out' }),
    h('p', { text: reason || 'Your session has ended.' }),
    h('div', { class: 'row', style: 'justify-content:center' },
      again ? h('button', { class: 'btn primary', type: 'button', onclick: () => { el.remove(); S.kicked = false; connect(); } }, 'Use here instead') : null,
      h('button', { class: again ? 'btn' : 'btn primary', type: 'button', onclick: () => { if (again) signOut(); else { ls.del(TOKEN_KEY); location.reload(); } } }, again ? 'Sign out' : 'Sign in again'))));
  document.body.append(el);
}

/* ------------------------------------------------------------------ socket */
function setStatus(state, text) { S.conn = state; S.connText = text; renderHeader(); }
function ask(ev, data) {
  return new Promise((res, rej) => {
    if (!S.sock || !S.sock.connected) return rej(new Error('You are offline. Reconnecting…'));
    S.sock.timeout(10000).emit(ev, data, (err, r) => {
      if (err) return rej(new Error('The server did not respond. Please try again.'));
      if (r && r.ok) return res(r);
      rej(Object.assign(new Error((r && r.error) || 'Something went wrong.'), { code: r && r.code }));
    });
  });
}
function connect() {
  if (S.sock) { S.sock.removeAllListeners(); S.sock.disconnect(); }
  setStatus('wait', 'Connecting…');
  const sock = io({ auth: { token: S.token }, transports: ['websocket', 'polling'], reconnectionDelayMax: 4000, timeout: 12000 });
  S.sock = sock;
  sock.on('connect', () => setStatus('on', 'Online'));
  sock.on('disconnect', () => { if (!S.kicked) setStatus('wait', 'Reconnecting…'); });
  sock.on('connect_error', async () => {
    setStatus('wait', 'Reconnecting…');
    if (sock.active) return;
    try { await api('me', { token: S.token }); setTimeout(() => { if (S.sock === sock && !S.kicked) sock.connect(); }, 2500); }
    catch (e) {
      if (e.status === 401) { ls.del(TOKEN_KEY); showKicked('expired', 'Your session has expired. Please sign in again.'); }
      else setTimeout(() => { if (S.sock === sock && !S.kicked) sock.connect(); }, 3000);
    }
  });
  sock.on('session_replaced', d => showKicked(d && d.code, d && d.reason));
  sock.on('groups_state', onGroupsState);
  sock.on('group_updated', gp => { addGroup(gp); if (gp.id === S.gid) { renderHeader(); updateCallUI(); } });
  sock.on('group_presence', d => {
    const G = S.groups.get(d.gid); if (!G) return;
    G.online = d.online || []; G.call = d.call || G.call;
    renderGroupList();
    if (d.gid === S.gid) { renderHeader(); updateCallUI(); }
  });
  sock.on('new_message', onNewMessage);
  sock.on('message_reaction', d => {
    const G = S.groups.get(d.gid); if (!G) return;
    const cm = G.msgs && G.msgs.find(x => x.id === d.id); if (cm) cm.reactions = d.reactions || {};
    if (d.gid !== S.gid) return;
    const m = S.msgs.get(d.id); if (m) m.reactions = d.reactions || {};
    const row = feed.querySelector('.msg[data-id="' + d.id + '"]'); if (row) paintReactions(row, d.reactions);
  });
  sock.on('message_failed', d => {
    const G = S.groups.get(d.gid); if (G && G.msgs) G.msgs = G.msgs.filter(x => x.id !== d.id);
    if (d.gid !== S.gid) return;
    const m = S.msgs.get(d.id);
    feed.querySelector('.msg[data-id="' + d.id + '"]')?.remove();
    if (m && m.uid === S.me.id) toast('A message could not be saved and was removed.', 'error');
  });
  sock.on('messages_removed', d => {
    const G = S.groups.get(d.gid); if (G && G.msgs) G.msgs = G.msgs.filter(x => x.uid !== d.uid);
    if (d.gid === S.gid) feed.querySelectorAll('.msg[data-uid="' + d.uid + '"]').forEach(n => n.remove());
  });
  sock.on('profile_updated', onProfileUpdated);
  sock.on('wallet_updated', d => { Object.assign(S.me, d); renderMe(); });
  sock.on('group_joined', gp => { addGroup(gp); toast('Your request to join "' + gp.name + '" was approved.', 'ok'); });
  sock.on('join_declined', d => toast('Your request to join "' + d.name + '" was declined.', 'info'));
  sock.on('join_request', d => toast(d.name + ' wants to join "' + d.group + '".', 'info', 5200));
  sock.on('group_deleted', d => { dropGroup(d.gid); toast('"' + d.name + '" was deleted by its owner.', 'info'); });
  sock.on('video_peer_joined', onPeerJoined);
  sock.on('video_peer_left', d => removePeer(d.sid));
  sock.on('peer_media', onPeerMedia);
  sock.on('webrtc_signal', handleSignal);
}
function onProfileUpdated(d) {
  if (d.id === S.me.id) { Object.assign(S.me, { name: d.name, username: d.username, avatar: d.avatar, verified: !!d.verified }); renderMe(); }
  for (const G of S.groups.values()) {
    const m = G.members.find(x => x.id === d.id); if (m) { m.name = d.name; m.username = d.username; m.avatar = d.avatar; m.verified = !!d.verified; }
    if (G.msgs) G.msgs.forEach(x => { if (x.uid === d.id) { x.name = d.name; x.username = d.username; x.avatar = d.avatar; x.verified = !!d.verified; } });
  }
  const u = { id: d.id, name: d.name, avatar: d.avatar };
  document.querySelectorAll('.avatar[data-uid="' + d.id + '"]').forEach(el => setAvatar(el, u));
  document.querySelectorAll('.msg[data-uid="' + d.id + '"] .name').forEach(n => { const nm = n.querySelector('.nm'); if (nm) nm.textContent = d.name; n.querySelectorAll('.vbadge').forEach(b => b.remove()); if (d.verified) (n.querySelector('.nm') || n).after(badgeEl()); });
  document.querySelectorAll('.msg[data-uid="' + d.id + '"] .name .un').forEach(n => { n.textContent = '@' + d.username; });
  for (const sid in C.peers) if (C.peers[sid].uid === d.id) { C.peers[sid].name = d.name; labelTile(sid); }
  renderHeader();
}
/* ------------------------------------------------------------------ groups & chat list */
function addGroup(gp) {
  const G = Object.assign(S.groups.get(gp.id) || { msgs: null, unread: 0 }, gp);
  S.groups.set(gp.id, G);
  renderGroupList();
  if (!S.gid) syncView();
  return G;
}
function onGroupsState(d) {
  const old = S.groups; S.groups = new Map();
  for (const gp of d.groups || []) S.groups.set(gp.id, Object.assign({ msgs: null, unread: old.has(gp.id) ? old.get(gp.id).unread : 0 }, gp));
  if (!S.groups.has(S.gid)) S.gid = '';
  if (!S.gid) {
    const last = ls.get(LAST_KEY), first = S.groups.keys().next().value;
    if (matchMedia('(min-width:960px)').matches) S.gid = S.groups.has(last) ? last : (first || '');
  }
  renderGroupList();
  if (S.gid) selectGroup(S.gid);
  else syncView();
  updateCallUI();
  handlePendingJoin();
}
function shortTime(ts) {
  const d = new Date(ts), t = new Date();
  if (d.toDateString() === t.toDateString()) return fmtTime(ts);
  if (d.toDateString() === new Date(Date.now() - 864e5).toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}
function previewText(G) {
  const l = G.last;
  if (!l) return G.members.length + ' member' + (G.members.length === 1 ? '' : 's');
  return (l.uid === S.me.id ? 'You' : String(l.name || '').split(' ')[0]) + ': ' + l.text;
}
function renderGroupList() {
  const rows = [...S.groups.values()].sort((a, b) => ((b.last && b.last.ts) || b.created_at) - ((a.last && a.last.ts) || a.created_at));
  $('chatCount').textContent = rows.length;
  if (!rows.length) { $('chatList').replaceChildren(h('li', { class: 'chat-empty' }, 'No chats yet. Tap + to create a group, find one by name or join with an invite code.')); return; }
  $('chatList').replaceChildren(...rows.map(G => {
    const reqs = G.owner === S.me.id && G.pending_count > 0;
    return h('li', null, h('button', { type: 'button', class: 'chat-row' + (G.id === S.gid && S.view === 'chat' ? ' on' : ''), onclick: () => selectGroup(G.id) },
      avatarEl({ id: G.id, name: G.name, avatar: G.avatar }, 50),
      h('div', { class: 'cr-main' },
        h('div', { class: 'cr-top' }, h('b', { text: G.name }), h('time', { text: G.last ? shortTime(G.last.ts) : '' })),
        h('div', { class: 'cr-bot' },
          G.call && G.call.active ? h('span', { class: 'cr-call' }, ico('video'), 'Call in progress')
            : reqs ? h('span', { class: 'cr-call' }, ico('users'), G.pending_count + ' join request' + (G.pending_count === 1 ? '' : 's'))
            : h('span', { class: 'cr-prev', text: previewText(G) }),
          G.unread ? h('span', { class: 'badge-n', text: G.unread > 99 ? '99+' : String(G.unread) }) : null))));
  }));
}
async function selectGroup(gid) {
  const G = S.groups.get(gid); if (!G) return;
  S.gid = gid; S.view = 'chat'; G.unread = 0; ls.set(LAST_KEY, gid);
  clearReply(); closeSide(); syncView(); renderGroupList(); updateCallUI();
  if (G.msgs) return renderHistory(G.msgs);
  feed.replaceChildren(h('div', { class: 'empty' }, 'Loading messages…'));
  try { G.msgs = (await ask('get_history', { gid })).messages || []; }
  catch (e) { if (S.gid === gid) feed.replaceChildren(h('div', { class: 'empty' }, e.message)); return; }
  if (S.gid === gid && S.view === 'chat') renderHistory(G.msgs);
}
function dropGroup(gid) {
  if (C.phase !== 'idle' && C.gid === gid) endCall(false);
  S.groups.delete(gid);
  if (S.gid === gid) {
    S.gid = ''; clearReply();
    const first = S.groups.keys().next().value;
    if (first && matchMedia('(min-width:960px)').matches) { selectGroup(first); return; }
  }
  syncView(); renderGroupList(); updateCallUI();
}
async function leaveGroup(gid) {
  await ask('leave_group', { gid });
  dropGroup(gid);
  toast('You left the group.', 'ok');
}
async function deleteGroup(gid) {
  await ask('delete_group', { gid });
  dropGroup(gid);
  toast('Group deleted.', 'ok');
}
async function copyText(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg, 'ok'); }
  catch (e) {
    const t = h('textarea', { style: 'position:fixed;opacity:0' }); t.value = text; document.body.append(t); t.select();
    try { document.execCommand('copy'); toast(okMsg, 'ok'); } catch (e2) { toast('Copy failed. Select the text and copy it manually.', 'error'); }
    t.remove();
  }
}
async function handlePendingJoin() {
  const code = S.pendingJoin; if (!code) return;
  S.pendingJoin = '';
  history.replaceState(null, '', location.pathname);
  try {
    const r = await ask('join_group', { code });
    addGroup(r.group); await selectGroup(r.group.id);
    toast(r.already ? 'You are already in this group.' : 'You joined ' + r.group.name + '.', 'ok');
  } catch (e) { toast(e.message, 'error'); }
}
function openGroupModal(tab = 'find') {
  openModal(close => {
    let mode = tab, timer = 0, seq = 0;
    const L = BOOT.limits || {};
    const findIn = h('input', { placeholder: 'Search groups by name', maxlength: '40', autocomplete: 'off', 'aria-label': 'Search groups' });
    const results = h('ul', { class: 'find-list' });
    const codeIn = h('input', { class: 'code-in', placeholder: 'XXXX-XXXX', maxlength: '9', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': 'Invite code' });
    const nameIn = h('input', { class: 'input', placeholder: 'e.g. Weekend Gamers', maxlength: '40', autocomplete: 'off', 'aria-label': 'Group name' });
    const apCb = h('input', { type: 'checkbox' });
    const err = h('div', { class: 'err' });
    const go = h('button', { class: 'btn primary', type: 'submit' }, h('span', { class: 'spin' }), h('span', { class: 'label' }));
    const defs = { find: ['search', 'Find'], join: ['key', 'Join'], create: ['plus', 'Create'] };
    const tabs = {}; for (const k in defs) tabs[k] = h('button', { type: 'button', role: 'tab' }, ico(defs[k][0]), h('span', { text: defs[k][1] }));
    const panes = {
      find: h('div', { class: 'pane' }, h('div', { class: 'search-box lg' }, ico('search'), findIn), results),
      join: h('div', { class: 'pane center' }, h('div', { class: 'hero-ico' }, ico('key')), h('p', { class: 'pane-t', text: 'Have an invite code?' }), h('p', { class: 'pane-s', text: 'Enter the 8-character code a friend shared with you.' }), codeIn),
      create: h('div', { class: 'pane' }, h('label', { class: 'field' }, h('span', { text: 'Group name' }), nameIn),
        h('label', { class: 'switch-row compact' }, h('span', null, h('b', { text: 'Approve new members' }), h('small', { text: 'You review every join request.' })), h('span', { class: 'switch' }, apCb, h('i'))),
        h('div', { class: 'facts' }, h('span', null, ico('users'), L.base_members + ' members'), h('span', null, ico('plus'), (S.me.slots - S.me.owned) + ' free slot' + (S.me.slots - S.me.owned === 1 ? '' : 's') + ' left'), h('span', null, ico('shield'), 'Private by default'))) };
    const paint = () => {
      for (const k in tabs) { tabs[k].classList.toggle('on', mode === k); tabs[k].setAttribute('aria-selected', mode === k); panes[k].hidden = mode !== k; }
      go.hidden = mode === 'find';
      go.querySelector('.label').textContent = mode === 'create' ? 'Create group' : 'Join group';
      err.textContent = '';
      setTimeout(() => ({ find: findIn, join: codeIn, create: nameIn })[mode].focus(), 40);
    };
    for (const k in tabs) tabs[k].onclick = () => { mode = k; paint(); };
    codeIn.addEventListener('input', () => { const v = codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); codeIn.value = v.length > 4 ? v.slice(0, 4) + '-' + v.slice(4) : v; });
    const joined = async r => {
      if (r.status === 'pending') { toast('Request sent to "' + (r.name || 'the group') + '". You can chat once the owner approves.', 'ok', 5200); return false; }
      close(); addGroup(r.group); await selectGroup(r.group.id);
      toast(r.status === 'member' ? 'You are already in this group.' : 'You joined ' + r.group.name + '.', 'ok'); return true;
    };
    const renderResults = (rows, q) => {
      if (!rows.length) { results.replaceChildren(h('li', { class: 'find-empty' }, h('div', { class: 'hero-ico sm' }, ico('search')), h('b', { text: q.length < 2 ? 'Discover public groups' : 'No groups found' }), h('small', { text: q.length < 2 ? 'Type at least 2 letters of a group name.' : 'Nothing matches "' + q + '". Try another name or use an invite code.' }))); return; }
      results.replaceChildren(...rows.map(g => {
        const label = { open: 'Join', approval: 'Request', pending: 'Requested', member: 'Open', full: 'Full' }[g.status];
        const btn = h('button', { type: 'button', class: 'btn sm' + (g.status === 'open' || g.status === 'approval' ? ' primary' : ''), disabled: g.status === 'pending' || g.status === 'full' }, label);
        btn.onclick = async () => {
          if (g.status === 'member') { close(); return selectGroup(g.id); }
          busy(btn, true);
          try {
            const r = await ask('request_join', { gid: g.id });
            if (r.status === 'pending') { g.status = 'pending'; busy(btn, false); btn.textContent = 'Requested'; btn.classList.remove('primary'); btn.disabled = true; toast('Request sent. You can chat once the owner approves.', 'ok', 5200); }
            else await joined(r);
          } catch (e) { busy(btn, false); toast(e.message, 'error'); }
        };
        const fill = Math.min(100, Math.round(g.members / g.limit * 100));
        return h('li', null, avatarEl({ id: g.id, name: g.name, avatar: g.avatar }, 46),
          h('div', { class: 'mi' }, h('b', { text: g.name }), h('div', { class: 'meter' }, h('i', { style: 'width:' + fill + '%' })), h('small', { text: g.members + ' / ' + g.limit + ' members' + (g.status === 'approval' ? ' · approval needed' : '') })), btn);
      }));
    };
    findIn.addEventListener('input', () => {
      clearTimeout(timer); const q = findIn.value.trim(), my = ++seq;
      if (q.length < 2) return renderResults([], q);
      timer = setTimeout(async () => { try { const r = await ask('search_groups', { q }); if (my === seq) renderResults(r.results, q); } catch (e) { if (my === seq) results.replaceChildren(h('li', { class: 'find-empty' }, h('small', { text: e.message }))); } }, 260);
    });
    renderResults([], '');
    const form = h('form', { novalidate: true, class: 'gm-form' }, ...Object.values(panes), err);
    form.addEventListener('submit', async e => {
      e.preventDefault(); err.textContent = '';
      if (mode === 'find') return;
      try {
        if (mode === 'create') {
          const name = nameIn.value.trim(); if (!name) throw new Error('Enter a group name.');
          if (S.me.owned >= S.me.slots) { close(); return openUnlockSlot(); }
          busy(go, true);
          const r = await ask('create_group', { name, approval: apCb.checked });
          if (r.me) { Object.assign(S.me, r.me); renderMe(); }
          close(); addGroup(r.group); await selectGroup(r.group.id); toast('Group created.', 'ok'); openGroupInfo();
        } else {
          if (codeIn.value.replace(/-/g, '').length < 8) throw new Error('Enter the 8-character invite code.');
          busy(go, true); await joined(await ask('join_group', { code: codeIn.value })); busy(go, false);
        }
      } catch (e2) { busy(go, false); if (e2.code === 'slots') { close(); return openUnlockSlot(); } err.textContent = e2.message; }
    });
    go.type = 'button'; go.onclick = () => form.requestSubmit();
    paint();
    return h('div', { class: 'modal sheet gm' }, h('div', { class: 'gm-head' }, h('h3', { text: 'Groups' }), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, ico('close'))),
      h('div', { class: 'tabbar', role: 'tablist' }, tabs.find, tabs.join, tabs.create),
      h('div', { class: 'sheet-body' }, form),
      h('div', { class: 'sheet-foot', hidden: false }, go));
  });
}
function memberRow(m, G, on) {
  return h('li', null, h('span', { class: 'wrap' + (on.has(m.id) ? ' on' : '') }, avatarEl(m, 42)),
    h('div', { class: 'mi' }, h('b', { text: m.name + (m.id === S.me.id ? ' (You)' : '') }), h('small', { text: m.username ? '@' + m.username : '' })),
    m.id === G.owner ? h('span', { class: 'role', text: 'Owner' }) : (on.has(m.id) ? h('span', { class: 'role on', text: 'Online' }) : null));
}
function memberRow(m, G, on, close) {
  return h('li', { class: 'clickable', onclick: () => { close(); openProfile(m.id); } }, h('span', { class: 'wrap' + (on.has(m.id) ? ' on' : '') }, avatarEl(m, 42)),
    h('div', { class: 'mi' }, h('b', null, nameBadge(m.name + (m.id === S.me.id ? ' (You)' : ''), m.verified)), h('small', { text: m.username ? '@' + m.username : '' })),
    m.id === G.owner ? h('span', { class: 'role', text: 'Owner' }) : (on.has(m.id) ? h('span', { class: 'role on', text: 'Online' }) : null));
}
function openGroupInfo() {
  const G0 = curGroup(); if (!G0) return;
  openModal(close => {
    const G = G0, L = BOOT.limits || {}, isOwner = G.owner === S.me.id, on = new Set(G.online || []);
    const members = [...G.members].sort((a, b) => (b.id === G.owner) - (a.id === G.owner) || (on.has(b.id) - on.has(a.id)) || a.name.localeCompare(b.name));
    const code = G.code.slice(0, 4) + '-' + G.code.slice(4);
    const ib = (icon, label, fn) => h('button', { class: 'icon-btn sm', type: 'button', title: label, 'aria-label': label, onclick: fn }, ico(icon));
    const top = h('div', { class: 'gi-top' },
      h('div', { class: 'gi-hero' }, avatarEl({ id: G.id, name: G.name, avatar: G.avatar }, 60),
        h('div', { class: 'gi-title' }, h('h3', { text: G.name }), h('p', null, G.members.length + ' / ' + G.member_limit + ' members', G.approval ? h('span', { class: 'tag', text: 'Approval' }) : null, G.public === false ? h('span', { class: 'tag', text: 'Hidden' }) : null)),
        isOwner ? ib('settings', 'Group settings', () => { close(); openGroupSettings(); }) : null),
      h('div', { class: 'code-row' }, ico('key'), h('span', { class: 'cr-l', text: 'Invite' }), h('b', { class: 'cr-code', text: code }),
        ib('copy', 'Copy code', () => copyText(code, 'Invite code copied.')), ib('link', 'Copy invite link', () => copyText(location.origin + '/?join=' + G.code, 'Invite link copied.'))),
      isOwner && G.pending_count ? h('button', { class: 'req-banner', type: 'button', onclick: () => { close(); openRequests(); } }, ico('users'), h('span', { text: G.pending_count + ' join request' + (G.pending_count === 1 ? '' : 's') }), h('i', { text: 'Review' })) : null,
      h('div', { class: 'gi-sub' }, h('b', { text: 'Members' }), h('span', { class: 'cnt', text: String(G.members.length) }),
        isOwner && G.member_limit < L.max_members ? h('button', { class: 'extend-pill', type: 'button', title: 'Add ' + L.members_step + ' member slots', onclick: () => extendMembers(G, close) }, gemEl(), h('span', { text: '+' + L.members_step }), h('i', { text: L.members_cost })) : null));
    const list = h('ul', { class: 'gi-members' }, ...members.map(m => memberRow(m, G, on, close)));
    const danger = isOwner
      ? h('button', { class: 'btn danger', type: 'button', onclick: () => { close(); confirmDialog({ title: 'Delete "' + G.name + '"?', text: 'This permanently deletes the group and all of its messages for every member. This cannot be undone.', label: 'Delete group', danger: true, onConfirm: () => deleteGroup(G.id) }); } }, ico('trash'), h('span', { text: 'Delete group' }))
      : h('button', { class: 'btn danger', type: 'button', onclick: () => { close(); confirmDialog({ title: 'Leave "' + G.name + '"?', text: 'You will no longer receive messages from this group. You can join again with the invite code.', label: 'Leave group', danger: true, onConfirm: () => leaveGroup(G.id) }); } }, ico('logout'), h('span', { text: 'Leave group' }));
    return h('div', { class: 'modal sheet group-info' }, top, list, h('div', { class: 'gi-actions' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Close'), danger));
  });
}
async function extendMembers(G, close) {
  const L = BOOT.limits || {};
  if (S.me.stones < L.members_cost) { close(); return openBuyStone('You need ' + L.members_cost + ' Stone to add ' + L.members_step + ' more member slots.'); }
  close();
  confirmDialog({ title: 'Add ' + L.members_step + ' member slots?', text: 'This costs ' + L.members_cost + ' Stone. "' + G.name + '" will hold up to ' + Math.min(L.max_members, G.member_limit + L.members_step) + ' members.', label: 'Pay ' + L.members_cost + ' Stone',
    onConfirm: async () => { const r = await api('extend-members', { token: S.token, gid: G.id }); Object.assign(S.me, r.me); renderMe(); addGroup(r.group); toast('Member limit increased.', 'ok'); } });
}
async function openRequests() {
  const G = curGroup(); if (!G) return;
  let rows;
  try { rows = (await ask('get_requests', { gid: G.id })).requests; } catch (e) { return toast(e.message, 'error'); }
  openModal(close => {
    const ul = h('ul', { class: 'req-list' });
    const draw = () => {
      ul.replaceChildren(...(rows.length ? rows.map(u => {
        const done = async approve => {
          try { await ask('resolve_request', { gid: G.id, uid: u.id, approve }); rows = rows.filter(x => x.id !== u.id); draw(); toast(approve ? u.name + ' joined the group.' : 'Request declined.', approve ? 'ok' : 'info'); }
          catch (e) { toast(e.message, 'error'); if (e.code === 'full') { close(); } }
        };
        return h('li', null, h('span', { class: 'clickable', onclick: () => openProfile(u.id) }, avatarEl(u, 42)), h('div', { class: 'mi clickable', onclick: () => openProfile(u.id) }, h('b', null, nameBadge(u.name, u.verified)), h('small', { text: '@' + u.username })),
          h('button', { class: 'btn sm', type: 'button', onclick: () => done(false) }, 'Decline'), h('button', { class: 'btn sm primary', type: 'button', onclick: () => done(true) }, 'Approve'));
      }) : [h('li', { class: 'find-empty' }, 'No pending requests.')]));
    };
    draw();
    return h('div', { class: 'modal sheet' }, h('h3', { text: 'Join requests' }), h('p', { text: 'People who asked to join "' + G.name + '".' }), ul, h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Close')));
  });
}
function openGroupSettings() {
  const G = curGroup(); if (!G || G.owner !== S.me.id) return;
  openModal(close => {
    let logo = G.avatar || '', logoData = null, removed = false;
    const prev = h('div', { class: 'gs-logo' });
    const paintLogo = () => prev.replaceChildren(avatarEl({ id: G.id, name: nameIn.value || G.name, avatar: removed ? '' : (logoData || logo) }, 84));
    const nameIn = h('input', { class: 'input', value: G.name, maxlength: '40', 'aria-label': 'Group name' });
    nameIn.addEventListener('input', paintLogo);
    const file = h('input', { type: 'file', accept: 'image/*', hidden: true });
    file.onchange = async () => {
      const f = file.files[0]; file.value = ''; if (!f) return;
      if (!/^image\//.test(f.type)) return toast('Please choose an image file.', 'error');
      try { logoData = (await cropAvatar(f, 256)).data; removed = false; paintLogo(); } catch (e) { toast(e.message, 'error'); }
    };
    const sw = (key, title, sub, val) => { const cb = h('input', { type: 'checkbox' }); cb.checked = val; return { cb, row: h('label', { class: 'switch-row' }, h('span', null, h('b', { text: title }), h('small', { text: sub })), h('span', { class: 'switch' }, cb, h('i'))) }; };
    const approval = sw('approval', 'Approve new members', 'New people must be approved by you before joining.', G.approval);
    const pub = sw('public', 'Show in search', 'Anyone can find this group by name. Turn off to keep it invite-only.', G.public !== false);
    const err = h('div', { class: 'err' });
    const save = h('button', { class: 'btn primary', type: 'button' }, h('span', { class: 'spin' }), h('span', { class: 'label', text: 'Save changes' }));
    save.onclick = async () => {
      const name = nameIn.value.trim().replace(/\s+/g, ' ');
      if (!name) { err.textContent = 'Group name cannot be empty.'; return; }
      const payload = { gid: G.id, name, approval: approval.cb.checked, public: pub.cb.checked };
      if (logoData) payload.avatar = logoData; else if (removed) payload.avatar = '';
      busy(save, true); err.textContent = '';
      try { const r = await ask('update_group', payload); addGroup(r.group); renderHeader(); close(); toast('Group updated.', 'ok'); }
      catch (e) { busy(save, false); err.textContent = e.message; }
    };
    paintLogo();
    return h('div', { class: 'modal sheet' }, h('h3', { text: 'Group settings' }),
      h('div', { class: 'gs-top' }, prev, h('div', { class: 'row left' }, h('button', { class: 'btn sm', type: 'button', onclick: () => file.click() }, ico('camera'), 'Change logo'), h('button', { class: 'btn sm', type: 'button', onclick: () => { removed = true; logoData = null; paintLogo(); } }, 'Remove'), file)),
      h('label', { class: 'field' }, h('span', { text: 'Group name' }), nameIn), approval.row, pub.row, err,
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), save));
  });
}
async function openHistory() {
  let d; try { d = await api('wallet', { token: S.token }); } catch (e) { return toast(e.message, 'error'); }
  Object.assign(S.me, d.me); renderMe();
  openModal(close => h('div', { class: 'modal sheet' }, h('h3', { text: 'Stone history' }),
    d.log.length ? h('ul', { class: 'hist' }, ...d.log.map(r => h('li', null, h('div', null, h('b', { text: r.why || 'Update' }), h('small', { text: new Date(r.ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) })),
      h('span', { class: 'delta ' + (r.delta >= 0 ? 'up' : 'down'), text: (r.delta >= 0 ? '+' : '') + r.delta })))) : h('p', { text: 'No Stone activity yet.' }),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Close'))));
}

/* ------------------------------------------------------------------ admin panel */
const AD = { filter: 'all', timer: 0 };
const adUser = (u, extra) => h('div', { class: 'au-top' }, avatarEl(u, 44), h('div', { class: 'mi' }, h('b', null, nameBadge(u.name, u.verified)), h('small', { text: '@' + u.username + (u.email ? ' · ' + u.email : '') })), extra || null);
async function adminAct(path, payload, okMsg) {
  try { const r = await api('admin/' + path, { token: S.token, ...payload }); if (okMsg) toast(okMsg(r), 'ok'); return r; }
  catch (e) { toast(e.message, 'error'); return null; }
}
function renderAdminStats(st) {
  const items = [['users', 'Users', st.users], ['shield', 'Verified', st.verified], ['eye', 'Online now', st.online], ['chat', 'Groups', st.groups], ['gem', 'Stone in wallets', st.stones]];
  $('adminStats').replaceChildren(...items.map(([ic, l, v]) => h('div', { class: 'stat' }, h('span', { class: 'si' }, ico(ic)), h('b', { text: String(v) }), h('small', { text: l }))));
}
function renderQueues(orders, reqs) {
  $('adminOrdersBox').hidden = !orders.length; $('ordersCount').textContent = orders.length;
  $('adminOrders').replaceChildren(...orders.map(u => h('li', null, adUser(u, h('span', { class: 'au-bal' }, gemEl(), String(u.order.pack))),
    h('div', { class: 'au-ctl' }, h('small', { class: 'muted', text: 'Has ' + u.stones + ' Stone · ordered ' + new Date(u.order.ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) }),
      h('button', { class: 'btn sm', type: 'button', onclick: async () => { if (await adminAct('dismiss', { uid: u.id, what: 'order' })) refreshAdmin(); } }, 'Dismiss'),
      h('button', { class: 'btn sm primary', type: 'button', onclick: async () => { if (await adminAct('stone', { uid: u.id, op: 'add', amount: u.order.pack, fulfil_order: true }, r => 'Added ' + u.order.pack + ' Stone to ' + u.name)) refreshAdmin(); } }, 'Add ' + u.order.pack + ' Stone')))));
  $('adminVerifyBox').hidden = !reqs.length; $('verifyCount').textContent = reqs.length;
  $('adminVerify').replaceChildren(...reqs.map(u => h('li', null, adUser(u),
    h('div', { class: 'au-ctl' }, h('button', { class: 'btn sm', type: 'button', onclick: async () => { if (await adminAct('dismiss', { uid: u.id, what: 'verify' })) refreshAdmin(); } }, 'Dismiss'),
      h('button', { class: 'btn sm primary', type: 'button', onclick: async () => { if (await adminAct('verify', { uid: u.id, verified: true }, () => u.name + ' is now verified')) refreshAdmin(); } }, ico('check'), 'Approve')))));
}
function renderAdminUsers(users, total) {
  $('adminCount').textContent = total + ' user' + (total === 1 ? '' : 's') + (users.length < total ? ' · showing ' + users.length : '');
  $('adminList').replaceChildren(...users.map(u => {
    const bal = h('b', { text: String(u.stones) }), amt = h('input', { type: 'number', inputmode: 'numeric', placeholder: 'Amount', 'aria-label': 'Amount' });
    const li = h('li', { class: 'au' });
    const act = async (op, amount, btn) => {
      const n = Number(amount); if (!Number.isInteger(n)) return toast('Enter a whole number.', 'error');
      if (btn) busy(btn, true);
      const r = await adminAct('stone', { uid: u.id, op, amount: n }, r => u.name + ': ' + r.user.stones + ' Stone');
      if (btn) busy(btn, false);
      if (r) { bal.textContent = r.user.stones; amt.value = ''; }
    };
    const addB = h('button', { class: 'btn sm primary', type: 'button', onclick: () => act('add', amt.value, addB) }, 'Add'), setB = h('button', { class: 'btn sm', type: 'button', onclick: () => act('set', amt.value, setB) }, 'Set');
    const vb = h('button', { class: 'btn sm' + (u.verified ? '' : ' primary'), type: 'button' }, u.verified ? 'Remove badge' : 'Verify');
    vb.onclick = async () => { busy(vb, true); const r = await adminAct('verify', { uid: u.id, verified: !u.verified }, r => u.name + (r.user.verified ? ' is now verified' : ' badge removed')); busy(vb, false); if (r) refreshAdmin(); };
    const head = h('button', { class: 'au-head', type: 'button', onclick: () => li.classList.toggle('open') }, adUser(u, h('span', { class: 'au-bal' }, gemEl(), bal)), h('span', { class: 'ico chev', html: I.chev }));
    li.append(head, h('div', { class: 'au-ctl' }, ...[10, 50, 100].map(n => h('button', { class: 'btn sm', type: 'button', onclick: () => act('add', n) }, '+' + n)), amt, addB, setB, vb));
    return li;
  }));
  if (!users.length) $('adminList').replaceChildren(h('li', { class: 'find-empty' }, h('small', { text: 'No users found.' })));
}
async function loadAdminUsers() {
  clearTimeout(AD.timer);
  AD.timer = setTimeout(async () => {
    try { const r = await api('admin/users', { token: S.token, q: $('adminSearch').value, filter: AD.filter }); renderAdminUsers(r.users, r.total); }
    catch (e) { toast(e.message, 'error'); }
  }, 200);
}
async function refreshAdmin() {
  try { const o = await api('admin/overview', { token: S.token }); renderAdminStats(o.stats); renderQueues(o.orders, o.requests); } catch (e) { toast(e.message, 'error'); }
  loadAdminUsers();
}
function openAdmin() { showView('admin'); $('adminSearch').value = ''; refreshAdmin(); }

/* ------------------------------------------------------------------ profile extras */
async function saveActive() {
  const want = $('activeSwitch').checked;
  try { const r = await api('profile', { token: S.token, show_active: want }); Object.assign(S.me, r.me); renderMe(); toast(want ? 'Others can see when you are active.' : 'You now appear offline.', 'ok'); }
  catch (err) { $('activeSwitch').checked = !want; toast(err.message, 'error'); }
}
function updateCallUI() {
  const G = curGroup(), ci = (G && G.call) || { active: false, participants: 0, started_by: '' }, active = !!ci.active, who = ci.started_by || 'A member';
  for (const b of [$('callBtn'), $('voiceBtn')]) b.classList.toggle('live', active);
  $('callBtn').title = $('callBtn').ariaLabel = active ? 'Join video call' : 'Start video call';
  $('voiceBtn').title = $('voiceBtn').ariaLabel = active ? 'Join voice call' : 'Start voice call';
  $('callBanner').hidden = !(active && C.phase === 'idle' && S.view === 'chat' && G);
  $('callBannerText').textContent = who + ' started a group call · ' + ci.participants + ' in call';
}

/* ------------------------------------------------------------------ messages */
const feed = $('feed');
const nearBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 90;
function scrollBottom() { feed.scrollTop = feed.scrollHeight; S.atBottom = true; S.unread = 0; updatePill(); }
function updatePill() {
  $('toBottom').hidden = S.atBottom;
  $('toBottomText').textContent = S.unread ? S.unread + ' new message' + (S.unread > 1 ? 's' : '') : 'Latest';
}
feed.addEventListener('scroll', () => {
  S.atBottom = nearBottom();
  if (S.atBottom) S.unread = 0;
  updatePill();
}, { passive: true });
$('toBottom').addEventListener('click', scrollBottom);

function emptyState() {
  return h('div', { class: 'empty' }, h('div', { class: 'big', text: '👋' }), h('b', { text: 'No messages yet' }), h('div', { text: 'Say hello and start the conversation.' }));
}
function renderHistory(list) {
  S.seen.clear(); S.msgs.clear(); S.lastMsg = null; S.lastDay = '';
  const frag = document.createDocumentFragment();
  for (const m of list) { S.seen.add(m.id); S.msgs.set(m.id, m); frag.append(buildMessage(m)); }
  feed.replaceChildren(frag);
  if (!list.length) feed.append(emptyState());
  scrollBottom();
}
function onNewMessage(m) {
  const G = S.groups.get(m.gid); if (!G) return;
  if (G.msgs) { if (G.msgs.some(x => x.id === m.id)) return; G.msgs.push(m); if (G.msgs.length > 300) G.msgs.shift(); }
  if (m.kind !== 'system') G.last = { text: String(m.text || '').slice(0, 80), name: m.name, uid: m.uid, ts: m.ts, kind: m.kind };
  if (m.gid === S.gid && S.view === 'chat') { if (G.msgs) appendLive(m); }
  else if (m.kind !== 'system' && m.uid !== S.me.id) G.unread++;
  renderGroupList();
}
function appendLive(m) {
  if (S.seen.has(m.id)) return;
  S.seen.add(m.id); S.msgs.set(m.id, m);
  feed.querySelector('.empty')?.remove();
  const stick = S.atBottom || m.uid === S.me.id;
  feed.append(buildMessage(m));
  if (stick) scrollBottom();
  else if (m.kind !== 'system') { S.unread++; updatePill(); }
}
function buildMessage(m) {
  const frag = document.createDocumentFragment();
  const d = new Date(m.ts), day = d.toDateString();
  if (S.lastDay !== day) { frag.append(h('div', { class: 'day-sep' }, h('span', { text: dayLabel(d) }))); S.lastDay = day; S.lastMsg = null; }
  if (m.kind === 'system' || m.uid === 'system') {
    const isCall = /\bcall\b/i.test(m.text || '');
    frag.append(h('div', { class: 'sys' + (isCall ? ' is-call' : ''), dataset: { id: m.id } }, h('span', null, isCall ? h('span', { class: 'ico', html: I.phone }) : null, m.text || '')));
    S.lastMsg = null;
    return frag;
  }
  const mine = m.uid === S.me.id;
  const cont = !!S.lastMsg && S.lastMsg.uid === m.uid && m.ts - S.lastMsg.ts < 5 * 60e3;
  S.lastMsg = { uid: m.uid, ts: m.ts };
  const row = h('div', { class: 'msg' + (mine ? ' mine' : '') + (cont ? ' cont' : ''), dataset: { id: m.id, uid: m.uid } });
  const bubble = h('div', { class: 'bubble' });
  if (!mine && !cont) bubble.append(h('div', { class: 'name', style: '--h:' + hue(String(m.uid || m.name || '')) },
    h('span', { class: 'nm', text: m.name || 'Member' }), m.verified ? badgeEl() : null, m.username ? h('span', { class: 'un', text: '@' + m.username }) : null));
  if (m.reply_to) {
    const rid = m.reply_to.id;
    bubble.append(h('div', {
      class: 'quote', onclick: e => {
        e.stopPropagation();
        const t = feed.querySelector('.msg[data-id="' + rid + '"]');
        if (t) { t.scrollIntoView({ block: 'center' }); t.classList.add('flash'); setTimeout(() => t.classList.remove('flash'), 1300); }
      }
    }, h('b', { text: m.reply_to.name || 'Member' }), h('span', { text: m.reply_to.text || '' })));
  }
  bubble.append(h('div', { class: 'text' }, linkify(m.text || '')), h('time', { class: 'time' }, fmtTime(m.ts), mine ? h('span', { class: 'tick ico', html: I.check }) : null));
  bubble.addEventListener('click', e => {
    if (e.target.closest('a') || !matchMedia('(hover:none)').matches) return;
    const open = row.classList.contains('tools-open');
    feed.querySelectorAll('.tools-open').forEach(n => n.classList.remove('tools-open'));
    if (!open) row.classList.add('tools-open');
  });
  const tools = h('div', { class: 'tools' },
    ...(BOOT.reactions || []).map(em => h('button', { type: 'button', class: 'tool', title: 'React ' + em, 'aria-label': 'React ' + em, onclick: () => { react(m.id, em); row.classList.remove('tools-open'); } }, em)),
    h('button', { type: 'button', class: 'tool', title: 'Reply', 'aria-label': 'Reply', onclick: () => { startReply(m); row.classList.remove('tools-open'); } }, ico('reply')));
  row.append(avatarEl({ id: m.uid, name: m.name || m.username, avatar: m.avatar }, 34), h('div', { class: 'col' }, bubble, h('div', { class: 'reactions' })),
    h('button', { type: 'button', class: 'quick-reply', title: 'Reply', 'aria-label': 'Reply', onclick: () => startReply(m) }, ico('reply')), tools);
  paintReactions(row, m.reactions);
  frag.append(row);
  return frag;
}
function paintReactions(row, rx) {
  const box = row.querySelector('.reactions'); if (!box) return;
  const counts = new Map();
  Object.values(rx || {}).forEach(e => counts.set(e, (counts.get(e) || 0) + 1));
  const mine = rx && rx[S.me.id];
  box.replaceChildren(...[...counts].map(([e, n]) => h('button', { type: 'button', class: 'rx' + (mine === e ? ' mine' : ''), title: 'React ' + e, onclick: () => react(row.dataset.id, e) }, e + ' ' + n)));
}
function react(id, emoji) { if (S.sock && S.sock.connected && S.gid) S.sock.emit('react_message', { gid: S.gid, id, emoji }); }
function startReply(m) {
  S.reply = { id: m.id, name: m.name || m.username || 'Member', text: (m.text || '').slice(0, 140) };
  $('replyName').textContent = 'Replying to ' + S.reply.name; $('replyText').textContent = S.reply.text;
  $('replyBar').hidden = false; $('msgInput').focus();
}
function clearReply() { S.reply = null; $('replyBar').hidden = true; }
const input = $('msgInput');
const EMOJIS = ['😀','😂','🤣','😊','😍','🥰','😘','😎','🤔','😅','🥹','😭','😡','😴','🤗','😇','👍','👎','🙏','👏','🙌','💪','🤝','👀','🔥','❤️','💔','🎉','✅','❌','⭐','🎂'];
function insertEmoji(em) { const a = input.selectionStart == null ? input.value.length : input.selectionStart, b = input.selectionEnd == null ? a : input.selectionEnd; input.setRangeText(em, a, b, 'end'); autosize(); if (matchMedia('(pointer:fine)').matches) input.focus(); }
function buildEmojiTray() { $('emojiTray').replaceChildren(...EMOJIS.map(em => h('button', { type: 'button', 'aria-label': em, onclick: () => insertEmoji(em) }, em))); }
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; $('sendBtn').disabled = !input.value.trim(); }
function sendMessage(e) {
  if (e) e.preventDefault();
  const text = input.value.trim(); if (!text) return;
  if (!S.sock || !S.sock.connected) { toast('You are offline. Reconnecting…', 'warn'); return; }
  const reply = S.reply;
  input.value = ''; autosize(); clearReply(); S.atBottom = true;
  const gid = S.gid; if (!gid) return;
  S.sock.timeout(10000).emit('send_message', { gid, text, reply_to: reply }, (err, res) => {
    if (err) { toast('Network is slow - your message may not have been sent.', 'warn'); return; }
    if (!res || !res.ok) {
      if (res && res.code === 'session') return;
      input.value = text; autosize();
      if (reply) startReply({ id: reply.id, name: reply.name, text: reply.text });
      toast((res && res.error) || 'Message could not be sent.', 'error');
    }
  });
}

/* ------------------------------------------------------------------ account page */
async function cropAvatar(file, size = 384) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That image could not be opened. Try a JPG or PNG.')); i.src = url; });
    const side = Math.min(img.naturalWidth, img.naturalHeight), sx = (img.naturalWidth - side) / 2, sy = (img.naturalHeight - side) / 2;
    const c = document.createElement('canvas'); c.width = c.height = size;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size); ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
    let q = .86, data = c.toDataURL('image/jpeg', q);
    while (data.length > 380000 && q > .4) { q -= .1; data = c.toDataURL('image/jpeg', q); }
    return { canvas: c, data };
  } finally { URL.revokeObjectURL(url); }
}
async function onAvatarPicked(file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) return toast('Please choose an image file.', 'error');
  let result;
  try { result = await cropAvatar(file); } catch (e) { return toast(e.message, 'error'); }
  openModal(close => {
    const save = h('button', { class: 'btn primary', type: 'button' }, h('span', { class: 'spin' }), h('span', { class: 'label', text: 'Save photo' }));
    save.onclick = async () => {
      busy(save, true);
      try { const r = await api('profile', { token: S.token, avatar: result.data }); S.me = r.me; renderMe(); close(); toast('Profile photo updated.', 'ok'); }
      catch (e) { busy(save, false); toast(e.message, 'error'); }
    };
    return h('div', { class: 'modal' }, h('h3', { text: 'Your new profile photo' }), h('p', { text: 'Looks good? It is cropped to a square from the centre of your image.' }),
      h('div', { class: 'crop-preview' }, result.canvas),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), save));
  });
}
function confirmDelete() {
  openModal(close => {
    const box = h('input', { class: 'input', placeholder: 'Type DELETE', autocomplete: 'off', autocapitalize: 'characters', 'aria-label': 'Type DELETE to confirm' });
    const err = h('div', { class: 'err' });
    const go = h('button', { class: 'btn danger', type: 'button' }, h('span', { class: 'spin' }), h('span', { class: 'label', text: 'Delete forever' }));
    go.onclick = async () => {
      if (box.value.trim() !== 'DELETE') { err.textContent = 'Type DELETE to confirm.'; return; }
      busy(go, true); err.textContent = '';
      try {
        await api('delete-account', { token: S.token, confirm: 'DELETE' });
        S.kicked = true; endCall(false); if (S.sock) S.sock.disconnect();
        ls.del(TOKEN_KEY); close(); toast('Account deleted.', 'ok'); setTimeout(() => location.reload(), 900);
      } catch (e) { busy(go, false); err.textContent = e.message; }
    };
    return h('div', { class: 'modal' }, h('h3', { text: 'Delete your account?' }),
      h('p', { text: 'This permanently deletes your account and every message you have sent in all groups. This cannot be undone.' }),
      h('div', { class: 'field' }, box), err,
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), go));
  });
}

/* ------------------------------------------------------------------ video call */
const C = {
  phase: 'idle', local: null, pcs: {}, pending: {}, meta: {}, tiles: {}, peers: {},
  micOn: true, camOn: true, spkOn: true, hasMic: false, hasCam: false,
  startedAt: 0, timer: null, ac: null, an: {}, speak: null, wake: null
};
function stopStream(s) { if (s) s.getTracks().forEach(t => t.stop()); }
async function getMedia(voiceOnly) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Calls need a secure (HTTPS) connection and a modern browser.');
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (voiceOnly) {
    try { return await navigator.mediaDevices.getUserMedia({ audio }); }
    catch (e) { throw new Error(e.name === 'NotAllowedError' || e.name === 'SecurityError' ? 'Microphone access is blocked. Allow access in your browser settings, then try again.' : e.name === 'NotFoundError' ? 'No microphone was found on this device.' : 'Could not start your microphone. Close other apps using it and try again.'); }
  }
  const video = { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
  try { return await navigator.mediaDevices.getUserMedia({ audio, video }); }
  catch (e) {
    if (e.name === 'NotAllowedError' || e.name === 'SecurityError') throw new Error('Camera and microphone access is blocked. Allow access in your browser settings, then try again.');
    try { return await navigator.mediaDevices.getUserMedia({ audio }); }
    catch (e2) { throw new Error(e2.name === 'NotFoundError' ? 'No camera or microphone was found on this device.' : 'Could not start your camera or microphone. Close other apps using them and try again.'); }
  }
}
function showCall(on) { $('callRoot').hidden = !on; }
function renderControls() {
  const mic = C.micOn && C.hasMic, cam = C.camOn && C.hasCam;
  for (const id of ['micBtn', 'lobbyMic']) {
    const b = $(id);
    b.innerHTML = '<span class="ico">' + (mic ? I.mic : I.micOff) + '</span>';
    b.classList.toggle('off', !mic); b.disabled = !C.hasMic;
    b.title = b.ariaLabel = !C.hasMic ? 'No microphone found' : mic ? 'Mute microphone' : 'Unmute microphone';
  }
  for (const id of ['camBtn', 'lobbyCam']) {
    const b = $(id);
    b.innerHTML = '<span class="ico">' + (cam ? I.cam : I.camOff) + '</span>';
    b.classList.toggle('off', !cam); b.disabled = !C.hasCam;
    b.title = b.ariaLabel = !C.hasCam ? (C.voice ? 'Camera is off in a voice call' : 'No camera found') : cam ? 'Turn camera off' : 'Turn camera on';
  }
  $('spkBtn').innerHTML = '<span class="ico">' + (C.spkOn ? I.spk : I.spkOff) + '</span>';
  $('spkBtn').classList.toggle('off', !C.spkOn);
  $('spkBtn').title = $('spkBtn').ariaLabel = C.spkOn ? 'Mute speaker' : 'Unmute speaker';
  $('endBtn').innerHTML = '<span class="ico">' + I.end + '</span>';
  $('preview').classList.toggle('nocam', !cam);
  updateTile('local');
}
async function openCall(voice = false) {
  if (C.phase !== 'idle') return toast('You are already in a call.', 'warn');
  const G = curGroup(); if (!G || S.view !== 'chat') return;
  C.voice = voice === true; C.gid = G.id; $('callName').textContent = G.name;
  if (!S.sock || !S.sock.connected) return toast('Still connecting to the server. Try again in a moment.', 'warn');
  C.phase = 'lobby';
  showCall(true);
  $('lobby').hidden = false; $('stage').hidden = true; $('callBar').hidden = true;
  $('lobbyErr').textContent = ''; $('joinNow').disabled = true;
  $('lobbyTitle').textContent = (C.voice ? 'Voice call' : (G.call && G.call.active ? 'Join the call' : 'Start a call'));
  $('lobbyInfo').textContent = 'Checking your camera and microphone…';
  $('previewCover').replaceChildren(avatarEl(S.me));
  $('callTimer').textContent = '00:00'; setNet('wait', 'Not connected'); $('callCount').textContent = 'Preview';
  document.addEventListener('keydown', onCallKey);
  try {
    const stream = await getMedia(C.voice);
    if (C.phase !== 'lobby') { stopStream(stream); return; }
    C.local = stream;
    C.hasMic = stream.getAudioTracks().length > 0; C.hasCam = stream.getVideoTracks().length > 0;
    C.micOn = C.hasMic; C.camOn = C.hasCam; C.spkOn = true;
    $('previewVideo').srcObject = stream;
    const ci = G.call || {}, n = ci.participants || 0;
    $('lobbyInfo').textContent = ci.active
      ? (ci.started_by || 'A member') + ' started this call' + (n > 1 ? ' - ' + n + ' people are in it.' : '.')
      : 'You will be the first one in. Others can join from the chat.';
    if (C.voice) $('lobbyInfo').textContent += ' Your camera stays off in a voice call.';
    else if (!C.hasCam) $('lobbyInfo').textContent += ' No camera found - you will join with audio only.';
    $('joinNow').disabled = false;
  } catch (e) {
    $('lobbyTitle').textContent = 'Cannot start the call';
    $('lobbyInfo').textContent = '';
    $('lobbyErr').textContent = e.message;
    C.hasMic = C.hasCam = false;
  }
  renderControls();
}
function joinCall() {
  if (C.phase !== 'lobby' || !C.local) return;
  C.phase = 'joining'; busy($('joinNow'), true);
  S.sock.timeout(12000).emit('join_video', { gid: C.gid, mic: C.micOn && C.hasMic, cam: C.camOn && C.hasCam }, (err, res) => {
    if (C.phase !== 'joining') return;
    busy($('joinNow'), false);
    if (err || !res || !res.ok) {
      C.phase = 'lobby';
      $('lobbyErr').textContent = (res && res.reason) || 'The server did not respond. Please try again.';
      return;
    }
    C.phase = 'live';
    $('lobby').hidden = true; $('stage').hidden = false; $('callBar').hidden = false;
    $('previewVideo').srcObject = null;
    C.startedAt = Date.now() - (res.elapsed_ms || 0);
    startTimer(); addTile('local');
    const peers = res.peers || [];
    peers.forEach(sid => { C.peers[sid] = Object.assign({ name: 'Participant' }, (res.profiles || {})[sid]); addTile(sid); });
    ensureAudio(); watch('local', C.local); startSpeakLoop(); lockScreen(); renderControls(); refreshNet(); updateCallUI();
    (async () => { for (const sid of peers) await makeOffer(sid); })();
  });
}
function onPeerJoined(d) {
  if (!d || !d.sid) return;
  C.peers[d.sid] = Object.assign(C.peers[d.sid] || {}, { uid: d.uid, name: d.name || 'Participant', avatar: d.avatar, mic: d.mic, cam: d.cam });
  if (C.phase === 'live' || C.phase === 'joining') { addTile(d.sid); labelTile(d.sid); const t = C.tiles[d.sid]; if (t) { t.mic = d.mic !== false; t.cam = d.cam !== false; updateTile(d.sid); } }
}
function onPeerMedia(d) {
  const t = C.tiles[d.sid]; if (!t) return;
  t.mic = d.mic !== false; t.cam = d.cam !== false; updateTile(d.sid);
}
function addTile(id) {
  if (C.tiles[id]) return C.tiles[id];
  const local = id === 'local';
  const p = local ? { id: S.me.id, name: S.me.name, avatar: S.me.avatar } : { id: (C.peers[id] || {}).uid, name: (C.peers[id] || {}).name || 'Participant', avatar: (C.peers[id] || {}).avatar };
  const video = h('video', { autoplay: true, playsinline: true });
  video.muted = local || !C.spkOn;
  const tname = h('span', { class: 'tname', text: local ? 'You' : p.name });
  const el = h('div', { class: 'tile nocam' + (local ? ' local' : ''), dataset: { sid: id } },
    video,
    h('div', { class: 'cover' }, avatarEl(p)),
    h('div', { class: 'tstate', text: local ? '' : 'Connecting…' }),
    h('div', { class: 'tag' }, h('span', { class: 'mic-off ico', html: I.micOff }), tname));
  const pr = C.peers[id] || {};
  const t = C.tiles[id] = { el, video, tname, stream: null, mic: pr.mic !== false, cam: pr.cam !== false };
  if (local) { video.srcObject = C.local; $('stage').prepend(el); } else $('stage').append(el);
  layoutStage(); updateTile(id);
  return t;
}
function labelTile(sid) {
  const t = C.tiles[sid], p = C.peers[sid]; if (!t || !p) return;
  t.tname.textContent = p.name || 'Participant';
}
function updateTile(id) {
  const t = C.tiles[id]; if (!t) return;
  let showVideo, micOn;
  if (id === 'local') { showVideo = C.camOn && C.hasCam; micOn = C.micOn && C.hasMic; }
  else { showVideo = t.cam !== false && !!t.stream && t.stream.getVideoTracks().some(x => x.readyState === 'live'); micOn = t.mic !== false; }
  t.el.classList.toggle('nocam', !showVideo);
  t.el.classList.toggle('muted', !micOn);
}
function layoutStage() {
  const ids = Object.keys(C.tiles), n = ids.length;
  $('stage').dataset.n = String(Math.min(n, 7));
  if (C.tiles.local) C.tiles.local.el.classList.toggle('pip', n === 2);
  $('callCount').textContent = n + (n === 1 ? ' person' : ' people');
}
function setNet(state, text) { $('callNet').dataset.state = state; $('callNetText').textContent = text; }
function refreshNet() {
  const ids = Object.keys(C.pcs);
  if (!ids.length) return setNet('wait', 'Waiting for others');
  const st = ids.map(i => C.pcs[i].connectionState);
  if (st.every(s => s === 'connected')) setNet('ok', 'Connected');
  else if (st.some(s => s === 'failed' || s === 'disconnected')) setNet('warn', 'Reconnecting…');
  else setNet('wait', 'Connecting…');
}
function startTimer() {
  clearInterval(C.timer);
  const tick = () => {
    const s = Math.max(0, Math.floor((Date.now() - C.startedAt) / 1000)), hh = Math.floor(s / 3600), mm = String(Math.floor(s % 3600 / 60)).padStart(2, '0'), ss = String(s % 60).padStart(2, '0');
    $('callTimer').textContent = (hh ? hh + ':' : '') + mm + ':' + ss;
  };
  tick(); C.timer = setInterval(tick, 1000);
}
async function lockScreen() { try { if (navigator.wakeLock) C.wake = await navigator.wakeLock.request('screen'); } catch (e) {} }
function toggleMic() {
  if (!C.local || !C.hasMic) return;
  C.micOn = !C.micOn; C.local.getAudioTracks().forEach(t => { t.enabled = C.micOn; });
  renderControls(); announceMedia();
}
function toggleCam() {
  if (!C.local || !C.hasCam) return;
  C.camOn = !C.camOn; C.local.getVideoTracks().forEach(t => { t.enabled = C.camOn; });
  renderControls(); announceMedia();
}
function toggleSpk() {
  C.spkOn = !C.spkOn;
  for (const id in C.tiles) if (id !== 'local') { C.tiles[id].video.muted = !C.spkOn; if (C.spkOn) C.tiles[id].video.play().catch(() => {}); }
  renderControls();
}
function announceMedia() { if (C.phase === 'live' && S.sock) S.sock.emit('media_state', { mic: C.micOn && C.hasMic, cam: C.camOn && C.hasCam }); }
function onCallKey(e) {
  if (C.phase !== 'live' || /INPUT|TEXTAREA/.test((e.target || {}).tagName || '')) return;
  if (e.key === 'm' || e.key === 'M') toggleMic();
  else if (e.key === 'v' || e.key === 'V') toggleCam();
}
function playVideo(v) { v.play().catch(() => { $('soundBanner').hidden = false; }); }

/* audio levels -> speaking highlight */
function ensureAudio() {
  if (!C.ac) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) { try { C.ac = new AC(); } catch (e) {} } }
  if (C.ac && C.ac.state === 'suspended') C.ac.resume().catch(() => {});
}
function watch(id, stream) {
  if (!C.ac || C.an[id] || !stream || !stream.getAudioTracks().length) return;
  try {
    const src = C.ac.createMediaStreamSource(stream), an = C.ac.createAnalyser();
    an.fftSize = 512; src.connect(an);
    C.an[id] = { src, an, buf: new Uint8Array(an.fftSize), until: 0 };
  } catch (e) {}
}
function startSpeakLoop() {
  clearInterval(C.speak);
  C.speak = setInterval(() => {
    const now = Date.now();
    for (const id in C.an) {
      const a = C.an[id], t = C.tiles[id]; if (!t) continue;
      a.an.getByteTimeDomainData(a.buf);
      let sum = 0; for (let i = 0; i < a.buf.length; i++) { const v = (a.buf[i] - 128) / 128; sum += v * v; }
      if (Math.sqrt(sum / a.buf.length) > 0.04 && (id !== 'local' || (C.micOn && C.hasMic))) a.until = now + 350;
      t.el.classList.toggle('speaking', a.until > now);
    }
  }, 150);
}

/* WebRTC mesh */
function makePeer(sid, offerer) {
  if (C.pcs[sid]) return C.pcs[sid];
  const pc = new RTCPeerConnection(BOOT.rtc);
  C.pcs[sid] = pc; C.pending[sid] = C.pending[sid] || []; C.meta[sid] = { offerer, tries: 0, timer: null };
  if (C.local) C.local.getTracks().forEach(t => pc.addTrack(t, C.local));
  if (offerer) {
    if (!C.local || !C.local.getVideoTracks().length) pc.addTransceiver('video', { direction: 'recvonly' });
    if (!C.local || !C.local.getAudioTracks().length) pc.addTransceiver('audio', { direction: 'recvonly' });
  }
  pc.onicecandidate = e => { if (e.candidate && S.sock && S.sock.connected) S.sock.emit('webrtc_signal', { to: sid, kind: 'ice', payload: e.candidate }); };
  pc.ontrack = e => {
    const stream = (e.streams && e.streams[0]) || new MediaStream([e.track]);
    const t = addTile(sid);
    if (t.video.srcObject !== stream) { t.video.srcObject = stream; t.stream = stream; }
    stream.onaddtrack = stream.onremovetrack = () => updateTile(sid);
    e.track.onmute = e.track.onunmute = e.track.onended = () => updateTile(sid);
    playVideo(t.video); watch(sid, stream); updateTile(sid);
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState, t = C.tiles[sid], m = C.meta[sid];
    if (s === 'connected') { if (m) { clearTimeout(m.timer); m.tries = 0; } if (t) t.el.querySelector('.tstate').textContent = ''; }
    else if (s === 'disconnected' || s === 'failed') {
      if (t) t.el.querySelector('.tstate').textContent = 'Reconnecting…';
      scheduleRestart(sid, s === 'failed' ? 300 : 3500);
    }
    refreshNet();
  };
  return pc;
}
function scheduleRestart(sid, delay) {
  const m = C.meta[sid]; if (!m || !m.offerer) return;
  clearTimeout(m.timer); m.timer = setTimeout(() => restartIce(sid), delay);
}
async function restartIce(sid) {
  const pc = C.pcs[sid], m = C.meta[sid];
  if (!pc || !m || pc.connectionState === 'connected' || pc.connectionState === 'closed') return;
  if (++m.tries > 4) { const t = C.tiles[sid]; if (t) t.el.querySelector('.tstate').textContent = 'Connection failed'; setNet('warn', 'Network blocked - a TURN server may be needed'); return; }
  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    S.sock.emit('webrtc_signal', { to: sid, kind: 'offer', payload: pc.localDescription });
    scheduleRestart(sid, 8000);
  } catch (e) { console.warn('ICE restart failed', e); }
}
async function makeOffer(sid) {
  if (!C.local || C.pcs[sid]) return;
  const pc = makePeer(sid, true);
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    S.sock.emit('webrtc_signal', { to: sid, kind: 'offer', payload: pc.localDescription });
  } catch (e) { console.warn('Offer failed', e); setNet('warn', 'Connection problem'); }
}
async function flushIce(sid, pc) {
  const q = C.pending[sid] || []; C.pending[sid] = [];
  for (const c of q) { try { await pc.addIceCandidate(c); } catch (e) { console.warn('ICE candidate rejected', e); } }
}
async function handleSignal(d) {
  if (!d || !d.from || !C.local || (C.phase !== 'live' && C.phase !== 'joining')) return;
  const sid = d.from;
  try {
    let pc = C.pcs[sid];
    if (d.kind === 'offer') {
      if (!C.peers[sid]) C.peers[sid] = { name: 'Participant' };
      addTile(sid);
      if (!pc) pc = makePeer(sid, false);
      if (pc.signalingState !== 'stable') return;
      await pc.setRemoteDescription(d.payload); await flushIce(sid, pc);
      const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
      S.sock.emit('webrtc_signal', { to: sid, kind: 'answer', payload: pc.localDescription });
    } else if (d.kind === 'answer') {
      if (pc && pc.signalingState === 'have-local-offer') { await pc.setRemoteDescription(d.payload); await flushIce(sid, pc); }
    } else if (d.kind === 'ice' && d.payload) {
      if (pc && pc.remoteDescription) await pc.addIceCandidate(d.payload);
      else (C.pending[sid] = C.pending[sid] || []).push(d.payload);
    }
  } catch (e) { console.warn('WebRTC signal error', e); setNet('warn', 'Connection problem'); }
}
function removePeer(sid) {
  const m = C.meta[sid]; if (m) clearTimeout(m.timer);
  const pc = C.pcs[sid]; if (pc) { pc.onconnectionstatechange = pc.ontrack = pc.onicecandidate = null; try { pc.close(); } catch (e) {} }
  const a = C.an[sid]; if (a) { try { a.src.disconnect(); } catch (e) {} delete C.an[sid]; }
  const t = C.tiles[sid]; if (t) { t.video.srcObject = null; t.el.remove(); }
  delete C.pcs[sid]; delete C.pending[sid]; delete C.meta[sid]; delete C.tiles[sid]; delete C.peers[sid];
  if (C.phase === 'live') { layoutStage(); refreshNet(); updateCallUI(); }
}
function teardownCall() {
  clearInterval(C.timer); clearInterval(C.speak);
  Object.keys(C.pcs).forEach(removePeer);
  for (const id in C.tiles) { C.tiles[id].video.srcObject = null; C.tiles[id].el.remove(); }
  for (const id in C.an) { try { C.an[id].src.disconnect(); } catch (e) {} }
  if (C.ac) { try { C.ac.close(); } catch (e) {} }
  stopStream(C.local);
  if (C.wake) { try { C.wake.release(); } catch (e) {} }
  document.removeEventListener('keydown', onCallKey);
  Object.assign(C, { phase: 'idle', local: null, pcs: {}, pending: {}, meta: {}, tiles: {}, peers: {}, an: {}, ac: null, wake: null, timer: null, speak: null, hasMic: false, hasCam: false });
  $('previewVideo').srcObject = null; $('soundBanner').hidden = true; busy($('joinNow'), false);
  showCall(false);
  updateCallUI();
}
function endCall(notify = true) {
  if (C.phase === 'idle') return;
  if (notify && S.sock && (C.phase === 'live' || C.phase === 'joining')) S.sock.emit('leave_video');
  teardownCall();
}

/* ------------------------------------------------------------------ wiring */
function init() {
  document.querySelectorAll('[data-ico]').forEach(el => { el.innerHTML = I[el.dataset.ico] || ''; });
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  renderControls();

  $('devForm').addEventListener('submit', devLogin);
  $('googleBtn').onclick = onGoogleClick;
  S.pendingJoin = (new URLSearchParams(location.search).get('join') || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12);

  $('menuBtn').onclick = openSide; $('sideClose').onclick = closeSide; $('scrim').onclick = closeSide;
  $('meBtn').onclick = () => showView('account'); $('meChip').onclick = () => showView('account');
  $('newGroupBtn').onclick = () => openGroupModal('find'); $('wCreate').onclick = () => openGroupModal('create'); $('wJoin').onclick = () => openGroupModal('join'); $('wFind').onclick = () => openGroupModal('find');
  $('feed').addEventListener('click', e => { const t = e.target.closest('.msg .avatar, .msg .name .nm, .msg .name .un'); if (!t) return; const row = t.closest('.msg'); if (row && row.dataset.uid) openProfile(row.dataset.uid); });
  $('grpBtn').onclick = openGroupInfo; $('metaBtn').onclick = () => { if (S.view === 'chat') openGroupInfo(); };
  $('accBack').onclick = () => showView('chat');
  $('callBtn').onclick = () => openCall(false); $('voiceBtn').onclick = () => openCall(true);
  $('joinBannerBtn').onclick = () => openCall(false);
  buildEmojiTray();
  $('emojiBtn').onclick = () => { const open = $('emojiTray').hidden; $('emojiTray').hidden = !open; $('chatView').classList.toggle('tray-open', open); $('emojiBtn').classList.toggle('on', open); };

  input.addEventListener('input', autosize);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer:fine)').matches) { e.preventDefault(); sendMessage(); }
  });
  $('composer').addEventListener('submit', sendMessage);
  $('replyCancel').onclick = clearReply;
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.reply) clearReply(); });

  $('accPhotoBtn').onclick = () => $('avatarFile').click();
  $('avatarFile').onchange = e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; onAvatarPicked(f); };
  $('editProfileBtn').onclick = openEditProfile;
  $('verifyBtn').onclick = async () => { try { const r = await api('verify-request', { token: S.token }); Object.assign(S.me, r.me); renderMe(); toast('Verification request sent to the admin.', 'ok'); } catch (e) { toast(e.message, 'error'); } };
  $('signOutBtn').onclick = askSignOut; $('sideSignOut').onclick = askSignOut;
  $('deleteBtn').onclick = confirmDelete;
  $('activeSwitch').addEventListener('change', saveActive);
  $('buyStoneBtn').onclick = () => openBuyStone(); $('historyBtn').onclick = openHistory;
  $('adminOpenBtn').onclick = openAdmin; $('adminBack').onclick = () => showView('account'); $('adminSearch').addEventListener('input', loadAdminUsers); $('adminRefresh').onclick = refreshAdmin;
  $('adminFilters').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; AD.filter = b.dataset.f; $('adminFilters').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); loadAdminUsers(); });
  matchMedia('(max-width:959px)').addEventListener('change', () => { if (S.me) syncView(); });
  document.querySelectorAll('#themeSeg button').forEach(b => { b.onclick = () => applyTheme(b.dataset.theme); });

  $('lobbyMic').onclick = $('micBtn').onclick = toggleMic;
  $('lobbyCam').onclick = $('camBtn').onclick = toggleCam;
  $('spkBtn').onclick = toggleSpk;
  $('joinNow').onclick = joinCall;
  $('lobbyCancel').onclick = () => endCall(false);
  $('endBtn').onclick = () => endCall(true);
  $('soundBanner').onclick = () => { for (const id in C.tiles) C.tiles[id].video.play().catch(() => {}); ensureAudio(); $('soundBanner').hidden = true; };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (S.sock && !S.sock.connected && !S.kicked) S.sock.connect();
    if (C.phase === 'live' && !C.wake) lockScreen();
  });
  window.addEventListener('online', () => { if (S.sock && !S.sock.connected && !S.kicked) S.sock.connect(); });
  window.addEventListener('beforeunload', () => { if (S.sock && C.phase === 'live') S.sock.emit('leave_video'); });

  boot();
}
async function boot() {
  if (!S.token) return showAuth();
  try { const d = await api('me', { token: S.token }); enter({ token: S.token, me: d.me }); }
  catch (e) {
    if (e.status === 401) { ls.del(TOKEN_KEY); S.token = ''; showAuth(); }
    else setTimeout(boot, 2500);
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
