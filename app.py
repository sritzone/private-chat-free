"""SR Private Chat - Flask + Socket.IO + Firebase Firestore.

Performance design
  * Auth sessions, the user directory, avatars and recent messages live in memory,
    so chat/call events never wait on Firestore.
  * Messages and reactions are persisted in the background (write-behind).
  * Avatars are served as cacheable images instead of being embedded in every message.

Security design
  * Firebase Authentication (Google provider); the Firebase ID token is verified on the server. One active login per account.
  * Groups: private, joined with an invite code. Login/group rate limits, strict avatar validation, CSP and security headers.

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
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor

from flask import Flask, Response, g, jsonify, render_template, request, url_for
from flask_socketio import SocketIO, emit, join_room, leave_room
from werkzeug.middleware.proxy_fix import ProxyFix

try:
    from flask_compress import Compress
except ImportError:  # optional speed-up
    Compress = None

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("sr-chat")

# --------------------------------------------------------------------------- config
ROOM_TITLE = (os.environ.get("ROOM_TITLE") or "Anonymous Group Chat")[:60]
SESSION_TTL_MS = 30 * 24 * 3600 * 1000      # sessions last 30 days
AUTH_RECHECK = 300                           # seconds a verified token is trusted from memory
HISTORY_SEND = 100                           # messages sent to a client on connect
CACHE_LIMIT = 200                            # messages kept in memory
MAX_AVATAR_BYTES = 300_000
FIREBASE_WEB_API_KEY = os.environ.get("FIREBASE_WEB_API_KEY", "").strip()      # Firebase console > Project settings > Web app
FIREBASE_AUTH_DOMAIN = os.environ.get("FIREBASE_AUTH_DOMAIN", "").strip()      # default: <project_id>.firebaseapp.com
FIREBASE_PROJECT_ID = os.environ.get("FIREBASE_PROJECT_ID", "").strip()
DEV_LOGIN = os.environ.get("LOCAL_DEV") == "1" and not FIREBASE_WEB_API_KEY   # local testing only
def _env_int(name, default):
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


ADMIN_EMAILS = {e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()}
TELEGRAM_ADMIN = (os.environ.get("TELEGRAM_ADMIN") or "developer_bhai").lstrip("@")
FREE_GROUPS = _env_int("FREE_GROUPS", 2)                  # groups every user may create for free
GROUP_SLOT_COST = _env_int("GROUP_SLOT_COST", 10)         # Stone for one more group slot
BASE_MEMBER_LIMIT = _env_int("BASE_MEMBER_LIMIT", 25)     # members per new group
MEMBER_EXTEND_STEP = _env_int("MEMBER_EXTEND_STEP", 25)   # extra members per purchase
MEMBER_EXTEND_COST = _env_int("MEMBER_EXTEND_COST", 10)   # Stone per purchase
MAX_MEMBER_LIMIT = _env_int("MAX_MEMBER_LIMIT", 200)
MAX_GROUPS_JOINED, MAX_PENDING = 30, 50
USERNAME_RE = re.compile(r"[a-z0-9_-]{5,20}")
LEGACY_USERNAME_RE = re.compile(r"[a-z0-9_-]{3,20}")
STONE_PACKS = (10, 25, 50, 100, 250)
GENDERS = ("male", "female", "other")
PROFILE_FIELDS = {"location": 40, "hobby": 80, "languages": 60, "occupation": 50, "bio": 160}
RESERVED_USERNAMES = {"system", "support", "root"}
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
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
        self.users, self.sessions, self.groups, self.gmsgs, self.usernames = {}, {}, {}, {}, {}

    # ---- users / sessions
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

    # ---- groups
    def create_group(self, gid, doc):
        with self.lock:
            self.groups[gid] = {**doc, "members": list(doc.get("members") or [])}
            self.gmsgs.setdefault(gid, {})

    def all_groups(self):
        with self.lock:
            return [(k, {**v, "members": list(v["members"])}) for k, v in self.groups.items()]

    def add_member(self, gid, uid):
        with self.lock:
            g = self.groups.get(gid)
            if g and uid not in g["members"]:
                g["members"].append(uid)

    def remove_member(self, gid, uid):
        with self.lock:
            g = self.groups.get(gid)
            if g and uid in g["members"]:
                g["members"].remove(uid)

    def update_group(self, gid, fields):
        with self.lock:
            if gid in self.groups:
                self.groups[gid].update(fields)

    def delete_group(self, gid):
        with self.lock:
            self.groups.pop(gid, None)
            self.gmsgs.pop(gid, None)

    # ---- usernames / pending join requests
    def claim_username(self, name, uid):
        with self.lock:
            if name in self.usernames:
                return self.usernames[name] == uid
            self.usernames[name] = uid
            return True

    def release_username(self, name):
        with self.lock:
            self.usernames.pop(name, None)

    def add_pending(self, gid, uid):
        with self.lock:
            g = self.groups.get(gid)
            if g is not None:
                p = g.setdefault("pending", [])
                if uid not in p:
                    p.append(uid)

    def remove_pending(self, gid, uid):
        with self.lock:
            g = self.groups.get(gid)
            if g is not None and uid in g.get("pending", []):
                g["pending"].remove(uid)

    # ---- messages (per group)
    def recent_messages(self, gid, limit):
        with self.lock:
            rows = sorted(self.gmsgs.get(gid, {}).values(), key=lambda m: m.get("ts", 0))[-limit:]
            return [dict(m) for m in rows]

    def add_message(self, gid, mid, data):
        with self.lock:
            self.gmsgs.setdefault(gid, {})[mid] = {"id": mid, **data}

    def set_reactions(self, gid, mid, reactions):
        with self.lock:
            m = self.gmsgs.get(gid, {}).get(mid)
            if m is not None:
                m["reactions"] = dict(reactions)

    def delete_messages_by_uid(self, gid, uid):
        with self.lock:
            box = self.gmsgs.get(gid, {})
            for mid in [i for i, m in box.items() if m.get("uid") == uid]:
                box.pop(mid, None)


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
        self.groups = self.db.collection("chat_groups")      # chat_groups/{gid}/messages/{mid}
        self.unames = self.db.collection("chat_usernames")   # unique usernames: {username: {uid}}

    def _eq(self, coll, field, value):
        try:
            from google.cloud.firestore_v1.base_query import FieldFilter
            return coll.where(filter=FieldFilter(field, "==", value))
        except ImportError:
            return coll.where(field, "==", value)

    def _msgs(self, gid):
        return self.groups.document(gid).collection("messages")

    # ---- users / sessions
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

    # ---- groups
    def create_group(self, gid, doc):
        self.groups.document(gid).set(doc)

    def all_groups(self):
        return [(d.id, d.to_dict() or {}) for d in self.groups.stream()]

    def add_member(self, gid, uid):
        self.groups.document(gid).update({"members": self.fs.ArrayUnion([uid])})

    def remove_member(self, gid, uid):
        self.groups.document(gid).update({"members": self.fs.ArrayRemove([uid])})

    def update_group(self, gid, fields):
        self.groups.document(gid).update(fields)

    def delete_group(self, gid):
        self._batch_delete(self._msgs(gid).stream())
        self.groups.document(gid).delete()

    # ---- usernames / pending join requests
    def claim_username(self, name, uid):
        ref = self.unames.document(name)

        @self.fs.transactional
        def run(tx):
            snap = ref.get(transaction=tx)
            if snap.exists:
                return (snap.to_dict() or {}).get("uid") == uid
            tx.set(ref, {"uid": uid, "ts": now_ms()})
            return True

        return run(self.db.transaction())

    def release_username(self, name):
        self.unames.document(name).delete()

    def add_pending(self, gid, uid):
        self.groups.document(gid).update({"pending": self.fs.ArrayUnion([uid])})

    def remove_pending(self, gid, uid):
        self.groups.document(gid).update({"pending": self.fs.ArrayRemove([uid])})

    # ---- messages (per group, no composite index needed)
    def recent_messages(self, gid, limit):
        out = []
        q = self._msgs(gid).order_by("ts", direction=self.fs.Query.DESCENDING).limit(limit)
        for d in q.stream():
            m = d.to_dict() or {}
            m["id"] = d.id
            out.append(m)
        out.reverse()
        return out

    def add_message(self, gid, mid, data):
        self._msgs(gid).document(mid).set(data)

    def set_reactions(self, gid, mid, reactions):
        self._msgs(gid).document(mid).update({"reactions": reactions})

    def delete_messages_by_uid(self, gid, uid):
        self._batch_delete(self._eq(self._msgs(gid), "uid", uid).stream())


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
if not FIREBASE_PROJECT_ID:
    try:
        FIREBASE_PROJECT_ID = json.loads(os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "") or "{}").get("project_id", "")
    except ValueError:
        FIREBASE_PROJECT_ID = ""
FIREBASE_AUTH_ON = bool(FIREBASE_WEB_API_KEY and store.kind == "firestore")
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


login_gate, me_gate, chat_gate, group_gate, join_gate, uname_gate, search_gate, admin_gate = (
    Limiter(), Limiter(), Limiter(), Limiter(), Limiter(), Limiter(), Limiter(), Limiter())

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
            "email": str(prof.get("email", "")), "created_at": prof.get("created_at", 0),
            "stones": int(prof.get("stones", 0) or 0), "extra_slots": int(prof.get("extra_slots", 0) or 0),
            "stone_log": list(prof.get("stone_log") or []), "show_active": prof.get("show_active", True) is not False,
            "gender": prof.get("gender", "") if prof.get("gender") in GENDERS else "",
            "location": prof.get("location", ""), "hobby": prof.get("hobby", ""), "languages": prof.get("languages", ""),
            "occupation": prof.get("occupation", ""), "bio": prof.get("bio", ""),
            "verified": bool(prof.get("verified", False)), "verify_requested": bool(prof.get("verify_requested", False)),
            "order": prof.get("order") if isinstance(prof.get("order"), dict) else None,
            "avatar_mime": mime, "avatar_raw": raw, "avatar_ver": ver}
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


def is_admin(uid):
    info = directory.get(uid) or {}
    email = (info.get("email") or "").lower()
    return bool(email and email in ADMIN_EMAILS) or bool(DEV_LOGIN and info.get("username") == "admin")


def owned_count(uid):
    with groups_lock:
        return sum(1 for gid in user_groups.get(uid, ()) if groups.get(gid, {}).get("owner") == uid)


def slot_limit(uid):
    return FREE_GROUPS + (directory.get(uid) or {}).get("extra_slots", 0)


def public_user(uid):
    info = directory[uid]
    return {"id": uid, "name": info["name"], "username": info["username"], "avatar": avatar_url(uid),
            "created_at": info["created_at"], "stones": info["stones"], "show_active": info["show_active"],
            "is_admin": is_admin(uid), "owned": owned_count(uid), "slots": slot_limit(uid),
            "verified": info["verified"], "verify_requested": info["verify_requested"], "order": info["order"],
            "gender": info["gender"], "location": info["location"], "hobby": info["hobby"], "languages": info["languages"],
            "occupation": info["occupation"], "bio": info["bio"]}


def shares_group(a_uid, b_uid):
    with groups_lock:
        return bool(user_groups.get(a_uid, set()) & user_groups.get(b_uid, set()))


def public_profile(uid):
    """What other members may see (never the email, Stone or orders)."""
    info = directory[uid]
    return {"id": uid, "name": info["name"], "username": info["username"], "avatar": avatar_url(uid),
            "verified": info["verified"], "gender": info["gender"], "location": info["location"], "hobby": info["hobby"],
            "languages": info["languages"], "occupation": info["occupation"], "bio": info["bio"],
            "created_at": info["created_at"], "online": uid in online_uids(),
            "groups": len(user_groups.get(uid, ()))}


def valid_username(u):
    return bool(USERNAME_RE.fullmatch(u)) and u not in RESERVED_USERNAMES


def make_username(name, email, uid):
    """Claim a unique username (a-z, 0-9, _ -, 5-20 chars) derived from the display name."""
    base = re.sub(r"[^a-z0-9]", "", str(name).casefold())[:14]
    if len(base) < 5:
        base = (base + re.sub(r"[^a-z0-9]", "", str(email).split("@")[0].casefold()))[:14]
    if len(base) < 5:
        base = (base or "user") + "".join(secrets.choice("0123456789") for _ in range(5 - len(base or "user")))
    for attempt in range(40):
        digits = 0 if attempt == 0 else 2 + attempt // 10
        cand = base[:20 - digits] + "".join(secrets.choice("0123456789") for _ in range(digits))
        if valid_username(cand) and store.claim_username(cand, uid):
            return cand
    cand = "user" + secrets.token_hex(6)
    store.claim_username(cand, uid)
    return cand


wallet_lock = threading.RLock()


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


# --------------------------------------------------------------------------- groups + message cache
groups = {}                                    # gid -> {"id","name","code","owner","members":[uid],"created_at"}
group_by_code = {}                             # invite code -> gid
user_groups = collections.defaultdict(set)     # uid -> {gid}
groups_lock = threading.RLock()
gmsgs = {}                                     # gid -> {"recent": deque, "by_id": {}, "loaded": bool, "lock": RLock}


def room(gid):
    return "g:" + gid


def new_code():
    while True:
        c = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
        if c not in group_by_code:
            return c


def _set_group_avatar(g, data_url):
    parsed = decode_avatar(data_url or "")
    g["avatar"] = data_url if parsed else ""
    g["avatar_ver"] = hashlib.sha1(parsed[1]).hexdigest()[:10] if parsed else ""
    g["avatar_mime"], g["avatar_raw"] = parsed if parsed else (None, None)


def register_group(gid, doc):
    g = {"id": gid, "name": doc.get("name", "Group"), "code": doc.get("code", ""), "owner": doc.get("owner", ""),
         "members": list(doc.get("members") or []), "created_at": doc.get("created_at", 0),
         "approval": bool(doc.get("approval", False)), "public": doc.get("public", True) is not False,
         "member_limit": int(doc.get("member_limit") or BASE_MEMBER_LIMIT), "pending": list(doc.get("pending") or [])}
    _set_group_avatar(g, doc.get("avatar") or "")
    with groups_lock:
        groups[gid] = g
        if g["code"]:
            group_by_code[g["code"]] = gid
        for u in g["members"]:
            user_groups[u].add(gid)
    return g


def member_add(gid, uid):
    store.add_member(gid, uid)
    with groups_lock:
        g = groups[gid]
        if uid not in g["members"]:
            g["members"].append(uid)
        user_groups[uid].add(gid)


def member_remove(gid, uid):
    """Remove uid from a group. Empty groups are deleted; ownership passes on. True if the group still exists."""
    with groups_lock:
        g = groups.get(gid)
        if not g:
            return False
        members = [m for m in g["members"] if m != uid]
        owner = g["owner"]
    if not members:
        store.delete_group(gid)
        with groups_lock:
            groups.pop(gid, None)
            group_by_code.pop(g["code"], None)
            user_groups[uid].discard(gid)
            gmsgs.pop(gid, None)
        return False
    store.remove_member(gid, uid)
    new_owner = members[0] if owner == uid else owner
    if new_owner != owner:
        store.update_group(gid, {"owner": new_owner})
    with groups_lock:
        g["members"], g["owner"] = members, new_owner
        user_groups[uid].discard(gid)
    return True


def gbucket(gid):
    with groups_lock:
        b = gmsgs.get(gid)
        if b is None:
            b = gmsgs[gid] = {"recent": collections.deque(), "by_id": {}, "loaded": False, "lock": threading.RLock()}
    return b


def _put(b, m):
    if m["id"] in b["by_id"]:
        return
    if len(b["recent"]) >= CACHE_LIMIT:
        b["by_id"].pop(b["recent"].popleft()["id"], None)
    b["recent"].append(m)
    b["by_id"][m["id"]] = m


def ensure_loaded(gid):
    b = gbucket(gid)
    if b["loaded"]:
        return b
    with b["lock"]:
        if not b["loaded"]:
            try:
                for m in store.recent_messages(gid, CACHE_LIMIT):
                    _put(b, m)
                b["loaded"] = True
            except Exception:
                log.exception("loading messages for group %s failed", gid)
    return b


def cache_add(gid, m):
    b = ensure_loaded(gid)
    with b["lock"]:
        _put(b, m)


def cache_remove(gid, mid):
    b = gbucket(gid)
    with b["lock"]:
        m = b["by_id"].pop(mid, None)
        if m is not None:
            try:
                b["recent"].remove(m)
            except ValueError:
                pass


def cache_remove_uid(gid, uid):
    b = gbucket(gid)
    with b["lock"]:
        keep = [m for m in b["recent"] if m.get("uid") != uid]
        b["recent"].clear()
        b["by_id"].clear()
        for m in keep:
            _put(b, m)


def msg_out(gid, m):
    uid = m.get("uid", "")
    info = directory.get(uid) if uid != "system" else None
    src = info or m
    return {"id": m["id"], "gid": gid, "uid": uid, "name": src.get("name", ""), "username": src.get("username", ""),
            "text": m.get("text", ""), "ts": m.get("ts", 0), "kind": m.get("kind", "user"),
            "avatar": avatar_url(uid) if info else "", "verified": bool(info and info.get("verified")),
            "reactions": m.get("reactions") or {},
            "reply_to": m.get("reply_to")}


def history_payload(gid):
    b = ensure_loaded(gid)
    with b["lock"]:
        rows = list(b["recent"])[-HISTORY_SEND:]
    return [msg_out(gid, m) for m in rows]


def last_preview(gid):
    b = ensure_loaded(gid)
    with b["lock"]:
        m = b["recent"][-1] if b["recent"] else None
    if not m:
        return None
    return {"text": str(m.get("text", ""))[:80], "name": m.get("name", ""), "uid": m.get("uid", ""), "ts": m.get("ts", 0), "kind": m.get("kind", "user")}


def group_avatar_url(g):
    return "/gavatar/%s?v=%s" % (g["id"], g["avatar_ver"]) if g.get("avatar_raw") else ""


# --------------------------------------------------------------------------- realtime state
online = {}             # sid -> {"uid","token"}
online_lock = threading.RLock()
calls = {}              # gid -> {"sids": set, "media": {sid: {"mic","cam"}}, "started": ms, "starter": uid}
sid_call = {}           # sid -> gid  (a socket is in at most one call)


def call_payload(gid):
    with online_lock:
        c = calls.get(gid)
        if not c or not c["sids"]:
            return {"active": False, "participants": 0, "started_by": "", "started_at": 0, "uids": []}
        uids = [(online.get(s) or {}).get("uid") for s in c["sids"]]
        starter, started = c.get("starter"), c.get("started") or 0
    return {"active": True, "participants": len(uids), "started_at": started,
            "started_by": (directory.get(starter) or {}).get("name", "A member"), "uids": [u for u in uids if u]}


def online_uids():
    """Online people who have not hidden their active status."""
    with online_lock:
        uids = {u["uid"] for u in online.values()}
    return {u for u in uids if (directory.get(u) or {}).get("show_active", True)}


def sids_of(uid):
    with online_lock:
        return [s for s, u in online.items() if u["uid"] == uid]


def enter_user_rooms(uid, gid):
    for sid in sids_of(uid):
        socketio.server.enter_room(sid, room(gid), namespace="/")


def group_public(gid):
    g = groups[gid]
    members = []
    for uid in g["members"]:
        info = directory.get(uid) or info_for(uid)
        if info:
            members.append({"id": uid, "name": info["name"], "username": info["username"], "avatar": avatar_url(uid),
                            "verified": info["verified"]})
    on = online_uids()
    return {"id": gid, "name": g["name"], "code": g["code"], "owner": g["owner"], "created_at": g["created_at"],
            "avatar": group_avatar_url(g), "approval": g["approval"], "public": g["public"],
            "member_limit": g["member_limit"], "pending_count": len(g["pending"]),
            "members": members, "online": [u for u in g["members"] if u in on],
            "call": call_payload(gid), "last": last_preview(gid)}


def emit_group(gid):
    if gid in groups:
        socketio.emit("group_updated", group_public(gid), to=room(gid))


def emit_group_presence(gid):
    g = groups.get(gid)
    if not g:
        return
    on = online_uids()
    socketio.emit("group_presence", {"gid": gid, "online": [u for u in g["members"] if u in on],
                                     "call": call_payload(gid)}, to=room(gid))


def emit_user_presence(uid):
    for gid in list(user_groups.get(uid, ())):
        emit_group_presence(gid)


def peer_profile(sid, gid):
    uid = (online.get(sid) or {}).get("uid", "")
    info = directory.get(uid) or {}
    st = ((calls.get(gid) or {}).get("media") or {}).get(sid) or {}
    return {"uid": uid, "name": info.get("name", "Participant"), "avatar": avatar_url(uid),
            "mic": st.get("mic", True), "cam": st.get("cam", True)}


def system_message(gid, text):
    m = {"id": secrets.token_hex(10), "uid": "system", "name": "SR Chat", "username": "system",
         "text": text, "ts": now_ms(), "kind": "system"}
    cache_add(gid, m)
    socketio.emit("new_message", msg_out(gid, m), to=room(gid))
    run_bg(io_pool, store.add_message, gid, m["id"], {k: v for k, v in m.items() if k != "id"})


def leave_call(sid, uid):
    """Take a socket out of its call (if any) and tell the group. Safe to call twice."""
    with online_lock:
        gid = sid_call.pop(sid, None)
        if not gid:
            return False
        c = calls.get(gid)
        peers = []
        if c:
            c["sids"].discard(sid)
            c["media"].pop(sid, None)
            peers = list(c["sids"])
            if not peers:
                calls.pop(gid, None)
    name = (directory.get(uid) or {}).get("name", "A member")
    if gid in groups:
        system_message(gid, "%s ended the call" % name if not peers else "%s left the call" % name)
    for p in peers:
        socketio.emit("video_peer_left", {"sid": sid, "gid": gid}, to=p)
    emit_group_presence(gid)
    return True


def drop_sid(sid):
    """Forget a socket and leave any call. Safe to call more than once."""
    with online_lock:
        user = online.pop(sid, None)
    leave_call(sid, (user or {}).get("uid"))
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
        emit_user_presence(uid)


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


def member_gid(sender, data):
    """The group id in `data`, only if the sender belongs to that group."""
    gid = str((data or {}).get("gid") or "")[:40]
    g = groups.get(gid)
    return gid if g and sender["uid"] in g["members"] else None


def stone_change(uid, delta=None, set_to=None, why=""):
    """Add/remove Stone (delta) or set an exact balance. Raises ValueError when the balance would go below 0."""
    with wallet_lock:
        info = directory[uid]
        cur = info["stones"]
        new = cur + delta if delta is not None else int(set_to)
        if new < 0:
            raise ValueError("Not enough Stone")
        entry = {"ts": now_ms(), "delta": new - cur, "balance": new, "why": str(why)[:60]}
        log = (info.get("stone_log") or [])[-29:] + [entry]
        store.update_user(info["key"], {"stones": new, "stone_log": log})
        info["stones"], info["stone_log"] = new, log
    push_wallet(uid)
    return new


def push_wallet(uid):
    me_ = public_user(uid)
    for sid in sids_of(uid):
        socketio.emit("wallet_updated", {k: me_[k] for k in ("stones", "owned", "slots", "verified", "verify_requested", "order")}, to=sid)


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
                "default-src 'self'; script-src 'self' 'nonce-%s' https://www.gstatic.com/firebasejs/ https://apis.google.com; "
                "style-src 'self' 'unsafe-inline'; "
                "img-src 'self' data: blob:; media-src 'self' blob:; "
                "connect-src 'self' ws: wss: https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com; "
                "frame-src https://*.firebaseapp.com https://accounts.google.com; "
                "font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" % nonce)
    return resp


# --------------------------------------------------------------------------- HTTP routes
@app.get("/")
def home():
    g.nonce = secrets.token_urlsafe(12)
    boot = {"title": ROOM_TITLE, "rtc": rtc_config(), "reactions": list(REACTIONS),
            "firebase": ({"apiKey": FIREBASE_WEB_API_KEY, "projectId": FIREBASE_PROJECT_ID,
                          "authDomain": FIREBASE_AUTH_DOMAIN or ("%s.firebaseapp.com" % FIREBASE_PROJECT_ID)} if FIREBASE_AUTH_ON else None),
            "dev_login": DEV_LOGIN, "telegram": TELEGRAM_ADMIN, "packs": list(STONE_PACKS),
            "limits": {"free_groups": FREE_GROUPS, "slot_cost": GROUP_SLOT_COST, "base_members": BASE_MEMBER_LIMIT,
                       "members_step": MEMBER_EXTEND_STEP, "members_cost": MEMBER_EXTEND_COST, "max_members": MAX_MEMBER_LIMIT}}
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


@app.get("/gavatar/<gid>")
def group_avatar(gid):
    g = groups.get(gid[:40])
    if not g or not g.get("avatar_raw"):
        return Response(status=404, headers={"Cache-Control": "public, max-age=60"})
    etag = '"%s"' % g["avatar_ver"]
    if request.headers.get("If-None-Match") == etag:
        return Response(status=304, headers={"ETag": etag})
    resp = Response(g["avatar_raw"], mimetype=g["avatar_mime"])
    resp.headers["ETag"] = etag
    resp.headers["Cache-Control"] = ("public, max-age=31536000, immutable"
                                     if request.args.get("v") == g["avatar_ver"] else "public, max-age=60")
    resp.headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
    return resp


def verify_firebase(id_token):
    """Verify a Firebase Authentication ID token (Google provider) and return its claims."""
    from firebase_admin import auth
    info = auth.verify_id_token(id_token)
    if (info.get("firebase") or {}).get("sign_in_provider") != "google.com":
        raise ValueError("not a Google sign-in")
    if not info.get("email_verified"):
        raise ValueError("email not verified")
    return info


def fetch_google_avatar(url):
    """Best-effort copy of the Google profile photo (validated like any uploaded avatar)."""
    try:
        u = urllib.parse.urlparse(url)
        if u.scheme != "https" or not (u.hostname or "").endswith(".googleusercontent.com"):
            return ""
        req = urllib.request.Request(url, headers={"User-Agent": "sr-chat"})
        with urllib.request.urlopen(req, timeout=4) as r:
            raw = r.read(MAX_AVATAR_BYTES + 1)
            mime = r.headers.get_content_type()
        if mime not in ("image/jpeg", "image/png", "image/webp"):
            return ""
        data_url = "data:%s;base64,%s" % (mime, base64.b64encode(raw).decode())
        return data_url if decode_avatar(data_url) else ""
    except Exception:
        return ""


def finish_login(key, name, email="", picture=""):
    prof = store.get_user(key)
    if not prof:
        uid = uuid.uuid4().hex
        username = make_username(name, email, uid)
        prof = {"uid": uid, "name": name[:40] or "Member", "username": username, "email": email,
                "created_at": now_ms(), "stones": 0, "show_active": True}
        avatar_data = fetch_google_avatar(picture) if picture else ""
        if avatar_data:
            prof["avatar"] = avatar_data
        if not store.create_user(key, prof):
            store.release_username(username)
            prof = store.get_user(key) or prof
    else:
        uid = prof.get("uid") or key
        fix = {}
        if not LEGACY_USERNAME_RE.fullmatch(str(prof.get("username") or "")):      # accounts made before usernames existed
            fix["username"] = make_username(prof.get("name") or name, email, uid)
        if email and prof.get("email") != email:
            fix["email"] = email
        if fix:
            store.update_user(key, fix)
            prof.update(fix)
    dir_put(key, prof)
    token = make_session(uid, key)
    return jsonify(token=token, me=public_user(uid))


@app.post("/api/google")
def google_login():
    """Body: {credential: <Firebase ID token>} obtained after signInWithPopup(GoogleAuthProvider)."""
    if not login_gate.hit("g|" + (request.remote_addr or "?"), 20, 300):
        return api_error("Too many attempts. Please wait a few minutes and try again.", 429)
    if not FIREBASE_AUTH_ON:
        return api_error("Google sign-in is not configured on this server.", 503)
    cred = str(body().get("credential") or "")
    if not cred or len(cred) > 8192:
        return api_error("Google sign-in failed. Please try again.", 401)
    try:
        info = verify_firebase(cred)
    except Exception as exc:
        log.info("firebase token rejected: %s", exc)
        return api_error("Google sign-in failed. Please try again.", 401)
    email = str(info.get("email") or "")
    name = clean_spaces(info.get("name")) or re.sub(r"[^A-Za-z0-9_.]", "", email.split("@")[0])[:20] or "Member"
    return finish_login("fb_" + str(info["uid"]), name, email, str(info.get("picture") or ""))


@app.post("/api/dev-login")
def dev_login():
    """Local testing only (LOCAL_DEV=1 and no FIREBASE_WEB_API_KEY). Never available in production."""
    if not DEV_LOGIN:
        return api_error("Not found", 404)
    name = clean_spaces(body().get("name"))[:40]
    slug = re.sub(r"[^a-z0-9]", "", name.casefold())[:30]
    if not slug:
        return api_error("Enter a name")
    return finish_login("dev_" + slug, name)


@app.post("/api/me")
def me():
    if not me_gate.hit(request.remote_addr or "?", 120, 60):
        return api_error("Too many requests", 429)
    e = resolve_token(body().get("token"))
    if not e or e["uid"] not in directory:
        return api_error("Session expired. Please sign in again.", 401)
    return jsonify(me=public_user(e["uid"]))


def broadcast_profile(uid):
    info = directory[uid]
    payload = {"id": uid, "name": info["name"], "username": info["username"], "avatar": avatar_url(uid), "verified": info["verified"]}
    for gid in list(user_groups.get(uid, ())):
        socketio.emit("profile_updated", payload, to=room(gid))


@app.post("/api/profile")
def update_profile():
    d = body()
    e = resolve_token(d.get("token"))
    if not e:
        return api_error("Session expired. Please sign in again.", 401)
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
    if "show_active" in d:
        fields["show_active"] = bool(d.get("show_active"))
    if "gender" in d:
        g_ = str(d.get("gender") or "").lower()
        if g_ and g_ not in GENDERS:
            return api_error("Choose a valid gender option.")
        fields["gender"] = g_
    for k_, limit_ in PROFILE_FIELDS.items():
        if k_ in d:
            v_ = clean_spaces(d.get(k_))
            if len(v_) > limit_:
                return api_error("%s is too long (maximum %d characters)." % (k_.capitalize(), limit_))
            fields[k_] = v_
    old_username = info["username"]
    if "username" in d:
        new = str(d.get("username") or "").strip().lower()
        if not valid_username(new):
            return api_error("Username must be 5-20 characters: small letters, numbers, _ or -")
        if new != old_username:
            if not uname_gate.hit(uid, 5, 3600):
                return api_error("You changed your username too many times. Try again later.", 429)
            if not store.claim_username(new, uid):
                return api_error("That username is already taken.")
            fields["username"] = new
    if not fields:
        return jsonify(me=public_user(uid))
    try:
        store.update_user(key, fields)
    except Exception:
        if fields.get("username"):
            store.release_username(fields["username"])
        raise
    if fields.get("username") and old_username and old_username != fields["username"]:
        try:
            store.release_username(old_username)
        except Exception:
            log.exception("releasing old username failed")
    with dir_lock:
        for k in ("name", "show_active", "username", "gender", *PROFILE_FIELDS):
            if k in fields:
                info[k] = fields[k]
        if "avatar" in fields:
            parsed = decode_avatar(fields["avatar"])
            info["avatar_mime"], info["avatar_raw"] = parsed if parsed else (None, None)
            info["avatar_ver"] = hashlib.sha1(info["avatar_raw"]).hexdigest()[:10] if parsed else ""
    broadcast_profile(uid)
    if "show_active" in fields:
        emit_user_presence(uid)
    return jsonify(me=public_user(uid))


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
        return api_error("Session expired. Please sign in again.", 401)
    if str(d.get("confirm") or "").strip() != "DELETE":
        return api_error('Type DELETE to confirm')
    uid, key = e["uid"], e["key"]
    kick_account(uid, "deleted")
    with groups_lock:
        waiting = [gid for gid, g in groups.items() if uid in g["pending"]]
    for gid in waiting:
        try:
            store.remove_pending(gid, uid)
        except Exception:
            log.exception("removing pending request failed")
        with groups_lock:
            if uid in groups[gid]["pending"]:
                groups[gid]["pending"].remove(uid)
    old_username = (directory.get(uid) or {}).get("username")
    for gid in list(user_groups.get(uid, ())):
        try:
            store.delete_messages_by_uid(gid, uid)
        except Exception:
            log.exception("deleting messages failed")
        cache_remove_uid(gid, uid)
        socketio.emit("messages_removed", {"gid": gid, "uid": uid}, to=room(gid))
        if member_remove(gid, uid):
            emit_group(gid)
    user_groups.pop(uid, None)
    store.delete_sessions_for_key(key)
    store.delete_user(key)
    if old_username:
        try:
            store.release_username(old_username)
        except Exception:
            log.exception("releasing username failed")
    revoke_account_tokens(key)
    with dir_lock:
        directory.pop(uid, None)
        missing_uids.add(uid)
    return jsonify(ok=True)


def _auth_json():
    d = body()
    e = resolve_token(d.get("token"))
    if not e or e["uid"] not in directory:
        return d, None
    return d, e["uid"]


@app.post("/api/wallet")
def wallet():
    d, uid = _auth_json()
    if not uid:
        return api_error("Session expired. Please sign in again.", 401)
    log_rows = list(reversed((directory[uid].get("stone_log") or [])[-15:]))
    return jsonify(me=public_user(uid), log=log_rows)


@app.post("/api/buy-slot")
def buy_slot():
    d, uid = _auth_json()
    if not uid:
        return api_error("Session expired. Please sign in again.", 401)
    try:
        stone_change(uid, delta=-GROUP_SLOT_COST, why="Group slot")
    except ValueError:
        return api_error("Not enough Stone. You need %d Stone." % GROUP_SLOT_COST, 402)
    info = directory[uid]
    info["extra_slots"] += 1
    store.update_user(info["key"], {"extra_slots": info["extra_slots"]})
    push_wallet(uid)
    return jsonify(me=public_user(uid))


@app.post("/api/extend-members")
def extend_members():
    d, uid = _auth_json()
    if not uid:
        return api_error("Session expired. Please sign in again.", 401)
    gid = str(d.get("gid") or "")[:40]
    g = groups.get(gid)
    if not g or g["owner"] != uid:
        return api_error("Only the group owner can do this.", 403)
    if g["member_limit"] >= MAX_MEMBER_LIMIT:
        return api_error("This group is already at the maximum size (%d)." % MAX_MEMBER_LIMIT)
    try:
        stone_change(uid, delta=-MEMBER_EXTEND_COST, why="Members +%d (%s)" % (MEMBER_EXTEND_STEP, g["name"][:20]))
    except ValueError:
        return api_error("Not enough Stone. You need %d Stone." % MEMBER_EXTEND_COST, 402)
    new_limit = min(MAX_MEMBER_LIMIT, g["member_limit"] + MEMBER_EXTEND_STEP)
    store.update_group(gid, {"member_limit": new_limit})
    g["member_limit"] = new_limit
    emit_group(gid)
    return jsonify(me=public_user(uid), group=group_public(gid))


@app.post("/api/user")
def view_user():
    d, uid = _auth_json()
    if not uid:
        return api_error("Session expired. Please sign in again.", 401)
    target = str(d.get("uid") or "")[:64]
    if target not in directory:
        return api_error("User not found", 404)
    allowed = target == uid or is_admin(uid) or shares_group(uid, target)
    if not allowed:
        with groups_lock:
            allowed = any(groups[g_]["owner"] == uid and target in groups[g_]["pending"] for g_ in user_groups.get(uid, ()) if g_ in groups)
    if not allowed:
        return api_error("You can only view profiles of people in your groups.", 403)
    return jsonify(profile=public_profile(target))


@app.post("/api/stone-order")
def stone_order():
    d, uid = _auth_json()
    if not uid:
        return api_error("Session expired. Please sign in again.", 401)
    try:
        pack = int(d.get("pack"))
    except (TypeError, ValueError):
        pack = 0
    if pack not in STONE_PACKS:
        return api_error("Choose a valid pack.")
    info = directory[uid]
    info["order"] = {"pack": pack, "ts": now_ms()}
    store.update_user(info["key"], {"order": info["order"]})
    return jsonify(me=public_user(uid))


@app.post("/api/verify-request")
def verify_request():
    d, uid = _auth_json()
    if not uid:
        return api_error("Session expired. Please sign in again.", 401)
    info = directory[uid]
    if info["verified"]:
        return api_error("Your account is already verified.")
    info["verify_requested"] = True
    store.update_user(info["key"], {"verify_requested": True})
    return jsonify(me=public_user(uid))


def _admin_uid():
    d, uid = _auth_json()
    if not uid:
        return d, None, api_error("Session expired. Please sign in again.", 401)
    if not is_admin(uid):
        return d, None, api_error("Admin access only.", 403)
    if not admin_gate.hit(uid, 120, 60):
        return d, None, api_error("Too many requests", 429)
    return d, uid, None


def _admin_row(info):
    return {"id": info["uid"], "name": info["name"], "username": info["username"], "email": info.get("email", ""),
            "avatar": avatar_url(info["uid"]), "stones": info["stones"], "groups": len(user_groups.get(info["uid"], ())),
            "verified": info["verified"], "verify_requested": info["verify_requested"], "order": info["order"],
            "created_at": info["created_at"]}


@app.post("/api/admin/users")
def admin_users():
    d, uid, err = _admin_uid()
    if err:
        return err
    q = clean_spaces(d.get("q")).casefold().lstrip("@")[:60]
    flt = str(d.get("filter") or "all")
    with dir_lock:
        rows = list(directory.values())
    if flt == "verified":
        rows = [i for i in rows if i["verified"]]
    elif flt == "pending":
        rows = [i for i in rows if i["order"] or i["verify_requested"]]
    if q:
        rows = [i for i in rows if q in i["name"].casefold() or q in i["username"] or q in i.get("email", "").casefold()]
    rows.sort(key=lambda i: (i["name"].casefold(), i["username"]))
    return jsonify(total=len(rows), users=[_admin_row(i) for i in rows[:40]])


@app.post("/api/admin/overview")
def admin_overview():
    d, uid, err = _admin_uid()
    if err:
        return err
    with dir_lock:
        rows = list(directory.values())
    orders = sorted((i for i in rows if i["order"]), key=lambda i: i["order"]["ts"])
    reqs = [i for i in rows if i["verify_requested"] and not i["verified"]]
    return jsonify(stats={"users": len(rows), "verified": sum(1 for i in rows if i["verified"]),
                          "stones": sum(i["stones"] for i in rows), "groups": len(groups), "online": len(online_uids())},
                   orders=[_admin_row(i) for i in orders], requests=[_admin_row(i) for i in reqs])


@app.post("/api/admin/verify")
def admin_verify():
    d, uid, err = _admin_uid()
    if err:
        return err
    target = str(d.get("uid") or "")[:64]
    if target not in directory:
        return api_error("User not found", 404)
    info = directory[target]
    on = bool(d.get("verified"))
    info["verified"], info["verify_requested"] = on, False
    store.update_user(info["key"], {"verified": on, "verify_requested": False})
    broadcast_profile(target)
    push_wallet(target)
    log.info("admin %s: verified=%s for %s", directory[uid]["username"], on, info["username"])
    return jsonify(user=_admin_row(info))


@app.post("/api/admin/dismiss")
def admin_dismiss():
    d, uid, err = _admin_uid()
    if err:
        return err
    target = str(d.get("uid") or "")[:64]
    if target not in directory:
        return api_error("User not found", 404)
    info, what = directory[target], d.get("what")
    if what == "order":
        info["order"] = None
        store.update_user(info["key"], {"order": None})
    elif what == "verify":
        info["verify_requested"] = False
        store.update_user(info["key"], {"verify_requested": False})
    push_wallet(target)
    return jsonify(user=_admin_row(info))


@app.post("/api/admin/stone")
def admin_stone():
    d, uid, err = _admin_uid()
    if err:
        return err
    target = str(d.get("uid") or "")[:64]
    if target not in directory:
        return api_error("User not found", 404)
    op = d.get("op")
    try:
        amount = int(d.get("amount"))
    except (TypeError, ValueError):
        return api_error("Enter a whole number.")
    if abs(amount) > 1_000_000 or op not in ("add", "set"):
        return api_error("Invalid amount.")
    note = clean_spaces(d.get("note"))[:30]
    why = "Admin " + ("adjustment" if op == "add" else "set") + (" - " + note if note else "")
    if d.get("fulfil_order") and directory[target]["order"]:
        why = "Purchase: %d Stone" % directory[target]["order"]["pack"]
    try:
        if op == "add":
            stone_change(target, delta=amount, why=why)
        else:
            if amount < 0:
                return api_error("Balance cannot be negative.")
            stone_change(target, set_to=amount, why=why)
    except ValueError:
        return api_error("This would make the balance negative.")
    if d.get("fulfil_order") and directory[target]["order"]:
        directory[target]["order"] = None
        store.update_user(directory[target]["key"], {"order": None})
        push_wallet(target)
    log.info("admin %s: %s %s %s -> %s", directory[uid]["username"], op, amount, directory[target]["username"], directory[target]["stones"])
    return jsonify(user=_admin_row(directory[target]))


# --------------------------------------------------------------------------- Socket.IO events
@socketio.on("connect")
def on_connect(auth=None):
    token = (auth or {}).get("token") if isinstance(auth, dict) else None
    e = resolve_token(token)
    if not e or e["uid"] not in directory:
        return False
    uid = e["uid"]
    kick_account(uid, "other_tab")      # newest tab/device wins
    with online_lock:
        online[request.sid] = {"uid": uid, "token": token}
    gids = list(user_groups.get(uid, ()))
    for gid in gids:
        join_room(room(gid))
    rows = [group_public(gid) for gid in gids if gid in groups]
    rows.sort(key=lambda r: (r["last"] or {}).get("ts", r["created_at"]), reverse=True)
    emit("groups_state", {"groups": rows})
    emit_user_presence(uid)


@socketio.on("disconnect")
def on_disconnect(*args):
    user = drop_sid(request.sid)
    if user:
        emit_user_presence(user["uid"])


def _fail(msg, code=None):
    return {"ok": False, "error": msg, **({"code": code} if code else {})}


def join_or_request(uid, gid):
    """Join a group, or ask its owner when approval is on. Returns an ack dict."""
    g = groups[gid]
    if uid in g["members"]:
        return {"ok": True, "status": "member", "group": group_public(gid)}
    if len(g["members"]) >= g["member_limit"]:
        return _fail("This group is full.")
    if len(user_groups.get(uid, ())) >= MAX_GROUPS_JOINED:
        return _fail("You have reached the group limit.")
    if g["approval"]:
        if uid in g["pending"]:
            return {"ok": True, "status": "pending", "name": g["name"]}
        if len(g["pending"]) >= MAX_PENDING:
            return _fail("This group has too many pending requests. Try again later.")
        store.add_pending(gid, uid)
        with groups_lock:
            g["pending"].append(uid)
        info = directory.get(uid) or {}
        for sid in sids_of(g["owner"]):
            socketio.emit("join_request", {"gid": gid, "group": g["name"], "name": info.get("name", "Someone")}, to=sid)
        emit_group(gid)
        return {"ok": True, "status": "pending", "name": g["name"]}
    member_add(gid, uid)
    enter_user_rooms(uid, gid)
    emit_group(gid)
    return {"ok": True, "status": "joined", "group": group_public(gid)}


@socketio.on("create_group")
def on_create_group(data=None):
    u = current_socket_user()
    if not u:
        return _fail("Session expired. Please sign in again.")
    uid = u["uid"]
    name = clean_spaces((data or {}).get("name") if isinstance(data, dict) else "")
    if not name or len(name) > 40:
        return _fail("Group name is required (maximum 40 characters).")
    if not group_gate.hit(uid, 6, 60):
        return _fail("Please wait a moment before creating another group.")
    with groups_lock:
        if owned_count(uid) >= slot_limit(uid):
            return _fail("You can create %d groups for free. Unlock one more group slot with %d Stone." % (FREE_GROUPS, GROUP_SLOT_COST), "slots")
        gid, code = uuid.uuid4().hex, new_code()
    doc = {"name": name, "code": code, "owner": uid, "members": [uid], "created_at": now_ms(),
           "approval": bool((data or {}).get("approval")) if isinstance(data, dict) else False, "public": True,
           "member_limit": BASE_MEMBER_LIMIT, "pending": []}
    try:
        store.create_group(gid, doc)
    except Exception:
        log.exception("create_group failed")
        return _fail("Could not create the group. Please try again.")
    register_group(gid, doc)
    join_room(room(gid))
    return {"ok": True, "group": group_public(gid), "me": public_user(uid)}


@socketio.on("join_group")
def on_join_group(data=None):
    u = current_socket_user()
    if not u:
        return _fail("Session expired. Please sign in again.")
    uid = u["uid"]
    if not join_gate.hit(uid, 8, 60):
        return _fail("Too many attempts. Please wait a minute.")
    raw = (data or {}).get("code") if isinstance(data, dict) else ""
    code = re.sub(r"[^A-Za-z0-9]", "", str(raw or "")).upper()[:12]
    gid = group_by_code.get(code)
    if not code or not gid or gid not in groups:
        return _fail("No group found with that invite code.")
    try:
        return join_or_request(uid, gid)
    except Exception:
        log.exception("join_group failed")
        return _fail("Could not join the group. Please try again.")


@socketio.on("request_join")
def on_request_join(data=None):
    """Join (or ask to join) a group found through search."""
    u = current_socket_user()
    if not u:
        return _fail("Session expired. Please sign in again.")
    uid = u["uid"]
    if not join_gate.hit(uid, 8, 60):
        return _fail("Too many attempts. Please wait a minute.")
    gid = str((data or {}).get("gid") or "")[:40] if isinstance(data, dict) else ""
    g = groups.get(gid)
    if not g or (not g["public"] and uid not in g["members"]):
        return _fail("This group was not found.")
    try:
        return join_or_request(uid, gid)
    except Exception:
        log.exception("request_join failed")
        return _fail("Could not send the request. Please try again.")


@socketio.on("search_groups")
def on_search_groups(data=None):
    u = current_socket_user()
    if not u:
        return _fail("Session expired. Please sign in again.")
    uid = u["uid"]
    q = clean_spaces((data or {}).get("q") if isinstance(data, dict) else "")[:40].casefold()
    if len(q) < 2:
        return {"ok": True, "results": []}
    if not search_gate.hit(uid, 40, 60):
        return _fail("Too many searches. Please wait a moment.")
    with groups_lock:
        items = list(groups.values())
    out = []
    for g in items:
        if q not in g["name"].casefold() or (not g["public"] and uid not in g["members"]):
            continue
        if uid in g["members"]:
            status = "member"
        elif uid in g["pending"]:
            status = "pending"
        elif len(g["members"]) >= g["member_limit"]:
            status = "full"
        else:
            status = "approval" if g["approval"] else "open"
        out.append({"id": g["id"], "name": g["name"], "avatar": group_avatar_url(g), "members": len(g["members"]),
                    "limit": g["member_limit"], "status": status})
    out.sort(key=lambda r: (not r["name"].casefold().startswith(q), -r["members"], r["name"].casefold()))
    return {"ok": True, "results": out[:20]}


def _owner_group(data):
    """(user, gid) when the caller is the owner of the group named in `data`; otherwise (None, error-ack)."""
    u = current_socket_user()
    if not u:
        return None, _fail("Session expired. Please sign in again.")
    gid = str((data or {}).get("gid") or "")[:40] if isinstance(data, dict) else ""
    g = groups.get(gid)
    if not g or g["owner"] != u["uid"]:
        return None, _fail("Only the group owner can do this.")
    return (u, gid), None


@socketio.on("get_requests")
def on_get_requests(data=None):
    ctx, err = _owner_group(data)
    if err:
        return err
    gid = ctx[1]
    rows = []
    for uid in list(groups[gid]["pending"]):
        info = directory.get(uid) or info_for(uid)
        if info:
            rows.append({"id": uid, "name": info["name"], "username": info["username"], "avatar": avatar_url(uid),
                         "verified": info["verified"]})
    return {"ok": True, "requests": rows}


@socketio.on("resolve_request")
def on_resolve_request(data=None):
    ctx, err = _owner_group(data)
    if err:
        return err
    gid = ctx[1]
    g = groups[gid]
    target = str((data or {}).get("uid") or "")[:64]
    approve = bool((data or {}).get("approve"))
    if target not in g["pending"]:
        return {"ok": True}
    if approve and len(g["members"]) >= g["member_limit"]:
        return _fail("The group is full. Extend the member limit first.", "full")
    try:
        store.remove_pending(gid, target)
        with groups_lock:
            if target in g["pending"]:
                g["pending"].remove(target)
        if approve:
            member_add(gid, target)
            enter_user_rooms(target, gid)
    except Exception:
        log.exception("resolve_request failed")
        return _fail("Could not update the request. Please try again.")
    for sid in sids_of(target):
        if approve:
            socketio.emit("group_joined", group_public(gid), to=sid)
        else:
            socketio.emit("join_declined", {"gid": gid, "name": g["name"]}, to=sid)
    emit_group(gid)
    return {"ok": True}


@socketio.on("update_group")
def on_update_group(data=None):
    ctx, err = _owner_group(data)
    if err:
        return err
    gid = ctx[1]
    g = groups[gid]
    d = data
    fields = {}
    if "name" in d:
        name = clean_spaces(d.get("name"))
        if not name or len(name) > 40:
            return _fail("Group name is required (maximum 40 characters).")
        fields["name"] = name
    if "avatar" in d:
        av = str(d.get("avatar") or "")
        if av and (len(av) > 420000 or not decode_avatar(av)):
            return _fail("Group logo must be a JPG, PNG or WebP image under 300 KB.")
        fields["avatar"] = av
    for k in ("approval", "public"):
        if k in d:
            fields[k] = bool(d.get(k))
    if fields:
        try:
            store.update_group(gid, fields)
        except Exception:
            log.exception("update_group failed")
            return _fail("Could not save the changes. Please try again.")
        with groups_lock:
            for k, v in fields.items():
                if k == "avatar":
                    _set_group_avatar(g, v)
                else:
                    g[k] = v
        emit_group(gid)
    return {"ok": True, "group": group_public(gid)}


@socketio.on("delete_group")
def on_delete_group(data=None):
    ctx, err = _owner_group(data)
    if err:
        return err
    gid = ctx[1]
    g = groups[gid]
    try:
        store.delete_group(gid)
    except Exception:
        log.exception("delete_group failed")
        return _fail("Could not delete the group. Please try again.")
    with online_lock:
        c = calls.pop(gid, None)
        for s in (c or {}).get("sids", ()):
            sid_call.pop(s, None)
    socketio.emit("group_deleted", {"gid": gid, "name": g["name"]}, to=room(gid))
    socketio.close_room(room(gid))
    with groups_lock:
        groups.pop(gid, None)
        group_by_code.pop(g["code"], None)
        gmsgs.pop(gid, None)
        for m in g["members"]:
            user_groups[m].discard(gid)
    for m in g["members"]:
        push_wallet(m)
    return {"ok": True}


@socketio.on("leave_group")
def on_leave_group(data=None):
    u = current_socket_user()
    if not u:
        return _fail("Session expired. Please sign in again.")
    gid = member_gid(u, data)
    if not gid:
        return {"ok": True}
    if groups[gid]["owner"] == u["uid"]:
        return _fail("The group owner cannot leave. Delete the group instead.")
    if sid_call.get(request.sid) == gid:
        leave_call(request.sid, u["uid"])
    name = (directory.get(u["uid"]) or {}).get("name", "A member")
    system_message(gid, "%s left the group" % name)
    try:
        alive = member_remove(gid, u["uid"])
    except Exception:
        log.exception("leave_group failed")
        return _fail("Could not leave the group. Please try again.")
    leave_room(room(gid))
    if alive:
        emit_group(gid)
    return {"ok": True, "gid": gid}


@socketio.on("get_history")
def on_get_history(data=None):
    u = current_socket_user()
    if not u:
        return {"ok": False, "error": "Session expired. Please sign in again.", "code": "session"}
    gid = member_gid(u, data)
    if not gid:
        return {"ok": False, "error": "You are not in this group."}
    return {"ok": True, "gid": gid, "messages": history_payload(gid)}


@socketio.on("send_message")
def on_send_message(data=None):
    sender = current_socket_user()
    if not sender:
        return {"ok": False, "error": "Session expired. Please sign in again.", "code": "session"}
    data = data if isinstance(data, dict) else {}
    gid = member_gid(sender, data)
    if not gid:
        return {"ok": False, "error": "You are not in this group."}
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
    cache_add(gid, m)
    socketio.emit("new_message", msg_out(gid, m), to=room(gid))        # instant delivery

    def failed():
        cache_remove(gid, m["id"])
        socketio.emit("message_failed", {"gid": gid, "id": m["id"]}, to=room(gid))

    run_bg(io_pool, store.add_message, gid, m["id"], {k: v for k, v in m.items() if k != "id"}, on_fail=failed)
    return {"ok": True, "id": m["id"]}


@socketio.on("react_message")
def on_react_message(data=None):
    sender = current_socket_user()
    data = data if isinstance(data, dict) else {}
    mid, emoji = str(data.get("id") or ""), str(data.get("emoji") or "")
    if not sender or emoji not in REACTIONS:
        return
    gid = member_gid(sender, data)
    if not gid:
        return
    b = gbucket(gid)
    with b["lock"]:
        m = b["by_id"].get(mid)
        if not m or m.get("kind") == "system":
            return
        reactions = dict(m.get("reactions") or {})
        if reactions.get(sender["uid"]) == emoji:
            reactions.pop(sender["uid"], None)
        else:
            reactions[sender["uid"]] = emoji
        m["reactions"] = reactions
    socketio.emit("message_reaction", {"gid": gid, "id": mid, "reactions": reactions}, to=room(gid))
    run_bg(seq_pool, store.set_reactions, gid, mid, dict(reactions))


# ---- group call signalling (WebRTC mesh). One call per group, one call per person at a time.
@socketio.on("join_video")
def join_video(data=None):
    user = current_socket_user()
    if not user:
        return {"ok": False, "reason": "Session expired. Please sign in again."}
    data = data if isinstance(data, dict) else {}
    gid = member_gid(user, data)
    if not gid:
        return {"ok": False, "reason": "You are not in this group."}
    sid = request.sid
    mic, cam = bool(data.get("mic", True)), bool(data.get("cam", True))
    with online_lock:
        if sid_call.get(sid) not in (None, gid):
            return {"ok": False, "reason": "You are already in a call in another group."}
        c = calls.get(gid)
        if c and any((online.get(s) or {}).get("uid") == user["uid"] for s in c["sids"] if s != sid):
            return {"ok": False, "reason": "This account is already in the call on another device."}
        if c is None:
            c = calls[gid] = {"sids": set(), "media": {}, "started": now_ms(), "starter": user["uid"]}
        already = sid in c["sids"]
        c["sids"].add(sid)
        c["media"][sid] = {"mic": mic, "cam": cam}
        sid_call[sid] = gid
        peers = [s for s in c["sids"] if s != sid]
        profiles = {s: peer_profile(s, gid) for s in peers}
        me_profile = peer_profile(sid, gid)
        count = len(c["sids"])
        elapsed = now_ms() - c["started"]
    if not already:                       # joining is silent: no chat note
        for p in peers:
            socketio.emit("video_peer_joined", {"sid": sid, "gid": gid, **me_profile}, to=p)
        emit_group_presence(gid)
    return {"ok": True, "peers": peers, "profiles": profiles, "participant_count": count, "elapsed_ms": elapsed}


@socketio.on("leave_video")
def leave_video():
    user = current_socket_user()
    leave_call(request.sid, (user or {}).get("uid"))


@socketio.on("media_state")
def media_state(data=None):
    if not current_socket_user():
        return
    data = data if isinstance(data, dict) else {}
    sid = request.sid
    with online_lock:
        gid = sid_call.get(sid)
        c = calls.get(gid) if gid else None
        if not c:
            return
        st = c["media"].setdefault(sid, {})
        st["mic"], st["cam"] = bool(data.get("mic", True)), bool(data.get("cam", True))
        out = {"sid": sid, "mic": st["mic"], "cam": st["cam"]}
        peers = [s for s in c["sids"] if s != sid]
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
        gid = sid_call.get(request.sid)
        if not gid or sid_call.get(target) != gid:
            return
    socketio.emit("webrtc_signal", {"from": request.sid, "kind": kind, "payload": data.get("payload")}, to=target)


# --------------------------------------------------------------------------- warm-up
def warm_up():
    t0 = time.time()
    try:
        for key, prof in store.all_users():
            dir_put(key, prof)
        for gid, doc in store.all_groups():
            register_group(gid, doc)
        log.info("warm-up: %d users, %d groups in %.2fs", len(directory), len(groups), time.time() - t0)
    except Exception:
        log.exception("warm-up failed (continuing with empty caches)")


warm_up()

if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), allow_unsafe_werkzeug=True)
