// send.js — POST /api/send endpoint for Glance Reply (Day 4).
//
// Plain Node 24, zero dependencies (global fetch).
//
// Exports:
//   - buildSendPayload(result, draftIndex): PURE function
//   - handleSend(req, res, store, getLatestVoice): HTTP handler

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

/**
 * Build the Telegram sendMessage payload from a voice result and draft index.
 * PURE function — no I/O, no env, no side effects.
 *
 * @param {object|null} result - Voice result from getLatestVoice()
 *   Expected shape for 'reply' mode: { mode: 'reply', chatId, drafts: string[], replyToMessageId: number|null }
 *   Expected shape for 'digest' mode: { mode: 'digest', ... }
 * @param {number} draftIndex - 0 or 1 (which draft to send)
 * @returns {{ chat_id: string, text: string, reply_to_message_id?: number }}
 * @throws {Error} with code property:
 *   - 'no_voice_result' (result null/undefined)
 *   - 'cannot_send_digest' (result.mode === 'digest')
 *   - 'bad_draft_index' (draftIndex not 0/1 or >= result.drafts.length)
 *   - 'no_chat' (result.chatId missing)
 */
export function buildSendPayload(result, draftIndex) {
  if (!result) {
    const err = new Error('no_voice_result');
    err.code = 'no_voice_result';
    throw err;
  }
  if (result.mode === 'digest') {
    const err = new Error('cannot_send_digest');
    err.code = 'cannot_send_digest';
    throw err;
  }
  if (!result.chatId) {
    const err = new Error('no_chat');
    err.code = 'no_chat';
    throw err;
  }
  if (draftIndex !== 0 && draftIndex !== 1) {
    const err = new Error('bad_draft_index');
    err.code = 'bad_draft_index';
    throw err;
  }
  if (!Array.isArray(result.drafts) || draftIndex >= result.drafts.length) {
    const err = new Error('bad_draft_index');
    err.code = 'bad_draft_index';
    throw err;
  }

  const payload = {
    chat_id: String(result.chatId),
    text: result.drafts[draftIndex],
  };
  if (result.replyToMessageId != null) {
    payload.reply_to_message_id = result.replyToMessageId;
  }
  return payload;
}

let demoSendCounter = 0;

/**
 * Handle POST /api/send
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {UnreadStore} store
 * @param {() => object} getLatestVoice
 */
export async function handleSend(req, res, store, getLatestVoice) {
  // Read JSON body (cap 64 KB)
  let body;
  try {
    body = await readJsonBody(req, 64 * 1024);
  } catch (err) {
    if (err.message === 'body_too_large') {
      return sendJson(res, 413, { error: 'body_too_large' });
    }
    return sendJson(res, 400, { error: 'bad_json' });
  }

  // Resolve the voice record
  let result = getLatestVoice();
  const hasVoiceId = body.voiceId !== undefined && body.voiceId !== null;
  const hasChatId = body.chatId !== undefined && body.chatId !== null;

  if (hasVoiceId) {
    const voiceId = Number(body.voiceId);
    if (!result || result.id !== voiceId || !result.transcript) {
      return sendJson(res, 404, { error: 'voice_not_found' });
    }
  } else if (hasChatId) {
    const chatId = String(body.chatId);
    if (!result || result.chatId !== chatId || !result.transcript) {
      return sendJson(res, 404, { error: 'voice_not_found' });
    }
  } else {
    if (!result || !result.transcript) {
      return sendJson(res, 404, { error: 'voice_not_found' });
    }
  }

  // Build payload
  let payload;
  try {
    payload = buildSendPayload(result, Number(body.draftIndex ?? 0));
  } catch (err) {
    return sendJson(res, 400, { error: err.code || 'bad_request' });
  }

  // DEMO_MODE: stub, do NOT call Telegram
  if (process.env.DEMO_MODE === '1') {
    demoSendCounter += 1;
    console.log(`[send] DEMO stub payload: ${JSON.stringify(payload)}`);
    return sendJson(res, 200, {
      ok: true,
      messageId: `demo-${demoSendCounter}`,
      chatId: payload.chat_id,
      text: payload.text,
      replyToMessageId: payload.reply_to_message_id ?? null,
      stubbed: true,
    });
  }

  // LIVE: call Telegram Bot API
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return sendJson(res, 503, { error: 'telegram_not_configured' });
  }

  try {
    const tgRes = await fetch(`${TELEGRAM_API_BASE}${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const tgData = await tgRes.json().catch(() => ({}));
    if (!tgRes.ok || !tgData.ok) {
      console.log(`[send] Telegram send failed: ${tgData.description ?? tgRes.status}`);
      return sendJson(res, 502, { error: 'telegram_send_failed' });
    }
    console.log(`[send] Telegram ok, message_id=${tgData.result?.message_id}`);
    return sendJson(res, 200, {
      ok: true,
      messageId: tgData.result?.message_id,
      chatId: payload.chat_id,
      text: payload.text,
      replyToMessageId: payload.reply_to_message_id ?? null,
    });
  } catch (err) {
    console.log(`[send] Telegram request error: ${err.message}`);
    return sendJson(res, 502, { error: 'telegram_send_failed' });
  }
}

/**
 * Read and parse JSON request body with size cap.
 * @param {http.IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<object>}
 */
async function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('body_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks, total);
      try {
        const parsed = JSON.parse(buf.toString());
        resolve(parsed);
      } catch {
        reject(new Error('bad_json'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(body);
}

// ---- self-test -----------------------------------------------------------
// Run: node src/send.js --self-test

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

function selfTest() {
  // Test 1: buildSendPayload on a reply result with replyToMessageId
  const replyResult = {
    mode: 'reply',
    chatId: 'd2',
    drafts: ['a', 'b'],
    replyToMessageId: 1001,
  };
  const payload1 = buildSendPayload(replyResult, 0);
  assert.deepEqual(payload1, { chat_id: 'd2', text: 'a', reply_to_message_id: 1001 });
  console.log('Test 1 (reply with replyToMessageId): PASS');

  // Test 2: buildSendPayload with replyToMessageId null -> no reply_to_message_id key
  const replyResultNull = {
    mode: 'reply',
    chatId: 'd2',
    drafts: ['a', 'b'],
    replyToMessageId: null,
  };
  const payload2 = buildSendPayload(replyResultNull, 0);
  assert.deepEqual(payload2, { chat_id: 'd2', text: 'a' });
  assert.ok(!('reply_to_message_id' in payload2), 'reply_to_message_id key omitted when null');
  console.log('Test 2 (reply with null replyToMessageId): PASS');

  // Test 3: draftIndex 2 -> throws 'bad_draft_index'
  try {
    buildSendPayload(replyResult, 2);
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'bad_draft_index');
  }
  console.log('Test 3 (bad_draft_index): PASS');

  // Test 4: digest result -> throws 'cannot_send_digest'
  const digestResult = { mode: 'digest', chatId: 'g2', drafts: ['bullet1', 'bullet2', 'bullet3'] };
  try {
    buildSendPayload(digestResult, 0);
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'cannot_send_digest');
  }
  console.log('Test 4 (cannot_send_digest): PASS');

  // Test 5: null result -> throws 'no_voice_result'
  try {
    buildSendPayload(null, 0);
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'no_voice_result');
  }
  console.log('Test 5 (no_voice_result): PASS');

  // Test 6: undefined result -> throws 'no_voice_result'
  try {
    buildSendPayload(undefined, 0);
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'no_voice_result');
  }
  console.log('Test 6 (no_voice_result undefined): PASS');

  // Test 7: missing chatId -> throws 'no_chat'
  const noChatResult = { mode: 'reply', drafts: ['a', 'b'], replyToMessageId: 1001 };
  try {
    buildSendPayload(noChatResult, 0);
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'no_chat');
  }
  console.log('Test 7 (no_chat): PASS');

  // Test 8: draftIndex negative -> throws 'bad_draft_index'
  try {
    buildSendPayload(replyResult, -1);
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'bad_draft_index');
  }
  console.log('Test 8 (bad_draft_index negative): PASS');

  console.log('send.js --self-test: PASS');
  console.log('  all helper tests passed');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && process.argv.includes('--self-test')) {
  selfTest();
}