# SR Private Chat — Firebase + Render Free

## Features
- Register: Name, unique Username, Password
- Login: Username and Password
- Passwords stored as secure hashes (not plain text)
- Firebase Firestore stores users, login sessions and chat messages
- Live Socket.IO group chat and message history
- Live online-user count
- Account deletion with password confirmation; deletes that user's messages and sessions
- Professional sign-in / registration experience with responsive chat layout
- Responsive group-call panel for desktop and Android Chrome
- Microphone, speaker and camera On/Off controls
- Microphone permission and WebRTC connection status indicators
- Remote participant audio playback with an explicit Enable sound action for mobile autoplay policies
- Group video call using browser WebRTC mesh signalling

## Firebase setup
1. Create a Firebase project: https://console.firebase.google.com/
2. Create Firestore Database in Native mode.
3. Firebase Project settings -> Service Accounts -> Generate New Private Key.
4. Keep the downloaded JSON private. Never upload it to a public GitHub repository.
5. Copy the entire JSON content into Render's `FIREBASE_SERVICE_ACCOUNT_JSON` environment variable.
6. `FIREBASE_PROJECT_ID` is optional if the service-account JSON already contains `project_id`.

The Firebase Admin SDK runs on the server and bypasses Firestore Security Rules. Protect the service-account key and Render environment variables.

## Render deployment
- Runtime: Python
- Build command: `pip install -r requirements.txt`
- Start command: `gunicorn --worker-class gthread --threads 100 --bind 0.0.0.0:$PORT app:app`

Set these environment variables in Render:
- `FIREBASE_SERVICE_ACCOUNT_JSON` = complete service account JSON
- `SECRET_KEY` = long, random, stable secret
- `FFX-G` = optional room title, e.g. SR Private Chat
- `FIREBASE_PROJECT_ID` = optional project id

No Render persistent disk is needed for chat data. Firestore stores it.

## Important limitations
- Firestore free quota limits apply; monitor usage and billing alerts.
- Render Free services can sleep/restart. Firestore data persists, but online presence resets.
- Active-user count is held in server memory and assumes one Render instance.
- Group video is peer-to-peer mesh. It is intended for a small group; bandwidth/CPU usage increases with each participant.
- Video uses public STUN servers only. Some mobile/corporate networks require a TURN server, so video/audio connectivity is not guaranteed on every network. If a peer connection stays on “checking” or “failed”, configure a TURN service (for example, a managed TURN provider) and add its credentials to `rtcConfig` in `templates/index.html`.
- On Android Chrome, open the Render HTTPS URL, allow both Camera and Microphone permissions, join the call, then tap “Enable sound” if the browser blocks remote audio autoplay. Keep the tab open while calling.
- Camera and microphone require HTTPS; Render provides HTTPS on its hosted URL.
- This is a starter build, not a complete security audit. Before public launch add rate limiting, abuse prevention, moderation/admin tools, account recovery, privacy policy, and testing.
- Existing SQLite data from the old ffx.py is not imported automatically.
