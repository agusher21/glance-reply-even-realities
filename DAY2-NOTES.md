# Day 2 notes — Telegram ingest → top-3 on glasses

Date: 24 Nov 2026. Repo: github.com/agusher21/glance-reply-even-realities.
Day-2 goal: Telegram ingest end-to-end → urgency rank → top-3 ListContainer on the
glasses in the simulator, bot in a test group. STT is Day 3, not Day 2.

## What changed

- `server/src/telegram.js` — retry_after-aware backoff: on a 429 the poller parses
  "retry after N", sleeps N+2s (cap 65s); other errors keep the 5s retry.
- `server/src/index.js` — CORS: `Access-Control-Allow-Origin: *` on all JSON
  responses + `OPTIONS` → 204, so the glasses app (Vite origin) can fetch /api/top3.
- `src/main.ts` — header text container (ID 1, 576×40, "Glance Reply - top 3") +
  ListContainer (ID 2, y=40, 576×248, 3 items) via CreateStartUpPageContainer;
  polls GET /api/top3 (VITE_BACKEND_URL, default http://localhost:3001) every 5s,
  rebuilds the page with rebuildPageContainer only when the item list changes;
  empty state is ['No messages yet — DM the bot', '', '']; lines truncated to 80 chars.
- `src/ui.ts` — webview panel shows the same top-3 ("Top 3 Urgent") with HTML escaping.

## How it was built

Implementation ran in the BoxLite hermes-runner box (BoxLite → Hermes routing rule);
review fixes were applied locally by the coordinator and are marked below.

## Verification (all run locally 24 Nov ~02:20–02:30 UTC)

- `node src/rank.js --self-test` — PASS (order d2 > d1 > g2; DM > @mention > plain).
- DEMO_MODE backend: GET /api/top3 returns the 3 canned items in rank order;
  CORS header present; OPTIONS → 204.
- `npx tsc --noEmit` — PASS. `npm run build` — success (7 modules, 901ms).
- Sim screenshot VIEWED by eye: demo/day2-sim-shot-on-black.png shows the header
  "Glance Reply - top 3" and the 3 demo items in order (Budi / Ayu / Crypto Alpha
  @mention). Webview shot shows the same top-3 in the "Top 3 Urgent" panel.
- Secret scan clean (only hit is the Day-1 doc line about empty .env.example values).

## Bugs caught in review / verification (all fixed)

1. `escapeHtml` in src/ui.ts was a NO-OP (replaced each char with itself) — sender/text
   from Telegram would have been injected raw into innerHTML. Fixed locally to
   escape & < > " ' properly.
2. No line truncation on glasses list items (brief required it) — added 80-char
   truncation in src/main.ts (local fix).
3. Startup page creation FAILED in the sim: `MISSING_Z_ORDER_INDEX` — the header text
   container lacked zOrderIndex while the list had zOrderIndex: 2. Fixed locally:
   header gets zOrderIndex: 1.
4. Still failed after (3): sim log said "multiple event listeners (2) not allowed" —
   the sim/native side allows exactly ONE event-capturing container per page, and
   both header and list had isEventCapture: 1. Fixed locally: header isEventCapture: 0,
   list keeps 1. LESSON: keep exactly one isEventCapture: 1 per page; every container
   on the page needs an explicit zOrderIndex once any of them uses one.

## Live Telegram ingest — BLOCKED by Telegram flood control (not a code defect)

- Bot token (Secure Vault surrogate) retrieval PROVEN working: surrogate-carrying
  requests reach Telegram and get 429 (a valid token being throttled); a dummy token
  gets a fast 401. Token is env-only via server/run-live.py, never printed or filed.
- The 429 wall is self-inflicted: rapid getMe probes + the old fixed-5s retry loop
  kept resetting Telegram's ~32s throttle window. The new backoff was observed
  working (slept 33s, then 34s on the next 429) — but each retry still returns
  retry_after 32, i.e. the block is NOT a simple 32s countdown; it persists across
  attempts spaced 33s apart.
- Poller STOPPED 24 Nov 02:31:32 UTC to give Telegram complete silence. Next step:
  after ≥5 min of silence, make ONE single getMe probe. If it succeeds, restart the
  live backend and check /api/unread + /api/top3 for real messages, then re-verify in
  the sim. If it still 429s, wait longer (flood-control blocks can last up to ~1h)
  and retry single probes only — never hammer.
- PROBE RESULT 24 Nov 02:37:06 UTC: after ~5.5 min of complete silence (zero Telegram
  requests from this side), ONE single getMe still returned 429 retry_after 32.
  Conclusion: the block is NOT a simple 32s countdown — it is an escalated
  flood-control restriction on this bot token that outlasts a 5-min silence. Do NOT
  restart the poller (it would only re-extend the block). Next: wait 30–60 min, then
  retry with single getMe probes only, spaced minutes apart; start the live backend
  only after a single getMe succeeds. (Alternative hypothesis, unproven: the egress
  proxy's shared IP may contribute to the 429; nothing else on this VM uses the token —
  verified by process list.)
- /api/unread and /api/top3 are both [] so far: NO real Telegram message has been
  ingested yet. Nobody has DM'd @Glance_replaybot or added it to a test group with a
  message since Day 1 — that still needs a Telegram user (Toni) to do it.

## Remaining Day-3 gate

Groq Whisper STT wiring (src/asr/stt.ts stub throws "STT PROVIDER NOT IMPLEMENTED";
VITE_STT_API_KEY unset; Groq key via Secure Vault custom.groq, bearer_header).
After that: live-ingest proof above, then demo video + Devpost submission
(deadline 30 Nov 02:59 WIB, Demo Day 3 Dec 17:00–21:00 WIB).
