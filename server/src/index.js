// index.js — Glance Reply backend (Day 1 skeleton).
//
// HTTP server, plain Node 24, no dependencies:
//   GET /healthz   -> {"ok":true}
//   GET /api/top3  -> JSON array: top-3 ranked unread items
//   GET /api/unread -> JSON array: all unread items (debug helper)
//
// Modes:
//   * Live: TELEGRAM_BOT_TOKEN in env -> getUpdates long-poll feeds the
//     unread store. (Token from env only, never from a file.)
//   * Demo: DEMO_MODE=1 (or --demo) -> canned updates, no token needed,
//     so the ranking can be verified end to end.
//   * No token, no demo: server still starts with an empty inbox and a
//     clear log line saying live polling is disabled.
//
// Run:
//   node src/index.js                 # live if token set, else empty inbox
//   DEMO_MODE=1 node src/index.js     # canned data
//   PORT=3001 node src/index.js       # PORT env, default 3001

import http from 'node:http';
import { UnreadStore } from './store.js';
import { rankUnread } from './rank.js';
import { createPollerFromEnv } from './telegram.js';
import { handleVoice, getLatestVoice } from './voice.js';

const PORT = Number(process.env.PORT ?? 3001);
const DEMO_MODE = process.env.DEMO_MODE === '1' || process.argv.includes('--demo');

const store = new UnreadStore();

/** Canned updates for demo mode — built to prove all three ranking rules. */
function seedDemo() {
  const now = Date.now();
  const min = 60_000;
  const demo = [
    // Plain group message — the NEWEST overall, but tier 2: must NOT make top 3.
    { chatId: 'g1', chatType: 'group', sender: 'Crypto Alpha', text: 'gm everyone, BTC pumping', time: now - 0.5 * min, mentionsBot: false },
    // Group @mention — newer than both DMs, tier 1: ranks #3, below the DMs.
    { chatId: 'g2', chatType: 'group', sender: 'Crypto Alpha', text: '@glance_reply_bot tolong rangkum dong', time: now - 1 * min, mentionsBot: true },
    // Older DM — ranks #2.
    { chatId: 'd1', chatType: 'dm', sender: 'Ayu', text: 'Nanti kabarin ya', time: now - 15 * min, mentionsBot: false },
    // Newer DM — ranks #1 (newest within the DM tier).
    { chatId: 'd2', chatType: 'dm', sender: 'Budi', text: 'Bro, jadi meet jam 7?', time: now - 2 * min, mentionsBot: false },
    // Plain channel message — tier 2, outside the top 3.
    { chatId: 'c1', chatType: 'channel', sender: 'Banzai News', text: 'Update: testnet v2 live', time: now - 5 * min, mentionsBot: false },
  ];
  for (const item of demo) store.upsert(item);
  console.log(`[server] DEMO_MODE: seeded ${demo.length} canned updates (no Telegram token used)`);
}

if (DEMO_MODE) {
  seedDemo();
} else {
  const poller = createPollerFromEnv((item) => store.upsert(item));
  if (poller) {
    poller.start().catch((err) => {
      console.log(`[telegram] poller exited with error: ${err.message}`);
    });
  } else {
    console.log('[server] running WITHOUT live Telegram polling (empty inbox until a token is set).');
  }
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

function handleOptions(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    res.end();
    return true;
  }
  return false;
}

const server = http.createServer((req, res) => {
  if (handleOptions(req, res)) return;
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/healthz') {
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/top3') {
    return sendJson(res, 200, rankUnread(store.list()));
  }
  if (req.method === 'GET' && url.pathname === '/api/unread') {
    return sendJson(res, 200, store.list());
  }
  if (req.method === 'POST' && url.pathname === '/api/voice') {
    return handleVoice(req, res, store);
  }
  if (req.method === 'GET' && url.pathname === '/api/voice/latest') {
    return sendJson(res, 200, getLatestVoice());
  }
  return sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT} (demo=${DEMO_MODE})`);
});
