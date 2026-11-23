// rank.js — urgency ranking for Glance Reply unread items.
//
// PURE function: no I/O, no env, no mutation of its input.
//
// Tier order (highest urgency first):
//   0 — direct messages (chatType 'dm')
//   1 — messages that @mention the bot (mentionsBot === true)
//   2 — everything else (plain group / channel messages)
// Within a tier: newest first (time desc). Result capped at 3.
//
// Input item shape:
//   { chatId, chatType: 'dm' | 'group' | 'channel',
//     sender, text, time, mentionsBot? }
// `time` is a unix-epoch ms number (an ISO string is also accepted).

export function tierOf(item) {
  if (item.chatType === 'dm') return 0;
  if (item.mentionsBot) return 1;
  return 2;
}

export function rankUnread(items, limit = 3) {
  return [...items]
    .sort((a, b) => {
      const tierDiff = tierOf(a) - tierOf(b);
      if (tierDiff !== 0) return tierDiff;
      return new Date(b.time).getTime() - new Date(a.time).getTime();
    })
    .slice(0, limit);
}

// ---- self-test -----------------------------------------------------------
// Run: node src/rank.js --self-test
// Proves, with canned data: a DM outranks a group message, a @mention
// outranks a plain message, newest first within a tier, and the cap of 3.

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

function selfTest() {
  const t0 = Date.parse('2026-11-24T00:00:00+07:00');
  const min = 60_000;
  const items = [
    // Plain group message — the NEWEST overall, but lowest tier.
    { chatId: 'g1', chatType: 'group', sender: 'Crypto Alpha', text: 'gm everyone, BTC pumping', time: t0 - 0.5 * min, mentionsBot: false },
    // Group @mention — newer than both DMs, but tier 1, so below them.
    { chatId: 'g2', chatType: 'group', sender: 'Crypto Alpha', text: '@glance_reply_bot tolong rangkum dong', time: t0 - 1 * min, mentionsBot: true },
    // Older DM.
    { chatId: 'd1', chatType: 'dm', sender: 'Ayu', text: 'Nanti kabarin ya', time: t0 - 15 * min, mentionsBot: false },
    // Newer DM — must rank #1 (newest within the DM tier).
    { chatId: 'd2', chatType: 'dm', sender: 'Budi', text: 'Bro, jadi meet jam 7?', time: t0 - 2 * min, mentionsBot: false },
    // Plain channel message — tier 2, oldest.
    { chatId: 'c1', chatType: 'channel', sender: 'Banzai News', text: 'Update: testnet v2 live', time: t0 - 5 * min, mentionsBot: false },
    // Second plain group message — proves the cap (only 3 returned).
    { chatId: 'g3', chatType: 'group', sender: 'Dev Chat', text: 'siapa yang deploy tadi?', time: t0 - 3 * min, mentionsBot: false },
  ];

  const ranked = rankUnread(items);
  const order = ranked.map((i) => i.chatId);

  assert.equal(ranked.length, 3, 'cap is 3');
  assert.deepEqual(
    order,
    ['d2', 'd1', 'g2'],
    'DMs first (newest DM on top), then the @mention group message',
  );
  assert.ok(
    !order.includes('g1'),
    'newest-overall plain group message is OUT of the top 3 — DM-first beats recency',
  );
  assert.ok(
    order.indexOf('g2') < order.indexOf('g1') || !order.includes('g1'),
    '@mention outranks a plain group message',
  );

  // Input must not be mutated.
  assert.equal(items[0].chatId, 'g1', 'input order unchanged');

  console.log('rank.js --self-test: PASS');
  console.log('  order:', order.join(' > '));
  console.log('  1. DM outranks group message: OK (d2/d1 above g1)');
  console.log('  2. @mention outranks plain message: OK (g2 in top 3, g1 out)');
  console.log('  3. newest first within a tier: OK (d2 newer than d1)');
  console.log('  4. cap 3: OK (6 items in, 3 out)');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && process.argv.includes('--self-test')) {
  selfTest();
}
