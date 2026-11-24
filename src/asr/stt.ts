// Speech-to-text client for the G2 microphone.
//
// The G2 mic emits PCM s16le @ 16 kHz, mono via `bridge.audioControl(true)`.
// Each onEvenHubEvent callback with `audioEvent.audioPcm` delivers a chunk.
//
// ─────────────────────────────────────────────────────────────────────
// Backend-driven STT (Day 3 Part B)
// ─────────────────────────────────────────────────────────────────────
// The glasses app holds NO API key. Audio is batched and sent to the
// backend at `${backendUrl}/api/voice?chatId=<ctx>` as raw PCM
// (Content-Type: audio/pcm). The backend runs Groq Whisper + LLM drafts
// and returns {id, transcript, drafts, chatId, originalText, createdAt}.
// ─────────────────────────────────────────────────────────────────────

export interface SttSnapshot {
  finalText: string
  interimText: string
  finished: boolean
}

export interface SttClient {
  sendPcm(chunk: Uint8Array): void
  close(): void
  setContext(chatId: string | null): void
}

export function startSttStream(
  backendUrl: string,
  onSnapshot: (snap: SttSnapshot) => void,
  onError?: (err: unknown) => void,
  onDrafts?: (result: { id: number; transcript: string; drafts: string[]; chatId: string | null }) => void,
): SttClient {
  if (!backendUrl) {
    throw new Error('Voice backend URL not set')
  }

  const BATCH_BYTES = 96000 // 3s at 16 kHz s16le mono = 16000 * 2 * 3 = 96000
  let buffer = new Uint8Array(0)
  let chatId: string | null = null
  let inFlight = false
  let closed = false

  async function flushBuffer(final = false) {
    if (buffer.length === 0) return
    if (inFlight && !final) return // wait for current request to finish

    const chunk = buffer
    buffer = new Uint8Array(0)
    inFlight = true

    try {
      const url = `${backendUrl}/api/voice${chatId ? `?chatId=${encodeURIComponent(chatId)}` : ''}`
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 30000) // 30s cap per request

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'audio/pcm',
        },
        body: chunk,
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}: ${errText}`)
      }

      const result = await res.json()
      const { id, transcript, drafts, chatId: resultChatId } = result

      onSnapshot({
        finalText: transcript ?? '',
        interimText: '',
        finished: false,
      })
      onDrafts?.({ id: id ?? 0, transcript: transcript ?? '', drafts: drafts ?? [], chatId: resultChatId ?? null })
    } catch (err) {
      onError?.(err)
    } finally {
      inFlight = false
      // If we closed and there's more buffered, send it
      if (closed && buffer.length > 0) {
        flushBuffer(true)
      }
    }
  }

  return {
    sendPcm(pcmChunk: Uint8Array) {
      if (closed) return
      // Append to buffer
      const newBuffer = new Uint8Array(buffer.length + pcmChunk.length)
      newBuffer.set(buffer)
      newBuffer.set(pcmChunk, buffer.length)
      buffer = newBuffer

      // Flush if we have enough
      if (buffer.length >= BATCH_BYTES) {
        flushBuffer()
      }
    },

    setContext(newChatId: string | null) {
      chatId = newChatId
    },

    async close() {
      closed = true
      if (buffer.length > 0) {
        // Best-effort final flush with 5s cap
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 5000)

        try {
          const url = `${backendUrl}/api/voice${chatId ? `?chatId=${encodeURIComponent(chatId)}` : ''}`
          await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'audio/pcm' },
            body: buffer,
            signal: controller.signal,
          })
          // Fire and forget the result - we're closing anyway
        } catch {
          // Ignore errors on final flush
        } finally {
          clearTimeout(timeoutId)
          buffer = new Uint8Array(0)
        }
      }
      // Wait briefly for any in-flight request (max 5s total from start of close)
      const startWait = Date.now()
      while (inFlight && Date.now() - startWait < 5000) {
        await new Promise(r => setTimeout(r, 50))
      }
    },
  }
}
