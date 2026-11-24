# Day 3 — Voice loop (24 Nov 2026)

Goal: G2 mic PCM (s16le 16kHz mono) → Groq Whisper STT → transcript on
glasses → Groq LLM drafts 2 short replies (≤100 chars each) → drafts on
glasses. Plus retry-on-429 + Deepgram fallback stubbed.

## Architecture (chosen, do not deviate)

The glasses app holds **no Groq key**. Voice goes through the backend:

```
glasses mic PCM --audio/pcm--> POST /api/voice?chatId=...
  backend wraps PCM in a WAV header, calls Groq Whisper
  (whisper-large-v3-turbo), then Groq LLM (openai/gpt-oss-120b)
  for 2 drafts --> { transcript, drafts, chatId }
glasses poll GET /api/voice/latest every 5s (renders results from any path)
```

Why the poll exists: the simulator has **no audio-injection API** — it only
emits `audioEvents` (16 kHz s16le PCM, 100 ms/event) from a real audio input
device, and this VM has none. The poll is the sim-verification route for the
backend + render paths; the live-mic path (`sendPcm` → batch POST → onDrafts)
is implemented but not exercised end-to-end in the sim (see "Remaining gap").

Secrets: Groq key ONLY via Secure Vault `custom.groq` (bearer_header
surrogate), fetched by `server/run-voice-dev.py` and passed as `GROQ_API_KEY`
to the node process. Never printed, never stored in a file, never committed.
No keys in `app.json` or the repo. Every Groq call carries a browser
User-Agent (api.groq.com is behind Cloudflare — a non-browser UA gets
HTTP 403 error 1010).

## What was built

Built in the BoxLite Hermes runner box (`hermes-runner-dac60648`), Part A
(backend) + Part B (glasses), downloaded and reviewed locally. Local review
found and fixed 3 real bugs (below) — the box's `tsc`/`vite build` passing
did not catch them.

| File | What it does |
|---|---|
| `server/src/voice.js` (new) | `wrapPcmToWav`, `parseDrafts`, `handleVoice` (POST `/api/voice`), `getLatestVoice` (GET `/api/voice/latest`). Groq Whisper + 429 retry honoring `retry-after` (FormData rebuilt inside the retry loop — a body sent once must never be re-sent), Deepgram fallback if `DEEPGRAM_API_KEY` set, Groq LLM drafts. 503 `stt_not_configured` without a key, 503 `stt_unavailable` on total STT failure. 5 MB body cap, RIFF sniffing (WAV vs raw PCM). |
| `server/src/index.js` | Wired POST `/api/voice` + GET `/api/voice/latest`; CORS methods now `GET, POST, OPTIONS`. |
| `server/run-voice-dev.py` (new) | Fetches the `custom.groq` surrogate, execs node with `GROQ_API_KEY` set, PORT=3002, DEMO_MODE=1. |
| `src/asr/stt.ts` (rewritten) | `startSttStream(backendUrl, onSnapshot, onError, onDrafts)` — NO apiKey param. Batches 96,000 bytes = 3 s PCM, POSTs raw PCM (`Content-Type: audio/pcm`) to `${backendUrl}/api/voice?chatId=...`, one request at a time. `setContext(chatId)`, `close()` flushes remaining buffer best-effort (5 s cap). Throws if backendUrl empty, never POSTs without audio. |
| `src/ui.ts` | Voice section + `setVoice(transcript, drafts)` (escaped HTML). |
| `src/main.ts` | Removed all `VITE_STT_API_KEY` handling. Shared `renderGlassesPage(header, items)` helper (header ID 1 `zOrderIndex: 1` `isEventCapture: 0`; list ID 2 `zOrderIndex: 2` `isEventCapture: 1`; the old `scheduleGlassesRender`/`textContainerUpgrade` path with the mismatched containerName `'transcript'` is deleted). `voiceMode` + `lastVoiceId`; `showVoiceResult` (header = transcript ≤80 chars, items = drafts ≤80 chars) wired to `stt.onDrafts` AND the 5 s `/api/voice/latest` poll (id-diff check). Top-3 poller calls `stt.setContext(top1 chatId)` and skips glasses rebuild in voiceMode. Tap in voiceMode exits to top-3 (and re-renders immediately); tap in top-3 mode toggles mic; double-tap still exits via `shutDownPageContainer(1)`. Event-envelope trap preserved (`eventType` resolved inside the envelope check; CLICK fallback last). |

Live backend (`:3001`, polling as @Glance_replaybot) was NOT touched. Dev
backend runs on `:3002` (`DEMO_MODE=1`, canned top-3). Vite dev on `:5173`
with `VITE_BACKEND_URL=http://localhost:3002`.

## Local review fixes (3 bugs the box build missed)

1. **TDZ crash — glasses stuck on the empty startup page.** Part B added
   `stt?.setContext(top1ChatId)` inside `fetchAndRenderTop3()`, but `let stt`
   was declared in the STT wiring section *below* the first
   `await fetchAndRenderTop3()` call. First fetch threw
   `Cannot access 'stt' before initialization`, the catch swallowed it, and
   `lastTop3Json` was already set — so every later poll early-returned and
   the glasses never rendered the top-3. Fix: hoisted the `let stt`
   declaration above `fetchAndRenderTop3` (with a comment explaining why).
   Found by adding a temporary debug log that printed `err.message` as a
   string — the sim console serializes Error objects as `{}`.
2. **escapeHtml REGRESSED to a no-op (Day-2 bug #1, back).** The box's
   `ui.ts` replaced `&`→`&amp;` etc. with identity replacements
   (`&`→`&`, `<`→`<`, …), so Telegram text / LLM drafts would be injected
   raw into `innerHTML`. Fix: restored the Day-2 escaping from HEAD.
3. **Tap-to-dismiss was broken two ways.** (a) The tap handler called
   `fetchAndRenderTop3()`, which early-returns when the top-3 list is
   unchanged — so the glasses never re-rendered after dismiss. Fix: reset
   `lastTop3Json = ''` before the call. (b) It set `lastVoiceId = null`,
   so the voice poller re-showed the same result 5 s later. Fix: keep
   `lastVoiceId` on dismiss (the poller's id check then skips it).

Also improved: the `fetchAndRenderTop3` catch now logs `err.message` as a
string instead of the Error object (sim console shows objects as `{}`).

## Verification evidence (all viewed by eye, 576×288, composited on black)

- `npx tsc --noEmit` PASS, `npm run build` success (7 modules, 92.44 kB).
- **Backend e2e (dev `:3002`, Groq surrogate):** POST 16 kHz WAV
  (`?chatId=d2`) → id=1, transcript `"Sounds good. Let's meet at 7."`
  (exact), drafts `["Sure, see you at 7!", "Got it, I'll be there at 7."]`,
  `originalText` `"Bro, jadi meet jam 7?"` (store lookup worked). POST raw
  PCM (wrap path) → id=2, same transcript. No 429s. Also re-verified after
  the review fixes (fresh backend): id=1, same transcript/drafts.
- **Top-3 on glasses** (`demo/day3-top3.png`): header
  `Glance Reply - top 3`, items `Budi: Bro, jadi meet jam 7?` /
  `Ayu: Nanti kabarin ya` / `Crypto Alpha: @glance_reply_bot tolong rangkum dong`.
  Sim debug log shows the `RebuildPageContainer` call; console zero errors.
- **Voice mode on glasses** (`demo/day3-voice.png`): header
  `Sounds good. Let's meet at 7.`, items `Sure thing, see you at 7!` /
  `Got it, I'll be there at 7.` — rendered via the 5 s `/api/voice/latest`
  poll after the POST above. Webview (`demo/day3-voice-webview.png`)
  confirms: status `VOICE REPLY READY · TAP TO DISMISS · DOUBLE-TAP TO EXIT`
  + `VOICE REPLY` panel with `You said:` + `Draft 1:` / `Draft 2:`.
- **Tap-to-dismiss** (`demo/day3-dismissed.png`): the sim's touchpad
  `click` routes to the active event container as a *list* event when the
  list holds capture, so it cannot exercise the tap branch directly. Proven
  with a temporary flip (header captures, list doesn't — reverted right
  after): click arrived as `sysEvent` (`eventSource: 1`, type omitted = 0 =
  CLICK), glasses returned to top-3, and stayed there through 2+ poll
  cycles (screenshots at +6 s and +13 s byte-identical top-3). Sim log
  rebuild sequence for that run: top-3 → voice (stale id=1) → voice
  (fresh id=2) → top-3 (dismiss). The flip was reverted immediately
  (`isEventCapture`: header 0, list 1, both places) and the shipped config
  re-verified end-to-end (top-3 + voice screenshots above, zero console
  errors).
- **Secret scan clean:** no key material in any repo text file
  (`gsk_`, `sk-…`, `GROQ_API_KEY=` with a value, etc.); only
  `.env.example` templates exist.

## BoxLite dispatch lesson (recorded)

A BoxLite exec reporting "completed" with `exit_code -1` does NOT mean the
Hermes task failed — the agent continues detached via
`process_supervisor.sh` and writes its report to the box-side
`/workspace/<task>.out` minutes later. Always re-check that file after a
delay and download the changed files directly; never trust the exec exit
code alone. (Both Part A and Part B reported -1 + empty `out` and both
completed fully.)

## Remaining gap (needs real hardware)

- **Live-mic PCM path not exercised end-to-end in the sim.** The sim log
  shows `ALSA: cannot find card '0'` / `Unknown PCM default` /
  `AudioControl error: The requested device is no longer available` — this
  VM has no audio input device, so no `audioEvents` are ever emitted, so
  `stt.sendPcm` → batch POST → `onDrafts` never runs here. The backend +
  render paths are proven with injected audio (above); the mic path needs
  real G2 hardware or a virtual audio device.
- **Tap-to-dismiss on real hardware** is the template's standard sysEvent
  CLICK branch (proven in the sim only via the temporary capture flip, see
  above). On real G2 a temple tap arrives as sysEvent CLICK; the sim cannot
  produce one while the list holds event capture.
- Flush is purely size-based (96,000 bytes = 3 s): a short utterance followed
  by silence only flushes once enough further frames (including silence)
  arrive, or on `close()`. No VAD/silence-based flush yet.

## How to run (dev)

```bash
# dev backend (voice + demo top-3), Groq key via vault surrogate
cd server && python3 run-voice-dev.py        # :3002, DEMO_MODE=1
# glasses app
VITE_BACKEND_URL=http://localhost:3002 npm run dev   # :5173
# simulator (headless)
xvfb-run -a evenhub-simulator http://localhost:5173 --automation-port 18081
```

Test voice without a mic: POST a 16 kHz WAV/PCM to
`http://localhost:3002/api/voice?chatId=d2` and watch the glasses pick it up
on the next 5 s poll. Test audio in `/tmp` (NOT committed):
`day3-test-voice-16k.wav` / `day3-test-voice.pcm` (flite-generated,
`"Sounds good, let's meet at seven."`).
