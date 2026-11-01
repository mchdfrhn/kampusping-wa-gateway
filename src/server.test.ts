import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { GatewayEvent } from './client.js';
import { loadConfig } from './config.js';
import { createGateway } from './server.js';
import { FakeClient, FakeScheduler, silentLogger, withTempDir } from './test/fakes.js';

const API_KEY = 'gateway-test-key-0123456789abcdef';
const SECRET = 'webhook-secret-0123456789abcdef';
const WEBHOOK = 'http://127.0.0.1:8000/api/v1/webhooks/whatsapp';

describe('gateway composition', () => {
  it('test_events_from_client_are_forwarded_to_webhook', async () => {
    await withTempDir(async (dir) => {
      const config = loadConfig({
        WA_GATEWAY_API_KEY: API_KEY,
        WA_WEBHOOK_URL: WEBHOOK,
        WA_WEBHOOK_SECRET: SECRET,
        WA_DEDUPE_FILE: join(dir, 'sent-refs.json'),
        WA_AUTH_DIR: join(dir, 'auth'),
      });
      const received: { event: GatewayEvent; signature: string; valid: boolean }[] = [];
      const fetchFn = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        const body = init?.body as Buffer;
        const headers = init?.headers as Record<string, string>;
        const signature = headers['x-signature'] ?? '';
        const expected = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
        received.push({
          event: JSON.parse(body.toString('utf8')) as GatewayEvent,
          signature,
          valid: signature === expected,
        });
        return Promise.resolve(new Response(null, { status: 202 }));
      });
      const scheduler = new FakeScheduler();
      const client = new FakeClient();
      const gateway = await createGateway({
        config,
        client,
        logger: silentLogger(),
        fetch: fetchFn,
        scheduler,
      });
      try {
        await gateway.app.ready();

        // Connection changes go out straight away.
        client.emit({ type: 'connection', state: 'connected' });
        await scheduler.advance(0);
        expect(received.map((r) => r.event)).toEqual([{ type: 'connection', state: 'connected' }]);

        // A receipt for a message sent through the API waits for the delay after the answer.
        const response = await gateway.app.inject({
          method: 'POST',
          url: '/messages',
          headers: { authorization: `Bearer ${API_KEY}` },
          payload: { to: '+6281234567890', text: 'Halo', client_ref: 'msg-1' },
        });
        expect(response.json()).toEqual({ provider_message_id: 'wamid-1' });
        client.emit({ type: 'status', provider_message_id: 'wamid-1', state: 'delivered' });
        await scheduler.advance(1999);
        expect(received).toHaveLength(1);
        await scheduler.advance(1);
        expect(received.map((r) => r.event)).toEqual([
          { type: 'connection', state: 'connected' },
          { type: 'status', provider_message_id: 'wamid-1', state: 'delivered' },
        ]);
        expect(received.every((r) => r.valid)).toBe(true);
      } finally {
        await gateway.close();
      }
    });
  });

  it('test_gateway_listen_starts_the_client_and_close_stops_it', async () => {
    await withTempDir(async (dir) => {
      const config = loadConfig({
        WA_GATEWAY_API_KEY: API_KEY,
        WA_WEBHOOK_URL: WEBHOOK,
        WA_WEBHOOK_SECRET: SECRET,
        WA_DEDUPE_FILE: join(dir, 'sent-refs.json'),
        GATEWAY_PORT: '18095',
      });
      const client = new FakeClient();
      let stopped = 0;
      client.stop = () => {
        stopped += 1;
        return Promise.resolve();
      };
      const gateway = await createGateway({ config, client, logger: silentLogger() });
      const address = await gateway.listen();
      expect(address).toContain('127.0.0.1:18095');
      expect(client.startCalls).toBe(1);

      const unauthenticated = await fetch('http://127.0.0.1:18095/status');
      expect(unauthenticated.status).toBe(401);

      await gateway.close();
      expect(stopped).toBe(1);
    });
  });

  it('test_close_waits_for_held_receipts_and_queued_webhooks', async () => {
    await withTempDir(async (dir) => {
      const config = loadConfig({
        WA_GATEWAY_API_KEY: API_KEY,
        WA_WEBHOOK_URL: WEBHOOK,
        WA_WEBHOOK_SECRET: SECRET,
        WA_DEDUPE_FILE: join(dir, 'sent-refs.json'),
      });
      const posted: GatewayEvent[] = [];
      const fetchFn = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        posted.push(JSON.parse((init!.body as Buffer).toString('utf8')) as GatewayEvent);
        return Promise.resolve(new Response(null, { status: 202 }));
      });
      const scheduler = new FakeScheduler();
      const client = new FakeClient();
      const gateway = await createGateway({
        config,
        client,
        logger: silentLogger(),
        fetch: fetchFn,
        scheduler,
      });
      await gateway.app.inject({
        method: 'POST',
        url: '/messages',
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { to: '+6281234567890', text: 'Halo', client_ref: 'msg-1' },
      });
      client.emit({ type: 'status', provider_message_id: 'wamid-1', state: 'read' });

      let closed = false;
      const closing = gateway.close().then(() => {
        closed = true;
      });
      await scheduler.advance(1000);
      expect(closed).toBe(false); // the receipt is still held by the relay
      await scheduler.advance(1000);
      await closing;
      expect(posted).toEqual([{ type: 'status', provider_message_id: 'wamid-1', state: 'read' }]);
      // The replay that was scheduled after delivery is dropped by close().
      await scheduler.runAll();
      expect(posted).toHaveLength(1);
    });
  });

  it('test_close_gives_up_draining_after_the_cap', async () => {
    await withTempDir(async (dir) => {
      const config = loadConfig({
        WA_GATEWAY_API_KEY: API_KEY,
        WA_WEBHOOK_URL: WEBHOOK,
        WA_WEBHOOK_SECRET: SECRET,
        WA_DEDUPE_FILE: join(dir, 'sent-refs.json'),
      });
      const scheduler = new FakeScheduler();
      const client = new FakeClient();
      const gateway = await createGateway({
        config,
        client,
        logger: silentLogger(),
        fetch: () => new Promise<Response>(() => undefined), // backend never answers
        scheduler,
        shutdownFlushMs: 50,
      });
      client.emit({ type: 'connection', state: 'connected' });
      const started = Date.now();
      await gateway.close();
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });
});
