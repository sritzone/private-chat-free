/* SR Private Chat - client */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const BOOT = JSON.parse($('boot').textContent || '{}');
const TOKEN_KEY = 'sr_chat_token', THEME_KEY = 'sr_theme';
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};
const S = {
  token: ls.get(TOKEN_KEY) || '', me: null, sock: null, registerMode: false, view: 'chat',
  reply: null, seen: new Set(), msgs: new Map(), lastMsg: null, lastDay: '', atBottom: true, unread: 0,
  callInfo: { active: false, participants: 0, started_by: '', started_at: 0 }, kicked: false
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
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', t === 'light' ? '#ffffff' : '#0d1322');
  document.querySelectorAll('#themeSeg button').forEach(b => b.classList.toggle('on', b.dataset.theme === t));
}

/* ------------------------------------------------------------------ auth */
function showError(msg) { $('authError').textContent = msg || ''; }
function setMode(reg) {
  S.registerMode = reg;
  $('tabLogin').classList.toggle('active', !reg);
  $('tabRegister').classList.toggle('active', reg);
  $('authTitle').textContent = reg ? 'Create your account' : 'Welcome back';
  $('authDesc').textContent = reg ? 'Set up your profile to join the community.' : 'Sign in to continue to your community.';
  $('nameField').hidden = !reg;
  $('submitBtn').querySelector('.label').textContent = reg ? 'Create account' : 'Sign in';
  $('password').autocomplete = reg ? 'new-password' : 'current-password';
  showError('');
}
async function submitAuth(e) {
  e.preventDefault();
  const reg = S.registerMode;
  const name = $('name').value.trim(), username = $('username').value.trim(), password = $('password').value;
  if (reg && !name) return showError('Please enter your full name.');
  if (!username) return showError('Please enter your username.');
  if (reg && !/^[A-Za-z0-9][A-Za-z0-9_.]{2,19}$/.test(username)) return showError('Username: 3-20 characters, start with a letter or number, only letters, numbers, _ or .');
  if (!password) return showError('Please enter your password.');
  if (reg && password.length < 6) return showError('Password must contain at least 6 characters.');
  showError('');
  busy($('submitBtn'), true);
  try {
    const data = await api(reg ? 'register' : 'login', reg ? { name, username, password } : { username, password });
    $('password').value = '';
    enter(data);
  } catch (err) { showError(err.message); }
  finally { busy($('submitBtn'), false); }
}
function showAuth() {
  $('splash').hidden = true; $('app').hidden = true; $('auth').hidden = false;
  if (matchMedia('(pointer:fine)').matches) $('username').focus();
}
function enter(data) {
  S.token = data.token; S.me = data.me; S.kicked = false;
  ls.set(TOKEN_KEY, S.token);
  $('splash').hidden = true; $('auth').hidden = true; $('app').hidden = false;
  renderMe(); showView('chat'); updateCallUI();
  connect();
}
function renderMe() {
  const m = S.me;
  $('meBtn').replaceChildren(avatarEl(m, 36));
  $('meChip').replaceChildren(avatarEl(m, 38), h('div', { class: 'mi' }, h('b', { text: m.name }), h('small', { text: '@' + m.username })));
  setAvatar($('accAvatar'), m);
  $('accName').textContent = m.name; $('accUser').textContent = '@' + m.username;
  $('accNameInput').value = m.name; $('accUserInput').value = m.username;
  $('kvUser').textContent = '@' + m.username;
  $('kvSince').textContent = m.created_at ? new Date(m.created_at).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' }) : '-';
}
function showView(v) {
  S.view = v;
  $('chatView').hidden = v !== 'chat';
  $('accountView').hidden = v !== 'account';
  $('roomTitle').textContent = v === 'account' ? 'My account' : (BOOT.title || 'Chat');
  closeSide();
  if (v === 'chat') { scrollBottom(); }
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
function setStatus(state, text) {
  $('status').dataset.s = state;
  $('statusText').textContent = text;
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
  sock.on('chat_history', d => renderHistory(d.messages || []));
  sock.on('new_message', onNewMessage);
  sock.on('message_reaction', d => {
    const m = S.msgs.get(d.id); if (m) m.reactions = d.reactions || {};
    const row = feed.querySelector('.msg[data-id="' + d.id + '"]'); if (row) paintReactions(row, d.reactions);
  });
  sock.on('message_failed', d => {
    const m = S.msgs.get(d.id);
    feed.querySelector('.msg[data-id="' + d.id + '"]')?.remove();
    if (m && m.uid === S.me.id) toast('A message could not be saved and was removed.', 'error');
  });
  sock.on('messages_removed', d => feed.querySelectorAll('.msg[data-uid="' + d.uid + '"]').forEach(n => n.remove()));
  sock.on('presence_update', d => renderMembers(d.users || []));
  sock.on('profile_updated', onProfileUpdated);
  sock.on('call_status', d => { S.callInfo = d || S.callInfo; updateCallUI(); });
  sock.on('video_peer_joined', onPeerJoined);
  sock.on('video_peer_left', d => removePeer(d.sid));
  sock.on('peer_media', onPeerMedia);
  sock.on('webrtc_signal', handleSignal);
}
function onProfileUpdated(d) {
  if (d.id === S.me.id) { S.me.name = d.name; S.me.avatar = d.avatar; renderMe(); }
  const u = { id: d.id, name: d.name, avatar: d.avatar };
  document.querySelectorAll('.avatar[data-uid="' + d.id + '"]').forEach(el => setAvatar(el, u));
  document.querySelectorAll('.msg[data-uid="' + d.id + '"] .name').forEach(n => { n.textContent = d.name; });
  for (const sid in C.peers) if (C.peers[sid].uid === d.id) { C.peers[sid].name = d.name; labelTile(sid); }
}

/* ------------------------------------------------------------------ members & call card */
function renderMembers(users) {
  $('onlineCount').textContent = users.length;
  $('members').replaceChildren(...users.map(u => h('li', { class: 'member' },
    h('span', { class: 'wrap' }, avatarEl(u, 38)),
    h('div', { class: 'mi' }, h('b', { text: u.name + (u.id === S.me.id ? ' (You)' : '') }), h('small', { text: '@' + u.username })),
    u.in_call ? h('span', { class: 'badge ico', html: I.video, title: 'In call' }) : null)));
}
function updateCallUI() {
  const ci = S.callInfo, active = !!ci.active, who = ci.started_by || 'A member';
  $('callCard').classList.toggle('live', active);
  $('callCardTitle').textContent = active ? 'Call in progress' : 'Group call';
  $('callCardText').textContent = active ? who + ' · ' + ci.participants + ' in call' : 'Start a video call with everyone online.';
  $('callCardBtn').textContent = active ? 'Join call' : 'Start call';
  $('callBtn').querySelector('.label').textContent = active ? 'Join' : 'Call';
  $('callBtn').classList.toggle('primary', active);
  $('callBtn').setAttribute('aria-label', active ? 'Join group call' : 'Start group call');
  $('callBanner').hidden = !(active && C.phase === 'idle');
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
    frag.append(h('div', { class: 'sys', dataset: { id: m.id } }, h('span', { text: m.text })));
    S.lastMsg = null;
    return frag;
  }
  const mine = m.uid === S.me.id;
  const cont = !!S.lastMsg && S.lastMsg.uid === m.uid && m.ts - S.lastMsg.ts < 5 * 60e3;
  S.lastMsg = { uid: m.uid, ts: m.ts };
  const row = h('div', { class: 'msg' + (mine ? ' mine' : '') + (cont ? ' cont' : ''), dataset: { id: m.id, uid: m.uid } });
  const bubble = h('div', { class: 'bubble' });
  if (!mine && !cont) bubble.append(h('div', { class: 'name', text: m.name || m.username || 'Member' }));
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
  bubble.append(h('div', { class: 'text' }, linkify(m.text || '')), h('time', { class: 'time', text: fmtTime(m.ts) }));
  bubble.addEventListener('click', e => {
    if (e.target.closest('a') || !matchMedia('(hover:none)').matches) return;
    const open = row.classList.contains('tools-open');
    feed.querySelectorAll('.tools-open').forEach(n => n.classList.remove('tools-open'));
    if (!open) row.classList.add('tools-open');
  });
  const tools = h('div', { class: 'tools' },
    ...(BOOT.reactions || []).map(em => h('button', { type: 'button', class: 'tool', title: 'React ' + em, 'aria-label': 'React ' + em, onclick: () => { react(m.id, em); row.classList.remove('tools-open'); } }, em)),
    h('button', { type: 'button', class: 'tool', title: 'Reply', 'aria-label': 'Reply', onclick: () => { startReply(m); row.classList.remove('tools-open'); } }, ico('reply')));
  row.append(avatarEl({ id: m.uid, name: m.name || m.username, avatar: m.avatar }, 34), h('div', { class: 'col' }, bubble, h('div', { class: 'reactions' })), tools);
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
function react(id, emoji) { if (S.sock && S.sock.connected) S.sock.emit('react_message', { id, emoji }); }
function startReply(m) {
  S.reply = { id: m.id, name: m.name || m.username || 'Member', text: (m.text || '').slice(0, 140) };
  $('replyName').textContent = 'Replying to ' + S.reply.name; $('replyText').textContent = S.reply.text;
  $('replyBar').hidden = false; $('msgInput').focus();
}
function clearReply() { S.reply = null; $('replyBar').hidden = true; }
const input = $('msgInput');
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; $('sendBtn').disabled = !input.value.trim(); }
function sendMessage(e) {
  if (e) e.preventDefault();
  const text = input.value.trim(); if (!text) return;
  if (!S.sock || !S.sock.connected) { toast('You are offline. Reconnecting…', 'warn'); return; }
  const reply = S.reply;
  input.value = ''; autosize(); clearReply(); S.atBottom = true;
  S.sock.timeout(10000).emit('send_message', { text, reply_to: reply }, (err, res) => {
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
async function cropAvatar(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That image could not be opened. Try a JPG or PNG.')); i.src = url; });
    const side = Math.min(img.naturalWidth, img.naturalHeight), sx = (img.naturalWidth - side) / 2, sy = (img.naturalHeight - side) / 2;
    const c = document.createElement('canvas'); c.width = c.height = 384;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 384, 384); ctx.drawImage(img, sx, sy, side, side, 0, 0, 384, 384);
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
async function saveName(e) {
  e.preventDefault();
  const name = $('accNameInput').value.trim().replace(/\s+/g, ' ');
  if (!name) return toast('Display name cannot be empty.', 'error');
  if (name === S.me.name) return toast('Nothing to update.', 'info');
  busy($('nameSave'), true);
  try { const r = await api('profile', { token: S.token, name }); S.me = r.me; renderMe(); toast('Profile updated.', 'ok'); }
  catch (err) { toast(err.message, 'error'); }
  finally { busy($('nameSave'), false); }
}
async function savePassword(e) {
  e.preventDefault();
  const cur = $('pwCur').value, n1 = $('pwNew').value, n2 = $('pwNew2').value;
  if (!cur) return toast('Enter your current password.', 'error');
  if (n1.length < 6) return toast('New password must contain at least 6 characters.', 'error');
  if (n1 !== n2) return toast('New passwords do not match.', 'error');
  busy($('pwSave'), true);
  try { await api('password', { token: S.token, current: cur, new: n1 }); $('pwForm').reset(); toast('Password updated.', 'ok'); }
  catch (err) { toast(err.message, 'error'); }
  finally { busy($('pwSave'), false); }
}
function confirmDelete() {
  openModal(close => {
    const pw = h('input', { class: 'input', type: 'password', placeholder: 'Your password', autocomplete: 'current-password', 'aria-label': 'Password' });
    const err = h('div', { class: 'err' });
    const go = h('button', { class: 'btn danger', type: 'button' }, h('span', { class: 'spin' }), h('span', { class: 'label', text: 'Delete forever' }));
    go.onclick = async () => {
      if (!pw.value) { err.textContent = 'Enter your password to confirm.'; return; }
      busy(go, true); err.textContent = '';
      try {
        await api('delete-account', { token: S.token, password: pw.value });
        S.kicked = true; endCall(false); if (S.sock) S.sock.disconnect();
        ls.del(TOKEN_KEY); close(); toast('Account deleted.', 'ok'); setTimeout(() => location.reload(), 900);
      } catch (e) { busy(go, false); err.textContent = e.message; }
    };
    return h('div', { class: 'modal' }, h('h3', { text: 'Delete your account?' }),
      h('p', { text: 'This permanently deletes your account and every message you have sent. This cannot be undone.' }),
      h('div', { class: 'field' }, pw), err,
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
async function getMedia() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Calls need a secure (HTTPS) connection and a modern browser.');
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
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
    b.title = b.ariaLabel = !C.hasCam ? 'No camera found' : cam ? 'Turn camera off' : 'Turn camera on';
  }
  $('spkBtn').innerHTML = '<span class="ico">' + (C.spkOn ? I.spk : I.spkOff) + '</span>';
  $('spkBtn').classList.toggle('off', !C.spkOn);
  $('spkBtn').title = $('spkBtn').ariaLabel = C.spkOn ? 'Mute speaker' : 'Unmute speaker';
  $('endBtn').innerHTML = '<span class="ico">' + I.end + '</span>';
  $('preview').classList.toggle('nocam', !cam);
  updateTile('local');
}
async function openCall() {
  if (C.phase !== 'idle') return;
  if (!S.sock || !S.sock.connected) return toast('Still connecting to the server. Try again in a moment.', 'warn');
  C.phase = 'lobby';
  showCall(true);
  $('lobby').hidden = false; $('stage').hidden = true; $('callBar').hidden = true;
  $('lobbyErr').textContent = ''; $('joinNow').disabled = true;
  $('lobbyTitle').textContent = S.callInfo.active ? 'Join the call' : 'Start a call';
  $('lobbyInfo').textContent = 'Checking your camera and microphone…';
  $('previewCover').replaceChildren(avatarEl(S.me));
  $('callTimer').textContent = '00:00'; setNet('wait', 'Not connected'); $('callCount').textContent = 'Preview';
  document.addEventListener('keydown', onCallKey);
  try {
    const stream = await getMedia();
    if (C.phase !== 'lobby') { stopStream(stream); return; }
    C.local = stream;
    C.hasMic = stream.getAudioTracks().length > 0; C.hasCam = stream.getVideoTracks().length > 0;
    C.micOn = C.hasMic; C.camOn = C.hasCam; C.spkOn = true;
    $('previewVideo').srcObject = stream;
    const n = S.callInfo.participants;
    $('lobbyInfo').textContent = S.callInfo.active
      ? (S.callInfo.started_by || 'A member') + ' started this call' + (n > 1 ? ' - ' + n + ' people are in it.' : '.')
      : 'You will be the first one in. Others can join from the chat.';
    if (!C.hasCam) $('lobbyInfo').textContent += ' No camera found - you will join with audio only.';
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
  S.sock.timeout(12000).emit('join_video', { mic: C.micOn && C.hasMic, cam: C.camOn && C.hasCam }, (err, res) => {
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

  $('tabLogin').onclick = () => setMode(false);
  $('tabRegister').onclick = () => setMode(true);
  $('authForm').addEventListener('submit', submitAuth);
  $('pwToggle').onclick = () => {
    const show = $('password').type === 'password';
    $('password').type = show ? 'text' : 'password';
    $('pwToggle').firstChild.innerHTML = show ? I.eyeOff : I.eye;
    $('pwToggle').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  };

  $('menuBtn').onclick = openSide; $('sideClose').onclick = closeSide; $('scrim').onclick = closeSide;
  $('meBtn').onclick = () => showView('account'); $('meChip').onclick = () => showView('account');
  $('accBack').onclick = () => showView('chat');
  $('callBtn').onclick = openCall; $('callCardBtn').onclick = () => { closeSide(); openCall(); }; $('joinBannerBtn').onclick = openCall;

  input.addEventListener('input', autosize);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer:fine)').matches) { e.preventDefault(); sendMessage(); }
  });
  $('composer').addEventListener('submit', sendMessage);
  $('replyCancel').onclick = clearReply;
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.reply) clearReply(); });

  $('uploadBtn').onclick = () => $('avatarFile').click(); $('accPhotoBtn').onclick = () => $('avatarFile').click();
  $('avatarFile').onchange = e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; onAvatarPicked(f); };
  $('removePhotoBtn').onclick = async () => {
    if (!S.me.avatar) return toast('You have no profile photo to remove.', 'info');
    try { const r = await api('profile', { token: S.token, avatar: '' }); S.me = r.me; renderMe(); toast('Profile photo removed.', 'ok'); } catch (e) { toast(e.message, 'error'); }
  };
  $('nameForm').addEventListener('submit', saveName);
  $('pwForm').addEventListener('submit', savePassword);
  $('signOutBtn').onclick = signOut; $('deleteBtn').onclick = confirmDelete;
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
