// voice.js — Glance Reply voice pipeline (Day 3 + Day 4 digest).
//
// Plain Node 24, no dependencies (global fetch, FormData).
//
// Exports:
//   - wrapPcmToWav(pcm: Buffer): Buffer
//   - parseDrafts(text: string): string[]
//   - parseBullets(text: string): string[]
//   - handleVoice(req, res, store): Promise<void>
//   - getLatestVoice(): object

import http from 'node:http';
import { strict as assert } from 'node:assert';
import { rankUnread } from './rank.js';

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
 * Parse LLM reply text into clean bullet strings (for digest mode).
 * Accepts: JSON array, JSON object with 'bullets' key, or plain lines.
 * Strips leading numbering ("1.", "1)", "- ", "* "), strips surrounding quotes.
 * Drops empties, takes first 3, truncates each to 80 chars.
 * @param {string} text - Raw LLM response
 * @returns {string[]} - Clean bullets (max 3, each <= 80 chars)
 */
export function parseBullets(text) {
  if (!text || typeof text !== 'string') return [];

  let bullets = [];

  // Try JSON array first
  try {
    const parsed = JSON.parse(text.trim());
    if (Array.isArray(parsed)) {
      bullets = parsed.filter(b => typeof b === 'string');
    } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.bullets)) {
      bullets = parsed.bullets.filter(b => typeof b === 'string');
    }
  } catch {
    // Not JSON, fall through to line parsing
  }

  // If JSON parsing didn't yield bullets, parse as plain lines
  if (bullets.length === 0) {
    bullets = text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
  }

  // Clean each bullet
  const cleaned = bullets.map(b => {
    let s = b.trim();
    // Strip leading numbering: "1.", "1)", "- ", "* "
    s = s.replace(/^(\d+[.)]|[-*])\s*/, '');
    // Strip surrounding quotes (single or double)
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      s = s.slice(1, -1);
    }
    return s.trim();
  }).filter(s => s.length > 0);

  // Take first 3, truncate to 80 chars
  return cleaned.slice(0, 3).map(s => s.slice(0, 80));
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
 * Shared Groq chat completions POST with 429 retry.
 * Used by both groqDrafts and digest path.
 * @param {Array<{role:string, content:string}>} messages
 * @param {string} apiKey
 * @returns {Promise<string>} - Raw LLM response content
 */
async function groqChat(messages, apiKey) {
  const payload = {
    model: 'openai/gpt-oss-120b',
    messages,
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
    return content;
  }

  throw lastErr || new Error('Groq chat failed after retries');
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
 * Generate draft replies via Groq chat.
 * @param {string} transcript
 * @param {string|null} originalText
 * @param {string} apiKey
 * @returns {Promise<string[]>} - Two draft replies
 */
async function groqDrafts(transcript, originalText, apiKey) {
  const systemPrompt = `You are a Telegram reply assistant. Output EXACTLY 2 short reply options, one per line, each at most 100 characters, in the same language as the transcript. No numbering, no quotes, no extra text.`;

  const userContent = originalText
    ? `Original message: "${originalText}"\nTranscript: "${transcript}"`
    : `Transcript: "${transcript}"`;

  const content = await groqChat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    apiKey,
  );
  return parseDrafts(content);
}

/**
 * Generate digest bullets via Groq chat.
 * @param {Array<{sender:string, text:string, time:number}>} history - Last 20 messages, oldest first
 * @param {string} chatName
 * @param {string} apiKey
 * @returns {Promise<string[]>} - Three bullet strings
 */
async function groqDigest(history, chatName, apiKey) {
  const systemPrompt = `Summarize these chat messages into EXACTLY 3 short bullets, one per line, each at most 80 characters, in the same language as the messages. No numbering, no quotes, no extra text.`;

  // Build user content: "sender: text" lines, truncate each message text to 200 chars
  const lines = history.map(m => `${m.sender}: ${m.text.slice(0, 200)}`);
  let userContent = lines.join('\n');

  // Cap whole user content at ~4000 chars
  if (userContent.length > 4000) {
    userContent = userContent.slice(-4000); // Keep the most recent (end)
  }

  const content = await groqChat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    apiKey,
  );
  return parseBullets(content);
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

  // Check for DIGEST intent BEFORE drafting replies
  const url = new URL(req.url, 'http://localhost');
  const chatIdParam = url.searchParams.get('chatId');
  const transcriptLower = transcript.trim().toLowerCase();

  if (transcriptLower === 'digest') {
    // DIGEST PATH
    // Target chat: ?chatId= if given AND store.get(chatId) exists; otherwise top-1 from rankUnread
    let targetChatId = null;
    if (chatIdParam && store.get(chatIdParam)) {
      targetChatId = chatIdParam;
    } else {
      const ranked = rankUnread(store.list());
      targetChatId = ranked[0]?.chatId ?? null;
    }

    if (!targetChatId) {
      res.writeHead(503, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ error: 'no_chat_for_digest' }));
      return;
    }

    const history = store.history(targetChatId);
    if (!history.length) {
      res.writeHead(503, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ error: 'no_history' }));
      return;
    }

    // Take last 20 (history is already capped at 20, oldest first)
    const recentHistory = history.slice(-20);
    const chatEntry = store.get(targetChatId);
    const chatName = chatEntry?.sender ?? targetChatId;

    let bullets;
    try {
      bullets = await groqDigest(recentHistory, chatName, groqKey);
    } catch (err) {
      console.log(`[voice] Digest generation failed: ${err.message}`);
      res.writeHead(503, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ error: 'digest_unavailable' }));
      return;
    }

    // Store and return digest result
    voiceResultId += 1;
    const result = {
      id: voiceResultId,
      mode: 'digest',
      transcript,
      bullets,
      drafts: bullets, // same array, so older clients still see drafts
      chatId: targetChatId,
      chatName,
      createdAt: new Date().toISOString(),
    };
    latestVoiceResult = result;
    console.log(`[voice] digest result id=${voiceResultId} chatId=${targetChatId} bullets=${bullets.length}`);

    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(result));
    return;
  }

  // DRAFT PATH (existing behavior)
  // Look up original message by chatId query param
  let originalText = null;
  if (chatIdParam) {
    const entry = store.get(chatIdParam);
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

  // Store and return result with mode: 'reply' and replyToMessageId
  voiceResultId += 1;
  const entry = chatIdParam ? store.get(chatIdParam) : null;
  const replyToMessageId = entry?.messageId ?? null;

  const result = {
    id: voiceResultId,
    mode: 'reply',
    transcript,
    drafts,
    chatId: chatIdParam || null,
    originalText: originalText || null,
    replyToMessageId,
    createdAt: new Date().toISOString(),
  };
  latestVoiceResult = result;
  console.log(`[voice] reply result id=${voiceResultId} transcript_len=${transcript.length} drafts=${drafts.length} chatId=${chatIdParam ?? 'none'} replyToMessageId=${replyToMessageId ?? 'null'}`);

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
  console.log('  drafts:', parsed3);

  // Test parseDrafts with quoted lines
  const quotedInput = `1. "Quoted reply one"
2. 'Quoted reply two'`;
  const parsed4 = parseDrafts(quotedInput);
  assert.equal(parsed4[0], 'Quoted reply one', 'strips double quotes');
  assert.equal(parsed4[1], 'Quoted reply two', 'strips single quotes');
  console.log('parseDrafts (quoted): PASS');
  console.log('  drafts:', parsed4);

  // Test parseBullets with numbered lines
  const bulletNumbered = `1. First bullet point here
2. Second bullet point here
3. Third bullet point here
4. Fourth should be dropped`;
  const bullets1 = parseBullets(bulletNumbered);
  assert.equal(bullets1.length, 3, 'takes first 3');
  assert.ok(bullets1[0].length <= 80, 'first <= 80 chars');
  assert.ok(bullets1[1].length <= 80, 'second <= 80 chars');
  assert.ok(bullets1[2].length <= 80, 'third <= 80 chars');
  assert.ok(!bullets1[0].match(/^\d+[.)]/), 'no leading number on first');
  assert.ok(!bullets1[1].match(/^\d+[.)]/), 'no leading number on second');
  assert.ok(!bullets1[2].match(/^\d+[.)]/), 'no leading number on third');
  console.log('parseBullets (numbered lines): PASS');
  console.log('  bullets:', bullets1);

  // Test parseBullets with JSON array
  const bulletJsonArray = `["Bullet one from JSON", "Bullet two from JSON", "Bullet three from JSON", "Bullet four dropped"]`;
  const bullets2 = parseBullets(bulletJsonArray);
  assert.equal(bullets2.length, 3, 'JSON array: takes first 3');
  assert.equal(bullets2[0], 'Bullet one from JSON');
  assert.equal(bullets2[1], 'Bullet two from JSON');
  assert.equal(bullets2[2], 'Bullet three from JSON');
  console.log('parseBullets (JSON array): PASS');
  console.log('  bullets:', bullets2);

  // Test parseBullets with JSON object with bullets key
  const bulletJsonObject = `{"bullets": ["Obj bullet 1", "Obj bullet 2", "Obj bullet 3"]}`;
  const bullets3 = parseBullets(bulletJsonObject);
  assert.equal(bullets3.length, 3, 'JSON object bullets: takes 3');
  assert.equal(bullets3[0], 'Obj bullet 1');
  assert.equal(bullets3[1], 'Obj bullet 2');
  assert.equal(bullets3[2], 'Obj bullet 3');
  console.log('parseBullets (JSON object bullets): PASS');
  console.log('  bullets:', bullets3);

  // Test parseBullets with quoted lines
  const bulletQuoted = `1. "Quoted bullet one"
2. 'Quoted bullet two'
3. "Quoted bullet three"`;
  const bullets4 = parseBullets(bulletQuoted);
  assert.equal(bullets4[0], 'Quoted bullet one', 'strips double quotes');
  assert.equal(bullets4[1], 'Quoted bullet two', 'strips single quotes');
  assert.equal(bullets4[2], 'Quoted bullet three', 'strips double quotes');
  console.log('parseBullets (quoted): PASS');
  console.log('  bullets:', bullets4);

  console.log('voice.js --self-test: PASS');
  console.log('  all helper tests passed');
}

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && process.argv.includes('--self-test')) {
  selfTest();
}