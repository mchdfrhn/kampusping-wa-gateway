/**
 * Configuration from environment variables, validated once at startup. Problems are collected
 * and reported together; secret values are never echoed in the messages.
 */

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
/** Baileys logs message content and JIDs at debug/trace, so those levels are refused. */
export const BAILEYS_LOG_LEVELS = ['silent', 'fatal', 'error', 'warn', 'info'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type BaileysLogLevel = (typeof BAILEYS_LOG_LEVELS)[number];

export interface GatewayConfig {
  host: string;
  port: number;
  apiKey: string;
  webhookUrl: string;
  webhookSecret: string;
  webhookRetries: number;
  webhookRetryBaseMs: number;
  webhookTimeoutMs: number;
  statusDelayMs: number;
  authDir: string;
  dedupeFile: string;
  dedupeTtlDays: number;
  logLevel: LogLevel;
  baileysLogLevel: BaileysLogLevel;
}

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid gateway configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const MIN_SECRET_LENGTH = 16;

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): GatewayConfig {
  const problems: string[] = [];
  const text = (name: string, fallback: string): string => {
    const value = env[name]?.trim();
    return value ? value : fallback;
  };

  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      problems.push(`${name} must be a whole number between ${min} and ${max}.`);
      return fallback;
    }
    return value;
  };

  const bool = (name: string): boolean => {
    const raw = env[name]?.trim().toLowerCase();
    if (!raw || raw === 'false' || raw === '0') return false;
    if (raw === 'true' || raw === '1') return true;
    problems.push(`${name} must be "true" or "false".`);
    return false;
  };

  const secret = (name: string): string => {
    const value = env[name] ?? '';
    if (!value) {
      problems.push(`${name} is required.`);
    } else if (value.length < MIN_SECRET_LENGTH) {
      problems.push(`${name} must be at least ${MIN_SECRET_LENGTH} characters long.`);
    } else if (value.toLowerCase().startsWith('change-me')) {
      problems.push(`${name} still has the placeholder value from .env.example.`);
    }
    return value;
  };

  const oneOf = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const raw = text(name, fallback).toLowerCase();
    if ((allowed as readonly string[]).includes(raw)) return raw as T;
    problems.push(`${name} must be one of: ${allowed.join(', ')}.`);
    return fallback;
  };

  const host = text('GATEWAY_HOST', '127.0.0.1');
  const allowNonLoopback = bool('GATEWAY_ALLOW_NON_LOOPBACK');
  if (!LOOPBACK_HOSTS.has(host.toLowerCase()) && !allowNonLoopback) {
    problems.push(
      'GATEWAY_HOST must be a loopback address (127.0.0.1, ::1 or localhost); ' +
        'set GATEWAY_ALLOW_NON_LOOPBACK=true only if the network is otherwise protected.',
    );
  }

  const webhookUrl = env.WA_WEBHOOK_URL?.trim() ?? '';
  if (!webhookUrl) {
    problems.push('WA_WEBHOOK_URL is required.');
  } else if (!isHttpUrl(webhookUrl)) {
    problems.push('WA_WEBHOOK_URL must be a valid http(s) URL.');
  }

  const config: GatewayConfig = {
    host,
    port: int('GATEWAY_PORT', 8095, 1, 65535),
    apiKey: secret('WA_GATEWAY_API_KEY'),
    webhookUrl,
    webhookSecret: secret('WA_WEBHOOK_SECRET'),
    webhookRetries: int('WA_WEBHOOK_RETRIES', 5, 1, 10),
    webhookRetryBaseMs: int('WA_WEBHOOK_RETRY_BASE_MS', 1000, 100, 60_000),
    webhookTimeoutMs: int('WA_WEBHOOK_TIMEOUT_MS', 10_000, 1000, 60_000),
    statusDelayMs: int('WA_STATUS_DELAY_MS', 2000, 500, 60_000),
    authDir: text('WA_AUTH_DIR', './auth_state'),
    dedupeFile: text('WA_DEDUPE_FILE', './data/sent-refs.json'),
    // Never shorter than 14 days: the worker may retry a message long after the first attempt.
    dedupeTtlDays: int('WA_DEDUPE_TTL_DAYS', 14, 14, 365),
    logLevel: oneOf('LOG_LEVEL', LOG_LEVELS, 'info'),
    baileysLogLevel: oneOf('WA_BAILEYS_LOG_LEVEL', BAILEYS_LOG_LEVELS, 'warn'),
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
  } catch {
    return false;
  }
}
