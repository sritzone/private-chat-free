
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
call_started_at = None

def username_key(value):
    return re.sub(r"\\s+", " ", str(value or "").strip()).casefold()

def public_user(uid, profile):
    return {"id": uid, "name": profile.get("name", ""),
            "username": profile.get("username", ""), "avatar": profile.get("avatar", "")}

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
            "text": m.get("text", ""), "ts": m.get("ts", 0), "kind": m.get("kind", "user"),
            "avatar": m.get("avatar", ""), "reactions": m.get("reactions", {}),
            "reply_to": m.get("reply_to")
        })
    return list(reversed(result))

def emit_presence():
    with online_lock:
        unique = {u["uid"]: {"id": u["uid"], "name": u["name"],
                             "username": u["username"], "avatar": u.get("avatar", "")}
                   for u in online.values()}
    socketio.emit("presence_update", {"count": len(unique), "users": list(unique.values()),
                                      "call_active": bool(video_sids)})

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

@app.post("/api/profile")
def update_profile():
    d = request.get_json(silent=True) or {}
    found = resolve_token(d.get("token"))
    if not found:
        return api_error("Session expired. Please log in again.", 401)
    uid, profile, key = found
    avatar = str(d.get("avatar") or "")
    if avatar and (not avatar.startswith("data:image/") or len(avatar) > 420000):
        return api_error("Profile image must be a compressed image under 300 KB")
    users.document(key).update({"avatar": avatar})
    # Keep existing chat history avatars in sync with the current profile photo.
    old_messages = list(messages.where("uid", "==", uid).stream())
    for offset in range(0, len(old_messages), 400):
        batch = db.batch()
        for doc in old_messages[offset:offset + 400]:
            batch.update(doc.reference, {"avatar": avatar})
        batch.commit()
    profile["avatar"] = avatar
    with online_lock:
        for sid, user in online.items():
            if user["uid"] == uid:
                user["avatar"] = avatar
                socketio.emit("profile_updated", {"id": uid, "name": user["name"],
                              "username": user["username"], "avatar": avatar})
    return jsonify(me=public_user(uid, profile))

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
            "username": profile.get("username", ""), "avatar": profile.get("avatar", "")
        }
    emit("chat_history", {"messages": get_recent_messages()})
    emit_presence()
    emit("call_status", {"active": bool(video_sids),
                         "participants": len(video_sids),
                         "started_by": call_started_by_name()})

def call_started_by_name():
    with online_lock:
        if not video_sids:
            return ""
        sid = next(iter(video_sids))
        return online.get(sid, {}).get("name", "A member")

def system_call_message(text):
    msg = {"uid": "system", "name": "SR Chat", "username": "system",
           "text": text, "ts": int(time.time() * 1000), "kind": "system"}
    ref = messages.document()
    ref.set(msg)
    socketio.emit("new_message", {"id": ref.id, **msg})

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
    reply_to = (data or {}).get("reply_to")
    message = {
        "uid": sender["uid"], "name": sender["name"],
        "username": sender["username"], "text": text, "avatar": sender.get("avatar", ""),
        "ts": int(time.time() * 1000), "reactions": {},
        "reply_to": reply_to if isinstance(reply_to, dict) else None
    }
    ref = messages.document()
    ref.set(message)
    socketio.emit("new_message", {"id": ref.id, **message})

@socketio.on("react_message")
def on_react_message(data):
    data = data or {}
    message_id = str(data.get("id") or "")
    emoji = str(data.get("emoji") or "")
    allowed = {"👍", "❤️", "😂", "😮", "😢", "🔥"}
    with online_lock:
        sender = online.get(request.sid)
    if not sender or not message_id or emoji not in allowed:
        return
    ref = messages.document(message_id)
    snap = ref.get()
    if not snap.exists:
        return
    item = snap.to_dict() or {}
    reactions = item.get("reactions") or {}
    current = reactions.get(sender["uid"])
    if current == emoji:
        reactions.pop(sender["uid"], None)
    else:
        reactions[sender["uid"]] = emoji
    ref.update({"reactions": reactions})
    socketio.emit("message_reaction", {"id": message_id, "reactions": reactions})

# Group WebRTC signalling: peers exchange offers/answers/ICE through Socket.IO.
@socketio.on("join_video")
def join_video():
    global call_started_at
    with online_lock:
        if request.sid not in online:
            return
        current_uid = online[request.sid]["uid"]
        if any(online.get(sid, {}).get("uid") == current_uid for sid in video_sids):
            emit("call_join_rejected", {"reason": "This account is already in the call on another device."})
            return
        was_empty = not video_sids
        video_sids.add(request.sid)
        peers = [sid for sid in video_sids if sid != request.sid]
        starter = online.get(request.sid, {}).get("name", "A member")
        if was_empty:
            call_started_at = int(time.time() * 1000)
    if was_empty:
        system_call_message(f"{starter} started the call")
    else:
        system_call_message(f"{starter} joined the call")
    emit("video_peers", {"peers": peers})
    with online_lock:
        profiles = {sid: {"uid": online.get(sid, {}).get("uid", ""),
                          "name": online.get(sid, {}).get("name", "Participant"),
                          "avatar": online.get(sid, {}).get("avatar", "")} for sid in peers}
        my_profile = {"uid": online.get(request.sid, {}).get("uid", ""),
                      "name": online.get(request.sid, {}).get("name", "Participant"),
                      "avatar": online.get(request.sid, {}).get("avatar", "")}
    emit("video_peer_profiles", {"profiles": profiles})
    socketio.emit("call_status", {"active": True, "participants": len(video_sids),
                                  "started_by": call_started_by_name()})
    for sid in peers:
        socketio.emit("video_peer_joined", {"sid": request.sid, "uid": my_profile["uid"],
                          "name": my_profile["name"], "avatar": my_profile["avatar"]}, to=sid)

@socketio.on("leave_video")
def leave_video():
    global call_started_at
    with online_lock:
        was_in_call = request.sid in video_sids
        video_sids.discard(request.sid)
        peers = list(video_sids)
        ended = was_in_call and not video_sids
        user_name = online.get(request.sid, {}).get("name", "A member")
        if ended:
            call_started_at = None
    if was_in_call:
        system_call_message(f"{user_name} ended the call" if ended else f"{user_name} left the call")
    socketio.emit("call_status", {"active": bool(peers), "participants": len(peers),
                                  "started_by": call_started_by_name()})
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
        disconnected_name = online.get(request.sid, {}).get("name", "A participant")
        online.pop(request.sid, None)
        was_in_call = request.sid in video_sids
        video_sids.discard(request.sid)
        peers = list(video_sids)
    if was_in_call:
        system_call_message(f"{disconnected_name} ended the call" if not peers else f"{disconnected_name} left the call")
        for sid in peers:
            socketio.emit("video_peer_left", {"sid": request.sid}, to=sid)
        socketio.emit("call_status", {"active": bool(peers), "participants": len(peers),
                                      "started_by": call_started_by_name()})
    emit_presence()

if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
