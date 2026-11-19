# SR Private Chat — Flask + Socket.IO + Firebase

Private group chat with video calls. Dark/light UI, responsive on desktop and mobile.

## Features
- **Google sign-in only** via Firebase Authentication (no usernames or passwords). The Firebase ID token is verified on the server.
- **Groups**: any user can create a group and share its 8-character invite code (or invite link `/?join=CODE`). Others join with the code. Chats and calls are per group, with a chat list, unread badges and call-in-progress indicator.
- One login per account — signing in on another device (or a second tab) signs the old one out
- Real-time chat: replies, reactions, emoji, link detection, day separators, unread pill
- **Group video / voice calls** (WebRTC mesh): lobby preview, adaptive grid, 1-to-1 full-screen layout, speaking highlight. Joining a call is silent; leaving adds a small line to the chat.
- Account page: photo, display name, theme, delete account (type DELETE)
- WhatsApp-style dark/light UI, responsive. On phones the profile button is hidden from the chat header (open it from the chats drawer).

## Google sign-in (Firebase Authentication)
1. Firebase console → **Build → Authentication → Get started → Sign-in method → Google → Enable** (choose a support email, Save).
2. **Authentication → Settings → Authorized domains** → add your site domain (e.g. `your-app.onrender.com`). `localhost` is already there.
3. **Project settings (gear) → General → Your apps → Add app → Web (`</>`)**. Copy the `apiKey` from the config it shows.
4. Set the environment variable `FIREBASE_WEB_API_KEY` to that `apiKey`. (The web API key is not secret.)
   Optional: `FIREBASE_AUTH_DOMAIN` if you use a custom auth domain (default `<project_id>.firebaseapp.com`).

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
| `FIREBASE_WEB_API_KEY` | required — Firebase web app `apiKey` (enables Google sign-in) |
| `SECRET_KEY` | long random string |
| `ROOM_TITLE` | chat title (old `FFX-G` still works) |
| `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | optional TURN server for calls on strict mobile/corporate networks |

## Run locally without Firebase
```
pip install -r requirements.txt
LOCAL_DEV=1 python app.py      # http://localhost:5000  (data is not saved)
```
Without `FIREBASE_WEB_API_KEY`, local mode shows a clearly-marked **test sign-in** (name only). It is disabled whenever `FIREBASE_WEB_API_KEY` is set or Firebase is used, so it never exists in production.

## Data model (Firestore)
`chat_users` (accounts, key `fb_<firebase uid>`), `chat_sessions`, `chat_groups/{gid}` (name, code, owner, members) with messages in `chat_groups/{gid}/messages` (no composite index needed).

## Notes
- Calls are peer-to-peer mesh: best for small groups (≤ 6). Without TURN some networks cannot connect.
- Old username/password accounts and the old single-room messages are not migrated: everyone signs in with Google and starts or joins groups.
- Limits: 10 groups owned, 30 joined, 50 members per group.
