import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  OsEventTypeList,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import { startSttStream } from './asr/stt'
import { mountUi, setStatus, setTranscript, setTop3, setVoice, setDigest, setSent } from './ui'

mountUi()

const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL as string) ?? 'http://localhost:3001'

const bridge = await waitForEvenAppBridge()

// Header text container (containerID 1)
const headerText = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 40,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: 4,
  containerID: 1,
  containerName: 'header',
  content: 'Glance Reply - top 3',
  isEventCapture: 0, // sim allows exactly ONE event-capturing container per page — the list holds it
  zOrderIndex: 1,
})

// List container (containerID 2) - full width, rest of the 288px height
const listContainer = new ListContainerProperty({
  xPosition: 0,
  yPosition: 40,
  width: 576,
  height: 248,
  borderWidth: 0,
  borderColor: 5,
  borderRadius: 0,
  paddingLength: 4,
  containerID: 2,
  containerName: 'top3list',
  itemContainer: new ListItemContainerProperty({
    itemCount: 3,
    itemWidth: 576,
    isItemSelectBorderEn: 0,
    itemName: ['No messages yet — DM the bot', '', ''],
  }),
  isEventCapture: 1,
  zOrderIndex: 2,
})

const created = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({ containerTotalNum: 2, textObject: [headerText], listObject: [listContainer] }),
)
if (created !== 0) {
  setStatus('error', `createStartUpPageContainer failed: ${created}`)
  console.error('Failed to create startup page')
}

let lastTop3Json = ''
let pollTimer: number | null = null

// STT client handle — declared up here (not in the STT wiring section below)
// because fetchAndRenderTop3() runs first and calls stt?.setContext().
// Declaring it below caused a TDZ crash: "Cannot access 'stt' before
// initialization" on the very first fetch, which left the glasses stuck on
// the empty startup page.
let stt: ReturnType<typeof startSttStream> | null = null
let voicePollTimer: number | null = null

let voiceMode = false
let digestMode = false
let lastVoiceId: number | null = null
let currentVoiceResult: { id: number; transcript: string; drafts: string[]; chatId: string | null; mode?: string; bullets?: string[]; chatName?: string } | null = null
let sendingFlag = false
let sentTimer: number | null = null
let sentShown = false // true while the '✓ Sent' confirm is displayed (~3 s)

// Shared render helper for both top-3, voice, and digest pages
function renderGlassesPage(headerContent: string, items: string[]) {
  const newListContainer = new ListContainerProperty({
    xPosition: 0,
    yPosition: 40,
    width: 576,
    height: 248,
    borderWidth: 0,
    borderColor: 5,
    borderRadius: 0,
    paddingLength: 4,
    containerID: 2,
    containerName: 'top3list',
    itemContainer: new ListItemContainerProperty({
      itemCount: 3,
      itemWidth: 576,
      isItemSelectBorderEn: 0,
      itemName: items,
    }),
    isEventCapture: 1,
    zOrderIndex: 2,
  })

  const newHeaderText = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 40,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: 1,
    containerName: 'header',
    content: headerContent,
    isEventCapture: 0,
    zOrderIndex: 1,
  })

  bridge.rebuildPageContainer(
    new RebuildPageContainer({ containerTotalNum: 2, textObject: [newHeaderText], listObject: [newListContainer] }),
  )
}

function truncateTo80(s: string): string {
  return s.length > 80 ? s.slice(0, 77) + '...' : s
}

// Pure helper: extract selected list index from an EvenHubEvent if present.
// Returns 0, 1, 2 for the three list items, or null if no list event/index.
// SDK evidence: List_ItemEvent.currentSelectItemIndex (number) arrives in event.listEvent.
function selectedListIndex(event: EvenHubEvent): number | null {
  const idx = event.listEvent?.currentSelectItemIndex
  return typeof idx === 'number' ? idx : null
}

async function fetchAndRenderTop3() {
  try {
    const res = await fetch(`${BACKEND_URL}/api/top3`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const items = await res.json()

    // Map to Top3Item shape for UI
    const top3Items = items.map((item: any) => ({ sender: item.sender, text: item.text }))
    setTop3(top3Items)

    // Build list itemName array (one line per item, truncated to fit 576px)
    const toLine = (sender: string, text: string) => {
      const line = `${sender}: ${text}`
      return truncateTo80(line)
    }
    const itemName = items.length === 0
      ? ['No messages yet — DM the bot', '', '']
      : items.map((item: any) => toLine(item.sender, item.text)).concat(Array(3 - items.length).fill(''))

    const currentJson = JSON.stringify(itemName)
    if (currentJson === lastTop3Json) return
    lastTop3Json = currentJson

    // Update STT context with top-1 chatId (or null)
    const top1ChatId = items.length > 0 ? items[0].chatId : null
    stt?.setContext(top1ChatId)

    // Skip glasses rebuild while voice/digest mode is active
    if (voiceMode || digestMode) return

    renderGlassesPage('Top 3', itemName)
    setStatus('listening', 'Top 3 loaded · tap to pause mic · double-tap to exit')
  } catch (err) {
    console.error('Failed to fetch top3: ' + (err instanceof Error ? err.message + ' | ' + err.stack : String(err)))
    // Render network error on glasses (not just webview)
    if (!voiceMode && !digestMode) {
      renderGlassesPage('No network', ['Check connection', 'Tap to retry', ''])
      // Record the error screen as the current page, or the CLICK handler's
      // isErrorScreen check can never match and a tap would toggle the mic
      // instead of retrying the fetch.
      lastTop3Json = JSON.stringify(['Check connection', 'Tap to retry', ''])
      setStatus('error', 'No network — tap to retry')
    }
  }
}

function showVoiceResult(result: { id: number; transcript: string; drafts: string[]; chatId: string | null; mode?: string; bullets?: string[]; chatName?: string }) {
  // A new voice result cancels any pending Sent auto-return timer —
  // otherwise the stale timer would yank this fresh result back to top-3.
  if (sentTimer !== null) {
    clearTimeout(sentTimer)
    sentTimer = null
  }
  sentShown = false

  const isDigest = result.mode === 'digest'

  if (isDigest) {
    digestMode = true
    voiceMode = false
  } else {
    voiceMode = true
    digestMode = false
  }
  lastVoiceId = result.id
  currentVoiceResult = result

  if (isDigest) {
    const header = truncateTo80(`Digest — ${result.chatName ?? 'chat'}`)
    const items = (result.bullets ?? []).map(truncateTo80).concat(Array(3 - (result.bullets?.length ?? 0)).fill(''))
    renderGlassesPage(header, items)
    setDigest(result.chatName ?? 'chat', result.bullets ?? [])
    setStatus('listening', 'Digest ready · tap to return · double-tap to exit')
  } else {
    const header = truncateTo80(result.transcript)
    // Three items: Draft 1, Draft 2, "✕ Dismiss"
    const draftItems = (result.drafts ?? []).map(truncateTo80)
    const items = [
      draftItems[0] ?? '',
      draftItems[1] ?? '',
      '✕ Dismiss',
    ]
    renderGlassesPage(header, items)
    setVoice(result.transcript, result.drafts ?? [])
    setStatus('listening', 'Voice reply ready · tap a draft to send · tap Dismiss to return · double-tap to exit')
  }
}

// Initial fetch
await fetchAndRenderTop3()

// Poll every 5 seconds
pollTimer = window.setInterval(fetchAndRenderTop3, 5000)

// Voice result poller (same cadence)
async function pollVoiceLatest() {
  try {
    const res = await fetch(`${BACKEND_URL}/api/voice/latest`)
    if (!res.ok) return
    const result = await res.json()
    if (result.id && result.id !== lastVoiceId && (result.transcript || result.mode === 'digest')) {
      showVoiceResult(result)
    }
  } catch (err) {
    console.error('Failed to poll voice latest:', err)
  }
}
voicePollTimer = window.setInterval(pollVoiceLatest, 5000)

// STT wiring (stt declared above fetchAndRenderTop3 — see the TDZ note there)
try {
  stt = startSttStream(
    BACKEND_URL,
    ({ finalText, interimText }) => {
      setTranscript(finalText, interimText)
    },
    (err) => {
      const msg = `STT error: ${(err as Error)?.message ?? err}`
      setStatus('error', msg)
      console.error('STT error:', err)
      // Render STT error on glasses
      if (!voiceMode && !digestMode) {
        renderGlassesPage('STT failed', ['Mic error', 'Tap to retry', ''])
        // Record the error screen as the current page so a tap retries the
        // fetch (see the isErrorScreen check in the CLICK handler).
        lastTop3Json = JSON.stringify(['Mic error', 'Tap to retry', ''])
        setStatus('error', 'STT failed — tap to retry')
      }
    },
    (result) => {
      showVoiceResult(result)
    },
  )
} catch (err) {
  setStatus('error', (err as Error)?.message ?? 'STT startup failed')
  console.error('STT startup failed:', err)
}

let micOn = false
if (stt) {
  await bridge.audioControl(true)
  micOn = true
  setStatus('listening', 'Microphone live · tap to pause · double-tap to exit')
}

function toggleMic() {
  if (!stt) return
  micOn = !micOn
  bridge.audioControl(micOn)
  setStatus(
    micOn ? 'listening' : 'paused',
    micOn ? 'Microphone live · tap to pause · double-tap to exit' : 'Paused · tap to resume · double-tap to exit',
  )
}

async function sendDraft(draftIndex: number) {
  if (sendingFlag) return
  if (!currentVoiceResult) return
  if (currentVoiceResult.mode === 'digest') return // cannot send from digest

  sendingFlag = true
  const voiceId = currentVoiceResult.id

  try {
    const res = await fetch(`${BACKEND_URL}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voiceId, draftIndex }),
    })

    if (res.ok) {
      const data = await res.json()
      if (data.ok) {
        // Show Sent confirm
        const sentText = currentVoiceResult.drafts[draftIndex] ?? ''
        setSent(sentText)
        setStatus('listening', '✓ Sent · back to top 3')
        // Render Sent on glasses: header '✓ Sent', list = [sent draft, '', '']
        renderGlassesPage('✓ Sent', [truncateTo80(sentText), '', ''])
        sentShown = true

        // Clear any pending sent timer
        if (sentTimer !== null) clearTimeout(sentTimer)
        // After ~3s return to top-3
        sentTimer = window.setTimeout(() => {
          sentShown = false
          sentTimer = null
          voiceMode = false
          digestMode = false
          lastTop3Json = ''
          fetchAndRenderTop3()
          // keep lastVoiceId so poller doesn't re-show
        }, 3000)
        return
      }
    }

    // Non-200 or ok:false
    const errText = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${errText}`)
  } catch (err) {
    console.error('Send failed:', err)
    // Show error, stay in voice mode with drafts
    setStatus('error', 'Send failed — tap a draft to retry')
    // Re-render voice view with stored result
    if (currentVoiceResult && currentVoiceResult.mode !== 'digest') {
      showVoiceResult(currentVoiceResult)
    }
  } finally {
    sendingFlag = false
  }
}

let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  bridge.audioControl(false)
  stt?.close()
  if (pollTimer !== null) clearInterval(pollTimer)
  if (voicePollTimer !== null) clearInterval(voicePollTimer)
  if (sentTimer !== null) clearTimeout(sentTimer)
  unsubscribe()
}

// Reads the event type out of one envelope.
//
// CLICK_EVENT is 0, and protobuf omits zero-value fields on the wire, so a
// single tap arrives as an envelope whose `eventType` is `undefined`. The
// default has to be resolved INSIDE the envelope check. Writing
// `event.sysEvent?.eventType ?? OsEventTypeList.CLICK_EVENT` instead would
// read CLICK on events that carry no `sysEvent` at all — and in this template
// that means every incoming audio frame would fire the tap handler.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

// Event routing, critical details:
//   • Taps/double-taps/lifecycle come through `event.sysEvent`.
//     Audio PCM frames come through `event.audioEvent` — separate branch.
//   • List item taps come through `event.listEvent` with `currentSelectItemIndex`.
//   • Tap-handler trap (prep §1): DOUBLE_CLICK (3), SCROLL_TOP (1),
//     SCROLL_BOTTOM (2) matched FIRST; CLICK (0) is the fallback checked LAST.
//     `eventType` default resolved INSIDE the envelope check (eventTypeOf).
//   • Double-tap → `shutDownPageContainer(1)` is a root-level check: it
//     must fire no matter which envelope the event arrives in, so users
//     can always exit the app. System exit confirmation dialog appears;
//     SYSTEM_EXIT_EVENT fires on confirm and we clean up there.
const unsubscribe = bridge.onEvenHubEvent((event: EvenHubEvent) => {
  const pcm = event.audioEvent?.audioPcm
  if (pcm) stt?.sendPcm(pcm)

  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)

  // 1. DOUBLE_CLICK — always exit, highest priority
  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    bridge.shutDownPageContainer(1)
    return
  }

  // 2. SCROLL_TOP / SCROLL_BOTTOM — navigation events (matched before CLICK)
  // On the G2, these come from the touchpad scroll zones. We handle them
  // for completeness; with only 3 items there's nowhere to scroll, so they
  // are no-ops but explicitly consumed so they don't fall through to CLICK.
  if (sysType === OsEventTypeList.SCROLL_TOP_EVENT || sysType === OsEventTypeList.SCROLL_BOTTOM_EVENT ||
      textType === OsEventTypeList.SCROLL_TOP_EVENT || textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    // No-op: list is only 3 items, no scroll needed. Consumed to keep
    // the trap order correct (scroll before click).
    return
  }

  // While the Sent confirm is showing (~3 s), ignore single taps — otherwise
  // a tap on the Sent page would re-send the same draft. Lifecycle events
  // (SYSTEM_EXIT / ABNORMAL_EXIT) still fall through to cleanup below.
  const isLifecycle = sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT
  if (sentShown && !isLifecycle) return

  // List item selection (tap on a list item) — arrives as listEvent.
  // currentSelectItemIndex is present when an item is focused/selected
  // (sim: after up/down navigation; hardware: the focused item). A list tap
  // with NO index (sim bare click, or firmware that never populates the
  // field) defaults to the top item (index 0) — the glance default: tap =
  // send Draft 1. Never invent an index; 0 is the focused/default item
  // when no selection is reported.
  const listIdx = selectedListIndex(event)
  if (event.listEvent && (voiceMode || digestMode)) {
    const idx = listIdx ?? 0
    if (voiceMode) {
      if (idx === 0 || idx === 1) {
        sendDraft(idx)
      } else if (idx === 2) {
        // Dismiss (item 2 = "✕ Dismiss")
        voiceMode = false
        lastTop3Json = ''
        fetchAndRenderTop3()
        // keep lastVoiceId so the voice poller does NOT re-show the dismissed result
      }
    } else if (digestMode) {
      // glance-friendly: any tap in digest mode returns to top-3
      digestMode = false
      lastTop3Json = ''
      fetchAndRenderTop3()
      // keep lastVoiceId so the poller does not re-show the digest
    }
    return
  }

  // 3. CLICK — fallback checked LAST (after DOUBLE_CLICK, SCROLL_TOP, SCROLL_BOTTOM)
  if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
    if (voiceMode) {
      // Fallback: if SDK exposes no per-item index, a plain tap sends Draft 1 (top item).
      // SDK evidence: List_ItemEvent.currentSelectItemIndex exists and is parsed above.
      // This branch only runs when listEvent is absent (e.g., tap on header area).
      sendDraft(0)
    } else if (digestMode) {
      // Fallback for digest: same as list tap
      digestMode = false
      lastTop3Json = ''
      fetchAndRenderTop3()
    } else {
      // Top-3 mode: if we're showing an error screen, retry; otherwise toggle mic
      const isErrorScreen = lastTop3Json === JSON.stringify(['Check connection', 'Tap to retry', '']) ||
                            lastTop3Json === JSON.stringify(['Mic error', 'Tap to retry', ''])
      if (isErrorScreen) {
        fetchAndRenderTop3()
      } else {
        toggleMic()
      }
    }
    return
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    cleanup()
  }
})

window.addEventListener('beforeunload', cleanup)