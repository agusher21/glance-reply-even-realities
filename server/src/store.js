// store.js — in-memory unread store for Glance Reply.
//
// One entry per chat (the latest unread message wins — a newer message in
// the same chat replaces the older one). No persistence yet: the Day-1
// skeleton keeps state in memory; a later day can swap this for SQLite
// or a file without changing the callers.
//
// Entry shape:
//   { chatId, chatType: 'dm' | 'group' | 'channel',
//     sender, text, time, mentionsBot }
// `time` is a unix-epoch ms number. `mentionsBot` is true when the
// message @mentions the bot (computed by telegram.js at ingest).

export class UnreadStore {
  #byChat = new Map();

  /**
   * Add a message, or update the entry for its chat if one exists.
   * Returns the stored entry.
   */
  upsert({ chatId, chatType, sender, text, time, mentionsBot = false }) {
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
    };
    this.#byChat.set(entry.chatId, entry);
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

  /** Drop every unread entry. */
  clear() {
    this.#byChat.clear();
  }

  get size() {
    return this.#byChat.size;
  }
}
