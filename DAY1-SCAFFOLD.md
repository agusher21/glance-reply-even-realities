# Glance Reply — Day 1 Scaffold (23 Nov 2026, Even Realities hackathon)

Scaffold + simulator hello-world proof ONLY. No backend, no repo, no DoraHacks, no keys.

## What was done

1. Toolchain check + reinstall (VM restart had wiped `/usr`):
   - `npm install -g --prefix ~/.npm-global @evenrealities/evenhub-cli@latest @evenrealities/evenhub-simulator@latest`
     (both were already present at the wanted versions; global reinstall re-verified)
   - `sudo apt-get install libwebkit2gtk-4.1-0 xvfb` — webkit was MISSING after the restart
     (simulator binary failed with `libwebkit2gtk-4.1.so.0: cannot open shared object file`).
     Note: first `apt-get update` (full, with Translation files) stalled ~7 min in the
     package-list parse phase on this 1.5-CPU VM — killed it and re-ran with
     `-o Acquire::Languages=none`, which completed. One non-fatal warning:
     `mirror.cogentco.com noble-security InRelease — Connection failed` (proxy);
     install succeeded from the azure mirror anyway. Also one runtime restart
     mid-task killed the first apt run (nothing had been installed yet — verified).
2. Scaffold: `npx degit even-realities/evenhub-templates/asr glance-reply-even-realities`
   (template commit = repo HEAD at 23 Nov 2026; prep doc's pinned commit 8cb01354 was the
   20 Nov reference — degit took HEAD).
3. `npm install` (73 packages) + `npm install @evenrealities/even_hub_sdk@latest` — exit 0.
4. `evenhub init` refused: `App meta file already exists: app.json` (template ships one).
   Edited `app.json` directly instead: `package_id` → `com.tonibanzai.glancereply`,
   `name` → `Glance Reply`. Everything else left as the template shipped it.
5. Dev server: `npm run dev` → Vite ready on http://localhost:5173/ (HTTP 200).
6. Simulator headless: `xvfb-run -a evenhub-simulator http://localhost:5173 --automation-port 18081`
   → `GET /api/ping` = `pong`.

## Versions (verified 23 Nov 2026 ~17:26 UTC / 24 Nov ~00:26 WIB)

- node v24.22.1, npm 10.9.4
- evenhub CLI 0.2.0, evenhub-simulator 0.9.5
- @evenrealities/even_hub_sdk 0.0.16 (template pinned ^0.0.10)
- vite 5.4.21, libwebkit2gtk-4.1-0 2.52.6-0ubuntu0.24.04.2, xvfb 2:21.1.12-1ubuntu1.9

## Screenshot proof — VERIFIED BY EYE

- Raw API shot: `demo/day1-sim-shot.png` — 576×288 RGBA PNG from
  `GET http://localhost:18081/api/screenshot/glasses` (HTTP 200, 4235 bytes).
- **What it shows:** the glasses framebuffer renders the ASR template's startup text
  container: **"Listening…" in green on black** (top-left, 576×288 G2 frame).
- ⚠️ Viewing gotcha (cost ~15 min of debugging): the raw PNG looks SOLID GREEN in most
  image viewers. That is a viewer artifact, not a blank render — the sim exports unlit
  pixels as TRANSPARENT (alpha=0) with green RGB, and viewers that ignore/flatten alpha
  show uniform green. Pixel analysis: 219 opaque pixels in bbox (4,10,89,31) = the text
  glyphs; the rest alpha=0. Proof: `demo/day1-sim-shot-on-black.png` is the same PNG
  composited onto black — "Listening…" is clearly visible. I viewed that composited
  image myself.
- Debug trail that confirmed the render is real (not a stale frame):
  - `GET /api/console`: `[EvenAppBridge] Bridge initialized`, `[Simulator] Flutter Bridge
    intercepted: evenAppMessage`, `STT startup failed: {}` (expected — see below).
  - `RUST_LOG=debug` sim log: `CreateStartUpPageContainer` received with the 576×288
    `transcript` text container, content "Listening…"; `draw_text_container` ran;
    `active_event_container: Some(1)`.
  - Xvfb screen capture (`demo/day1-sim-window.png`, ffmpeg x11grab on :99): the sim
    window shows the webview (ASR Demo UI) on the left and "Listening…" in green on the
    glasses display on the right, plus the Up/Down/Click/Double Click/Long Press/Menu
    buttons. `POST /api/input {"action":"click"}` → `{"ok":true}`.
  - Webview shot (`demo/day1-webview-shot.png`, 600×800): ASR Demo UI renders correctly.
- Expected non-error: the web UI shows a red chip
  "STT PROVIDER NOT IMPLEMENTED — OPEN SRC/ASR/STT.TS AND WIRE UP YOUR CHOSEN STT SERVICE."
  and the console warns `VITE_STT_API_KEY is not set.` — the `asr` template's `stt.ts`
  is a blank stub by design, and Day 1 sets NO keys (none in any file, per task rules).
  The glasses "Listening…" render is unaffected. Wiring Groq Whisper is a Day-3 job.

## app.json

`package_id: com.tonibanzai.glancereply`, `name: Glance Reply`, `version: 0.1.0`,
`entrypoint: index.html`, permission: `g2-microphone` only.

## Still running? (as of 17:26 UTC / 00:26 WIB, 24 Nov)

- YES — Vite dev server on :5173 (pid 2280) and simulator under Xvfb :99 on
  automation port 18081 (both still responding: dev 200, ping `pong`).
- Honest caveat: both are background processes on this VM. A VM restart wipes /usr
  (webkit/xvfb need reinstall per §1 of the prep doc) and kills these processes —
  restart with: `npm run dev` in this dir, then
  `xvfb-run -a evenhub-simulator http://localhost:5173 --automation-port 18081`.

## Commands to resume

```bash
export PATH="$HOME/.npm-global/bin:$PATH"
cd ~/workspace/glance-reply-even-realities
npm run dev                                   # terminal 1
xvfb-run -a evenhub-simulator http://localhost:5173 --automation-port 18081  # terminal 2
curl -s http://localhost:18081/api/ping       # pong
curl -s -o demo/day1-sim-shot.png http://localhost:18081/api/screenshot/glasses
```
