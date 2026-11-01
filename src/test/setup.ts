/**
 * Vitest setup (vitest.config.mts `setupFiles`): unit tests must never reach WhatsApp or GitHub.
 *
 * - The Baileys socket factory and the version fetch are replaced by functions that throw, so a
 *   test that forgets to inject fake `BaileysDeps` fails loudly instead of opening a socket.
 * - The global `fetch` only allows loopback hosts (the HTTP server test talks to 127.0.0.1).
 */
import { vi } from 'vitest';

export const NETWORK_BLOCKED = 'network is blocked in unit tests';

vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const blockedSocket = (): never => {
    throw new Error(`${NETWORK_BLOCKED}: makeWASocket (inject fake BaileysDeps)`);
  };
  return {
    ...actual,
    default: blockedSocket,
    makeWASocket: blockedSocket,
    fetchLatestBaileysVersion: () =>
      Promise.reject(new Error(`${NETWORK_BLOCKED}: fetchLatestBaileysVersion`)),
  };
});

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const realFetch = globalThis.fetch;

function hostOf(input: string | URL | Request): string {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(href).hostname;
  } catch {
    return '';
  }
}

globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
  const host = hostOf(input);
  if (!LOOPBACK_HOSTS.has(host)) {
    return Promise.reject(new Error(`${NETWORK_BLOCKED}: fetch to ${host || 'an invalid URL'}`));
  }
  return realFetch(input, init);
};
