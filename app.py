
import json, os, re, secrets, threading, time, uuid
import firebase_admin
from firebase_admin import credentials, firestore
from flask import Flask, jsonify, request, render_template
from flask_socketio import SocketIO, emit
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
socketio = SocketIO(app, async_mode="threading", cors_allowed_origins="*",
                    ping_interval=25, ping_timeout=60)
ROOM_TITLE = (os.environ.get("FFX-G") or "SR Private Chat")[:60]

def get_firestore():
    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
    if not raw:
        raise RuntimeError("Missing FIREBASE_SERVICE_ACCOUNT_JSON environment variable")
    info = json.loads(raw)
    if not firebase_admin._apps:
        firebase_admin.initialize_app(
            credentials.Certificate(info),
            {"projectId": os.environ.get("FIREBASE_PROJECT_ID") or info.get("project_id")}
        )
    return firestore.client()

db = get_firestore()
users = db.collection("chat_users")
sessions = db.collection("chat_sessions")
messages = db.collection("chat_messages")
online = {}  # Socket.IO sid -> user; one Render instance
online_lock = threading.RLock()
video_sids = set()

def username_key(value):
    return re.sub(r"\\s+", " ", str(value or "").strip()).casefold()

def public_user(uid, profile):
    return {"id": uid, "name": profile.get("name", ""),
            "username": profile.get("username", "")}

def resolve_token(token):
    token = str(token or "")
    if not token or len(token) > 200:
        return None
    s = sessions.document(token).get()
    if not s.exists:
        return None
    sd = s.to_dict() or {}
    key, uid = sd.get("user_key"), sd.get("uid")
    if not key or not uid:
        return None
    u = users.document(key).get()
    if not u.exists:
        return None
    return uid, u.to_dict() or {}, key

def make_session(uid, key):
    token = secrets.token_urlsafe(36)
    sessions.document(token).set({
        "uid": uid, "user_key": key, "created_at": int(time.time() * 1000)
    })
    return token

def api_error(message, status=400):
    return jsonify(error=message), status

def get_recent_messages(limit=150):
    docs = messages.order_by("ts", direction=firestore.Query.DESCENDING).limit(limit).stream()
    result = []
    for doc in docs:
        m = doc.to_dict() or {}
        result.append({
            "id": doc.id, "uid": m.get("uid", ""),
            "username": m.get("username", ""), "name": m.get("name", ""),
            "text": m.get("text", ""), "ts": m.get("ts", 0)
        })
    return list(reversed(result))

def emit_presence():
    with online_lock:
        unique = {u["uid"]: {"id": u["uid"], "name": u["name"],
                             "username": u["username"]} for u in online.values()}
    socketio.emit("presence_update", {"count": len(unique), "users": list(unique.values())})

@app.get("/")
def home():
    return render_template("index.html", room_title=ROOM_TITLE)

@app.get("/health")
def health():
    return jsonify(ok=True, service="sr-firebase-chat")

@app.post("/api/register")
def register():
    d = request.get_json(silent=True) or {}
    name = re.sub(r"\\s+", " ", str(d.get("name") or "").strip())
    username = re.sub(r"\\s+", " ", str(d.get("username") or "").strip())
    password = str(d.get("password") or "")
    if not name or len(name) > 40:
        return api_error("Name is required (maximum 40 characters)")
    if not re.fullmatch(r"[A-Za-z0-9_.]{3,20}", username):
        return api_error("Username must be 3-20 characters: letters, numbers, _ or .")
    if len(password) < 6:
        return api_error("Password must contain at least 6 characters")
    key = username_key(username)
    ref = users.document(key)
    profile = {
        "uid": uuid.uuid4().hex, "name": name, "username": username,
        "password_hash": generate_password_hash(password),
        "created_at": int(time.time() * 1000)
    }
    tx = db.transaction()

    @firestore.transactional
    def create_if_available(transaction):
        existing = ref.get(transaction=transaction)
        if existing.exists:
            return False
        transaction.set(ref, profile)
        return True

    if not create_if_available(tx):
        return api_error("That username is already taken")
    token = make_session(profile["uid"], key)
    return jsonify(token=token, me=public_user(profile["uid"], profile))

@app.post("/api/login")
def login():
    d = request.get_json(silent=True) or {}
    username, password = str(d.get("username") or "").strip(), str(d.get("password") or "")
    snap = users.document(username_key(username)).get()
    if not username or not password or not snap.exists:
        return api_error("Incorrect username or password", 401)
    profile = snap.to_dict() or {}
    if not check_password_hash(profile.get("password_hash", ""), password):
        return api_error("Incorrect username or password", 401)
    uid = profile.get("uid") or snap.id
    token = make_session(uid, snap.id)
    return jsonify(token=token, me=public_user(uid, profile))

@app.post("/api/me")
def me():
    d = request.get_json(silent=True) or {}
    found = resolve_token(d.get("token"))
    if not found:
        return api_error("Session expired. Please log in again.", 401)
    return jsonify(me=public_user(found[0], found[1]))

@app.post("/api/logout")
def logout():
    token = str((request.get_json(silent=True) or {}).get("token") or "")
    if token:
        sessions.document(token).delete()
    return jsonify(ok=True)

@app.post("/api/delete-account")
def delete_account():
    d = request.get_json(silent=True) or {}
    token, password = str(d.get("token") or ""), str(d.get("password") or "")
    found = resolve_token(token)
    if not found:
        return api_error("Session expired. Please log in again.", 401)
    uid, profile, key = found
    if not check_password_hash(profile.get("password_hash", ""), password):
        return api_error("Incorrect password", 401)

    # Delete all messages written by this account, in Firestore-safe batches.
    message_docs = list(messages.where("uid", "==", uid).stream())
    for offset in range(0, len(message_docs), 400):
        batch = db.batch()
        for doc in message_docs[offset:offset + 400]:
            batch.delete(doc.reference)
        batch.commit()

    session_docs = list(sessions.where("user_key", "==", key).stream())
    for offset in range(0, len(session_docs), 400):
        batch = db.batch()
        for doc in session_docs[offset:offset + 400]:
            batch.delete(doc.reference)
        batch.commit()
    users.document(key).delete()

    with online_lock:
        stale = [sid for sid, u in online.items() if u["uid"] == uid]
        for sid in stale:
            online.pop(sid, None)
            video_sids.discard(sid)
    for sid in stale:
        socketio.server.disconnect(sid, namespace="/")
    emit_presence()
    return jsonify(ok=True)

@app.get("/api/messages")
def message_history():
    token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    if not resolve_token(token):
        return api_error("Please log in again", 401)
    return jsonify(messages=get_recent_messages())

@socketio.on("connect")
def on_connect(auth=None):
    found = resolve_token((auth or {}).get("token"))
    if not found:
        return False
    uid, profile, _ = found
    with online_lock:
        online[request.sid] = {
            "uid": uid, "name": profile.get("name", ""),
            "username": profile.get("username", "")
        }
    emit("chat_history", {"messages": get_recent_messages()})
    emit_presence()

@socketio.on("send_message")
def on_send_message(data):
    with online_lock:
        sender = online.get(request.sid)
    if not sender:
        return
    text = str((data or {}).get("text") or "").strip()
    if not text:
        return
    if len(text) > 2000:
        emit("chat_error", {"error": "Message limit is 2000 characters"})
        return
    message = {
        "uid": sender["uid"], "name": sender["name"],
        "username": sender["username"], "text": text,
        "ts": int(time.time() * 1000)
    }
    ref = messages.document()
    ref.set(message)
    socketio.emit("new_message", {"id": ref.id, **message})

# Group WebRTC signalling: peers exchange offers/answers/ICE through Socket.IO.
@socketio.on("join_video")
def join_video():
    with online_lock:
        if request.sid not in online:
            return
        video_sids.add(request.sid)
        peers = [sid for sid in video_sids if sid != request.sid]
    emit("video_peers", {"peers": peers})
    for sid in peers:
        socketio.emit("video_peer_joined", {"sid": request.sid}, to=sid)

@socketio.on("leave_video")
def leave_video():
    with online_lock:
        video_sids.discard(request.sid)
        peers = list(video_sids)
    for sid in peers:
        socketio.emit("video_peer_left", {"sid": request.sid}, to=sid)

@socketio.on("webrtc_signal")
def webrtc_signal(data):
    data = data or {}
    target, kind = str(data.get("to") or ""), data.get("kind")
    if kind not in ("offer", "answer", "ice") or not target:
        return
    with online_lock:
        if request.sid not in video_sids or target not in video_sids:
            return
    socketio.emit("webrtc_signal", {
        "from": request.sid, "kind": kind, "payload": data.get("payload")
    }, to=target)

@socketio.on("disconnect")
def on_disconnect():
    with online_lock:
        online.pop(request.sid, None)
        was_in_call = request.sid in video_sids
        video_sids.discard(request.sid)
        peers = list(video_sids)
    if was_in_call:
        for sid in peers:
            socketio.emit("video_peer_left", {"sid": request.sid}, to=sid)
    emit_presence()

if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
