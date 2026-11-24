import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
} from '@evenrealities/even_hub_sdk'
import { startSttStream } from './asr/stt'
import { mountUi, setStatus, setTranscript, setTop3 } from './ui'

mountUi()

const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL as string) ?? 'http://localhost:3001'

const API_KEY = import.meta.env.VITE_STT_API_KEY as string
if (!API_KEY) {
  setStatus('error', 'VITE_STT_API_KEY not set — copy .env.example to .env.local')
  console.warn('VITE_STT_API_KEY is not set.')
}

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
      return line.length > 80 ? line.slice(0, 77) + '...' : line
    }
    const itemName = items.length === 0
      ? ['No messages yet — DM the bot', '', '']
      : items.map((item: any) => toLine(item.sender, item.text)).concat(Array(3 - items.length).fill(''))

    const currentJson = JSON.stringify(itemName)
    if (currentJson === lastTop3Json) return
    lastTop3Json = currentJson

    // Rebuild the whole page: header + list
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
        itemName,
      }),
      isEventCapture: 1,
      zOrderIndex: 2,
    })

    await bridge.rebuildPageContainer(
      new RebuildPageContainer({ containerTotalNum: 2, textObject: [headerText], listObject: [newListContainer] }),
    )
  } catch (err) {
    console.error('Failed to fetch top3:', err)
  }
}

// Initial fetch
await fetchAndRenderTop3()

// Poll every 5 seconds
pollTimer = window.setInterval(fetchAndRenderTop3, 5000)

let lastRender = ''
let renderTimer: number | null = null
let currentContent = 'Listening…'

function scheduleGlassesRender() {
  if (renderTimer !== null) return
  renderTimer = window.setTimeout(async () => {
    renderTimer = null
    if (currentContent === lastRender) return
    lastRender = currentContent
    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: 1,
        containerName: 'transcript',
        content: currentContent,
      }),
    )
  }, 120) // debounce display writes — BLE render queue is slow
}

// The default stt.ts is a blank stub that throws. Catch the throw so the UI
// surfaces the "configure stt.ts" error chip instead of hanging on "Connecting…".
let stt: ReturnType<typeof startSttStream> | null = null
try {
  stt = startSttStream(
    API_KEY,
    ({ finalText, interimText }) => {
      const combined = (finalText + interimText).trim()
      // 240 chars is a rough fit for the 576x288 text container at default font.
      currentContent = combined ? combined.slice(-240) : 'Listening…'
      setTranscript(finalText, interimText)
      scheduleGlassesRender()
    },
    err => {
      setStatus('error', `STT error: ${(err as Error)?.message ?? err}`)
      console.error('STT error:', err)
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

// Tap toggles capture. `audioControl(false)` stops the host pushing PCM, so no
// further frames reach `sendPcm`; the STT client itself is left open. If your
// provider closes an idle stream, tear it down here and reopen it on resume.
// No-ops until stt.ts is wired up — there is no capture to pause.
function toggleMic() {
  if (!stt) return
  micOn = !micOn
  bridge.audioControl(micOn)
  currentContent = micOn ? 'Listening…' : 'Paused'
  scheduleGlassesRender()
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
const unsubscribe = bridge.onEvenHubEvent(event => {
  const pcm = event.audioEvent?.audioPcm
  if (pcm) stt?.sendPcm(pcm)

  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)

  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    bridge.shutDownPageContainer(1)
    return
  }

  if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
    toggleMic()
    return
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    cleanup()
  }
})

window.addEventListener('beforeunload', cleanup)
