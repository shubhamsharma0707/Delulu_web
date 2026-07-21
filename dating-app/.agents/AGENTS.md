# AGENTS.md — Delulu College Dating App

> **Purpose**: This file gives any AI agent (or developer) a complete mental model of the Delulu project — its architecture, data flows, algorithms, and rules — so no code needs to be read before making changes.

---

## 1. Project Overview

**Delulu** is an anonymous college dating app where identities are **hidden by design**. Users connect based on interests, chat anonymously, and only reveal their real identity after building a genuine connection over 7+ days. Think of it as "Blind Dating + Slow Dating" built for college students.

**Live URL**: https://delulu-college.onrender.com  
**Android APK**: `public/delulu.apk` (served locally — too large for GitHub)  
**Stack**: Node.js + Express (server), Firestore (users/connections), Supabase Postgres (messages), Capacitor (Android wrapper), Vanilla JS + Tailwind (frontend)

---

## 2. Tech Stack & Infrastructure

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Server | Express.js (Node 18+) | REST API + SSE + Socket.io |
| Primary DB | Firebase Firestore | Users, connections, games |
| Messages DB | Supabase Postgres | All chat messages (high write) |
| Sessions | connect-pg-simple → Supabase | Persistent 30-day sessions |
| Real-time | SSE (`/api/connections/:id/stream`) | Per-connection live events |
| Per-user RT | SSE (`/api/user/stream`) | Messages list live updates |
| Socket.io | Present but **MOCKED** on client | `socket.isMock = true` — do NOT rely on it |
| Auth | Express-session + bcrypt | Cookie-based, `httpOnly`, 30-day TTL |
| Push | Web Push (VAPID) | Browser push notifications |
| Native Push | `@capacitor/local-notifications` | Android native notifications |
| Email | Brevo API | OTP verification emails |
| Hosting | Render.com (free tier) | Auto-sleep when idle |
| Android | Capacitor (WebView wrapper) | APK from web codebase |

---

## 3. File Structure

```
dating-app/
├── server.js           # All API routes (1800+ lines)
├── database.js         # All Firestore + Supabase operations (1578 lines)
├── db/supabase.js      # Supabase client (service-role, server-only)
├── firestore.rules     # Firestore security rules
├── capacitor.config.json
├── android/            # Capacitor Android project
└── public/
    ├── login.html       # Auth page (signup + OTP + login)
    ├── discover.html    # Profile swiping (3D card carousel)
    ├── requests.html    # Pending/sent connection requests
    ├── messages.html    # Active chats list
    ├── chat.html        # Individual chat room
    ├── profile.html     # Edit own profile
    ├── sw.js            # Service Worker (web push notifications)
    └── js/
        ├── shared.js    # Global utilities, auth, socket mock, navigation
        ├── login.js     # Signup/login/OTP flow
        ├── discover.js  # Discovery + connect/dismiss logic
        ├── requests.js  # Accept/reject request UI
        ├── messages.js  # Chat list + per-user SSE stream
        ├── chat.js      # Full chat room (messages, games, reveal, voice)
        ├── profile.js   # Profile edit
        ├── crypto.js    # E2EE (Web Crypto API — AES-GCM + ECDH)
        ├── chat-cache.js # IndexedDB message cache (Dexie.js)
        └── avatar3d.js  # Three.js 3D avatar carousel for discover page
```

---

## 4. Database Architecture

### 4.1 Firestore Collections

#### `users/{userId}`
```js
{
  id: Number,            // auto-incremented integer
  username: String,      // display name (anonymous, no real name)
  gender: "male"|"female",
  email: String,         // college email (determines ecosystem)
  passcode_hash: String, // bcrypt hash
  bio: String,
  hobbies: String[],     // ["hiking", "music", ...]
  avatar: String,        // avatar key e.g. "female_01"
  is_onboarded: 0|1,
  ecosystem: "rishihood"|"vitbhopal", // derived from email domain
  public_key: String|null,            // ECDH public key for E2EE
  encrypted_private_key: String|null, // E2EE private key encrypted with user password
  created_at: ISO8601
}
```

#### `connections/{connectionId}`
```js
{
  id: Number,
  from_user_id: Number,  // who sent the request
  to_user_id: Number,    // who received the request
  status: "pending"|"accepted"|"rejected"|"expired"|"revealed",
  created_at: ISO8601,
  chat_started_at: ISO8601|null,
  // Identity reveal (Day 7+)
  identity_reveal_available_at: ISO8601|null,
  from_identity_reveal: 0|1,
  to_identity_reveal: 0|1,
  meeting_code: String|null,   // Google Meet code when both agree
  // Face reveal (Day 10+)
  face_reveal_available_at: ISO8601|null,
  from_face_reveal: 0|1,
  to_face_reveal: 0|1,
  face_reveal_declined_by: Number|null,
  // Read receipts
  from_last_read_at: ISO8601|null,
  to_last_read_at: ISO8601|null,
  // Icebreak game (stored inline)
  active_game: {
    game_type: "would_you_rather"|"truth_or_dare"|"hot_takes",
    question: String,
    answers: { [userId]: String },
    created_at: ISO8601
  }|null,
  last_message_at: ISO8601|null,
  ended_reason: String|null
}
```

#### `counters/{collectionName}`
Auto-incrementing integer ID generator. Used for `users` and `connections`.

#### `blocked_users/{docId}`
`{ from_user_id, to_user_id, created_at }`

#### `reported_users/{docId}`
`{ reporter_id, reported_user_id, reason, connection_id, created_at }`

#### `otp_codes/{docId}`
`{ email, code_hash, created_at, expires_at, verified: bool }`

### 4.2 Supabase Postgres Tables

#### `messages`
```sql
id              BIGSERIAL PRIMARY KEY
connection_id   INTEGER NOT NULL
sender_id       INTEGER NOT NULL
content         TEXT
reactions       JSONB DEFAULT '{}'     -- { "😂": [userId, ...] }
is_voice        INTEGER DEFAULT 0      -- 0=text, 1=voice, 2=photo
voice_duration  INTEGER DEFAULT 0      -- seconds
is_encrypted    INTEGER DEFAULT 0      -- 0=plain, 1=E2EE
iv              TEXT                   -- AES-GCM IV for E2EE
created_at      TIMESTAMPTZ DEFAULT NOW()
deleted_at      TIMESTAMPTZ            -- soft-delete tombstone
deleted_by      INTEGER
```

#### `push_subscriptions`
```sql
user_id        INTEGER
endpoint       TEXT
keys           JSONB    -- { p256dh, auth }
created_at     TIMESTAMPTZ
```

#### `session` (auto-created by connect-pg-simple)
```sql
sid     VARCHAR PRIMARY KEY
sess    JSON
expire  TIMESTAMPTZ
```

---

## 5. Core Algorithms & Workflows

### 5.1 Ecosystem Algorithm (CRITICAL — DO NOT CHANGE)
Users are siloed into **ecosystems** based on their college email domain. Users from different ecosystems **never see each other** in discover.

```js
function getEcosystem(email) {
  const domain = email.split('@')[1];
  if (domain === 'vitbhopal.ac.in') return 'vitbhopal';
  return 'rishihood'; // default for nst.rishihood.edu.in and all others
}
```

**Discovery query** always filters by `ecosystem === userEcosystem`. This is the core isolation mechanism.

### 5.2 Discovery Algorithm (CRITICAL — DO NOT CHANGE)
The discover page shows profiles filtered by:
1. **Same ecosystem** as the viewer
2. **Opposite gender** (male sees female, female sees male; other genders see all)
3. **Exclude**: already-connected users, blocked users, self
4. **Random shuffle** via `array.sort(() => Math.random() - 0.5)` on every load

The `getDiscoverable(userId, gender, excludeIds)` method in `database.js` handles this. `excludeIds` is populated from `getConnectedUserIds()` — all users with any connection record (pending/accepted/rejected).

### 5.3 Connection Lifecycle (CRITICAL — DO NOT CHANGE)
```
[Discover] → Send Request (status: "pending")
    ↓
[Requests page] → Accept → status: "accepted"
    - chat_started_at = NOW
    - identity_reveal_available_at = NOW + 7 days
    - face_reveal_available_at = NOW + 10 days
    ↓
[Chat] Day 0-6: Anonymous chat only
    ↓
[Chat] Day 7+: Identity Reveal button appears
    - Both users must click to agree
    - Firestore transaction ensures atomicity
    - If both agree → meeting_code generated → Google Meet link
    - status changes to "revealed"
    ↓
[Chat] Day 10+: Face Reveal button appears
    - Both must agree within the window
    - If either declines → other user gets notification
    - If window passes without both agreeing → status: "expired" (sweepExpired)
```

**Either user can end the chat at any time** with "Not Vibing" button → status: "rejected", ended_reason: "not_vibing".

### 5.4 Connection Expiry Sweep (Background Job)
`connectionOps.sweepExpired()` runs on a schedule (every 24h):
- Connections where `face_reveal_available_at < NOW` AND NOT both agreed → status: "expired"
- Connections where `identity_reveal_available_at < NOW` AND neither agreed → status: "expired"

### 5.5 Icebreak Game Algorithm (CRITICAL — DO NOT CHANGE)
Three game types: `would_you_rather`, `truth_or_dare`, `hot_takes`.

State machine:
```
No game → Start game → active_game written to Firestore connection doc
    ↓
User A answers → answers[userA_id] stored in active_game.answers
    ↓
User B answers → bothAnswered=true → SSE/socket broadcasts answers to both
    ↓
30-second delay → /api/connections/:id/game/clear → active_game: null
```

Game state is stored **inline on the connection document** as `active_game`. This is intentional — it avoids a separate collection and ensures atomic updates via Firestore transactions.

### 5.6 E2EE Algorithm
Using Web Crypto API (browser-native):

1. **Key Generation**: On registration, generate ECDH P-256 key pair
2. **Key Storage**: Public key → Firestore `users/{id}.public_key`; private key → AES-GCM encrypted with user password via PBKDF2 (100,000 iterations) → `users/{id}.encrypted_private_key`
3. **Shared Secret**: When chat opens, derive ECDH shared secret from own private key + partner's public key
4. **Encryption**: AES-GCM with random 128-bit IV; ciphertext in `content`, IV stored separately
5. **Flag**: `is_encrypted: 1` on encrypted messages

E2EE is opt-in and only active when both users have public keys. Plain-text fallback otherwise.

---

## 6. Real-Time Architecture

### IMPORTANT: Socket.io is Disabled
`socket.isMock = true` in `shared.js`. The socket object is a no-op stub. **Do not add real socket.io client code.**

### 6.1 Per-Connection SSE (`/api/connections/:id/stream`)
- Client opens `EventSource` when entering a chat room
- Server uses `connectionEmitter` (Node.js EventEmitter) to push events
- Event types:
  - `message` — new message; **contains full `msg` object** (zero extra fetch needed)
  - `read` — other user read messages; `readAt` timestamp included
  - `messages` — reload messages (fallback)
  - `game` — game state changed
  - `info` — chat info refresh
  - `ended` — chat ended by other user
- Heartbeat every 25s prevents Render proxy timeout

### 6.2 Per-User SSE (`/api/user/stream`)
- Client opens on messages list page
- Server uses `userEmitter` to push events
- Event: `{ type: 'message', connectionId, lastMessage, lastMessageTime, senderId }`
- Client calls `updateChatListItem()` for instant list update without page refresh

### 6.3 Message Delivery Flow (WhatsApp-like)
```
User sends message
→ POST /api/messages/send → saved to Supabase
→ connectionEmitter emits: { type: 'message', msg: fullMessageObject }
→ userEmitter emits to other user: { type: 'message', connectionId, ... }
→ sendPushNotification() called for other user
→ Receiver's SSE fires immediately
→ Client appends message directly (ZERO extra HTTP round-trip)
```

### 6.4 Read Receipt Flow
```
User opens chat → markMessagesAsRead()
→ POST /api/messages/:connectionId/read
→ Server updates from_last_read_at / to_last_read_at in Firestore
→ connectionEmitter emits: { type: 'read', readAt }
→ Sender's SSE fires → blue double-tick appears instantly
```

---

## 7. Authentication & Session

### Registration Flow
1. Enter college email → POST `/api/auth/send-verification-email` (Brevo OTP)
2. Verify OTP → POST `/api/auth/verify-otp`
3. Complete profile → POST `/api/auth/register`
4. Session created, `cached_user` in localStorage

### `requireAuth()` — Optimistic Cache Pattern
1. Check `localStorage.cached_user`
2. If exists → render immediately (optimistic, non-blocking)
3. Background verify with server (3s timeout)
4. If invalid → clear cache → redirect to login

### Session Configuration
- **Store**: Supabase Postgres (`connect-pg-simple`) — requires `SUPABASE_DB_URL` env var
- **Fallback**: `memorystore` (sessions lost on restart) if no `SUPABASE_DB_URL`
- **TTL**: 30 days, `rolling: true`
- **Cookie**: `httpOnly: true`, `sameSite: 'none'` + `secure: true` in production

---

## 8. Push Notifications

### Web Push
1. `initPushNotifications()` → request permission → register SW → get VAPID key
2. Subscription stored in Supabase `push_subscriptions`
3. On new message → `sendPushNotification(userId, title, body, url)` via `web-push`

### Native Android (`@capacitor/local-notifications`)
- `showNativeNotification({ title, body, url, id })` in `shared.js`
- Called from chat.js SSE handler when `document.hidden === true`
- Called from messages.js SSE handler on incoming messages

---

## 9. Android App (Capacitor)

- **Config**: `capacitor.config.json` — `webDir: "public"`, server: `https://delulu-college.onrender.com`
- **Plugins**: `@capacitor/app` (back button), `@capacitor/local-notifications`
- **Back navigation**: `initNativeBackButton()` intercepts hardware back
  - Chat → Messages → Discover → Exit (confirm dialog)
- **Build**: `npx cap sync android` → `./gradlew assembleRelease`
- **APK**: 126MB — gitignored, distribute via Google Drive

---

## 10. Key API Endpoints

### Auth
- `POST /api/auth/send-verification-email` — send OTP
- `POST /api/auth/verify-otp` — verify OTP
- `POST /api/auth/register` — create account
- `POST /api/auth/login` — login
- `POST /api/auth/logout` — destroy session
- `GET /api/session` — check auth status

### Discovery
- `GET /api/discover` — shuffled profiles (ecosystem filtered)
- `POST /api/connections/request` — send connection request
- `POST /api/connections/dismiss` — dismiss profile

### Connections
- `GET /api/connections/pending` — incoming requests
- `GET /api/connections/sent` — outgoing requests
- `POST /api/connections/:id/respond` — accept or reject
- `POST /api/connections/end` — end active chat
- `GET /api/connections/active` — all active chats

### Chat
- `GET /api/messages/:connectionId` — load messages (paginated)
- `POST /api/messages/send` — send text
- `POST /api/messages/upload-voice` — send voice note
- `POST /api/messages/:id/react` — toggle emoji reaction
- `DELETE /api/messages/:id` — soft-delete
- `POST /api/messages/:connectionId/read` — mark as read
- `GET /api/connections/:id/stream` — SSE for chat room
- `GET /api/user/stream` — SSE for messages list

### Games
- `POST /api/connections/:id/game/start`
- `POST /api/connections/:id/game/answer`
- `POST /api/connections/:id/game/clear`

### Reveals
- `POST /api/connections/:id/identity-reveal`
- `POST /api/connections/:id/face-reveal`
- `POST /api/connections/:id/face-reveal/decline`
- `GET /api/connections/:id/info`

### Profile
- `GET /api/profile`
- `PUT /api/profile`

---

## 11. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SESSION_SECRET` | ✅ | 48+ byte hex secret |
| `FIREBASE_PROJECT_ID` | ✅ | Firebase project |
| `FIREBASE_CLIENT_EMAIL` | ✅ | Service account email |
| `FIREBASE_PRIVATE_KEY` | ✅ | Service account private key |
| `SUPABASE_URL` | ✅ | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Supabase service role key |
| `SUPABASE_DB_URL` | Recommended | Postgres URI for persistent sessions |
| `BREVO_API_KEY` | ✅ | OTP email sending |
| `VAPID_PUBLIC_KEY` | Optional | Web push |
| `VAPID_PRIVATE_KEY` | Optional | Web push |
| `NODE_ENV` | Recommended | Set to `production` on Render |

---

## 12. Caching Architecture

### Server-Side (in-memory)
| Cache | TTL | Purpose |
|-------|-----|---------|
| `userByIdCache` | 15s | User profile reads |
| `_connCache` | 2 min | Connection auth checks |
| `_lastMessageCache` | 15s | Last message per connection |
| `sessionCache` | 30s | Session validation |

Cache invalidation via `evictConnection()` / `invalidateUserCache()` on every write.

### Client-Side
- `localStorage.cached_user` — instant auth
- IndexedDB (Dexie.js) — offline message cache
- `chatListCache` array — in-memory for SSE-driven list updates

---

## 13. Developer Rules (MUST FOLLOW)

1. **Never break ecosystem isolation** — discovery MUST filter by ecosystem
2. **Never skip connection ownership checks** — `getConnection(connectionId, userId)` on every message route
3. **Never inject raw HTML** — always `escapeHtml()` on user content
4. **Socket.io is mocked** — `socket.isMock = true`. Don't add real socket client code
5. **Firestore for relationships, Supabase for messages** — permanent architecture split
6. **Reveal timeline is sacred** — Day 7 = identity reveal, Day 10 = face reveal
7. **No server-rendered HTML** — pure MPA with static HTML + vanilla JS
8. **Run `npx cap sync android`** before building APK after any web change
9. **APK is gitignored** — 126MB, distribute manually
10. **`SUPABASE_DB_URL` required for persistent sessions** — without it, users log out on every Render restart

---

## 14. Known Constraints & Gotchas

- **Render free tier cold starts**: Server sleeps after 15min. First request ~30s. SSE keeps it warm for active users.
- **Firestore composite index**: `(ecosystem + gender)` on `users` collection needed for discover. Falls back to in-memory filter if missing.
- **`sameSite: 'none'`** required in production for Capacitor WebView cross-origin cookies.
- **`X-Accel-Buffering: no`** required on SSE responses to prevent Nginx buffering.
- **25s SSE heartbeat** prevents Render's 30s proxy timeout.
- **Voice uploads stored locally** on server filesystem — lost on Render redeploy without persistent disk.
- **APK is 126MB** — exceeds GitHub's 100MB limit. Never commit to git.
