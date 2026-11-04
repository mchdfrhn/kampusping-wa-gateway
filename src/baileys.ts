/**
 * The real WhatsApp client, built on Baileys (`@whiskeysockets/baileys`, pinned in package.json).
 * This is the ONLY module that imports Baileys; everything else talks to `WaClient`.
 *
 * - Session: `useMultiFileAuthState(authDir)`. Baileys documents this store as a reference
 *   implementation rather than a heavy-production store; for one number and a few hundred
 *   messages a day it is adequate. Keep the folder private (0700) and backed up (README).
 * - Connection: `connection.update` is mapped by `nextSnapshot`; on `close`, `planAfterClose`
 *   decides: `loggedOut`, `connectionReplaced` and `forbidden` are terminal (stay disconnected,
 *   one warning); `restartRequired` (sent right after pairing) restarts at once, at most
 *   MAX_CONSECUTIVE_RESTARTS times in a row; anything else reconnects with capped exponential
 *   backoff that only starts over after a connection stayed open STABLE_CONNECTION_MS.
 * - Receipts: `messages.update` entries for our own messages (`key.fromMe`, `key.id`) are mapped
 *   by `eventFromMessageUpdate` (DELIVERY_ACK -> delivered, READ/PLAYED -> read, ERROR -> failed).
 * - Inbound messages are not handled in this milestone and are never logged.
 *
 * The pure helpers and the wiring (through injectable `BaileysDeps` and a fake socket) are
 * unit-tested; only `realDeps` (the real socket factory) needs a real phone (manual smoke test).
 */
import { mkdir } from 'node:fs/promises';
import makeWASocket, {
  type AuthenticationState,
  type BaileysEventMap,
  Browsers,
  type ConnectionState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type proto,
  useMultiFileAuthState,
  type WAMessageUpdate,
  WAMessageStatus,
  type WAVersion,
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
import { removeOldAuthCopies, swapAuthDir } from './authdir.js';
import type { BaileysLogLevel } from './config.js';
import { createBaileysLogger, type LibraryLogger } from './logging.js';
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

// ---------------------------------------------------------------------------------------------
// Reconnect policy (pure, unit-tested)
// ---------------------------------------------------------------------------------------------

/** A connection must stay open this long before the backoff (and the restart cap) start over. */
export const STABLE_CONNECTION_MS = 60_000;
/** At most this many immediate `restartRequired` restarts in a row; later ones back off. */
export const MAX_CONSECUTIVE_RESTARTS = 3;

export interface ReconnectState {
  /** Backoff exponent for the next ordinary reconnect. */
  attempt: number;
  /** Immediate restarts (`restartRequired`) in a row. */
  restarts: number;
  /** When the current connection opened (null when it never opened). */
  openedAt: number | null;
}

export const INITIAL_RECONNECT_STATE: ReconnectState = { attempt: 0, restarts: 0, openedAt: null };

export type TerminalReason = 'logged_out' | 'replaced' | 'forbidden';

export type CloseAction =
  | { kind: 'terminal'; reason: TerminalReason }
  | { kind: 'restart_now' }
  | { kind: 'reconnect'; delayMs: number };

export interface ReconnectPolicy {
  baseMs: number;
  capMs: number;
}

const TERMINAL_CODES = new Map<number, TerminalReason>([
  [DisconnectReason.loggedOut, 'logged_out'],
  // Another process or device holds the same session (e.g. a restored backup on another host):
  // reconnecting would kick it, it would kick us back, forever.
  [DisconnectReason.connectionReplaced, 'replaced'],
  // WhatsApp refused the session (restricted or banned number): retrying makes it worse.
  [DisconnectReason.forbidden, 'forbidden'],
]);

/**
 * What to do after the socket closed with `code`. Repeated logins are what gets a number banned,
 * so the backoff only starts over after a connection stayed open for STABLE_CONNECTION_MS, and
 * immediate restarts are capped.
 *
 * `qrExpired` means the socket was waiting for a scan when it closed with a timeout (Baileys:
 * "QR refs attempts ended", 408). No number is registered yet, so this is no login attempt and
 * no failure: a fresh QR is requested after the base delay, without growing the backoff.
 */
export function planAfterClose(
  code: number | undefined,
  state: ReconnectState,
  now: number,
  policy: ReconnectPolicy,
  qrExpired = false,
): { action: CloseAction; next: ReconnectState } {
  const stable = state.openedAt !== null && now - state.openedAt >= STABLE_CONNECTION_MS;
  const attempt = stable ? 0 : state.attempt;
  const restarts = stable ? 0 : state.restarts;

  if (qrExpired && code === DisconnectReason.timedOut) {
    return {
      action: { kind: 'reconnect', delayMs: policy.baseMs },
      next: { attempt, restarts, openedAt: null },
    };
  }

  const terminal = code === undefined ? undefined : TERMINAL_CODES.get(code);
  if (terminal) {
    return {
      action: { kind: 'terminal', reason: terminal },
      next: { attempt, restarts, openedAt: null },
    };
  }
  if (code === DisconnectReason.restartRequired && restarts < MAX_CONSECUTIVE_RESTARTS) {
    return {
      action: { kind: 'restart_now' },
      next: { attempt, restarts: restarts + 1, openedAt: null },
    };
  }
  return {
    action: { kind: 'reconnect', delayMs: reconnectDelayMs(attempt, policy.baseMs, policy.capMs) },
    // A different close reason ends a run of restarts; a capped 515 keeps counting.
    next: {
      attempt: attempt + 1,
      restarts: code === DisconnectReason.restartRequired ? restarts : 0,
      openedAt: null,
    },
  };
}
export type VersionOutcome = 'fetched' | 'invalid' | 'failed';

/**
 * Judge the result of `fetchLatestBaileysVersion`. Only three positive integers from a
 * successful fetch are used (and cached); otherwise the bundled version is used. A failed fetch
 * (Baileys answers its bundled version with `isLatest: false`) is not treated as "latest".
 */
export function pickWaVersion(result: { version: unknown; isLatest: boolean } | Error): {
  version?: WAVersion;
  outcome: VersionOutcome;
} {
  if (result instanceof Error || !result.isLatest) return { outcome: 'failed' };
  const { version } = result;
  if (
    Array.isArray(version) &&
    version.length === 3 &&
    version.every((part) => Number.isSafeInteger(part) && (part as number) > 0)
  ) {
    return { version: version as WAVersion, outcome: 'fetched' };
  }
  return { outcome: 'invalid' };
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
// Socket wiring (tested with a fake socket; only `realDeps` needs the manual smoke test)
// ---------------------------------------------------------------------------------------------

export type { BaileysEventMap };
export type SocketEventName = 'creds.update' | 'connection.update' | 'messages.update';

/** The part of a Baileys socket the client uses (a real `WASocket` satisfies it). */
export interface SocketLike {
  ev: {
    on<K extends SocketEventName>(event: K, listener: (arg: BaileysEventMap[K]) => void): void;
  };
  onWhatsApp(...jids: string[]): Promise<{ jid: string; exists: unknown }[] | undefined>;
  sendMessage(jid: string, content: { text: string }): Promise<proto.WebMessageInfo | undefined>;
  logout(): Promise<void>;
  end(error: Error | undefined): void;
}

export interface AuthHandle {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}

export interface SocketConfig {
  auth: AuthenticationState;
  logger: LibraryLogger;
  version?: WAVersion;
  getMessage: (key: proto.IMessageKey) => Promise<proto.IMessage | undefined>;
}

/** Everything with side effects, injectable so the wiring is tested without WhatsApp. */
export interface BaileysDeps {
  loadAuthState(dir: string): Promise<AuthHandle>;
  makeSocket(config: SocketConfig): SocketLike;
  fetchVersion(): Promise<{ version: number[]; isLatest: boolean }>;
  now(): number;
  /** Start a timer; the returned function cancels it. */
  setTimer(fn: () => void, ms: number): () => void;
  /** Move the session folder aside on logout (default: `swapAuthDir` from authdir.ts). */
  swapAuthDir?(authDir: string): Promise<void>;
}

const VERSION_FETCH_TIMEOUT_MS = 5000;

export const realDeps: BaileysDeps = {
  loadAuthState: (dir) => useMultiFileAuthState(dir),
  makeSocket: (config) =>
    makeWASocket({
      auth: {
        creds: config.auth.creds,
        keys: makeCacheableSignalKeyStore(config.auth.keys, config.logger),
      },
      logger: config.logger,
      browser: Browsers.ubuntu('KampusPing'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      getMessage: config.getMessage,
      ...(config.version ? { version: config.version } : {}),
    }),
  fetchVersion: () => fetchLatestBaileysVersion({ timeout: VERSION_FETCH_TIMEOUT_MS }),
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

export interface BaileysClientOptions {
  authDir: string;
  logger: Logger;
  baileysLogLevel: BaileysLogLevel;
  reconnectBaseMs?: number;
  reconnectCapMs?: number;
  /** Ask GitHub for the current WhatsApp Web version (default true); false = bundled, offline. */
  fetchWaVersion?: boolean;
  deps?: BaileysDeps;
}

const JID_CACHE_TTL_MS = 10 * 60 * 1000;

const TERMINAL_HINTS: Record<TerminalReason, string> = {
  logged_out:
    'WhatsApp session was logged out (unlinked on the phone). Not reconnecting. Pair again with ' +
    'POST /logout (the disconnect action in the KampusPing settings), which shows a new QR code.',
  replaced:
    'WhatsApp session was taken over by another connection with the same credentials (another ' +
    'gateway process or a restored auth_state copy?). Not reconnecting. Stop the other one, then ' +
    'restart this gateway.',
  forbidden:
    'WhatsApp refused the session (the number may be restricted or banned). Not reconnecting. ' +
    'Check the phone before restarting the gateway or pairing again.',
};

/**
 * Wrap an auth handle so that writes (credentials and signal keys) only happen while
 * `isCurrent()` is true, and every write that does start is passed to `track`. After a logout
 * the old socket may still try to save; those writes are dropped, and the ones already running
 * are awaited before the folder is swapped, so stale credentials never land in the new session.
 */
export function gateAuthHandle(
  handle: AuthHandle,
  isCurrent: () => boolean,
  track: (write: Promise<unknown>) => void,
): AuthHandle {
  const { keys } = handle.state;
  const gatedKeys: AuthenticationState['keys'] = {
    get: (type, ids) => keys.get(type, ids),
    set: (data) => {
      if (!isCurrent()) return Promise.resolve();
      const write = Promise.resolve(keys.set(data));
      track(write);
      return write;
    },
    ...(keys.clear
      ? {
          clear: () => {
            if (!isCurrent()) return Promise.resolve();
            const write = Promise.resolve(keys.clear?.());
            track(write);
            return write;
          },
        }
      : {}),
  };
  return {
    state: { creds: handle.state.creds, keys: gatedKeys },
    saveCreds: () => {
      if (!isCurrent()) return Promise.resolve();
      const write = handle.saveCreds();
      track(write);
      return write;
    },
  };
}

export function createBaileysClient(options: BaileysClientOptions): WaClient {
  const { authDir, logger } = options;
  const deps = options.deps ?? realDeps;
  const policy: ReconnectPolicy = {
    baseMs: options.reconnectBaseMs ?? 2000,
    capMs: options.reconnectCapMs ?? 5 * 60 * 1000,
  };
  const libraryLogger = createBaileysLogger(logger, options.baileysLogLevel);

  const handlers: ((event: GatewayEvent) => void)[] = [];
  // Phone -> JID from the last onWhatsApp lookup, so a send does not query WhatsApp twice.
  const jidCache = new BoundedMap<string, { jid: string; at: number }>(1000);
  // Recently sent messages, so Baileys can re-encrypt them when a recipient asks for a retry.
  const sentMessages = new BoundedMap<string, proto.IMessage>(500);

  let sock: SocketLike | undefined;
  let generation = 0;
  let snapshot: ClientSnapshot = { state: 'disconnected', qr: null };
  let reconnect: ReconnectState = INITIAL_RECONNECT_STATE;
  let cancelReconnect: (() => void) | undefined;
  let cancelCleanup: (() => void) | undefined;
  let stopped = false;
  let version: WAVersion | undefined;
  // Fetch at most once per process; only an invalid answer allows another try.
  let versionSettled = options.fetchWaVersion === false;
  const pendingWrites = new Set<Promise<unknown>>();
  const trackWrite = (write: Promise<unknown>): void => {
    pendingWrites.add(write);
    write.then(
      () => pendingWrites.delete(write),
      () => pendingWrites.delete(write),
    );
  };

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

  /** undefined = let Baileys use its bundled version. */
  const resolveVersion = async (): Promise<WAVersion | undefined> => {
    if (versionSettled) return version;
    let picked: ReturnType<typeof pickWaVersion>;
    try {
      picked = pickWaVersion(await deps.fetchVersion());
    } catch (error) {
      picked = pickWaVersion(error instanceof Error ? error : new Error('fetch failed'));
    }
    if (picked.outcome === 'fetched') {
      version = picked.version;
      versionSettled = true;
      logger.info({ wa_version: version?.join('.') }, 'WhatsApp Web version fetched');
    } else if (picked.outcome === 'failed') {
      versionSettled = true; // no retry: keep the bundled version for this process
      logger.info('WhatsApp Web version fetch failed; using the bundled version');
    } else {
      logger.warn('WhatsApp Web version fetch returned an invalid version; using the bundled one');
    }
    return version;
  };

  const clearReconnect = (): void => {
    cancelReconnect?.();
    cancelReconnect = undefined;
  };

  const scheduleReconnect = (delayMs: number): void => {
    clearReconnect();
    logger.info({ in_ms: delayMs }, 'reconnecting to WhatsApp');
    cancelReconnect = deps.setTimer(() => {
      cancelReconnect = undefined;
      connect().catch((error: unknown) => {
        logger.error({ err_type: (error as Error).name }, 'reconnect failed');
        const plan = planAfterClose(undefined, reconnect, deps.now(), policy);
        reconnect = plan.next;
        if (plan.action.kind === 'reconnect') scheduleReconnect(plan.action.delayMs);
      });
    }, delayMs);
  };

  const clearCleanup = (): void => {
    cancelCleanup?.();
    cancelCleanup = undefined;
  };

  /**
   * Once a session has stayed open for the stability window, the `<dir>.old-*` copies left by a
   * logout are no longer needed and may hold live credentials: delete them (best effort).
   */
  const scheduleOldCopyCleanup = (): void => {
    clearCleanup();
    const current = generation;
    cancelCleanup = deps.setTimer(() => {
      cancelCleanup = undefined;
      if (current !== generation || snapshot.state !== 'connected') return;
      removeOldAuthCopies(authDir, logger).catch(() => undefined);
    }, STABLE_CONNECTION_MS);
  };

  const onConnectionUpdate = (update: Partial<ConnectionState>): void => {
    const waitingForScan = snapshot.state === 'qr';
    setSnapshot(nextSnapshot(snapshot, update));
    if (update.connection === 'open') {
      reconnect = { ...reconnect, openedAt: deps.now() };
      scheduleOldCopyCleanup();
    }
    if (update.connection !== 'close') return;

    clearCleanup();
    sock = undefined;
    const code = disconnectCode(update.lastDisconnect?.error);
    const plan = planAfterClose(code, reconnect, deps.now(), policy, waitingForScan);
    reconnect = plan.next;
    if (stopped) return;
    const { action } = plan;
    if (waitingForScan && code === DisconnectReason.timedOut) {
      // The unscanned QR simply expired: show "connecting" until the next one, not "disconnected".
      setSnapshot({ state: 'connecting', qr: null });
    }
    if (action.kind === 'terminal') {
      // One warning per terminal close, reason code only.
      logger.warn({ code, reason: action.reason }, TERMINAL_HINTS[action.reason]);
      return;
    }
    const delay = action.kind === 'restart_now' ? 0 : action.delayMs;
    logger.warn({ code, retry_in_ms: delay }, 'WhatsApp connection closed');
    scheduleReconnect(delay);
  };

  async function connect(): Promise<void> {
    generation += 1;
    const current = generation;
    await mkdir(authDir, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = gateAuthHandle(
      await deps.loadAuthState(authDir),
      () => current === generation,
      trackWrite,
    );
    const waVersion = await resolveVersion();
    if (current !== generation || stopped) return; // superseded meanwhile

    const socket = deps.makeSocket({
      auth: state,
      logger: libraryLogger,
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

  const lookupJid = async (socket: SocketLike, phone: string): Promise<string | undefined> => {
    const cached = jidCache.get(phone);
    if (cached && deps.now() - cached.at < JID_CACHE_TTL_MS) return cached.jid;
    const [result] = (await socket.onWhatsApp(phoneToJid(phone))) ?? [];
    if (!result?.exists || typeof result.jid !== 'string') return undefined;
    jidCache.set(phone, { jid: result.jid, at: deps.now() });
    return result.jid;
  };

  const connectedSocket = (): SocketLike => {
    if (!sock || snapshot.state !== 'connected') throw new DisconnectedError();
    return sock;
  };

  const asDisconnected = (error: unknown): unknown =>
    snapshot.state !== 'connected' || isConnectionError(error) ? new DisconnectedError() : error;

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
      clearCleanup();
      const current = sock;
      sock = undefined;
      generation += 1; // ignore the events of the old socket from here on
      if (current) {
        try {
          await current.logout();
        } catch (error) {
          logger.warn(
            { code: disconnectCode(error) },
            'logout request failed; replacing the session anyway',
          );
        }
        try {
          current.end(undefined);
        } catch {
          // already closed
        }
      }
      // Writes the old session started before the cut-off land in the old folder first.
      await Promise.allSettled([...pendingWrites]);
      try {
        await (deps.swapAuthDir
          ? deps.swapAuthDir(authDir)
          : swapAuthDir(authDir, { now: () => deps.now(), logger }));
      } catch (error) {
        // Never stay "connected" without a socket: report the truth and retry with backoff
        // (the old session is still in place, so the reconnect uses it).
        setSnapshot({ state: 'disconnected', qr: null });
        const plan = planAfterClose(undefined, reconnect, deps.now(), policy);
        reconnect = plan.next;
        const delay = plan.action.kind === 'reconnect' ? plan.action.delayMs : 0;
        logger.warn(
          { code: (error as NodeJS.ErrnoException).code, retry_in_ms: delay },
          'could not move the WhatsApp session aside during logout; reconnecting',
        );
        if (!stopped) scheduleReconnect(delay);
        throw error;
      }
      jidCache.clear();
      sentMessages.clear();
      setSnapshot({ state: 'disconnected', qr: null });
      logger.info('WhatsApp session moved aside; starting over for a new QR code');
      reconnect = INITIAL_RECONNECT_STATE;
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
      clearCleanup();
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
