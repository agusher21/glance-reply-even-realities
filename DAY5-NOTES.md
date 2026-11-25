# Day 5 — Polish + .ehpk pack (25 Nov 2026)

Built by one local Hermes session (Nemotron-3-Ultra, BoxLite down; local
gateway restarted once by the coordinator — see "Gateway" below), then
verified end-to-end by the coordinator in the simulator with a fake
backend. The live backend on :3001 was NOT touched.

## What changed

| File | What it does |
|---|---|
| `src/main.ts` | Tap-handler trap (prep §1) made explicit: DOUBLE_CLICK (3) first, SCROLL_TOP (1) / SCROLL_BOTTOM (2) second, CLICK (0) fallback last; `eventType` default resolved INSIDE the envelope check (`eventTypeOf`). "No network" error renders on glasses (`No network / Check connection / Tap to retry`) when the top-3 fetch fails. "STT failed" renders on glasses (`STT failed / Mic error / Tap to retry`) from the STT error callback. Header tightened to `Top 3` (was `Glance Reply - top 3`); status lines tightened. Tap-to-retry on error screens (coordinator fix, see below). |
| `app.json` | `min_app_version` 2.0.0 → 2.2.10 (the SDK 0.0.16 floor the packer was already stamping; removes the pack warning). |
| `.gitignore` | `*.ehpk` — the pack artifact stays out of git (regenerable with `npm run pack`). |
| `DAY5-NOTES.md` | This file. |

## Coordinator fix — tap-to-retry was dead code (found by review, fixed before commit)

The builder rendered the error screens but never recorded them as the
current page: `lastTop3Json` kept the previous top-3 JSON, so the CLICK
handler's `isErrorScreen` check could never match and a tap on `No
network` / `STT failed` would have toggled the mic instead of retrying.
Fix (2 sites in `src/main.ts`): the `fetchAndRenderTop3` catch sets
`lastTop3Json = JSON.stringify(['Check connection', 'Tap to retry',
''])` after rendering, and the STT error callback sets it to
`JSON.stringify(['Mic error', 'Tap to retry', ''])` — the exact JSON
expressions the CLICK handler compares against. The retry branch is now
reachable on hardware (temple tap = sysEvent CLICK). In sim 0.7.3 it is
NOT triggerable — the sim delivers taps as listEvents only, which top-3
mode ignores (see "Sim limits"). Recovery when the network returns IS
proven in the sim (5 s poller; Run B below).

## Verification evidence (all checked by the coordinator, not builder claims)

- `npx tsc --noEmit` PASS. `npm run build` PASS (7 modules, 96.78 kB, gzip 37.04 kB).
- Self-tests, all PASS: `node src/rank.js --self-test`, `store.js`, `voice.js`, `send.js` (rank order d2 > d1 > g2, store cap 20, parseDrafts/parseBullets, send 8 cases).
- `node --check` OK on all 6 backend files (`index, rank, send, store, telegram, voice`).
- Secret scan clean: only `process.env.*` references and API endpoint URLs; no key/token values; no `.env` file (only `.env.example`); `server/live.log` has no tokens.
- `escapeHtml` is a REAL escaper — verified in `src/ui.ts:124-131` (`&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;`, `"`→`&quot;`, `'`→`&#039;`). (The builder's draft note wrote this as `&`→`&` — sloppy note, code is correct.)
- `.ehpk` pack: `npm run pack` SUCCESS — `out.ehpk`, **40,006 bytes**,
  sha256 `0bca616fd9d147d118c0fb01c5bd4cc1432ba1d48e01312b24fb80b0e7547e98`,
  `min_app_version 2.2.10` (SDK 0.0.16). The file is NOT committed
  (gitignored); regenerate with `npm run pack`. Portal `create`/`upload`
  NOT attempted (needs Toni's Even Realities account).

## Simulator verification (coordinator's own runs, screenshots viewed by eye)

Setup: fake backend `/tmp/day5-fake-backend.mjs` (scratch, never in the
repo) on :3003 serving the exact app contract (`/api/top3`,
`/api/unread`, `/api/voice/latest`, `/api/send` → `{ok:true,
messageId:"demo-1"}`, `/api/voice` → 503) with CORS headers and a
`/__control` mode switch; Vite :5174 (`VITE_BACKEND_URL=
http://localhost:3003`); evenhub-simulator 0.7.3 via xvfb-run,
automation :18081. Raw glasses framebuffer is RGBA 576×288 with a
transparent background — composited on black before viewing. Screenshots
in `/tmp/day5-sim/` (`a-glasses-*.png`, `a-webview-*.png`,
`b-glasses-*.png`).

Run A (fake :3003, mode voice → digest → empty):
- Top-3 renders: header `Top 3`, Budi / Ayu / Crypto Alpha.
- Voice mode renders: header `tolong rangkum dong`, Draft 1 `Siap, saya
  rangkum ya`, Draft 2 `Oke, noted — saya balas nanti`, `Dismiss`
  (✕ glyph drops in the sim font, renders `Dismiss` — unambiguous).
- Bare click (no up/down first) → fake log proves send:
  `SEND payload: {"voiceId":99,"draftIndex":0}` — the Day 4
  bare-tap-defaults-to-0 fix holds.
- Sent confirm renders: header `Sent` (✓ drops, renders `Sent`) +
  Draft 1 text. Auto-return to Top 3 after ~3 s — verified by screenshot.
- Digest renders: header `Digest — Crypto Alpha` + 3 bullets. Tap in
  digest mode → back to Top 3, send count unchanged (1) — no send from digest.
- Empty inbox renders: `Top 3` + `No messages yet — DM the bot`.
- Up + down: screen unchanged, mic still live, sends still 1 — scroll
  events are consumed before CLICK (trap order holds in the sim).
- Double-tap exit: console shows `sysEvent eventType 3`
  (DOUBLE_CLICK_EVENT); glasses framebuffer goes fully blank — container
  shut down. (The builder's earlier double-click shot shows the same.)
- Webview voice panel verified: `VOICE REPLY READY · TAP A DRAFT TO
  SEND · TAP DISMISS TO RETURN · DOUBLE-TAP TO EXIT`, top-3 list, voice
  reply panel with transcript + both drafts.

Run B (dead backend :3999, Vite :5175, automation :18082):
- `No network / Check connection / Tap to retry` renders on load with
  nothing listening on :3999.
- Fake backend started on :3999 afterwards (`FAKE_MODE=none`) → next
  5 s poll succeeds → Top 3 renders with all 3 items. Recovery when
  the network returns is proven; the tap-to-retry branch itself is
  hardware-only (see "Sim limits").

## Sim limits / honest gaps (still unverified)

- **Sim 0.7.3 rejects `zOrderIndex`.** Proven again today:
  `CreateStartUpPageContainer` fails with `unknown field
  'zOrderIndex'` and the app never starts (blank framebuffer). Sim
  runs used a scratch copy in `/tmp/day5-sim-copy` with the 4
  `zOrderIndex` lines stripped; the SHIPPED repo keeps the field
  (verified: 4 occurrences in `src/main.ts` after restore). Do not
  ship a sim workaround.
- **Sim taps are listEvents, not sysEvent CLICK.** In top-3 mode a sim
  tap (bare or after up/down) is silently ignored — it cannot toggle
  the mic or trigger tap-to-retry. On hardware, temple taps arrive as
  sysEvent CLICK, which is the path the retry fix serves. (Pre-existing
  Day 2/3/4 behaviour; top-3 tap semantics deliberately unchanged.)
- **STT-fail screen not rendered in the sim.** The render call exists
  in the STT error callback and the callback fires on a failed
  `POST /api/voice` (e.g. 503 with no Groq key), but the sim delivers
  no PCM frames, so the buffer never flushes and the callback never
  fires here. Code-verified only.
- **NOT verified (needs credentials / hardware):** Groq STT/LLM paths
  (no GROQ_API_KEY), live Telegram send (no TELEGRAM_BOT_TOKEN), DEMO
  stub 200 through the REAL backend (needs a voice result first),
  live-mic PCM path (no audio device on this VM), real-hardware taps.
- The builder's draft notes claimed the top-3 screenshot showed
  `No messages yet` — wrong; it showed the 3 demo items. The
  coordinator's screenshots above are the verified record.
- The builder's draft also said the single click "toggles the mic" —
  in the sim it does nothing observable (see sim-tap limit above);
  the click API returns `{"ok":true}`.

## Day 4 fixes preserved (re-checked)

1. `escapeHtml` real escaper — see above.
2. Stale Sent timer cleared on new voice result — `showVoiceResult()`
   clears `sentTimer` + `sentShown` on entry (unchanged).
3. Taps ignored during the ~3 s Sent window — `sentShown` guard
   (unchanged; not re-exercised in the sim this round — the Sent
   auto-return was verified instead).
4. Bare list tap defaults to index 0 in voice/digest mode — proven
   by the `{"voiceId":99,"draftIndex":0}` send log above.

## Gateway (coordinator note, not part of the build)

The local Hermes gateway had exited cleanly at 08:45 UTC and the
auto-restart came up on the system Python 3.12.3, whose broken pydantic
broke the gateway WebSocket (`Gateway connection/read failed`). The
coordinator killed it and restarted the gateway with the tool Python
3.14.9 (`~/.hermes/tools/python-3.14.9+20261021-linux-x64/bin/python3
-m hermes_cli.main --profile default gateway run --quiet --idle-exit`,
PID 37158); the builder session then connected and ran 1145.9 s,
112 API calls. The cooking-game Hermes session (spawned 07:51 UTC
under the old gateway) is likely dead with it — the parent should
check its state before assuming the cook build is still running.
