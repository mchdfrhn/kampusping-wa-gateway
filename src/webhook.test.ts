import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type { GatewayEvent } from './client.js';
import { captureLogger, FakeScheduler, flush, silentLogger } from './test/fakes.js';
import { createWebhookSender, signBody } from './webhook.js';

const URL_ = 'http://127.0.0.1:8000/api/v1/webhooks/whatsapp';
const SECRET = 'webhook-secret-0123456789abcdef';

interface Call {
  body: Buffer;
  headers: Record<string, string>;
  event: GatewayEvent;
}

type Answer = number | Error;

/**
 * Fake fetch answering with the queued status codes (or throwing the queued errors), or with
 * what `answerFor` decides for the event when given.
 */
function fakeFetch(
  answers: Answer[] = [],
  fallback: Answer = 202,
  answerFor?: (event: GatewayEvent) => Answer | undefined,
) {
  const calls: Call[] = [];
  const fetchFn = vi.fn((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    expect(url).toBe(URL_);
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('manual');
    const body = init?.body as Buffer;
    calls.push({
      body,
      headers: init?.headers as Record<string, string>,
      event: JSON.parse(body.toString('utf8')) as GatewayEvent,
    });
    const decided = answerFor?.(calls[calls.length - 1]!.event);
    const answer = decided ?? (answers.length > 0 ? answers.shift()! : fallback);
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(new Response(null, { status: answer }));
  });
  return { fetchFn, calls };
}

const delivered = (id: string): GatewayEvent => ({
  type: 'status',
  provider_message_id: id,
  state: 'delivered',
});
const read = (id: string): GatewayEvent => ({
  type: 'status',
  provider_message_id: id,
  state: 'read',
});

describe('webhook sender', () => {
  it('test_webhook_sender_signs_body_with_hmac_sha256_lowercase_hex', async () => {
    const { fetchFn, calls } = fakeFetch();
    const sender = createWebhookSender({
      url: URL_,
      secret: SECRET,
      fetch: fetchFn,
      scheduler: new FakeScheduler(),
      logger: silentLogger(),
    });
    const event: GatewayEvent = {
      type: 'status',
      provider_message_id: '3EB0C0FFEE',
      state: 'read',
    };
    sender.enqueue(event);
    await sender.idle();

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(Buffer.isBuffer(call!.body)).toBe(true);
    const expected = createHmac('sha256', SECRET).update(call!.body).digest('hex');
    expect(call!.headers['x-signature']).toBe(`sha256=${expected}`);
    expect(call!.headers['x-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(call!.headers['content-type']).toBe('application/json');
    expect(call!.event).toEqual(event);

    // Same known vector as the backend's signature test.
    expect(signBody('key', Buffer.from('The quick brown fox jumps over the lazy dog'))).toBe(
      'sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    );
  });

  it('test_webhook_retries_with_backoff_on_non_2xx_and_network_error', async () => {
    const scheduler = new FakeScheduler();
    const { fetchFn, calls } = fakeFetch([500, new TypeError('fetch failed'), 401, 302, 202]);
    const sender = createWebhookSender({
      url: URL_,
      secret: SECRET,
      fetch: fetchFn,
      scheduler,
      logger: silentLogger(),
    });
    sender.enqueue({ type: 'connection', state: 'connected' });
    await scheduler.runAll();
    await sender.idle();

    expect(calls).toHaveLength(5);
    expect(scheduler.sleeps).toEqual([1000, 2000, 4000, 8000]);
    // Every attempt sends the identical bytes with the identical signature.
    expect(new Set(calls.map((call) => call.body.toString('hex'))).size).toBe(1);
    expect(new Set(calls.map((call) => call.headers['x-signature'])).size).toBe(1);
  });

  it('test_webhook_drops_after_the_last_retry_with_a_warning_without_payload', async () => {
    const scheduler = new FakeScheduler();
    const { fetchFn, calls } = fakeFetch([], 503);
    const { logger, lines } = captureLogger();
    const sender = createWebhookSender({
      url: URL_,
      secret: SECRET,
      fetch: fetchFn,
      scheduler,
      logger,
    });
    sender.enqueue(delivered('3EB0SECRETID'));
    await scheduler.runAll();
    await sender.idle();

    expect(calls).toHaveLength(6); // first attempt + 5 retries
    expect(scheduler.sleeps).toEqual([1000, 2000, 4000, 8000, 16000]);
    const warnings = lines.filter((line) => line.includes('"level":40'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('dropped');
    expect(lines.join('\n')).not.toContain('3EB0SECRETID');
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(sender.queued()).toBe(0);
  });

  it('test_webhook_preserves_per_message_order', async () => {
    const scheduler = new FakeScheduler();
    // A's "delivered" fails twice; meanwhile A's "read" and B's "delivered" are queued.
    let failuresLeft = 2;
    const { fetchFn, calls } = fakeFetch([], 202, (event) => {
      if (event.type === 'status' && event.provider_message_id === 'A' && failuresLeft > 0) {
        failuresLeft -= 1;
        return 500;
      }
      return undefined;
    });
    const sender = createWebhookSender({
      url: URL_,
      secret: SECRET,
      fetch: fetchFn,
      scheduler,
      logger: silentLogger(),
    });
    sender.enqueue(delivered('A'));
    await flush();
    sender.enqueue(read('A'));
    sender.enqueue(delivered('B'));
    await flush();

    // B is not held up by A's retries.
    expect(calls.map((call) => call.event)).toEqual([delivered('A'), delivered('B')]);

    await scheduler.runAll();
    await sender.idle();
    const forA = calls
      .map((call) => call.event)
      .filter((event) => event.type === 'status' && event.provider_message_id === 'A');
    expect(forA).toEqual([delivered('A'), delivered('A'), delivered('A'), read('A')]);
  });

  it('test_webhook_continues_with_the_next_event_after_a_drop', async () => {
    const scheduler = new FakeScheduler();
    const { fetchFn, calls } = fakeFetch([500, 500, 500]);
    const sender = createWebhookSender({
      url: URL_,
      secret: SECRET,
      fetch: fetchFn,
      scheduler,
      retries: 2,
      baseDelayMs: 100,
      logger: silentLogger(),
    });
    sender.enqueue(delivered('A'));
    sender.enqueue(read('A'));
    await scheduler.runAll();
    await sender.idle();
    expect(scheduler.sleeps).toEqual([100, 200]);
    expect(calls.map((call) => call.event)).toEqual([
      delivered('A'),
      delivered('A'),
      delivered('A'),
      read('A'),
    ]);
  });

  it('test_webhook_queue_is_bounded', async () => {
    const scheduler = new FakeScheduler();
    const { fetchFn } = fakeFetch([], 500);
    const { logger, lines } = captureLogger();
    const sender = createWebhookSender({
      url: URL_,
      secret: SECRET,
      fetch: fetchFn,
      scheduler,
      maxQueued: 2,
      logger,
    });
    sender.enqueue(delivered('A'));
    sender.enqueue(delivered('B'));
    sender.enqueue(delivered('C'));
    expect(sender.queued()).toBe(2);
    expect(lines.some((line) => line.includes('queue full'))).toBe(true);
    await scheduler.runAll();
    await sender.idle();
  });
});
