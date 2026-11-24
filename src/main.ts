import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  OsEventTypeList,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
} from '@evenrealities/even_hub_sdk'
import { startSttStream } from './asr/stt'
import { mountUi, setStatus, setTranscript, setTop3, setVoice } from './ui'

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
let lastVoiceId: number | null = null

// Shared render helper for both top-3 and voice pages
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

    // Skip glasses rebuild while voice mode is active
    if (voiceMode) return

    renderGlassesPage('Glance Reply - top 3', itemName)
  } catch (err) {
    console.error('Failed to fetch top3: ' + (err instanceof Error ? err.message + ' | ' + err.stack : String(err)))
  }
}

function showVoiceResult(result: { id: number; transcript: string; drafts: string[]; chatId: string | null }) {
  voiceMode = true
  lastVoiceId = result.id

  const header = truncateTo80(result.transcript)
  const items = (result.drafts ?? []).map(truncateTo80).concat(Array(3 - (result.drafts?.length ?? 0)).fill(''))

  renderGlassesPage(header, items)
  setVoice(result.transcript, result.drafts ?? [])
  setStatus('listening', `Voice reply ready · tap to dismiss · double-tap to exit`)
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
    if (result.id && result.id !== lastVoiceId && result.transcript) {
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
      setStatus('error', `STT error: ${(err as Error)?.message ?? err}`)
      console.error('STT error:', err)
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

let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  bridge.audioControl(false)
  stt?.close()
  if (pollTimer !== null) clearInterval(pollTimer)
  if (voicePollTimer !== null) clearInterval(voicePollTimer)
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
//   • Double-tap → `shutDownPageContainer(1)` is a root-level check: it
//     must fire no matter which envelope the event arrives in, so users
//     can always exit the app. System exit confirmation dialog appears;
//     SYSTEM_EXIT_EVENT fires on confirm and we clean up there.
//   • Check DOUBLE_CLICK_EVENT before CLICK_EVENT.
const unsubscribe = bridge.onEvenHubEvent((event) => {
  const pcm = event.audioEvent?.audioPcm
  if (pcm) stt?.sendPcm(pcm)

  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)

  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    bridge.shutDownPageContainer(1)
    return
  }

  if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
    if (voiceMode) {
      // Exit voice mode, back to top-3. Keep lastVoiceId so the voice
      // poller does NOT re-show the dismissed result 5s later; reset
      // lastTop3Json so fetchAndRenderTop3 actually re-renders the
      // glasses (it early-returns when the top-3 list is unchanged).
      voiceMode = false
      lastTop3Json = ''
      fetchAndRenderTop3() // immediate re-render of top-3
    } else {
      toggleMic()
    }
    return
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    cleanup()
  }
})

window.addEventListener('beforeunload', cleanup)