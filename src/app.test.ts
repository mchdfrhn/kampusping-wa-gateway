import * as crypto from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp, type GatewayApp, type SendObserver } from './app.js';
import { openDedupeStore, type DedupeStore } from './dedupe.js';
import { captureLogger, FakeClient, silentLogger, withTempDir } from './test/fakes.js';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof crypto>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const API_KEY = 'gateway-test-key-0123456789abcdef';
const PHONE = '+6281234567890';
const TEXT = 'Halo, tagihan SPP Anda jatuh tempo pada 10 November.';
const AUTH = { authorization: `Bearer ${API_KEY}` };

interface Harness {
  app: GatewayApp;
  client: FakeClient;
  dedupe: DedupeStore;
  file: string;
}

let apps: GatewayApp[] = [];

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps = [];
});

async function harness(
  dir: string,
  options: { logger?: Logger; observer?: SendObserver; client?: FakeClient } = {},
): Promise<Harness> {
  const file = join(dir, 'sent-refs.json');
  const dedupe = await openDedupeStore({ file, ttlDays: 14, logger: silentLogger() });
  const client = options.client ?? new FakeClient();
  const app = createApp({
    client,
    apiKey: API_KEY,
    dedupe,
    logger: options.logger ?? silentLogger(),
    ...(options.observer ? { observer: options.observer } : {}),
  });
  apps.push(app);
  await app.ready();
  return { app, client, dedupe, file };
}

function send(app: GatewayApp, payload: unknown, headers: Record<string, string> = AUTH) {
  return app.inject({ method: 'POST', url: '/messages', headers, payload: payload as object });
}

const message = (clientRef = 'msg-1') => ({ to: PHONE, text: TEXT, client_ref: clientRef });

describe('gateway HTTP API', () => {
  it('test_requests_without_bearer_are_401', async () => {
    await withTempDir(async (dir) => {
      const { app, client } = await harness(dir);
      const attempts: Record<string, string>[] = [
        {},
        { authorization: 'Bearer wrong-key-wrong-key-wrong' },
        { authorization: `Basic ${API_KEY}` },
        { authorization: API_KEY },
        { authorization: `Bearer ${API_KEY}x` },
        { authorization: 'Bearer ' },
      ];
      const timingSafeEqual = vi.mocked(crypto.timingSafeEqual);
      timingSafeEqual.mockClear();

      for (const headers of attempts) {
        for (const request of [
          () => send(app, message(), headers),
          () => app.inject({ method: 'GET', url: '/status', headers }),
          () => app.inject({ method: 'POST', url: '/logout', headers }),
        ]) {
          const response = await request();
          expect(response.statusCode).toBe(401);
          expect(response.json()).toEqual({ error: 'unauthorized' });
        }
      }
      // Unknown routes are protected too (no route discovery without the key).
      const unknown = await app.inject({ method: 'GET', url: '/nope' });
      expect(unknown.statusCode).toBe(401);

      expect(client.sent).toEqual([]);
      expect(client.logoutCalls).toBe(0);
      // The key comparison goes through crypto.timingSafeEqual (equal-length digests).
      expect(timingSafeEqual).toHaveBeenCalled();
      for (const [a, b] of timingSafeEqual.mock.calls) {
        expect((a as Buffer).length).toBe((b as Buffer).length);
      }
    });
  });

  it('test_send_returns_provider_message_id', async () => {
    await withTempDir(async (dir) => {
      const { app, client } = await harness(dir);
      const response = await send(app, message());
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ provider_message_id: 'wamid-1' });
      expect(client.sent).toEqual([{ phone: PHONE, text: TEXT, id: 'wamid-1' }]);
    });
  });

  it('test_send_unregistered_number_is_404_not_on_whatsapp', async () => {
    await withTempDir(async (dir) => {
      const { app, client, dedupe } = await harness(dir);
      client.unregistered.add(PHONE);
      const response = await send(app, message());
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'not_on_whatsapp' });
      expect(client.sent).toEqual([]);
      expect(dedupe.get('msg-1')).toBeUndefined();
    });
  });

  it('test_send_while_disconnected_is_503', async () => {
    await withTempDir(async (dir) => {
      const { app, client } = await harness(dir);
      for (const state of ['disconnected', 'connecting', 'qr'] as const) {
        client.state = state;
        const response = await send(app, message(`msg-${state}`));
        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ error: 'disconnected' });
      }
      expect(client.sent).toEqual([]);
    });
  });

  it('test_send_invalid_request_is_400', async () => {
    await withTempDir(async (dir) => {
      const { app, client } = await harness(dir);
      const invalid: unknown[] = [
        { ...message(), to: '081234567890' },
        { ...message(), to: '+62 812 3456 7890' },
        { ...message(), to: '+1234567' },
        { ...message(), to: '+1234567890123456' },
        { ...message(), to: 6281234567890 },
        { ...message(), text: '' },
        { ...message(), text: '   ' },
        { ...message(), text: 'x'.repeat(4097) },
        { ...message(), text: 42 },
        { ...message(), client_ref: '' },
        { ...message(), client_ref: 'r'.repeat(101) },
        { to: PHONE, text: TEXT },
      ];
      for (const payload of invalid) {
        const response = await send(app, payload);
        expect(response.statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400);
        expect(response.json()).toEqual({ error: 'invalid_request' });
      }

      for (const raw of ['[1,2,3]', '"just a string"', 'null', '{not json', '']) {
        const response = await app.inject({
          method: 'POST',
          url: '/messages',
          headers: { ...AUTH, 'content-type': 'application/json' },
          payload: raw,
        });
        expect(response.statusCode, raw).toBe(400);
        expect(response.json()).toEqual({ error: 'invalid_request' });
      }
      const form = await app.inject({
        method: 'POST',
        url: '/messages',
        headers: { ...AUTH, 'content-type': 'text/plain' },
        payload: 'to=+6281234567890',
      });
      expect(form.statusCode).toBe(400);
      expect(form.json()).toEqual({ error: 'invalid_request' });

      // Boundaries that are valid: 8 and 15 digits, exactly 4096 characters, 100-char ref.
      const ok = await send(app, {
        to: '+12345678',
        text: 'x'.repeat(4096),
        client_ref: 'r'.repeat(100),
      });
      expect(ok.statusCode).toBe(200);
      const fifteen = await send(app, { ...message('msg-15'), to: '+123456789012345' });
      expect(fifteen.statusCode).toBe(200);
      expect(client.sent).toHaveLength(2);
    });
  });

  it('test_send_unexpected_failure_is_500_internal', async () => {
    await withTempDir(async (dir) => {
      const { app, client, dedupe } = await harness(dir);
      client.sendImpl = () => Promise.reject(new Error('socket exploded'));
      const response = await send(app, message());
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: 'internal' });
      expect(dedupe.get('msg-1')).toBeUndefined();
    });
  });

  it('test_status_returns_snapshot_with_qr', async () => {
    await withTempDir(async (dir) => {
      const { app, client } = await harness(dir);
      client.state = 'qr';
      client.qr = '2@abcdef,ghijkl';
      const response = await app.inject({ method: 'GET', url: '/status', headers: AUTH });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ state: 'qr', qr: '2@abcdef,ghijkl' });

      client.state = 'connected';
      client.qr = null;
      const connected = await app.inject({ method: 'GET', url: '/status', headers: AUTH });
      expect(connected.json()).toEqual({ state: 'connected', qr: null });
    });
  });

  it('test_logout_calls_client', async () => {
    await withTempDir(async (dir) => {
      const { app, client } = await harness(dir);
      const response = await app.inject({ method: 'POST', url: '/logout', headers: AUTH });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
      expect(client.logoutCalls).toBe(1);

      client.logout = () => Promise.reject(new Error('boom'));
      const failed = await app.inject({ method: 'POST', url: '/logout', headers: AUTH });
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toEqual({ error: 'internal' });
    });
  });

  it('test_repeated_client_ref_returns_original_id_without_sending', async () => {
    await withTempDir(async (dir) => {
      const { app, client } = await harness(dir);
      const first = await send(app, message('msg-7'));
      expect(first.json()).toEqual({ provider_message_id: 'wamid-1' });

      // Even while disconnected, a known ref answers with the original id.
      client.state = 'disconnected';
      const again = await send(app, message('msg-7'));
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual({ provider_message_id: 'wamid-1' });
      expect(client.sent).toHaveLength(1);
    });
  });

  it('test_repeated_client_ref_is_remembered_across_restarts', async () => {
    await withTempDir(async (dir) => {
      const first = await harness(dir);
      await send(first.app, message('msg-8'));
      await first.app.close();

      const client = new FakeClient();
      const second = await harness(dir, { client });
      const again = await send(second.app, message('msg-8'));
      expect(again.json()).toEqual({ provider_message_id: 'wamid-1' });
      expect(client.sent).toEqual([]);
      // The fingerprint is reloaded too: other content under the same ref is still refused.
      const reused = await send(second.app, { ...message('msg-8'), text: 'lain' });
      expect(reused.statusCode).toBe(409);
    });
  });

  it('test_reused_client_ref_with_different_text_is_409_and_sends_nothing', async () => {
    await withTempDir(async (dir) => {
      const { app, client } = await harness(dir);
      expect((await send(app, message('msg-1'))).statusCode).toBe(200);
      const reused = await send(app, {
        ...message('msg-1'),
        text: 'Pesan lain untuk mahasiswa lain',
      });
      expect(reused.statusCode).toBe(409);
      expect(reused.json()).toEqual({ error: 'client_ref_conflict' });
      expect(client.sent).toHaveLength(1);

      // Same ref with the original content still answers the original id.
      const same = await send(app, message('msg-1'));
      expect(same.json()).toEqual({ provider_message_id: 'wamid-1' });
    });
  });

  it('test_reused_client_ref_with_different_to_is_409', async () => {
    await withTempDir(async (dir) => {
      const { app, client } = await harness(dir);
      await send(app, message('msg-2'));
      const reused = await send(app, { ...message('msg-2'), to: '+6289999999999' });
      expect(reused.statusCode).toBe(409);
      expect(reused.json()).toEqual({ error: 'client_ref_conflict' });
      expect(client.sent).toHaveLength(1);
    });
  });

  it('test_concurrent_reuse_with_different_content_is_409', async () => {
    await withTempDir(async (dir) => {
      const { app, client } = await harness(dir);
      let release: (value: { id: string }) => void = () => undefined;
      client.sendImpl = () =>
        new Promise((resolve) => {
          release = resolve;
        });
      const first = send(app, message('msg-3'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const other = await send(app, { ...message('msg-3'), text: 'beda' });
      expect(other.statusCode).toBe(409);
      release({ id: 'wamid-3' });
      expect((await first).json()).toEqual({ provider_message_id: 'wamid-3' });
    });
  });

  it('test_legacy_record_without_fingerprint_dedupes_by_ref_only', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'sent-refs.json');
      await writeFile(
        file,
        JSON.stringify({
          version: 1,
          entries: {
            'msg-old': { provider_message_id: 'wamid-legacy', sent_at: new Date().toISOString() },
          },
        }),
      );
      const { app, client } = await harness(dir);
      const response = await send(app, { ...message('msg-old'), text: 'anything at all' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ provider_message_id: 'wamid-legacy' });
      expect(client.sent).toEqual([]);
    });
  });

  it('test_fingerprint_is_not_reversible', async () => {
    await withTempDir(async (dir) => {
      const { app, file } = await harness(dir);
      await send(app, message('msg-f'));
      const stored = await readFile(file, 'utf8');
      expect(stored).not.toContain(PHONE);
      expect(stored).not.toContain('81234567890');
      expect(stored).not.toContain('tagihan');
      const parsed = JSON.parse(stored) as {
        entries: Record<string, { fingerprint?: string }>;
      };
      expect(parsed.entries['msg-f']?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    });
  });
  it('test_concurrent_same_client_ref_sends_once', async () => {
    await withTempDir(async (dir) => {
      const { app, client } = await harness(dir);
      let release: (value: { id: string }) => void = () => undefined;
      let calls = 0;
      client.sendImpl = () => {
        calls += 1;
        return new Promise((resolve) => {
          release = resolve;
        });
      };

      const pending = [
        send(app, message('msg-9')),
        send(app, message('msg-9')),
        send(app, message('msg-9')),
      ];
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toBe(1);
      release({ id: 'wamid-only' });

      const responses = await Promise.all(pending);
      for (const response of responses) {
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ provider_message_id: 'wamid-only' });
      }
      expect(calls).toBe(1);
    });
  });

  it('test_concurrent_same_client_ref_shares_a_failure', async () => {
    await withTempDir(async (dir) => {
      const { app, client } = await harness(dir);
      let fail: (error: Error) => void = () => undefined;
      let calls = 0;
      client.sendImpl = () => {
        calls += 1;
        return new Promise((_resolve, reject) => {
          fail = reject;
        });
      };
      const pending = [send(app, message('msg-x')), send(app, message('msg-x'))];
      await new Promise((resolve) => setTimeout(resolve, 20));
      fail(new Error('lost'));
      const responses = await Promise.all(pending);
      expect(responses.map((response) => response.statusCode)).toEqual([500, 500]);
      expect(calls).toBe(1);
    });
  });

  it('test_failed_send_is_not_recorded_and_can_be_retried', async () => {
    await withTempDir(async (dir) => {
      const { app, client, dedupe } = await harness(dir);
      client.sendImpl = () => Promise.reject(new Error('timeout'));
      expect((await send(app, message('msg-r'))).statusCode).toBe(500);
      expect(dedupe.get('msg-r')).toBeUndefined();

      client.state = 'disconnected';
      client.sendImpl = undefined;
      expect((await send(app, message('msg-r'))).statusCode).toBe(503);

      client.state = 'connected';
      const retried = await send(app, message('msg-r'));
      expect(retried.statusCode).toBe(200);
      expect(retried.json()).toEqual({ provider_message_id: 'wamid-1' });
      expect(dedupe.get('msg-r')?.provider_message_id).toBe('wamid-1');
      expect(client.sent).toHaveLength(1);
    });
  });

  it('test_send_answers_200_when_the_dedupe_write_fails_after_sending', async () => {
    await withTempDir(async (dir) => {
      const { app, client, dedupe } = await harness(dir);
      dedupe.record = () => Promise.reject(new Error('ENOSPC'));
      const response = await send(app, message('msg-d'));
      // The message went out: answering an error would make the worker send it again.
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ provider_message_id: 'wamid-1' });
      expect(client.sent).toHaveLength(1);
    });
  });

  it('test_observer_hears_send_resolved_before_and_responded_after_the_reply', async () => {
    await withTempDir(async (dir) => {
      const calls: string[] = [];
      const observer: SendObserver = {
        sendResolved: (id) => calls.push(`resolved:${id}`),
        sendResponded: (id) => calls.push(`responded:${id}`),
      };
      const { app } = await harness(dir, { observer });
      await send(app, message('msg-o'));
      await send(app, message('msg-o')); // duplicate answers count as a response too
      expect(calls).toEqual(['resolved:wamid-1', 'responded:wamid-1', 'responded:wamid-1']);
    });
  });

  it('test_logs_never_contain_text_or_full_phone', async () => {
    await withTempDir(async (dir) => {
      const { logger, lines } = captureLogger('trace');
      const { app, client } = await harness(dir, { logger });

      await send(app, message('msg-a'));
      await send(app, message('msg-a'));
      client.unregistered.add('+6289999999999');
      await send(app, { ...message('msg-b'), to: '+6289999999999' });
      client.sendImpl = () =>
        Promise.reject(new Error(`failed to send "${TEXT}" to 6281234567890@s.whatsapp.net`));
      await send(app, message('msg-c'));
      await send(app, { ...message('msg-d'), text: '' });
      await send(app, message('msg-e'), { authorization: 'Bearer nope-nope-nope-nope' });
      await app.inject({ method: 'GET', url: '/status', headers: AUTH });

      const output = lines.join('\n');
      expect(lines.length).toBeGreaterThan(0);
      expect(output).toContain('7890'); // masked numbers keep the last four digits
      expect(output).not.toContain('6281234567890');
      expect(output).not.toContain('81234567890');
      expect(output).not.toContain('6289999999999');
      expect(output).not.toContain(TEXT);
      expect(output).not.toContain('tagihan');
      expect(output).not.toContain(API_KEY);
      expect(output).not.toContain('nope-nope');
    });
  });
});
