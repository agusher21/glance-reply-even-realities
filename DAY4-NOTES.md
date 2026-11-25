# Day 4 — One-tap send + digest mode (25 Nov 2026)

Goal: tap a draft on the glasses to send it to Telegram (POST /api/send),
plus a "digest" voice intent that summarises a chat's recent history into
3 bullets. Built LOCAL (BoxLite down all day; Toni: "gas lokal") with two
local Hermes sessions (Nemotron-3-Ultra) + coordinator review fixes.

## Architecture (unchanged)

Glasses hold NO key. Send goes through the backend:

```
glasses tap draft -> POST /api/send {voiceId, draftIndex}
  backend resolves the latest voice result -> Telegram sendMessage
  (DEMO_MODE=1 stubs it, logs the exact payload, returns "demo-<n>")
  -> glasses show '✓ Sent', auto-return to top-3 after ~3 s
voice "digest" -> POST /api/voice -> transcript == 'digest' ->
  Groq LLM summarises last 20 history messages -> 3 bullets on glasses
```

## What was built

| File | What it does |
|---|---|
| `server/src/store.js` | Per-chat history ring buffer (#history Map, max 20, oldest first); `history(chatId)` returns a COPY; `clear()` clears history too; upsert preserves `messageId`. Self-test. |
| `server/src/telegram.js` | `normalizeUpdate()` adds `messageId: msg.message_id ?? null`. |
| `server/src/index.js` | Demo seeds: 5 canned items get messageIds (d2:1001, d1:1002, g2:1003, g1:1004, c1:1005) + ~10 extra Crypto Alpha messages (1010-1019) upserted FIRST into g2 history so g2's latest stays the @mention and top-3 order is unchanged (d2 > d1 > g2). Wires POST /api/send. |
| `server/src/voice.js` | Digest intent: transcript exactly 'digest' (case-insensitive, trimmed) takes the digest path BEFORE groqDrafts — target chat = ?chatId= if it exists, else top-1 from rankUnread; history last 20 -> Groq chat (gpt-oss-120b, same UA + 429 retry) with the "EXACTLY 3 short bullets" prompt -> parseBullets. Result {mode:'digest', bullets, drafts: bullets, chatName}. Draft path adds mode:'reply' + replyToMessageId. Groq chat POST refactored into shared groqChat() helper (drafts system prompt unchanged). parseBullets exported + self-tested. |
| `server/src/send.js` (new) | POST /api/send. Pure buildSendPayload(result, draftIndex) with coded errors (no_voice_result / cannot_send_digest / bad_draft_index / no_chat); reply_to_message_id omitted when null. handleSend: body cap 64 KB (bad_json 400), resolves voice record by voiceId / chatId / latest (404 voice_not_found), DEMO stub logs `[send] DEMO stub payload: {...}` and returns messageId "demo-<n>", live path POSTs api.telegram.org (503 telegram_not_configured, 502 telegram_send_failed). Self-test. |
| `src/main.ts` | Voice list = [Draft 1, Draft 2, '✕ Dismiss']; `selectedListIndex(event)` parses `event.listEvent.currentSelectItemIndex`; tap 0/1 -> sendDraft(index), tap 2 -> dismiss; `sendDraft()` POSTs /api/send {voiceId, draftIndex}, Sent confirm + ~3 s auto-return, failure stays in voice mode with retry, sendingFlag guards double-send; digest view (header `Digest — <chatName>`, 3 bullets), any tap in digest mode returns to top-3; poller accepts digest results; Sent-window tap guard (see fixes). |
| `src/ui.ts` | setDigest() + setSent() webview panels (mutually exclusive with voice panel); escapeHtml restored (see fixes). |
| `src/asr/stt.ts` | onDrafts type extended to VoiceResult {mode, bullets, chatName, ...}; flush forwards all backend fields, no new network calls. |

## Coordinator review fixes (3 bugs the Hermes sessions shipped)

1. **escapeHtml REGRESSED to a no-op (Day-2 bug #1, third time).** Part B's
   ui.ts replaced `&`→`&amp;` etc. with identity replacements (`&`→`&`,
   `<`→`<`, …), so Telegram/LLM text would be injected raw into innerHTML.
   Fix: restored the Day-2 escaping. Proven in the sim webview: a draft
   containing `<b>bold</b> & "quoted"` renders literally.
2. **Stale Sent timer could yank a fresh voice result back to top-3.**
   showVoiceResult() never cleared a pending sentTimer, although the brief
   requires it. Fix: showVoiceResult clears sentTimer + sentShown on entry.
3. **Taps during the ~3 s Sent window re-sent the draft** (voiceMode still
   true, sendingFlag already reset). Fix: `sentShown` flag; tap handler
   ignores single taps while Sent is showing (double-tap exit + lifecycle
   cleanup still work).
4. **Bare list tap (no index) did nothing.** The sim delivers a click as a
   listEvent WITHOUT currentSelectItemIndex until an item is focused via
   up/down; the handler fell through both branches (no list index, no
   sysEvent CLICK). Fix: a listEvent with no index in voice/digest mode
   defaults to index 0 (glance default: tap = send Draft 1; any tap in
   digest mode = return to top-3). Top-3 mode unchanged.

## Verification evidence (all checked by the coordinator, not just builder claims)

- `npx tsc --noEmit` PASS, `npm run build` success (7 modules, 96.18 kB).
- Self-tests, all PASS (run by coordinator): rank (order d2 > d1 > g2),
  store (3 msgs -> history 3; 21 msgs -> capped 20), voice (parseDrafts +
  parseBullets incl. JSON array/object/numbered/quoted), send (8 cases).
- `node --check` OK on all 6 backend files. Secret scan clean.
- Dev backend DEMO_MODE=1 :3002 (coordinator's own server): /api/top3
  d2 > d1 > g2 with g2 text '@glance_reply_bot tolong rangkum dong';
  /api/voice/latest {"transcript":null,"drafts":[],"chatId":null};
  POST /api/voice (empty) 503 stt_not_configured; POST /api/send
  {"draftIndex":0} 404 voice_not_found; /api/unread 5 entries with
  messageIds 1001-1005; /healthz {"ok":true}. Server stopped afterwards.
- **Sim tap-to-send (fake backend on :3002 serving the exact Part A
  contract, Vite :5173, evenhub-simulator 0.7.3 via xvfb-run, automation
  :18081)** — all 4 phases PASS, screenshots viewed by eye (composited on
  black; raw framebuffer is RGBA with transparent background):
  - top-3 renders (byte-identical to Day 3's top-3 shot).
  - voice mode: header transcript + Draft 1 / Draft 2 / Dismiss.
  - bare click -> send log {"voiceId":99,"draftIndex":0} -> 'Sent' confirm
    showing Draft 1 text -> auto-return to top-3 after ~3 s.
  - digest mode: header 'Digest — Crypto Alpha' + 3 bullets; tap ->
    top-3, no send.
  - down + click -> {"voiceId":101,"draftIndex":1} (Draft 2 sent).
  - down down + click -> dismiss, no send, back to top-3.
  - Console log proves listEvents arrive with currentSelectItemIndex 1
    and 2. Webview shows voice/digest panels + status lines.
- selectedListIndex unit check 7/7 (exact copy of the shipped function).

## Known gaps / caveats (honest)

- **Sim 0.7.3 rejects `zOrderIndex`.** The installed simulator's Rust
  struct has no zOrderIndex field, so CreateStartUpPageContainer fails
  ("unknown field `zOrderIndex`") and the app never starts in the sim —
  the sim renders a blank green framebuffer. Day 3's sim rendered fine,
  so this is an SDK/sim version skew (SDK 0.0.16 sends zOrderIndex; sim
  0.7.3 predates it). Workaround used ONLY for the sim test: a scratch
  copy in /tmp/day4-sim-copy with the 4 zOrderIndex lines stripped
  (byte-identical otherwise); the SHIPPED repo keeps zOrderIndex (the
  SDK doc says omitting remains valid, but real hardware presumably
  accepts the field; do not ship a sim workaround). The sim test ran
  against that copy.
- **Sim font drops `✓` and `✕`.** The glasses render 'Sent' (not '✓ Sent')
  and 'Dismiss' (not '✕ Dismiss'). Labels stay unambiguous; whether real
  G2 firmware renders the glyphs is unverified — check on hardware.
- **NOT verified by the coordinator (needs parent's credentials):**
  Groq STT/LLM paths (no GROQ_API_KEY), live Telegram send (no token),
  the DEMO stub's 200 branch through the REAL backend (needs a voice
  result first — POST a WAV via the Groq dev backend, then POST /api/send
  {voiceId, draftIndex:0} and expect 200 demo-1), live-mic PCM path
  (no audio device in this VM — same gap as Day 3), double-tap exit in
  the sim (not exercised), real-hardware tap behaviour (sim delivers
  listEvents; hardware temple taps are expected as sysEvent CLICK, which
  the fallback covers by sending Draft 1).
- package-lock.json has a 2-line name-only churn (`evenhub-asr` ->
  `glance-reply`, from Part B's `npm install` re-syncing the lock name
  with package.json). No version changes. Revert at commit time if
  unwanted.
- Live backend :3001 was restarted ~12:37 WIB by the parent (Toni's
  'hidupin') from a clean Day 3 worktree (~/workspace/glance-reply-live);
  the coordinator did NOT touch it.

## How to run (dev)

```bash
# dev backend (voice + demo top-3), Groq key via vault surrogate (parent)
cd server && python3 run-voice-dev.py        # :3002, DEMO_MODE=1
# glasses app
VITE_BACKEND_URL=http://localhost:3002 npm run dev   # :5173
# simulator (headless)
xvfb-run -a evenhub-simulator http://localhost:5173 --automation-port 18081
```

Test voice without a mic: POST a 16 kHz WAV/PCM to
`http://localhost:3002/api/voice?chatId=d2`, say "digest" for the digest
path. Test send: POST `{"voiceId":<id>,"draftIndex":0}` to
`http://localhost:3002/api/send` (DEMO stub returns demo-1).
