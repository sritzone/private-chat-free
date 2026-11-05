# SR Private Chat — Flask + Socket.IO + Firebase

Private group chat with video calls. Dark/light UI, responsive on desktop and mobile.

## Features
- Register / sign in (hashed passwords, login rate-limit)
- **One login per account** — signing in on another device (or opening a second tab) signs the old one out instantly; the old tab can click "Use here" to take it back
- Real-time chat: replies, reactions, link detection, day separators, unread pill, members sidebar
- **Group video call**: pre-join lobby (camera preview, mic/cam toggles), adaptive grid, picture-in-picture for 1-to-1, speaking highlight, mic/camera state shown to others, call timer, connection status, auto ICE-restart, "tap to enable sound" fallback, audio-only fallback when no camera
- **Account page**: photo upload with preview, display name, change password, theme, delete account
- Fast: in-memory auth/user/message caches, write-behind persistence, cached avatar images, gzip, vendored socket.io, WebSocket-first

## Firebase setup
1. Create a Firebase project and a Firestore database (Native mode).
2. Project settings → Service accounts → Generate new private key. Keep it private.
3. Put the whole JSON into the `FIREBASE_SERVICE_ACCOUNT_JSON` environment variable.

## Render deployment
- Build: `pip install -r requirements.txt`
- Start: `gunicorn --worker-class gthread --threads 100 --workers 1 --bind 0.0.0.0:$PORT app:app`
- **Keep exactly 1 worker/instance** (presence, calls and caches live in memory).

Environment variables
| Name | Purpose |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | required — service account JSON |
| `SECRET_KEY` | long random string |
| `ROOM_TITLE` | chat title (old `FFX-G` still works) |
| `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | optional TURN server for calls on strict mobile/corporate networks |

## Run locally without Firebase
```
pip install -r requirements.txt
LOCAL_DEV=1 python app.py      # http://localhost:5000  (data is not saved)
```
Camera/mic need HTTPS (or `localhost`).

## Notes
- Calls are peer-to-peer mesh: best for small groups (≤ 6). Without TURN some networks cannot connect.
- Existing users, sessions and messages keep working. Old messages that stored avatars inside each message are cleaned up automatically (the avatar now comes from the user profile).
- New usernames must start with a letter/number (Firestore does not allow ids like `__name__`).
