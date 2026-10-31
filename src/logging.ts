/**
 * Loggers. The gateway's own log lines never carry message text, full phone numbers, the API key
 * or the webhook secret (they are written that way, and pino redacts the obvious fields as a
 * second line of defence).
 *
 * Baileys is third-party code that logs JIDs (phone numbers) and, at verbose levels, message
 * content and key material. It gets an adapter that: has its own level (WA_BAILEYS_LOG_LEVEL,
 * at most `info`), masks phone-like digit runs in every string, replaces content/credential
 * fields and binary data with `[redacted]`, and reduces errors to their type and masked message.
 */
import pino, { type DestinationStream, type Logger } from 'pino';

import type { BaileysLogLevel, LogLevel } from './config.js';
import { redactDigits } from './phone.js';

const REDACT_PATHS = [
  'authorization',
  'headers.authorization',
  'req.headers.authorization',
  'apiKey',
  'secret',
  'text',
  'body',
];

export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  const options = {
    level,
    base: { service: 'kampusping-wa-gateway' },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  };
  return destination ? pino(options, destination) : pino(options);
}

/** The logger shape Baileys expects (its `ILogger`), declared here without importing Baileys. */
export interface LibraryLogger {
  level: string;
  child(bindings: Record<string, unknown>): LibraryLogger;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

const LEVEL_VALUES: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
};

/** Fields that can hold message content, contact names, key material or raw protocol nodes. */
const REDACTED_KEYS = new Set([
  'message',
  'messages',
  'conversation',
  'text',
  'caption',
  'content',
  'body',
  'node',
  'pushName',
  'notify',
  'verifiedName',
  'name',
  'creds',
  'keys',
  'auth',
  'privKey',
  'pubKey',
]);
const MAX_DEPTH = 4;

export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactDigits(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    return { type: value.name, message: redactDigits(value.message).slice(0, 200) };
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return '[redacted]';
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value))
    return value.slice(0, 20).map((item) => sanitizeForLog(item, depth + 1));
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = REDACTED_KEYS.has(key) ? '[redacted]' : sanitizeForLog(item, depth + 1);
    }
    return result;
  }
  return '[unloggable]';
}

export function createBaileysLogger(
  base: Logger,
  level: BaileysLogLevel,
  bindings: Record<string, unknown> = {},
): LibraryLogger {
  const threshold = LEVEL_VALUES[level] ?? LEVEL_VALUES.warn!;
  const safeBindings = sanitizeForLog(bindings) as Record<string, unknown>;

  const emit =
    (method: 'trace' | 'debug' | 'info' | 'warn' | 'error') =>
    (obj: unknown, msg?: string): void => {
      if (LEVEL_VALUES[method]! < threshold) return;
      let fields: Record<string, unknown>;
      let message = msg;
      if (typeof obj === 'string') {
        message = obj;
        fields = {};
      } else if (obj instanceof Error) {
        fields = { err: sanitizeForLog(obj) };
      } else if (typeof obj === 'object' && obj !== null) {
        fields = sanitizeForLog(obj) as Record<string, unknown>;
      } else {
        fields = { value: sanitizeForLog(obj) };
      }
      base[method]({ lib: 'baileys', ...safeBindings, ...fields }, redactDigits(message ?? ''));
    };

  return {
    level,
    child: (more) => createBaileysLogger(base, level, { ...bindings, ...more }),
    trace: emit('trace'),
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
  };
}
