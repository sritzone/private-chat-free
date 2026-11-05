"""SR Private Chat - Flask + Socket.IO + Firebase Firestore.

Performance design
  * Auth sessions, the user directory, avatars and recent messages live in memory,
    so chat/call events never wait on Firestore.
  * Messages and reactions are persisted in the background (write-behind).
  * Avatars are served as cacheable images instead of being embedded in every message.

Security design
  * One active login per account: a new login or a new tab/device signs the old one out instantly.
  * Login/registration rate limits, strict avatar validation, CSP and security headers.

Run on a single worker/process (state is kept in memory).
"""
import base64
import collections
import hashlib
import json
import logging
import os
import re
import secrets
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

from flask import Flask, Response, g, jsonify, render_template, request, url_for
from flask_socketio import SocketIO, emit
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash

try:
    from flask_compress import Compress
except ImportError:  # optional speed-up
    Compress = None

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("sr-chat")

# --------------------------------------------------------------------------- config
ROOM_TITLE = (os.environ.get("ROOM_TITLE") or os.environ.get("FFX-G") or "SR Private Chat")[:60]
SESSION_TTL_MS = 30 * 24 * 3600 * 1000      # sessions last 30 days
AUTH_RECHECK = 300                           # seconds a verified token is trusted from memory
HISTORY_SEND = 100                           # messages sent to a client on connect
CACHE_LIMIT = 200                            # messages kept in memory
MAX_AVATAR_BYTES = 300_000
REACTIONS = ("👍", "❤️", "😂", "😮", "😢", "🔥")
SESSION_CODES = {
    "login_elsewhere": "You were signed out because this account signed in on another device.",
    "other_tab": "This account is open in another tab or window.",
    "logout": "You have been signed out.",
    "deleted": "This account has been deleted.",
}

app = Flask(__name__, static_folder="static", template_folder="templates")
app.config.update(
    SECRET_KEY=os.environ.get("SECRET_KEY") or secrets.token_hex(32),
    MAX_CONTENT_LENGTH=700 * 1024,
    SEND_FILE_MAX_AGE_DEFAULT=31536000,
    COMPRESS_MIN_SIZE=500,
)
app.json.sort_keys = False
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
if Compress:
    Compress(app)
socketio = SocketIO(app, async_mode="threading", cors_allowed_origins="*",
                    ping_interval=20, ping_timeout=40, max_http_buffer_size=256_000)


def now_ms():
    return int(time.time() * 1000)


# --------------------------------------------------------------------------- storage
class MemoryStore:
    """Local development store (LOCAL_DEV=1). Data is lost on restart."""
    kind = "memory"

    def __init__(self):
        self.lock = threading.RLock()
        self.users, self.sessions, self.messages = {}, {}, {}

    def get_user(self, key):
        with self.lock:
            u = self.users.get(key)
            return dict(u) if u else None

    def create_user(self, key, profile):
        with self.lock:
            if key in self.users:
                return False
            self.users[key] = dict(profile)
            return True

    def update_user(self, key, fields):
        with self.lock:
            if key in self.users:
                self.users[key].update(fields)

    def delete_user(self, key):
        with self.lock:
            self.users.pop(key, None)

    def all_users(self):
        with self.lock:
            return [(k, dict(v)) for k, v in self.users.items()]

    def find_user_by_uid(self, uid):
        with self.lock:
            for k, v in self.users.items():
                if (v.get("uid") or k) == uid:
                    return k, dict(v)
        return None

    def replace_session(self, key, uid, token):
        with self.lock:
            user = self.users.get(key)
            if not user:
                raise ValueError("Account no longer exists")
            old = user.get("active_session")
            user["active_session"] = token
            if old:
                self.sessions.pop(old, None)
            self.sessions[token] = {"uid": uid, "user_key": key, "created_at": now_ms()}
            return old

    def get_session(self, token):
        with self.lock:
            s = self.sessions.get(token)
            return dict(s) if s else None

    def delete_session(self, token):
        with self.lock:
            self.sessions.pop(token, None)

    def delete_sessions_for_key(self, key):
        with self.lock:
            for t in [t for t, s in self.sessions.items() if s.get("user_key") == key]:
                self.sessions.pop(t, None)

    def clear_active_session(self, key, token):
        with self.lock:
            u = self.users.get(key)
            if u and u.get("active_session") == token:
                u.pop("active_session", None)

    def recent_messages(self, limit):
        with self.lock:
            rows = sorted(self.messages.values(), key=lambda m: m.get("ts", 0))[-limit:]
            return [dict(m) for m in rows]

    def add_message(self, mid, data):
        with self.lock:
            self.messages[mid] = {"id": mid, **data}

    def set_reactions(self, mid, reactions):
        with self.lock:
            if mid in self.messages:
                self.messages[mid]["reactions"] = dict(reactions)

    def delete_messages_by_uid(self, uid):
        with self.lock:
            for mid in [i for i, m in self.messages.items() if m.get("uid") == uid]:
                self.messages.pop(mid, None)


class FirestoreStore:
    kind = "firestore"

    def __init__(self, info):
        import firebase_admin
        from firebase_admin import credentials, firestore
        self.fs = firestore
        if not firebase_admin._apps:
            firebase_admin.initialize_app(
                credentials.Certificate(info),
                {"projectId": os.environ.get("FIREBASE_PROJECT_ID") or info.get("project_id")})
        self.db = firestore.client()
        self.users = self.db.collection("chat_users")
        self.sessions = self.db.collection("chat_sessions")
        self.messages = self.db.collection("chat_messages")

    def _eq(self, coll, field, value):
        try:
            from google.cloud.firestore_v1.base_query import FieldFilter
            return coll.where(filter=FieldFilter(field, "==", value))
        except ImportError:
            return coll.where(field, "==", value)

    def get_user(self, key):
        s = self.users.document(key).get()
        return (s.to_dict() or {}) if s.exists else None

    def create_user(self, key, profile):
        ref = self.users.document(key)

        @self.fs.transactional
        def run(tx):
            if ref.get(transaction=tx).exists:
                return False
            tx.set(ref, profile)
            return True

        return run(self.db.transaction())

    def update_user(self, key, fields):
        self.users.document(key).update(fields)

    def delete_user(self, key):
        self.users.document(key).delete()

    def all_users(self):
        return [(d.id, d.to_dict() or {}) for d in self.users.stream()]

    def find_user_by_uid(self, uid):
        for d in self._eq(self.users, "uid", uid).limit(1).stream():
            return d.id, d.to_dict() or {}
        legacy = self.get_user(uid)
        return (uid, legacy) if legacy else None

    def replace_session(self, key, uid, token):
        user_ref = self.users.document(key)
        session_ref = self.sessions.document(token)
        sessions = self.sessions

        @self.fs.transactional
        def run(tx):
            snap = user_ref.get(transaction=tx)
            if not snap.exists:
                raise ValueError("Account no longer exists")
            old = (snap.to_dict() or {}).get("active_session")
            tx.update(user_ref, {"active_session": token})
            tx.set(session_ref, {"uid": uid, "user_key": key, "created_at": now_ms()})
            if old:
                tx.delete(sessions.document(old))
            return old

        return run(self.db.transaction())

    def get_session(self, token):
        s = self.sessions.document(token).get()
        return (s.to_dict() or {}) if s.exists else None

    def delete_session(self, token):
        self.sessions.document(token).delete()

    def _batch_delete(self, docs):
        docs = list(docs)
        for i in range(0, len(docs), 400):
            batch = self.db.batch()
            for d in docs[i:i + 400]:
                batch.delete(d.reference)
            batch.commit()

    def delete_sessions_for_key(self, key):
        self._batch_delete(self._eq(self.sessions, "user_key", key).stream())

    def clear_active_session(self, key, token):
        snap = self.users.document(key).get()
        if snap.exists and (snap.to_dict() or {}).get("active_session") == token:
            self.users.document(key).update({"active_session": self.fs.DELETE_FIELD})

    def recent_messages(self, limit):
        out = []
        q = self.messages.order_by("ts", direction=self.fs.Query.DESCENDING).limit(limit)
        for d in q.stream():
            m = d.to_dict() or {}
            m["id"] = d.id
            out.append(m)
        out.reverse()
        return out

    def add_message(self, mid, data):
        self.messages.document(mid).set(data)

    def set_reactions(self, mid, reactions):
        self.messages.document(mid).update({"reactions": reactions})

    def delete_messages_by_uid(self, uid):
        self._batch_delete(self._eq(self.messages, "uid", uid).stream())


def build_store():
    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
    if raw:
        return FirestoreStore(json.loads(raw))
    if os.environ.get("LOCAL_DEV") == "1":
        log.warning("LOCAL_DEV=1: using in-memory storage. Data is NOT saved.")
        return MemoryStore()
    raise RuntimeError("Missing FIREBASE_SERVICE_ACCOUNT_JSON environment variable "
                       "(set LOCAL_DEV=1 to try the app locally without Firebase)")


store = build_store()
io_pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix="persist")
seq_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="persist-seq")


def run_bg(pool, fn, *args, on_fail=None, retries=3):
    """Write-behind persistence with retries."""
    def job():
        for attempt in range(retries):
            try:
                fn(*args)
                return
            except Exception:
                log.exception("background write failed (attempt %s)", attempt + 1)
                time.sleep(0.4 * (attempt + 1))
        if on_fail:
            try:
                on_fail()
            except Exception:
                log.exception("on_fail handler crashed")
    pool.submit(job)


# --------------------------------------------------------------------------- rate limiting
class Limiter:
    def __init__(self):
        self.h = collections.defaultdict(collections.deque)
        self.lock = threading.Lock()

    def _trim(self, d, window, now):
        while d and d[0] <= now - window:
            d.popleft()

    def peek(self, key, limit, window):
        now = time.time()
        with self.lock:
            d = self.h[key]
            self._trim(d, window, now)
            return len(d) < limit

    def add(self, key):
        with self.lock:
            if len(self.h) > 5000:
                cutoff = time.time() - 3600
                for k in [k for k, d in self.h.items() if not d or d[-1] < cutoff]:
                    self.h.pop(k, None)
            self.h[key].append(time.time())

    def hit(self, key, limit, window):
        if not self.peek(key, limit, window):
            return False
        self.add(key)
        return True

    def clear(self, key):
        with self.lock:
            self.h.pop(key, None)


login_gate, reg_gate, me_gate, pw_gate, chat_gate = Limiter(), Limiter(), Limiter(), Limiter(), Limiter()

# --------------------------------------------------------------------------- directory (users + avatars)
directory = {}          # uid -> info
missing_uids = set()
dir_lock = threading.RLock()


def decode_avatar(data_url):
    m = re.fullmatch(r"data:(image/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)", data_url or "")
    if not m:
        return None
    try:
        raw = base64.b64decode(m.group(2), validate=True)
    except Exception:
        return None
    mime = m.group(1)
    ok = ((mime == "image/jpeg" and raw[:3] == b"\xff\xd8\xff") or
          (mime == "image/png" and raw[:8] == b"\x89PNG\r\n\x1a\n") or
          (mime == "image/webp" and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP"))
    if not ok or len(raw) > MAX_AVATAR_BYTES:
        return None
    return mime, raw


def dir_put(key, prof):
    uid = prof.get("uid") or key
    mime = raw = None
    ver = ""
    parsed = decode_avatar(prof.get("avatar") or "")
    if parsed:
        mime, raw = parsed
        ver = hashlib.sha1(raw).hexdigest()[:10]
    info = {"uid": uid, "key": key, "name": prof.get("name", ""), "username": prof.get("username", ""),
            "created_at": prof.get("created_at", 0), "avatar_mime": mime, "avatar_raw": raw, "avatar_ver": ver}
    with dir_lock:
        directory[uid] = info
        missing_uids.discard(uid)
    return info


def info_for(uid):
    info = directory.get(uid)
    if info or not uid or uid == "system" or uid in missing_uids:
        return info
    try:
        found = store.find_user_by_uid(uid)
    except Exception:
        log.exception("user lookup failed")
        return None
    if found:
        return dir_put(*found)
    missing_uids.add(uid)
    return None


def avatar_url(uid):
    info = directory.get(uid)
    if info and info["avatar_raw"]:
        return "/avatar/%s?v=%s" % (uid, info["avatar_ver"])
    return ""


def public_user(uid):
    info = directory[uid]
    return {"id": uid, "name": info["name"], "username": info["username"],
            "avatar": avatar_url(uid), "created_at": info["created_at"]}


# --------------------------------------------------------------------------- auth cache
auth_lock = threading.RLock()
tokens = {}             # token -> {"uid","key","checked"}
active_by_key = {}      # account key -> the one valid token


def resolve_token(token):
    token = str(token or "")
    if not token or len(token) > 200:
        return None
    now = time.time()
    with auth_lock:
        e = tokens.get(token)
        if e and e["checked"] + AUTH_RECHECK > now and active_by_key.get(e["key"]) == token:
            return e
    try:
        sd = store.get_session(token)
        if not sd:
            return None
        key, uid = sd.get("user_key"), sd.get("uid")
        if not key or not uid:
            return None
        if now_ms() - int(sd.get("created_at") or 0) > SESSION_TTL_MS:
            store.delete_session(token)
            return None
        user = store.get_user(key)
    except Exception:
        log.exception("token check failed")
        return None
    if not user or user.get("active_session") != token:
        return None
    if uid not in directory:
        dir_put(key, user)
    e = {"uid": uid, "key": key, "checked": now}
    with auth_lock:
        tokens[token] = e
        active_by_key[key] = token
    return e


def make_session(uid, key):
    token = secrets.token_urlsafe(36)
    old_db = store.replace_session(key, uid, token)
    with auth_lock:
        for old in (active_by_key.get(key), old_db):
            if old:
                tokens.pop(old, None)
        active_by_key[key] = token
        tokens[token] = {"uid": uid, "key": key, "checked": time.time()}
    kick_account(uid, "login_elsewhere")
    return token


def revoke_account_tokens(key):
    with auth_lock:
        old = active_by_key.pop(key, None)
        if old:
            tokens.pop(old, None)


# --------------------------------------------------------------------------- messages cache
recent = collections.deque()
recent_by_id = {}
recent_lock = threading.RLock()


def cache_add(m):
    with recent_lock:
        if len(recent) >= CACHE_LIMIT:
            recent_by_id.pop(recent.popleft()["id"], None)
        recent.append(m)
        recent_by_id[m["id"]] = m


def cache_remove(mid):
    with recent_lock:
        m = recent_by_id.pop(mid, None)
        if m is not None:
            try:
                recent.remove(m)
            except ValueError:
                pass


def cache_remove_uid(uid):
    with recent_lock:
        keep = [m for m in recent if m.get("uid") != uid]
        recent.clear()
        recent_by_id.clear()
        for m in keep:
            recent.append(m)
            recent_by_id[m["id"]] = m


def msg_out(m):
    uid = m.get("uid", "")
    info = directory.get(uid) if uid != "system" else None
    src = info or m
    return {"id": m["id"], "uid": uid, "name": src.get("name", ""), "username": src.get("username", ""),
            "text": m.get("text", ""), "ts": m.get("ts", 0), "kind": m.get("kind", "user"),
            "avatar": avatar_url(uid) if info else "", "reactions": m.get("reactions") or {},
            "reply_to": m.get("reply_to")}


def history_payload():
    with recent_lock:
        rows = list(recent)[-HISTORY_SEND:]
    return [msg_out(m) for m in rows]


# --------------------------------------------------------------------------- realtime state
online = {}             # sid -> {"uid","token"}
online_lock = threading.RLock()
video_sids = set()
video_media = {}        # sid -> {"mic","cam"}
call_started_at = None


def peer_profile(sid):
    uid = (online.get(sid) or {}).get("uid", "")
    info = directory.get(uid) or {}
    st = video_media.get(sid) or {}
    return {"uid": uid, "name": info.get("name", "Participant"), "avatar": avatar_url(uid),
            "mic": st.get("mic", True), "cam": st.get("cam", True)}


def emit_presence():
    with online_lock:
        in_call = {online[s]["uid"] for s in video_sids if s in online}
        uids = list({u["uid"] for u in online.values()})
        call_active = bool(video_sids)
    users = []
    for uid in uids:
        info = directory.get(uid)
        if info:
            users.append({"id": uid, "name": info["name"], "username": info["username"],
                          "avatar": avatar_url(uid), "in_call": uid in in_call})
    users.sort(key=lambda u: u["name"].lower())
    socketio.emit("presence_update", {"count": len(users), "users": users, "call_active": call_active})


def call_status_payload():
    with online_lock:
        sids = list(video_sids)
        first = (online.get(sids[0]) or {}).get("uid") if sids else None
        started = call_started_at
    return {"active": bool(sids), "participants": len(sids),
            "started_by": (directory.get(first) or {}).get("name", "A member") if first else "",
            "started_at": started or 0}


def emit_call_status():
    socketio.emit("call_status", call_status_payload())


def system_message(text):
    m = {"id": secrets.token_hex(10), "uid": "system", "name": "SR Chat", "username": "system",
         "text": text, "ts": now_ms(), "kind": "system"}
    cache_add(m)
    socketio.emit("new_message", msg_out(m))
    run_bg(io_pool, store.add_message, m["id"], {k: v for k, v in m.items() if k != "id"})


def _announce_leave(sid, name, peers):
    global call_started_at
    ended = not peers
    if ended:
        call_started_at = None
    system_message("%s ended the call" % name if ended else "%s left the call" % name)
    for p in peers:
        socketio.emit("video_peer_left", {"sid": sid}, to=p)
    emit_call_status()


def drop_sid(sid):
    """Forget a socket and leave any call. Safe to call more than once."""
    with online_lock:
        user = online.pop(sid, None)
        was_in_call = sid in video_sids
        video_sids.discard(sid)
        video_media.pop(sid, None)
        peers = list(video_sids)
    if was_in_call:
        _announce_leave(sid, (directory.get((user or {}).get("uid")) or {}).get("name", "A member"), peers)
    return user


def kick_account(uid, code, except_sid=None):
    """Sign an account out of every live socket (one active login per account)."""
    with online_lock:
        sids = [s for s, u in online.items() if u["uid"] == uid and s != except_sid]
    for sid in sids:
        socketio.emit("session_replaced", {"code": code, "reason": SESSION_CODES.get(code, "Signed out.")}, to=sid)
        drop_sid(sid)
    if sids:
        time.sleep(0.05)  # let the notice flush before closing
        for sid in sids:
            try:
                socketio.server.disconnect(sid, namespace="/")
            except Exception:
                log.debug("disconnect failed", exc_info=True)
        emit_presence()


def current_socket_user():
    sid = request.sid
    with online_lock:
        item = online.get(sid)
    if not item:
        return None
    e = resolve_token(item["token"])
    if not e or e["uid"] != item["uid"]:
        socketio.emit("session_replaced", {"code": "login_elsewhere", "reason": SESSION_CODES["login_elsewhere"]}, to=sid)
        return None
    return item


# --------------------------------------------------------------------------- HTTP helpers
def api_error(message, status=400):
    return jsonify(error=message), status


def body():
    d = request.get_json(silent=True)
    return d if isinstance(d, dict) else {}


def clean_spaces(v):
    return re.sub(r"\s+", " ", str(v or "").strip())


def username_key(v):
    return clean_spaces(v).casefold()


def asset(path):
    try:
        v = int(os.path.getmtime(os.path.join(app.static_folder, path)))
    except OSError:
        v = 0
    return url_for("static", filename=path, v=v)


app.jinja_env.globals["asset"] = asset


def rtc_config():
    cfg = {"iceServers": [{"urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]}]}
    urls = os.environ.get("TURN_URLS", "").strip()
    user = os.environ.get("TURN_USERNAME", "").strip()
    cred = os.environ.get("TURN_CREDENTIAL", "").strip()
    if urls and user and cred:
        cfg["iceServers"].append({"urls": [u.strip() for u in urls.split(",") if u.strip()],
                                  "username": user, "credential": cred})
    return cfg


@app.after_request
def add_headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()")
    path = request.path
    if path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    elif path == "/":
        resp.headers["Cache-Control"] = "no-cache"
        nonce = g.get("nonce")
        if nonce:
            resp.headers["Content-Security-Policy"] = (
                "default-src 'self'; script-src 'self' 'nonce-%s'; style-src 'self' 'unsafe-inline'; "
                "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; "
                "font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" % nonce)
    return resp


# --------------------------------------------------------------------------- HTTP routes
@app.get("/")
def home():
    g.nonce = secrets.token_urlsafe(12)
    boot = {"title": ROOM_TITLE, "rtc": rtc_config(), "reactions": list(REACTIONS)}
    return render_template("index.html", room_title=ROOM_TITLE, boot=boot, nonce=g.nonce)


@app.get("/health")
def health():
    return jsonify(ok=True, service="sr-firebase-chat", storage=store.kind)


@app.get("/avatar/<uid>")
def avatar(uid):
    info = info_for(uid[:64])
    if not info or not info["avatar_raw"]:
        return Response(status=404, headers={"Cache-Control": "public, max-age=60"})
    etag = '"%s"' % info["avatar_ver"]
    if request.headers.get("If-None-Match") == etag:
        return Response(status=304, headers={"ETag": etag})
    resp = Response(info["avatar_raw"], mimetype=info["avatar_mime"])
    resp.headers["ETag"] = etag
    resp.headers["Cache-Control"] = ("public, max-age=31536000, immutable"
                                     if request.args.get("v") == info["avatar_ver"] else "public, max-age=60")
    resp.headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
    return resp


@app.post("/api/register")
def register():
    ip = request.remote_addr or "?"
    if not reg_gate.hit(ip, 10, 3600):
        return api_error("Too many sign-ups from this network. Please try again later.", 429)
    d = body()
    name = clean_spaces(d.get("name"))
    username = str(d.get("username") or "").strip()
    password = str(d.get("password") or "")
    if not name or len(name) > 40:
        return api_error("Name is required (maximum 40 characters)")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.]{2,19}", username):
        return api_error("Username must be 3-20 characters, start with a letter or number, and use only letters, numbers, _ or .")
    if len(password) < 6 or len(password) > 128:
        return api_error("Password must be 6 to 128 characters")
    key = username_key(username)
    uid = uuid.uuid4().hex
    profile = {"uid": uid, "name": name, "username": username,
               "password_hash": generate_password_hash(password), "created_at": now_ms()}
    if not store.create_user(key, profile):
        return api_error("That username is already taken")
    dir_put(key, profile)
    token = make_session(uid, key)
    return jsonify(token=token, me=public_user(uid))


@app.post("/api/login")
def login():
    d = body()
    username = str(d.get("username") or "").strip()[:40]
    password = str(d.get("password") or "")[:128]
    if not username or not password:
        return api_error("Enter your username and password")
    key = username_key(username)
    gate = "%s|%s" % (request.remote_addr, key)
    if not login_gate.peek(gate, 6, 300):
        return api_error("Too many attempts. Please wait a few minutes and try again.", 429)
    prof = store.get_user(key)
    if not prof or not check_password_hash(prof.get("password_hash", ""), password):
        login_gate.add(gate)
        return api_error("Incorrect username or password", 401)
    login_gate.clear(gate)
    uid = prof.get("uid") or key
    dir_put(key, prof)
    token = make_session(uid, key)
    return jsonify(token=token, me=public_user(uid))


@app.post("/api/me")
def me():
    if not me_gate.hit(request.remote_addr or "?", 120, 60):
        return api_error("Too many requests", 429)
    e = resolve_token(body().get("token"))
    if not e or e["uid"] not in directory:
        return api_error("Session expired. Please log in again.", 401)
    return jsonify(me=public_user(e["uid"]))


@app.post("/api/profile")
def update_profile():
    d = body()
    e = resolve_token(d.get("token"))
    if not e:
        return api_error("Session expired. Please log in again.", 401)
    uid, key = e["uid"], e["key"]
    info = directory.get(uid) or info_for(uid)
    if not info:
        return api_error("Account not found", 404)
    fields = {}
    if "name" in d:
        name = clean_spaces(d.get("name"))
        if not name or len(name) > 40:
            return api_error("Name is required (maximum 40 characters)")
        fields["name"] = name
    if "avatar" in d:
        avatar_data = str(d.get("avatar") or "")
        if avatar_data:
            if len(avatar_data) > 420000 or not decode_avatar(avatar_data):
                return api_error("Profile photo must be a JPG, PNG or WebP image under 300 KB")
        fields["avatar"] = avatar_data
    if not fields:
        return jsonify(me=public_user(uid))
    store.update_user(key, fields)
    with dir_lock:
        if "name" in fields:
            info["name"] = fields["name"]
        if "avatar" in fields:
            parsed = decode_avatar(fields["avatar"])
            info["avatar_mime"], info["avatar_raw"] = parsed if parsed else (None, None)
            info["avatar_ver"] = hashlib.sha1(info["avatar_raw"]).hexdigest()[:10] if parsed else ""
    socketio.emit("profile_updated", {"id": uid, "name": info["name"], "username": info["username"],
                                      "avatar": avatar_url(uid)})
    emit_presence()
    return jsonify(me=public_user(uid))


@app.post("/api/password")
def change_password():
    d = body()
    e = resolve_token(d.get("token"))
    if not e:
        return api_error("Session expired. Please log in again.", 401)
    if not pw_gate.hit("pw|" + e["uid"], 6, 600):
        return api_error("Too many attempts. Please wait a few minutes.", 429)
    current, new = str(d.get("current") or "")[:128], str(d.get("new") or "")
    if len(new) < 6 or len(new) > 128:
        return api_error("New password must be 6 to 128 characters")
    prof = store.get_user(e["key"])
    if not prof or not check_password_hash(prof.get("password_hash", ""), current):
        return api_error("Current password is incorrect", 401)
    store.update_user(e["key"], {"password_hash": generate_password_hash(new)})
    return jsonify(ok=True)


@app.post("/api/logout")
def logout():
    token = str(body().get("token") or "")
    e = resolve_token(token)
    if e:
        try:
            store.clear_active_session(e["key"], token)
            store.delete_session(token)
        except Exception:
            log.exception("logout cleanup failed")
        revoke_account_tokens(e["key"])
        kick_account(e["uid"], "logout")
    return jsonify(ok=True)


@app.post("/api/delete-account")
def delete_account():
    d = body()
    e = resolve_token(d.get("token"))
    if not e:
        return api_error("Session expired. Please log in again.", 401)
    uid, key = e["uid"], e["key"]
    prof = store.get_user(key)
    if not prof or not check_password_hash(prof.get("password_hash", ""), str(d.get("password") or "")[:128]):
        return api_error("Incorrect password", 401)
    store.delete_messages_by_uid(uid)
    store.delete_sessions_for_key(key)
    store.delete_user(key)
    revoke_account_tokens(key)
    kick_account(uid, "deleted")
    cache_remove_uid(uid)
    with dir_lock:
        directory.pop(uid, None)
        missing_uids.add(uid)
    socketio.emit("messages_removed", {"uid": uid})
    emit_presence()
    return jsonify(ok=True)


@app.get("/api/messages")
def message_history():
    token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    if not resolve_token(token):
        return api_error("Please log in again", 401)
    return jsonify(messages=history_payload())


# --------------------------------------------------------------------------- Socket.IO events
@socketio.on("connect")
def on_connect(auth=None):
    token = (auth or {}).get("token") if isinstance(auth, dict) else None
    e = resolve_token(token)
    if not e or e["uid"] not in directory:
        return False
    uid = e["uid"]
    # One active connection per account: the newest tab/device wins.
    kick_account(uid, "other_tab")
    with online_lock:
        online[request.sid] = {"uid": uid, "token": token}
    emit("chat_history", {"messages": history_payload()})
    emit("call_status", call_status_payload())
    emit_presence()


@socketio.on("disconnect")
def on_disconnect(*args):
    drop_sid(request.sid)
    emit_presence()


@socketio.on("send_message")
def on_send_message(data=None):
    sender = current_socket_user()
    if not sender:
        return {"ok": False, "error": "Session expired. Please sign in again.", "code": "session"}
    data = data if isinstance(data, dict) else {}
    text = str(data.get("text") or "").strip()
    if not text:
        return {"ok": False, "error": "Message is empty."}
    if len(text) > 2000:
        return {"ok": False, "error": "Message limit is 2000 characters."}
    if not chat_gate.hit(sender["uid"], 12, 10):
        return {"ok": False, "error": "You are sending messages too fast. Please slow down."}
    reply = data.get("reply_to")
    reply_to = None
    if isinstance(reply, dict) and reply.get("id"):
        reply_to = {"id": str(reply.get("id"))[:40], "name": str(reply.get("name") or "")[:40],
                    "text": str(reply.get("text") or "")[:140]}
    info = directory.get(sender["uid"]) or {}
    m = {"id": secrets.token_hex(10), "uid": sender["uid"], "name": info.get("name", ""),
         "username": info.get("username", ""), "text": text, "ts": now_ms(),
         "kind": "user", "reactions": {}, "reply_to": reply_to}
    cache_add(m)
    socketio.emit("new_message", msg_out(m))          # instant delivery

    def failed():
        cache_remove(m["id"])
        socketio.emit("message_failed", {"id": m["id"]})

    run_bg(io_pool, store.add_message, m["id"], {k: v for k, v in m.items() if k != "id"}, on_fail=failed)
    return {"ok": True, "id": m["id"]}


@socketio.on("react_message")
def on_react_message(data=None):
    sender = current_socket_user()
    data = data if isinstance(data, dict) else {}
    mid, emoji = str(data.get("id") or ""), str(data.get("emoji") or "")
    if not sender or emoji not in REACTIONS:
        return
    with recent_lock:
        m = recent_by_id.get(mid)
        if not m or m.get("kind") == "system":
            return
        reactions = dict(m.get("reactions") or {})
        if reactions.get(sender["uid"]) == emoji:
            reactions.pop(sender["uid"], None)
        else:
            reactions[sender["uid"]] = emoji
        m["reactions"] = reactions
    socketio.emit("message_reaction", {"id": mid, "reactions": reactions})
    run_bg(seq_pool, store.set_reactions, mid, dict(reactions))


# ---- group call signalling (WebRTC mesh)
@socketio.on("join_video")
def join_video(data=None):
    global call_started_at
    user = current_socket_user()
    if not user:
        return {"ok": False, "reason": "Session expired. Please sign in again."}
    data = data if isinstance(data, dict) else {}
    sid = request.sid
    mic, cam = bool(data.get("mic", True)), bool(data.get("cam", True))
    with online_lock:
        if any((online.get(s) or {}).get("uid") == user["uid"] for s in video_sids if s != sid):
            return {"ok": False, "reason": "This account is already in the call on another device."}
        was_empty = not video_sids
        already = sid in video_sids
        video_sids.add(sid)
        video_media[sid] = {"mic": mic, "cam": cam}
        if was_empty:
            call_started_at = now_ms()
        peers = [s for s in video_sids if s != sid]
        profiles = {s: peer_profile(s) for s in peers}
        me_profile = peer_profile(sid)
        count = len(video_sids)
        elapsed = now_ms() - (call_started_at or now_ms())
    name = me_profile["name"]
    if not already:
        system_message("%s started the call" % name if was_empty else "%s joined the call" % name)
        for p in peers:
            socketio.emit("video_peer_joined", {"sid": sid, **me_profile}, to=p)
        emit_call_status()
        emit_presence()
    return {"ok": True, "peers": peers, "profiles": profiles, "participant_count": count,
            "elapsed_ms": elapsed}


@socketio.on("leave_video")
def leave_video():
    sid = request.sid
    with online_lock:
        was_in_call = sid in video_sids
        video_sids.discard(sid)
        video_media.pop(sid, None)
        peers = list(video_sids)
        name = (directory.get((online.get(sid) or {}).get("uid")) or {}).get("name", "A member")
    if was_in_call:
        _announce_leave(sid, name, peers)
        emit_presence()


@socketio.on("media_state")
def media_state(data=None):
    if not current_socket_user():
        return
    data = data if isinstance(data, dict) else {}
    sid = request.sid
    with online_lock:
        if sid not in video_sids:
            return
        st = video_media.setdefault(sid, {})
        st["mic"], st["cam"] = bool(data.get("mic", True)), bool(data.get("cam", True))
        out = {"sid": sid, "mic": st["mic"], "cam": st["cam"]}
        peers = [s for s in video_sids if s != sid]
    for p in peers:
        socketio.emit("peer_media", out, to=p)


@socketio.on("webrtc_signal")
def webrtc_signal(data=None):
    data = data if isinstance(data, dict) else {}
    target, kind = str(data.get("to") or ""), data.get("kind")
    if kind not in ("offer", "answer", "ice") or not target:
        return
    if not current_socket_user():
        return
    with online_lock:
        if request.sid not in video_sids or target not in video_sids:
            return
    socketio.emit("webrtc_signal", {"from": request.sid, "kind": kind, "payload": data.get("payload")}, to=target)


# --------------------------------------------------------------------------- warm-up
def warm_up():
    t0 = time.time()
    try:
        for key, prof in store.all_users():
            dir_put(key, prof)
        for m in store.recent_messages(CACHE_LIMIT):
            cache_add(m)
        log.info("warm-up: %d users, %d messages in %.2fs", len(directory), len(recent), time.time() - t0)
    except Exception:
        log.exception("warm-up failed (continuing with empty caches)")


warm_up()

if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), allow_unsafe_werkzeug=True)
