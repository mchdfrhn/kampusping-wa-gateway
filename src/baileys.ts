/**
 * The real WhatsApp client, built on Baileys (`@whiskeysockets/baileys`, pinned in package.json).
 * This is the ONLY module that imports Baileys; everything else talks to `WaClient`.
 *
 * - Session: `useMultiFileAuthState(authDir)`. Baileys documents this store as a reference
 *   implementation rather than a heavy-production store; for one number and a few hundred
 *   messages a day it is adequate. Keep the folder private (0700) and backed up (README).
 * - Connection: `connection.update` is mapped by `nextSnapshot`; on `close` the socket is
 *   rebuilt with capped exponential backoff, immediately for `restartRequired` (sent right after
 *   pairing), and not at all for `loggedOut` (pair again through POST /logout).
 * - Receipts: `messages.update` entries for our own messages (`key.fromMe`, `key.id`) are mapped
 *   by `eventFromMessageUpdate` (DELIVERY_ACK -> delivered, READ/PLAYED -> read, ERROR -> failed).
 * - Inbound messages are not handled in this milestone and are never logged.
 *
 * The pure helpers below are unit-tested; the socket wiring needs a real phone (manual smoke test).
 */
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import makeWASocket, {
  Browsers,
  type ConnectionState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type proto,
  useMultiFileAuthState,
  type WAMessageUpdate,
  WAMessageStatus,
  type WASocket,
} from '@whiskeysockets/baileys';
import type { Logger } from 'pino';

import {
  type ClientSnapshot,
  DisconnectedError,
  type GatewayEvent,
  NotOnWhatsAppError,
  type ReceiptState,
  type WaClient,
} from './client.js';
import type { BaileysLogLevel } from './config.js';
import { createBaileysLogger } from './logging.js';
import { maskPhone, phoneToJid } from './phone.js';

// Re-exported so the mapping tests check against the real enums without importing Baileys.
export { DisconnectReason, WAMessageStatus };

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------------------------

/** Map one `connection.update` onto the snapshot exposed by `GET /status`. */
export function nextSnapshot(
  previous: ClientSnapshot,
  update: Partial<ConnectionState>,
): ClientSnapshot {
  if (typeof update.qr === 'string' && update.qr !== '') return { state: 'qr', qr: update.qr };
  switch (update.connection) {
    case 'open':
      return { state: 'connected', qr: null };
    case 'connecting':
      return { state: 'connecting', qr: null };
    case 'close':
      return { state: 'disconnected', qr: null };
    default:
      return previous;
  }
}

/** The status code Baileys attaches to a disconnect error (a Boom error), if any. */
export function disconnectCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { output?: { statusCode?: unknown } }).output?.statusCode;
  return typeof code === 'number' ? code : undefined;
}

export type CloseDecision = 'logged_out' | 'restart_now' | 'reconnect';

export function closeDecision(error: unknown): CloseDecision {
  const code = disconnectCode(error);
  if (code === DisconnectReason.loggedOut) return 'logged_out';
  if (code === DisconnectReason.restartRequired) return 'restart_now';
  return 'reconnect';
}

export function reconnectDelayMs(attempt: number, baseMs: number, capMs: number): number {
  const exponent = Math.min(Math.max(attempt, 0), 30);
  return Math.min(capMs, baseMs * 2 ** exponent);
}

const CONNECTION_ERROR_CODES = new Set<number>([
  DisconnectReason.connectionClosed,
  DisconnectReason.connectionLost,
  DisconnectReason.connectionReplaced,
]);

/** Errors meaning "the socket is gone" (HTTP 503 for the caller, who retries later). */
export function isConnectionError(error: unknown): boolean {
  const code = disconnectCode(error);
  return code !== undefined && CONNECTION_ERROR_CODES.has(code);
}

export function receiptStateFromStatus(
  status: proto.WebMessageInfo.Status | null | undefined,
): ReceiptState | null {
  switch (status) {
    case WAMessageStatus.DELIVERY_ACK:
      return 'delivered';
    case WAMessageStatus.READ:
    case WAMessageStatus.PLAYED:
      return 'read';
    case WAMessageStatus.ERROR:
      return 'failed';
    default:
      return null;
  }
}

/** A `status` event for a receipt of one of our own messages, or null for anything else. */
export function eventFromMessageUpdate(update: WAMessageUpdate): GatewayEvent | null {
  const { key } = update;
  if (key.fromMe !== true || typeof key.id !== 'string' || key.id === '') return null;
  const state = receiptStateFromStatus(update.update.status);
  return state ? { type: 'status', provider_message_id: key.id, state } : null;
}

class BoundedMap<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly max: number) {}
  get(key: K): V | undefined {
    return this.map.get(key);
  }
  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
  }
  clear(): void {
    this.map.clear();
  }
}

// ---------------------------------------------------------------------------------------------
// Socket wiring (manual smoke test)
// ---------------------------------------------------------------------------------------------

export interface BaileysClientOptions {
  authDir: string;
  logger: Logger;
  baileysLogLevel: BaileysLogLevel;
  reconnectBaseMs?: number;
  reconnectCapMs?: number;
}

const JID_CACHE_TTL_MS = 10 * 60 * 1000;
const VERSION_FETCH_TIMEOUT_MS = 5000;

export function createBaileysClient(options: BaileysClientOptions): WaClient {
  const { authDir, logger } = options;
  const reconnectBaseMs = options.reconnectBaseMs ?? 2000;
  const reconnectCapMs = options.reconnectCapMs ?? 5 * 60 * 1000;
  const libraryLogger = createBaileysLogger(logger, options.baileysLogLevel);

  const handlers: ((event: GatewayEvent) => void)[] = [];
  // Phone -> JID from the last onWhatsApp lookup, so a send does not query WhatsApp twice.
  const jidCache = new BoundedMap<string, { jid: string; at: number }>(1000);
  // Recently sent messages, so Baileys can re-encrypt them when a recipient asks for a retry.
  const sentMessages = new BoundedMap<string, proto.IMessage>(500);

  let sock: WASocket | undefined;
  let generation = 0;
  let snapshot: ClientSnapshot = { state: 'disconnected', qr: null };
  let reconnectAttempt = 0;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  let version: [number, number, number] | undefined;

  const emit = (event: GatewayEvent): void => {
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (error) {
        logger.error({ err_type: (error as Error).name }, 'event handler failed');
      }
    }
  };

  const setSnapshot = (next: ClientSnapshot): void => {
    const changed = next.state !== snapshot.state;
    snapshot = next;
    if (changed) {
      logger.info({ state: next.state }, 'WhatsApp connection state changed');
      emit({ type: 'connection', state: next.state });
    }
  };

  const resolveVersion = async (): Promise<[number, number, number] | undefined> => {
    if (version) return version;
    try {
      const latest = await fetchLatestBaileysVersion({ timeout: VERSION_FETCH_TIMEOUT_MS });
      if (latest.isLatest) version = latest.version;
      logger.info(
        { wa_version: latest.version.join('.'), latest: latest.isLatest },
        'WhatsApp Web version selected',
      );
      return latest.version;
    } catch {
      return undefined; // Baileys falls back to its bundled version
    }
  };

  const clearReconnect = (): void => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  };

  const scheduleReconnect = (delayMs: number): void => {
    clearReconnect();
    logger.info({ in_ms: delayMs }, 'reconnecting to WhatsApp');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect().catch((error: unknown) => {
        logger.error({ err_type: (error as Error).name }, 'reconnect failed');
        scheduleReconnect(reconnectDelayMs(reconnectAttempt++, reconnectBaseMs, reconnectCapMs));
      });
    }, delayMs);
  };

  const onConnectionUpdate = (update: Partial<ConnectionState>): void => {
    setSnapshot(nextSnapshot(snapshot, update));
    if (update.connection === 'open') reconnectAttempt = 0;
    if (update.connection !== 'close') return;

    sock = undefined;
    const error = update.lastDisconnect?.error;
    const decision = closeDecision(error);
    logger.warn({ code: disconnectCode(error), decision }, 'WhatsApp connection closed');
    if (stopped) return;
    if (decision === 'logged_out') {
      logger.warn(
        'WhatsApp session was logged out (unlinked on the phone). Pair again with POST /logout ' +
          '(the "disconnect" action in the KampusPing settings), which shows a new QR code.',
      );
      return;
    }
    const delay =
      decision === 'restart_now'
        ? 0
        : reconnectDelayMs(reconnectAttempt++, reconnectBaseMs, reconnectCapMs);
    scheduleReconnect(delay);
  };

  async function connect(): Promise<void> {
    generation += 1;
    const current = generation;
    await mkdir(authDir, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const waVersion = await resolveVersion();
    if (current !== generation || stopped) return; // superseded meanwhile

    const socket = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, libraryLogger) },
      logger: libraryLogger,
      browser: Browsers.ubuntu('KampusPing'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      getMessage: (key) => Promise.resolve(key.id ? sentMessages.get(key.id) : undefined),
      ...(waVersion ? { version: waVersion } : {}),
    });
    sock = socket;
    setSnapshot({ state: 'connecting', qr: null });

    socket.ev.on('creds.update', () => {
      saveCreds().catch((error: unknown) =>
        logger.error({ code: (error as NodeJS.ErrnoException).code }, 'saving credentials failed'),
      );
    });
    socket.ev.on('connection.update', (update) => {
      if (current === generation) onConnectionUpdate(update);
    });
    socket.ev.on('messages.update', (updates) => {
      if (current !== generation) return;
      for (const update of updates) {
        const event = eventFromMessageUpdate(update);
        if (event) emit(event);
      }
    });
    // messages.upsert (inbound replies) is handled in milestone M3; nothing is subscribed here.
  }

  const lookupJid = async (socket: WASocket, phone: string): Promise<string | undefined> => {
    const cached = jidCache.get(phone);
    if (cached && Date.now() - cached.at < JID_CACHE_TTL_MS) return cached.jid;
    const [result] = (await socket.onWhatsApp(phoneToJid(phone))) ?? [];
    if (!result?.exists || typeof result.jid !== 'string') return undefined;
    jidCache.set(phone, { jid: result.jid, at: Date.now() });
    return result.jid;
  };

  const connectedSocket = (): WASocket => {
    if (!sock || snapshot.state !== 'connected') throw new DisconnectedError();
    return sock;
  };

  const asDisconnected = (error: unknown): unknown =>
    snapshot.state !== 'connected' || isConnectionError(error) ? new DisconnectedError() : error;

  const wipeAuthDir = async (): Promise<void> => {
    await mkdir(authDir, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(authDir)) {
      await rm(join(authDir, entry), { recursive: true, force: true });
    }
  };

  return {
    async start() {
      stopped = false;
      await connect();
    },

    async isOnWhatsApp(phone) {
      const socket = connectedSocket();
      try {
        return (await lookupJid(socket, phone)) !== undefined;
      } catch (error) {
        throw asDisconnected(error);
      }
    },

    async sendText(phone, text) {
      const socket = connectedSocket();
      let sent: proto.WebMessageInfo | undefined;
      try {
        const jid = await lookupJid(socket, phone);
        if (!jid) throw new NotOnWhatsAppError();
        sent = await socket.sendMessage(jid, { text });
      } catch (error) {
        if (error instanceof NotOnWhatsAppError) throw error;
        throw asDisconnected(error);
      }
      const id = sent?.key?.id;
      if (!id) throw new Error('WhatsApp returned no message id');
      if (sent?.message) sentMessages.set(id, sent.message);
      logger.debug({ to: maskPhone(phone) }, 'handed message to WhatsApp');
      return { id };
    },

    async logout() {
      clearReconnect();
      const current = sock;
      sock = undefined;
      generation += 1; // ignore the events of the old socket from here on
      if (current) {
        try {
          await current.logout();
        } catch (error) {
          logger.warn({ code: disconnectCode(error) }, 'logout request failed; wiping anyway');
        }
        try {
          current.end(undefined);
        } catch {
          // already closed
        }
      }
      await wipeAuthDir();
      jidCache.clear();
      sentMessages.clear();
      setSnapshot({ state: 'disconnected', qr: null });
      logger.info('WhatsApp session wiped; starting over for a new QR code');
      reconnectAttempt = 0;
      if (!stopped) await connect();
    },

    onEvent(handler) {
      handlers.push(handler);
    },

    snapshot() {
      return { ...snapshot };
    },

    stop() {
      stopped = true;
      clearReconnect();
      generation += 1;
      const current = sock;
      sock = undefined;
      try {
        current?.end(undefined);
      } catch {
        // already closed
      }
      setSnapshot({ state: 'disconnected', qr: null });
      return Promise.resolve();
    },
  };
}
