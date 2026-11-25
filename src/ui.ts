type Status = 'connecting' | 'listening' | 'paused' | 'error'

interface Top3Item {
  sender: string
  text: string
}

let statusEl: HTMLDivElement
let finalEl: HTMLSpanElement
let interimEl: HTMLSpanElement
let top3El: HTMLUListElement
let voiceEl: HTMLDivElement
let voiceTranscriptEl: HTMLDivElement
let voiceDraftsEl: HTMLUListElement
let digestEl: HTMLDivElement
let digestHeadingEl: HTMLDivElement
let digestBulletsEl: HTMLUListElement
let sentEl: HTMLDivElement
let sentTextEl: HTMLDivElement

export function mountUi() {
  const app = document.querySelector<HTMLDivElement>('#app')!
  app.innerHTML = `
    <main class="panel">
      <header>
        <h1>Glance Reply</h1>
        <div id="status" class="status status-connecting">Connecting…</div>
      </header>
      <section class="transcript" aria-live="polite">
        <span id="final"></span><span id="interim" class="interim"></span>
      </section>
      <section class="top3">
        <h2>Top 3 Urgent</h2>
        <ul id="top3" class="top3-list"></ul>
      </section>
      <section class="voice" id="voice" style="display: none;">
        <h2>Voice Reply</h2>
        <div id="voice-transcript" class="voice-transcript"></div>
        <ul id="voice-drafts" class="voice-drafts"></ul>
      </section>
      <section class="digest" id="digest" style="display: none;">
        <h2>Digest</h2>
        <div id="digest-heading" class="digest-heading"></div>
        <ul id="digest-bullets" class="digest-bullets"></ul>
      </section>
      <section class="sent" id="sent" style="display: none;">
        <h2>Sent</h2>
        <div id="sent-text" class="sent-text"></div>
      </section>
      <footer>Tap the glasses temple to pause · double-tap to exit.</footer>
    </main>
  `
  statusEl = app.querySelector<HTMLDivElement>('#status')!
  finalEl = app.querySelector<HTMLSpanElement>('#final')!
  interimEl = app.querySelector<HTMLSpanElement>('#interim')!
  top3El = app.querySelector<HTMLUListElement>('#top3')!
  voiceEl = app.querySelector<HTMLDivElement>('#voice')!
  voiceTranscriptEl = app.querySelector<HTMLDivElement>('#voice-transcript')!
  voiceDraftsEl = app.querySelector<HTMLUListElement>('#voice-drafts')!
  digestEl = app.querySelector<HTMLDivElement>('#digest')!
  digestHeadingEl = app.querySelector<HTMLDivElement>('#digest-heading')!
  digestBulletsEl = app.querySelector<HTMLUListElement>('#digest-bullets')!
  sentEl = app.querySelector<HTMLDivElement>('#sent')!
  sentTextEl = app.querySelector<HTMLDivElement>('#sent-text')!
  injectStyles()
}

export function setStatus(kind: Status, text: string) {
  if (!statusEl) return
  statusEl.className = `status status-${kind}`
  statusEl.textContent = text
}

export function setTranscript(finalText: string, interimText: string) {
  if (!finalEl) return
  finalEl.textContent = finalText
  interimEl.textContent = interimText
}

export function setTop3(items: Top3Item[]) {
  if (!top3El) return
  if (items.length === 0) {
    top3El.innerHTML = '<li class="top3-empty">No messages yet — DM the bot</li>'
    return
  }
  top3El.innerHTML = items
    .map((item) => `<li><strong>${escapeHtml(item.sender)}:</strong> ${escapeHtml(item.text)}</li>`)
    .join('')
}

export function setVoice(transcript: string, drafts: string[]) {
  if (!voiceEl || !voiceTranscriptEl || !voiceDraftsEl) return
  // Hide other panels
  voiceEl.style.display = 'block'
  if (digestEl) digestEl.style.display = 'none'
  if (sentEl) sentEl.style.display = 'none'
  voiceTranscriptEl.innerHTML = `<strong>You said:</strong> ${escapeHtml(transcript)}`
  voiceDraftsEl.innerHTML = drafts
    .map((d, i) => `<li><strong>Draft ${i + 1}:</strong> ${escapeHtml(d)}</li>`)
    .join('')
}

export function setDigest(chatName: string, bullets: string[]) {
  if (!digestEl || !digestHeadingEl || !digestBulletsEl) return
  // Hide other panels
  digestEl.style.display = 'block'
  if (voiceEl) voiceEl.style.display = 'none'
  if (sentEl) sentEl.style.display = 'none'
  digestHeadingEl.innerHTML = `<strong>Digest — ${escapeHtml(chatName)}</strong>`
  digestBulletsEl.innerHTML = bullets
    .map((b, i) => `<li><strong>Bullet ${i + 1}:</strong> ${escapeHtml(b)}</li>`)
    .join('')
}

export function setSent(draftText: string) {
  if (!sentEl || !sentTextEl) return
  // Hide other panels
  sentEl.style.display = 'block'
  if (voiceEl) voiceEl.style.display = 'none'
  if (digestEl) digestEl.style.display = 'none'
  sentTextEl.innerHTML = `<strong>Sent:</strong> ${escapeHtml(draftText)}`
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function injectStyles() {
  // ER brand dark-theme surfaces: #232323 / #2E2E2E / #3E3E3E.
  // ER OS green (#3CFA44) + signal red (#FF453A) for state chips.
  const css = `
    :root { color-scheme: dark; }
    html, body { margin: 0; height: 100%; background: #232323; color: #E5E5E5;
      font: 16px/1.4 -apple-system, BlinkMacSystemFont, 'Helvetica Neue', system-ui, sans-serif;
      touch-action: manipulation; -webkit-text-size-adjust: 100%;
      overscroll-behavior: none; }
    #app { display: flex; height: 100%; }
    .panel { display: flex; flex-direction: column; gap: 16px;
      width: 100%; max-width: 640px; margin: 0 auto; padding: 24px; box-sizing: border-box; }
    header { display: flex; align-items: center; justify-content: space-between; }
    h1 { font-size: 18px; font-weight: 600; margin: 0; letter-spacing: 0.02em; }
    .status { font-size: 12px; padding: 4px 10px; border-radius: 999px;
      border: 1px solid transparent; letter-spacing: 0.04em; text-transform: uppercase; }
    .status-connecting { color: #A7A7A7; border-color: #3E3E3E; }
    .status-listening  { color: #3CFA44; border-color: #3CFA44; background: rgba(60,250,68,0.08); }
    .status-paused     { color: #E5E5E5; border-color: #7B7B7B; background: rgba(229,229,229,0.06); }
    .status-error      { color: #FF453A; border-color: #FF453A; background: rgba(255,69,58,0.08); }
    .transcript { flex: 1; overflow: auto; background: #2E2E2E; border: 1px solid #3E3E3E;
      color: #E5E5E5;
      border-radius: 12px; padding: 20px; font-size: 18px; line-height: 1.5;
      min-height: 180px; white-space: pre-wrap; word-break: break-word; }
    .interim { color: #919191; }
    .top3 { background: #2E2E2E; border: 1px solid #3E3E3E; border-radius: 12px; padding: 16px; }
    .top3 h2 { font-size: 14px; font-weight: 600; margin: 0 0 12px; color: #A7A7A7; text-transform: uppercase; letter-spacing: 0.04em; }
    .top3-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .top3-list li { font-size: 15px; line-height: 1.4; color: #E5E5E5; white-space: normal; word-break: break-word; }
    .top3-list li strong { color: #3CFA44; }
    .top3-empty { color: #7B7B7B; font-style: italic; text-align: center; padding: 16px 0; }
    .voice { background: #2E2E2E; border: 1px solid #3E3E3E; border-radius: 12px; padding: 16px; }
    .voice h2 { font-size: 14px; font-weight: 600; margin: 0 0 12px; color: #A7A7A7; text-transform: uppercase; letter-spacing: 0.04em; }
    .voice-transcript { font-size: 15px; line-height: 1.4; color: #E5E5E5; margin-bottom: 12px; padding: 12px; background: #3E3E3E; border-radius: 8px; }
    .voice-transcript strong { color: #3CFA44; }
    .voice-drafts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .voice-drafts li { font-size: 15px; line-height: 1.4; color: #E5E5E5; padding: 10px; background: #3E3E3E; border-radius: 8px; }
    .voice-drafts li strong { color: #FFD600; }
    .digest { background: #2E2E2E; border: 1px solid #3E3E3E; border-radius: 12px; padding: 16px; }
    .digest h2 { font-size: 14px; font-weight: 600; margin: 0 0 12px; color: #A7A7A7; text-transform: uppercase; letter-spacing: 0.04em; }
    .digest-heading { font-size: 15px; line-height: 1.4; color: #E5E5E5; margin-bottom: 12px; padding: 12px; background: #3E3E3E; border-radius: 8px; }
    .digest-heading strong { color: #3CFA44; }
    .digest-bullets { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .digest-bullets li { font-size: 15px; line-height: 1.4; color: #E5E5E5; padding: 10px; background: #3E3E3E; border-radius: 8px; }
    .digest-bullets li strong { color: #FFD600; }
    .sent { background: #2E2E2E; border: 1px solid #3E3E3E; border-radius: 12px; padding: 16px; }
    .sent h2 { font-size: 14px; font-weight: 600; margin: 0 0 12px; color: #A7A7A7; text-transform: uppercase; letter-spacing: 0.04em; }
    .sent-text { font-size: 15px; line-height: 1.4; color: #E5E5E5; padding: 12px; background: #3E3E3E; border-radius: 8px; }
    .sent-text strong { color: #3CFA44; }
    footer { font-size: 12px; color: #7B7B7B; text-align: center; }
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}