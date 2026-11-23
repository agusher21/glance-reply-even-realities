// telegram.js — Telegram Bot API getUpdates long-poll client.
//
// Plain Node 24, no dependencies (global fetch). The bot token comes ONLY
// from process.env.TELEGRAM_BOT_TOKEN — never from a file, never logged.
// With no token set, createPollerFromEnv() returns null and the server
// still starts (demo mode / empty inbox); live polling is refused with a
// clear message instead of crashing.
//
// Bot API scope reminder (prep doc §2): a bot only sees messages sent to
// it (DMs) and messages in groups/channels it was added to. It cannot read
// a user's personal Telegram inbox.

const API_BASE = 'https://api.telegram.org/bot';

/** Map a Telegram chat.type to the store's chatType. */
export function chatTypeOf(telegramType) {
  switch (telegramType) {
    case 'private':
      return 'dm';
    case 'group':
    case 'supergroup':
      return 'group';
    case 'channel':
      return 'channel';
    default:
      return 'group';
  }
}

/**
 * Pure: turn one raw getUpdates `update` into a store-shaped item.
 * Returns null for updates without a text message (stickers, joins, etc.).
 * `botUsername` (without '@') is used to detect @mentions of the bot;
 * pass null/undefined when unknown — mentionsBot is then false.
 */
export function normalizeUpdate(update, botUsername) {
  const msg = update?.message ?? update?.channel_post;
  if (!msg || typeof msg.text !== 'string') return null;
  const chat = msg.chat ?? {};
  const from = msg.from ?? {};
  const sender = from.first_name
    ? `${from.first_name}${from.last_name ? ` ${from.last_name}` : ''}`
    : from.username
      ? `@${from.username}`
      : 'unknown';
  const mentionsBot = Boolean(
    botUsername && msg.text.toLowerCase().includes(`@${botUsername.toLowerCase()}`),
  );
  return {
    chatId: String(chat.id),
    chatType: chatTypeOf(chat.type),
    sender,
    text: msg.text,
    // Telegram `date` is unix seconds -> store ms.
    time: (msg.date ?? Math.floor(Date.now() / 1000)) * 1000,
    mentionsBot,
  };
}

export class TelegramPoller {
  #token;
  #onUpdate;
  #pollTimeoutSec;
  #offset = 0;
  #seen = new Set();
  #running = false;
  #abort = null;
  #botUsername = null;

  /**
   * @param {string} token - Bot token (from env only; never logged).
   * @param {(item) => void} onUpdate - called once per new normalized message.
   * @param {number} [pollTimeoutSec=30] - getUpdates long-poll timeout.
   */
  constructor({ token, onUpdate, pollTimeoutSec = 30 }) {
    if (!token) {
      throw new Error(
        'TelegramPoller: TELEGRAM_BOT_TOKEN is not set — live polling refused. ' +
          'Set TELEGRAM_BOT_TOKEN in the environment (never in a file) or run with DEMO_MODE=1.',
      );
    }
    if (typeof onUpdate !== 'function') {
      throw new Error('TelegramPoller: onUpdate callback is required');
    }
    this.#token = token;
    this.#onUpdate = onUpdate;
    this.#pollTimeoutSec = pollTimeoutSec;
  }

  get botUsername() {
    return this.#botUsername;
  }

  get running() {
    return this.#running;
  }

  async #api(method, params = {}) {
    const url = `${API_BASE}${this.#token}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout((this.#pollTimeoutSec + 15) * 1000),
    });
    const body = await res.json();
    if (!body.ok) {
      throw new Error(`Telegram API ${method} failed: ${body.description ?? res.status}`);
    }
    return body.result;
  }

  /** One long-poll round. Returns the updates received (may be empty). */
  async #pollOnce() {
    const url =
      `${API_BASE}${this.#token}/getUpdates` +
      `?offset=${this.#offset}&timeout=${this.#pollTimeoutSec}`;
    const res = await fetch(url, {
      signal: this.#abort?.signal ?? AbortSignal.timeout((this.#pollTimeoutSec + 15) * 1000),
    });
    const body = await res.json();
    if (!body.ok) {
      throw new Error(`Telegram API getUpdates failed: ${body.description ?? res.status}`);
    }
    return body.result ?? [];
  }

  /**
   * Start polling. Resolves only when stop() is called (or on fatal error).
   * Learns the bot username via getMe first (for @mention detection).
   */
  async start() {
    if (this.#running) return;
    this.#running = true;
    this.#abort = new AbortController();
    try {
      const me = await this.#api('getMe');
      this.#botUsername = me.username ?? null;
      console.log(`[telegram] polling as @${this.#botUsername ?? '(unknown)'}`);
    } catch (err) {
      console.log(`[telegram] getMe failed (${err.message}) — continuing without @mention detection`);
    }
    while (this.#running) {
      try {
        const updates = await this.#pollOnce();
        for (const update of updates) {
          // Offset advances past every update, seen or not.
          this.#offset = Math.max(this.#offset, update.update_id + 1);
          // Dedupe by update_id (defensive: offset alone normally suffices).
          if (this.#seen.has(update.update_id)) continue;
          this.#seen.add(update.update_id);
          if (this.#seen.size > 5000) this.#seen.clear();
          const item = normalizeUpdate(update, this.#botUsername);
          if (item) this.#onUpdate(item);
        }
      } catch (err) {
        if (err.name === 'AbortError' || !this.#running) break;
        console.log(`[telegram] poll error (${err.message}) — retrying in 5s`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    console.log('[telegram] polling stopped');
  }

  /** Stop the poll loop (aborts the in-flight long-poll). */
  stop() {
    this.#running = false;
    this.#abort?.abort();
  }
}

/**
 * Build a poller from the environment, or null when no token is set.
 * Returning null (instead of throwing) is what lets the server start in
 * demo / no-token mode. The refusal message is explicit so nobody
 * mistakes "no messages" for "polling works".
 */
export function createPollerFromEnv(onUpdate) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log(
      '[telegram] TELEGRAM_BOT_TOKEN is not set — live polling DISABLED. ' +
        'Server still starts (empty inbox). Set TELEGRAM_BOT_TOKEN in the ' +
        'environment, or run with DEMO_MODE=1 for canned updates.',
    );
    return null;
  }
  return new TelegramPoller({ token, onUpdate });
}
