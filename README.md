# Glance Reply — AI-drafted Telegram replies on Even Realities G2

**Track 01 Messaging & News** (+ Best Telegram integration) — Even Realities Hackathon, DoraHacks, 23–29 Nov 2026.

**Problem:** replying to a Telegram message means taking the phone out. On G2 glasses, you should be able to glance at the 3 most urgent unread items, speak a reply, pick one of two AI drafts, and send it with one tap — hands free.

**How it works:** a Telegram bot is the inbox (DM the bot, or add it to groups/channels). A Node backend polls the bot's updates, ranks the 3 most urgent unread items (DMs first, then @mentions, then recency), and serves them to the glasses app. The glasses mic records voice → Groq Whisper transcribes → Groq LLM drafts two short replies → you tap one → the backend sends it via the Telegram Bot API. A digest mode summarises a channel into 3 bullets on demand.

## Status — Day 1 (24 Nov 2026, 00:00 WIB)

- ✅ Scaffold from the Even Hub `asr` template; runs in the simulator (screenshot: `demo/day1-sim-shot-on-black.png` — "Listening…" on the 576×288 G2 framebuffer).
- ✅ Backend skeleton (`server/`): Telegram `getUpdates` long-poll client, unread store, urgency rank (DMs → @mentions → recency, cap 3), `GET /healthz` + `GET /api/top3` — verified in demo mode.
- ⏳ Not yet: STT provider wiring (the template's `stt.ts` is still a blank stub — the WebView shows "STT PROVIDER NOT IMPLEMENTED" by design), live Telegram polling (needs `TELEGRAM_BOT_TOKEN` in server env at runtime), glasses-app ↔ backend connection (Day 2), voice loop, one-tap send, digest mode, demo video, submission.

## What existed before 23 Nov 2026

- Even Hub `asr` template (MIT, github.com/even-realities/evenhub-templates) — scaffold only: Vite + TS + mic UI + STT stub.
- `@evenrealities/even_hub_sdk`, `evenhub-cli`, `evenhub-simulator` (official Even Realities tooling).
- Everything else (glance UI changes, Telegram ingest, urgency rank, voice loop, draft replies, one-tap send, digest mode) was built during the hackathon, 23–29 Nov 2026.

## Setup — glasses app

```bash
npm install
npm run dev            # Vite on http://localhost:5173
npm run simulate       # simulator (needs Xvfb headless: xvfb-run -a evenhub-simulator http://localhost:5173 --automation-port 18081)
```

Requires Node 24, Even Hub CLI 0.2.0, simulator 0.9.5 (`npm install -g --prefix ~/.npm-global @evenrealities/evenhub-cli @evenrealities/evenhub-simulator`), plus `libwebkit2gtk-4.1-0` and `xvfb` on Linux.

## Setup — backend

```bash
cd server
npm start              # live polling if TELEGRAM_BOT_TOKEN is set, else empty inbox
DEMO_MODE=1 node src/index.js   # demo: canned updates, no token needed
```

Copy `server/.env.example` to `server/.env` and fill in `TELEGRAM_BOT_TOKEN` / `GROQ_API_KEY`. **Never commit real values.**

## Honest scope

A Telegram Bot API bot can only read **messages sent to it** (DMs) and messages in **groups/channels where it is added**. It **cannot** read a user's personal Telegram inbox (that needs MTProto user-API login — heavier, privacy-sensitive, out of scope for this sprint). Glance Reply's inbox IS the bot. This is a Bot API limit, not a bug.

## Security

No API keys ship in the app. All external calls go through the backend; `app.json` currently grants only the `g2-microphone` permission — there is no `network` permission and no host whitelist yet (the glasses app talks to no external host on Day 1; the backend host will be whitelisted when the Day-2 connection lands). Tokens live in server env only, never in the repo.
