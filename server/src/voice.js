// voice.js — Glance Reply voice pipeline (Day 3).
//
// Plain Node 24, no dependencies (global fetch, FormData).
//
// Exports:
//   - wrapPcmToWav(pcm: Buffer): Buffer
//   - parseDrafts(text: string): string[]
//   - handleVoice(req, res, store): Promise<void>
//   - getLatestVoice(): object

import http from 'node:http';
import { strict as assert } from 'node:assert';

const GROQ_STT_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEEPGRAM_STT_URL = 'https://api.deepgram.com/v1/listen?model=nova-3';

const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let latestVoiceResult = null;
let voiceResultId = 0;

/**
 * Prepend a 44-byte RIFF/WAVE header to raw PCM (s16le, 1ch, 16kHz).
 * @param {Buffer} pcm - Raw PCM bytes (s16le, mono, 16000 Hz)
 * @returns {Buffer} - WAV file with 44-byte header + PCM data
 */
export function wrapPcmToWav(pcm) {
  const sampleRate = 16000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = pcm.length;
  const riffSize = 36 + dataSize; // 44 - 8 + dataSize

  const header = Buffer.alloc(44);
  let offset = 0;

  // RIFF chunk descriptor
  header.write('RIFF', offset); offset += 4;
  header.writeUInt32LE(riffSize, offset); offset += 4;
  header.write('WAVE', offset); offset += 4;

  // fmt sub-chunk
  header.write('fmt ', offset); offset += 4;
  header.writeUInt32LE(16, offset); offset += 4; // subchunk1Size = 16 for PCM
  header.writeUInt16LE(1, offset); offset += 2; // audioFormat = 1 (PCM)
  header.writeUInt16LE(numChannels, offset); offset += 2;
  header.writeUInt32LE(sampleRate, offset); offset += 4;
  header.writeUInt32LE(byteRate, offset); offset += 4;
  header.writeUInt16LE(blockAlign, offset); offset += 2;
  header.writeUInt16LE(bitsPerSample, offset); offset += 2;

  // data sub-chunk
  header.write('data', offset); offset += 4;
  header.writeUInt32LE(dataSize, offset); offset += 4;

  return Buffer.concat([header, pcm]);
}

/**
 * Parse LLM reply text into clean draft strings.
 * Accepts: JSON array, JSON object with 'drafts' or 'replies' key, or plain lines.
 * Strips leading numbering ("1.", "1)", "- ", "* "), strips surrounding quotes.
 * Drops empties, takes first 2, truncates each to 100 chars.
 * @param {string} text - Raw LLM response
 * @returns {string[]} - Clean drafts (max 2, each <= 100 chars)
 */
export function parseDrafts(text) {
  if (!text || typeof text !== 'string') return [];

  let drafts = [];

  // Try JSON array first
  try {
    const parsed = JSON.parse(text.trim());
    if (Array.isArray(parsed)) {
      drafts = parsed.filter(d => typeof d === 'string');
    } else if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.drafts)) drafts = parsed.drafts.filter(d => typeof d === 'string');
      else if (Array.isArray(parsed.replies)) drafts = parsed.replies.filter(d => typeof d === 'string');
    }
  } catch {
    // Not JSON, fall through to line parsing
  }

  // If JSON parsing didn't yield drafts, parse as plain lines
  if (drafts.length === 0) {
    drafts = text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
  }

  // Clean each draft
  const cleaned = drafts.map(d => {
    let s = d.trim();
    // Strip leading numbering: "1.", "1)", "- ", "* "
    s = s.replace(/^(\d+[.)]|[-*])\s*/, '');
    // Strip surrounding quotes (single or double)
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      s = s.slice(1, -1);
    }
    return s.trim();
  }).filter(s => s.length > 0);

  // Take first 2, truncate to 100 chars
  return cleaned.slice(0, 2).map(s => s.slice(0, 100));
}

/**
 * Read the full request body with a size cap.
 * @param {http.IncomingMessage} req
 * @param {number} maxBytes - Default 5 MB
 * @returns {Promise<Buffer>}
 */
async function readBody(req, maxBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('body_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks, total)));
    req.on('error', reject);
  });
}

/**
 * POST with multipart FormData to Groq STT, with 429 retry.
 * @param {Buffer} wavBytes
 * @param {string} apiKey
 * @returns {Promise<string>} transcript
 */
async function groqStt(wavBytes, apiKey) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Build the multipart body fresh per attempt: a body sent once must
    // never be re-sent on retry.
    const form = new FormData();
    const blob = new Blob([wavBytes], { type: 'audio/wav' });
    form.append('file', blob, 'audio.wav');
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'json');

    const res = await fetch(GROQ_STT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': BROWSER_UA,
      },
      body: form,
    });

    if (res.status === 429) {
      let waitMs = 2000 * attempt;
      const retryAfter = res.headers.get('retry-after');
      if (retryAfter) {
        const sec = parseInt(retryAfter, 10);
        if (!isNaN(sec)) waitMs = sec * 1000;
      }
      console.log(`[voice] Groq STT 429 (attempt ${attempt}/3), waiting ${waitMs}ms`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      lastErr = new Error(`Groq STT ${res.status}: ${txt}`);
      console.log(`[voice] Groq STT error: ${lastErr.message}`);
      break;
    }

    const data = await res.json();
    const transcript = (data.text ?? '').trim();
    console.log(`[voice] Groq STT ok, transcript length ${transcript.length}`);
    return transcript;
  }

  throw lastErr || new Error('Groq STT failed after retries');
}

/**
 * POST to Deepgram STT as fallback.
 * @param {Buffer} wavBytes
 * @param {string} apiKey
 * @returns {Promise<string>} transcript
 */
async function deepgramStt(wavBytes, apiKey) {
  const res = await fetch(DEEPGRAM_STT_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${apiKey}`,
      'Content-Type': 'audio/wav',
      'User-Agent': BROWSER_UA,
    },
    body: wavBytes,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Deepgram STT ${res.status}: ${txt}`);
  }

  const data = await res.json();
  const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
  console.log(`[voice] Deepgram STT ok, transcript length ${transcript.length}`);
  return transcript.trim();
}

/**
 * POST to Groq chat completions for draft replies, with 429 retry.
 * @param {string} transcript
 * @param {string|null} originalText - The original message text (or null)
 * @param {string} apiKey
 * @returns {Promise<string[]>} - Two draft replies
 */
async function groqDrafts(transcript, originalText, apiKey) {
  const systemPrompt = `You are a Telegram reply assistant. Output EXACTLY 2 short reply options, one per line, each at most 100 characters, in the same language as the transcript. No numbering, no quotes, no extra text.`;

  const userContent = originalText
    ? `Original message: "${originalText}"\nTranscript: "${transcript}"`
    : `Transcript: "${transcript}"`;

  const payload = {
    model: 'openai/gpt-oss-120b',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.7,
    max_tokens: 200,
  };

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': BROWSER_UA,
      },
      body: JSON.stringify(payload),
    });

    if (res.status === 429) {
      let waitMs = 2000 * attempt;
      const retryAfter = res.headers.get('retry-after');
      if (retryAfter) {
        const sec = parseInt(retryAfter, 10);
        if (!isNaN(sec)) waitMs = sec * 1000;
      }
      console.log(`[voice] Groq chat 429 (attempt ${attempt}/3), waiting ${waitMs}ms`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      lastErr = new Error(`Groq chat ${res.status}: ${txt}`);
      console.log(`[voice] Groq chat error: ${lastErr.message}`);
      break;
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    console.log(`[voice] Groq chat ok, response length ${content.length}`);
    return parseDrafts(content);
  }

  throw lastErr || new Error('Groq chat failed after retries');
}

/**
 * Handle POST /api/voice
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {UnreadStore} store
 */
export async function handleVoice(req, res, store) {
  const groqKey = process.env.GROQ_API_KEY;
  const deepgramKey = process.env.DEEPGRAM_API_KEY;

  if (!groqKey) {
    console.log('[voice] GROQ_API_KEY not set');
    res.writeHead(503, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ error: 'stt_not_configured' }));
    return;
  }

  let wavBytes;
  try {
    const body = await readBody(req);
    console.log(`[voice] received ${body.length} bytes`);
    if (body.length >= 4 && body.subarray(0, 4).toString() === 'RIFF') {
      wavBytes = body;
      console.log('[voice] input is already WAV');
    } else {
      wavBytes = wrapPcmToWav(body);
      console.log(`[voice] wrapped PCM -> WAV ${wavBytes.length} bytes`);
    }
  } catch (err) {
    if (err.message === 'body_too_large') {
      res.writeHead(413, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ error: 'body_too_large' }));
    } else {
      console.log(`[voice] read body error: ${err.message}`);
      res.writeHead(500, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ error: 'read_failed' }));
    }
    return;
  }

  // STT: Groq Whisper -> Deepgram fallback
  let transcript;
  try {
    transcript = await groqStt(wavBytes, groqKey);
  } catch (err) {
    console.log(`[voice] Groq STT failed: ${err.message}`);
    if (deepgramKey) {
      try {
        transcript = await deepgramStt(wavBytes, deepgramKey);
      } catch (err2) {
        console.log(`[voice] Deepgram STT failed: ${err2.message}`);
        res.writeHead(503, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        res.end(JSON.stringify({ error: 'stt_unavailable' }));
        return;
      }
    } else {
      console.log('[voice] Deepgram key not set, STT fallback unavailable');
      res.writeHead(503, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ error: 'stt_unavailable' }));
      return;
    }
  }

  if (!transcript) {
    res.writeHead(503, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ error: 'stt_empty_transcript' }));
    return;
  }

  // Look up original message by chatId query param
  const url = new URL(req.url, 'http://localhost');
  const chatId = url.searchParams.get('chatId');
  let originalText = null;
  if (chatId) {
    const entry = store.get(chatId);
    if (entry) originalText = entry.text;
  }

  // Generate drafts
  let drafts;
  try {
    drafts = await groqDrafts(transcript, originalText, groqKey);
  } catch (err) {
    console.log(`[voice] Draft generation failed: ${err.message}`);
    res.writeHead(503, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ error: 'drafts_unavailable' }));
    return;
  }

  // Store and return result
  voiceResultId += 1;
  const result = {
    id: voiceResultId,
    transcript,
    drafts,
    chatId: chatId || null,
    originalText: originalText || null,
    createdAt: new Date().toISOString(),
  };
  latestVoiceResult = result;
  console.log(`[voice] result id=${voiceResultId} transcript_len=${transcript.length} drafts=${drafts.length} chatId=${chatId ?? 'none'}`);

  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(result));
}

/**
 * Get the latest voice result, or a default empty object.
 * @returns {object}
 */
export function getLatestVoice() {
  return latestVoiceResult ?? { transcript: null, drafts: [], chatId: null };
}

// ---- self-test -----------------------------------------------------------
// Run: node src/voice.js --self-test

function selfTest() {
  // Test wrapPcmToWav
  const pcm = Buffer.alloc(1600); // 100ms of silence at 16kHz 16-bit mono = 1600 bytes
  const wav = wrapPcmToWav(pcm);
  assert.equal(wav.length, 44 + 1600, 'WAV length = 44 header + PCM');
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF', 'RIFF header');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE', 'WAVE header');
  assert.equal(wav.subarray(12, 16).toString(), 'fmt ', 'fmt chunk');
  assert.equal(wav.subarray(36, 40).toString(), 'data', 'data chunk');
  // Check sample rate in header (bytes 24-27, little-endian)
  const sampleRate = wav.readUInt32LE(24);
  assert.equal(sampleRate, 16000, 'sample rate 16000');
  // Check channels (bytes 22-23)
  const channels = wav.readUInt16LE(22);
  assert.equal(channels, 1, 'mono');
  // Check bits per sample (bytes 34-35)
  const bits = wav.readUInt16LE(34);
  assert.equal(bits, 16, '16-bit');
  console.log('wrapPcmToWav: PASS');

  // Test parseDrafts with numbered lines
  const numberedInput = `1. First reply option here
2. Second reply option here
3. Third should be dropped`;
  const parsed1 = parseDrafts(numberedInput);
  assert.equal(parsed1.length, 2, 'takes first 2');
  assert.ok(parsed1[0].length <= 100, 'first <= 100 chars');
  assert.ok(parsed1[1].length <= 100, 'second <= 100 chars');
  assert.ok(!parsed1[0].match(/^\d+[.)]/), 'no leading number on first');
  assert.ok(!parsed1[1].match(/^\d+[.)]/), 'no leading number on second');
  console.log('parseDrafts (numbered lines): PASS');
  console.log('  drafts:', parsed1);

  // Test parseDrafts with JSON array
  const jsonArrayInput = `["Draft one from JSON", "Draft two from JSON", "Draft three dropped"]`;
  const parsed2 = parseDrafts(jsonArrayInput);
  assert.equal(parsed2.length, 2, 'JSON array: takes first 2');
  assert.equal(parsed2[0], 'Draft one from JSON', 'first draft correct');
  assert.equal(parsed2[1], 'Draft two from JSON', 'second draft correct');
  console.log('parseDrafts (JSON array): PASS');
  console.log('  drafts:', parsed2);

  // Test parseDrafts with JSON object with drafts key
  const jsonObjectInput = `{"drafts": ["Obj draft 1", "Obj draft 2"]}`;
  const parsed3 = parseDrafts(jsonObjectInput);
  assert.equal(parsed3.length, 2, 'JSON object drafts: takes 2');
  assert.equal(parsed3[0], 'Obj draft 1');
  assert.equal(parsed3[1], 'Obj draft 2');
  console.log('parseDrafts (JSON object drafts): PASS');

  // Test parseDrafts with quoted lines
  const quotedInput = `1. "Quoted reply one"
2. 'Quoted reply two'`;
  const parsed4 = parseDrafts(quotedInput);
  assert.equal(parsed4[0], 'Quoted reply one', 'strips double quotes');
  assert.equal(parsed4[1], 'Quoted reply two', 'strips single quotes');
  console.log('parseDrafts (quoted): PASS');

  console.log('voice.js --self-test: PASS');
  console.log('  all helper tests passed');
}

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && process.argv.includes('--self-test')) {
  selfTest();
}