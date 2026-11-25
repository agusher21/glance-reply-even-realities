// store.js — in-memory unread store for Glance Reply.
//
// One entry per chat (the latest unread message wins — a newer message in
// the same chat replaces the older one). No persistence yet: the Day-1
// skeleton keeps state in memory; a later day can swap this for SQLite
// or a file without changing the callers.
//
// Entry shape:
//   { chatId, chatType: 'dm' | 'group' | 'channel',
//     sender, text, time, mentionsBot, messageId? }
// `time` is a unix-epoch ms number. `mentionsBot` is true when the
// message @mentions the bot (computed by telegram.js at ingest).
// `messageId` is the Telegram message_id (integer) when available.
//
// Per-chat history ring buffer (max 20 entries, oldest first):
//   upsert() appends every message to that chat's history IN ADDITION
//   to replacing the latest entry. history(chatId) returns a COPY.

export class UnreadStore {
  #byChat = new Map();
  #history = new Map(); // chatId -> array of {sender, text, time}, oldest first, capped at 20

  /**
   * Add a message, or update the entry for its chat if one exists.
   * Returns the stored entry.
   */
  upsert({ chatId, chatType, sender, text, time, mentionsBot = false, messageId = null }) {
    if (chatId === undefined || chatId === null || chatId === '') {
      throw new Error('UnreadStore.upsert: chatId is required');
    }
    const entry = {
      chatId: String(chatId),
      chatType,
      sender,
      text,
      time,
      mentionsBot: Boolean(mentionsBot),
      messageId,
    };
    this.#byChat.set(entry.chatId, entry);

    // Append to history ring buffer (capped at 20, oldest first)
    const hist = this.#history.get(entry.chatId) ?? [];
    hist.push({ sender, text, time });
    if (hist.length > 20) hist.shift(); // drop oldest
    this.#history.set(entry.chatId, hist);

    return entry;
  }

  /** All unread entries, in insertion order (ranking happens in rank.js). */
  list() {
    return [...this.#byChat.values()];
  }

  /** The entry for one chat, or undefined. */
  get(chatId) {
    return this.#byChat.get(String(chatId));
  }

  /** Mark a chat read (drop its unread entry). Returns true if one existed. */
  markRead(chatId) {
    return this.#byChat.delete(String(chatId));
  }

  /** Drop every unread entry AND history. */
  clear() {
    this.#byChat.clear();
    this.#history.clear();
  }

  /** Return a COPY of the chat's history (oldest first), or [] if unknown. */
  history(chatId) {
    const hist = this.#history.get(String(chatId));
    return hist ? [...hist] : [];
  }

  get size() {
    return this.#byChat.size;
  }
}

// ---- self-test -----------------------------------------------------------
// Run: node src/store.js --self-test
// Proves: upsert 3 messages to one chat -> list() has 1 entry (the latest)
// and history() has 3 in insertion order; upsert 21 messages -> history()
// is capped at exactly 20, oldest dropped.

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

function selfTest() {
  const store = new UnreadStore();
  const now = Date.now();
  const min = 60_000;

  // Test 1: upsert 3 messages to one chat
  store.upsert({ chatId: 'test1', chatType: 'dm', sender: 'A', text: 'msg1', time: now - 2 * min });
  store.upsert({ chatId: 'test1', chatType: 'dm', sender: 'A', text: 'msg2', time: now - 1 * min });
  store.upsert({ chatId: 'test1', chatType: 'dm', sender: 'A', text: 'msg3', time: now });

  const list1 = store.list();
  assert.equal(list1.length, 1, 'list() has 1 entry (latest wins)');
  assert.equal(list1[0].text, 'msg3', 'latest entry is msg3');

  const hist1 = store.history('test1');
  assert.equal(hist1.length, 3, 'history() has 3 entries');
  assert.equal(hist1[0].text, 'msg1', 'oldest first: msg1');
  assert.equal(hist1[1].text, 'msg2', 'middle: msg2');
  assert.equal(hist1[2].text, 'msg3', 'newest last: msg3');
  console.log('Test 1 (3 messages): PASS');

  // Test 2: upsert 21 messages -> history capped at 20
  const store2 = new UnreadStore();
  for (let i = 1; i <= 21; i++) {
    store2.upsert({ chatId: 'test2', chatType: 'dm', sender: 'B', text: `msg${i}`, time: now + i * min });
  }
  const hist2 = store2.history('test2');
  assert.equal(hist2.length, 20, 'history capped at 20');
  assert.equal(hist2[0].text, 'msg2', 'oldest (msg1) dropped, msg2 is first');
  assert.equal(hist2[19].text, 'msg21', 'newest is msg21');
  console.log('Test 2 (21 messages -> capped at 20): PASS');

  // Test 3: history() returns copy (mutation doesn't affect store)
  const hist3 = store.history('test1');
  hist3.push({ sender: 'X', text: 'injected', time: now });
  const hist3b = store.history('test1');
  assert.equal(hist3b.length, 3, 'external mutation does not affect store');
  console.log('Test 3 (history returns copy): PASS');

  // Test 4: unknown chat returns []
  assert.deepEqual(store.history('unknown'), [], 'unknown chat returns empty array');
  console.log('Test 4 (unknown chat): PASS');

  // Test 5: clear() clears history too
  store.clear();
  assert.equal(store.list().length, 0, 'list empty after clear');
  assert.equal(store.history('test1').length, 0, 'history empty after clear');
  console.log('Test 5 (clear): PASS');

  console.log('store.js --self-test: PASS');
  console.log('  all helper tests passed');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && process.argv.includes('--self-test')) {
  selfTest();
}