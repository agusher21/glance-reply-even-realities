# Day 1 — Backend skeleton test evidence

Date: 24 Nov 2026 ~00:10–00:20 WIB. No real Telegram token was used anywhere.
All tests run from `server/` in `glance-reply-even-realities/`. Node v24.22.1.

## 1. Rank self-test (pure function, canned data)

Command:

```bash
node src/rank.js --self-test
```

Output:

```
rank.js --self-test: PASS
  order: d2 > d1 > g2
  1. DM outranks group message: OK (d2/d1 above g1)
  2. @mention outranks plain message: OK (g2 in top 3, g1 out)
  3. newest first within a tier: OK (d2 newer than d1)
  4. cap 3: OK (6 items in, 3 out)
```

Proves: with 6 canned items, the ranker returns exactly `d2 (DM, newer) >
d1 (DM, older) > g2 (group @mention)`. The newest-overall plain group
message (`g1`) is excluded — DM-first beats raw recency.

## 2. Demo mode — server + HTTP endpoints

Command:

```bash
DEMO_MODE=1 PORT=3001 node src/index.js
curl -s http://localhost:3001/healthz
curl -s http://localhost:3001/api/top3
curl -s http://localhost:3001/api/unread
```

Server log:

```
[server] DEMO_MODE: seeded 5 canned updates (no Telegram token used)
[server] listening on http://localhost:3001 (demo=true)
```

`GET /healthz` →

```json
{"ok":true}
```

`GET /api/top3` →

```json
[
  { "chatId": "d2", "chatType": "dm", "sender": "Budi",
    "text": "Bro, jadi meet jam 7?", "time": 1795453729153, "mentionsBot": false },
  { "chatId": "d1", "chatType": "dm", "sender": "Ayu",
    "text": "Nanti kabarin ya", "time": 1795452949153, "mentionsBot": false },
  { "chatId": "g2", "chatType": "group", "sender": "Crypto Alpha",
    "text": "@glance_reply_bot tolong rangkum dong", "time": 1795453789153, "mentionsBot": true }
]
```

Order: `d2(dm) > d1(dm) > g2(group,@mention)`. `GET /api/unread` returned
5 items (the 2 excluded from the top 3 are the newest-overall plain group
message `g1` and the channel message `c1`).

Proves: end to end, the HTTP ranking works — a DM outranks a group
message, a @mention outranks a plain message, newest first within a tier
(Budi's DM above Ayu's older DM), cap of 3.

## 3. No-token start — live polling refused cleanly, server still starts

Command (token explicitly unset):

```bash
env -u TELEGRAM_BOT_TOKEN PORT=3002 node src/index.js
curl -s http://localhost:3002/healthz
curl -s http://localhost:3002/api/top3
```

Server log:

```
[telegram] TELEGRAM_BOT_TOKEN is not set — live polling DISABLED. Server still starts (empty inbox). Set TELEGRAM_BOT_TOKEN in the environment, or run with DEMO_MODE=1 for canned updates.
[server] running WITHOUT live Telegram polling (empty inbox until a token is set).
[server] listening on http://localhost:3002 (demo=false)
```

`GET /healthz` → `{"ok":true}`. `GET /api/top3` → `[]`.

Proves: without a token the server starts (no crash), refuses live
polling with a clear message, and serves an empty inbox. Both test
servers were stopped afterwards (no stray processes left).

## 4. Secret scan

Command:

```bash
grep -rniE '[0-9]{6,}:[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9]|sk-[A-Za-z0-9]{10,}|xox[baprs]-[A-Za-z0-9]|(TELEGRAM_BOT_TOKEN|GROQ_API_KEY)=[^[:space:]#]' server/
```

Result: `NO SECRET-LIKE STRINGS FOUND`. `.env.example` holds empty values
only (`TELEGRAM_BOT_TOKEN=` / `GROQ_API_KEY=`).

## 5. NOT tested (stated plainly)

**Live Telegram polling is UNTESTED.** It needs `TELEGRAM_BOT_TOKEN` in the
environment at runtime — a Toni Secure Vault handoff, not something done
here. No token was retrieved, and no token appears in any file, log, or
chat message. `getUpdates` long-poll, offset tracking, dedupe, and
`getMe`-based @mention detection are implemented but only exercised
against canned data (via `normalizeUpdate` in the demo path — the poller
itself has not hit `api.telegram.org`).
