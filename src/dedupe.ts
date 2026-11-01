/**
 * Durable `client_ref -> provider_message_id` store.
 *
 * The backend worker retries a send when it did not get (or could not commit) an answer. Without
 * this store such a retry would deliver the same reminder to a student twice. The store is a
 * small JSON file rewritten atomically (temp file, fsync, rename) on every change; at the
 * expected volume (hundreds of messages a day, 14 days retained) that is a few hundred KB.
 *
 * A missing file starts empty. An unreadable file starts empty with a warning and is kept aside
 * as `<file>.corrupt` for inspection. Entries older than the TTL are ignored, pruned on load and
 * by `prune()` (called periodically by the server).
 */
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from 'pino';

export interface DedupeRecord {
  provider_message_id: string;
  /** ISO 8601 timestamp of the successful send. */
  sent_at: string;
  /**
   * sha256 of the recipient and text (see send.ts), so a reused ref with other content is
   * detected. Absent in records written before it existed: those dedupe by ref only.
   */
  fingerprint?: string;
}

export interface DedupeStore {
  /** The record of an earlier successful send with this ref, unless it has expired. */
  get(clientRef: string): DedupeRecord | undefined;
  /** Remember a successful send (in memory at once, then persisted; rejects if the write fails). */
  record(clientRef: string, providerMessageId: string, fingerprint?: string): Promise<void>;
  hasMessageId(providerMessageId: string): boolean;
  /** Drop expired records; resolves with how many were removed. */
  prune(): Promise<number>;
  size(): number;
}

export interface DedupeOptions {
  file: string;
  ttlDays: number;
  logger: Logger;
  now?: () => number;
}

interface FileShape {
  version: 1;
  entries: Record<string, DedupeRecord>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function openDedupeStore(options: DedupeOptions): Promise<DedupeStore> {
  const { file, logger } = options;
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlDays * DAY_MS;
  const entries = new Map<string, DedupeRecord>();
  const messageIds = new Set<string>();
  let writing: Promise<void> = Promise.resolve();

  const isExpired = (record: DedupeRecord): boolean => now() - Date.parse(record.sent_at) > ttlMs;

  const rebuildIds = (): void => {
    messageIds.clear();
    for (const record of entries.values()) messageIds.add(record.provider_message_id);
  };

  const persist = (): Promise<void> => {
    const snapshot: FileShape = { version: 1, entries: Object.fromEntries(entries) };
    const body = JSON.stringify(snapshot);
    // Serialise writes so two renames never race; each write stores the latest snapshot.
    const next = writing.then(() => writeAtomically(file, body));
    writing = next.catch(() => undefined);
    return next;
  };

  const removeExpired = (): number => {
    let removed = 0;
    for (const [ref, record] of entries) {
      if (isExpired(record)) {
        entries.delete(ref);
        removed += 1;
      }
    }
    if (removed > 0) rebuildIds();
    return removed;
  };

  await mkdir(dirname(file), { recursive: true });
  const loaded = await readEntries(file, logger);
  for (const [ref, record] of loaded) entries.set(ref, record);
  rebuildIds();
  if (removeExpired() > 0 || loaded.corrupt) await persist();
  logger.info({ entries: entries.size }, 'dedupe store loaded');

  return {
    get(clientRef) {
      const record = entries.get(clientRef);
      return record && !isExpired(record) ? record : undefined;
    },
    async record(clientRef, providerMessageId, fingerprint) {
      entries.set(clientRef, {
        provider_message_id: providerMessageId,
        sent_at: new Date(now()).toISOString(),
        ...(fingerprint ? { fingerprint } : {}),
      });
      messageIds.add(providerMessageId);
      await persist();
    },
    hasMessageId(providerMessageId) {
      return messageIds.has(providerMessageId);
    },
    async prune() {
      const removed = removeExpired();
      if (removed > 0) await persist();
      return removed;
    },
    size() {
      return entries.size;
    },
  };
}

type Loaded = Map<string, DedupeRecord> & { corrupt?: boolean };

async function readEntries(file: string, logger: Logger): Promise<Loaded> {
  const result: Loaded = new Map();
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ code: (error as NodeJS.ErrnoException).code }, 'dedupe store unreadable');
    }
    return result;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const entries = isObject(parsed) && isObject(parsed.entries) ? parsed.entries : undefined;
  if (!entries) {
    logger.warn('dedupe store is corrupt; starting empty (old file kept as .corrupt)');
    await rename(file, `${file}.corrupt`).catch(() => undefined);
    result.corrupt = true;
    return result;
  }

  for (const [ref, value] of Object.entries(entries)) {
    if (
      isObject(value) &&
      typeof value.provider_message_id === 'string' &&
      value.provider_message_id !== '' &&
      typeof value.sent_at === 'string' &&
      !Number.isNaN(Date.parse(value.sent_at))
    ) {
      result.set(ref, {
        provider_message_id: value.provider_message_id,
        sent_at: value.sent_at,
        ...(typeof value.fingerprint === 'string' && value.fingerprint !== ''
          ? { fingerprint: value.fingerprint }
          : {}),
      });
    }
  }
  return result;
}

async function writeAtomically(file: string, body: string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  const handle = await open(temp, 'w', 0o600);
  try {
    await handle.writeFile(body, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
