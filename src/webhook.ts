/**
 * Signed webhook delivery to the backend.
 *
 * Each event is serialised once; the exact bytes are signed (`X-Signature: sha256=<lowercase hex
 * HMAC-SHA256>`, key WA_WEBHOOK_SECRET) and those same bytes are sent on every attempt.
 *
 * Delivery: one attempt plus up to `retries` retries on a network error, a timeout or any
 * non-2xx answer (redirects are not followed), waiting `baseDelayMs * 2^n` in between
 * (defaults: 1 s, 2 s, 4 s, 8 s, 16 s). Events are queued in memory in lanes: one lane per
 * message id (plus one for connection events). A lane delivers strictly in order, so a `read`
 * never overtakes a `delivered`, while one failing message does not hold up the others. An event
 * that still fails is dropped with a warning that carries no payload. The queue is lost on a
 * restart (documented in the README).
 *
 * Every attempt has its own timeout, enforced even if `fetch` ignores its abort signal.
 *
 * Replays: after a `status` event was delivered successfully, the same event is sent once more
 * `replayMs` later (through the same ordered, signed, retried path). That covers a backend whose
 * outcome commit took longer than the receipt delay, so it dropped the first copy as unknown; the
 * backend ignores stale or duplicate receipts. Pending replays are bounded and `stop()` drops them.
 */
import { createHmac } from 'node:crypto';
import type { Logger } from 'pino';

import type { GatewayEvent } from './client.js';
import { realScheduler, type Scheduler } from './scheduler.js';

export interface WebhookSenderOptions {
  url: string;
  secret: string;
  logger: Logger;
  fetch?: typeof fetch;
  scheduler?: Scheduler;
  /** Retries after the first attempt (default 5). */
  retries?: number;
  /** First retry delay in ms, doubled on every further retry (default 1000). */
  baseDelayMs?: number;
  /** Per-attempt timeout in ms (default 10000). */
  timeoutMs?: number;
  /** Events queued at most (all lanes together); newer events are dropped beyond it. */
  maxQueued?: number;
  /** Replay each delivered status event once after this delay (default 0 = off). */
  replayMs?: number;
  /** Replays waiting at most; further ones are skipped (default 1000). */
  maxPendingReplays?: number;
}

export interface WebhookSender {
  enqueue(event: GatewayEvent): void;
  /** Resolves once every queued event was delivered or dropped. */
  idle(): Promise<void>;
  queued(): number;
  /** Drop pending replays (shutdown). Queued events are still delivered. */
  stop(): void;
}

/** `sha256=<lowercase hex>` over the exact body bytes, as the backend's `verify_signature`. */
export function signBody(secret: string, body: Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function laneKey(event: GatewayEvent): string {
  return event.type === 'status' ? `status:${event.provider_message_id}` : event.type;
}

export function createWebhookSender(options: WebhookSenderOptions): WebhookSender {
  const { url, secret, logger } = options;
  const fetchFn = options.fetch ?? fetch;
  const scheduler = options.scheduler ?? realScheduler;
  const retries = options.retries ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxQueued = options.maxQueued ?? 10_000;
  const replayMs = options.replayMs ?? 0;
  const maxPendingReplays = options.maxPendingReplays ?? 1000;
  let pendingReplays = 0;
  let stopped = false;

  interface Queued {
    event: GatewayEvent;
    replay: boolean;
  }
  const lanes = new Map<string, Queued[]>();
  let total = 0;
  let idleWaiters: (() => void)[] = [];

  const attemptOnce = async (body: Buffer, signature: string): Promise<string | null> => {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error('webhook attempt timed out');
        error.name = 'TimeoutError';
        controller.abort(error);
        reject(error);
      }, timeoutMs);
      timer.unref();
    });
    try {
      const response = await Promise.race([
        fetchFn(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-signature': signature },
          body,
          redirect: 'manual',
          signal: controller.signal,
        }),
        timedOut,
      ]);
      await response.body?.cancel().catch(() => undefined);
      return response.status >= 200 && response.status < 300 ? null : `HTTP ${response.status}`;
    } catch (error) {
      return error instanceof Error ? error.name : 'unknown error';
    } finally {
      clearTimeout(timer);
    }
  };

  const scheduleReplay = (event: GatewayEvent): void => {
    if (event.type !== 'status' || replayMs <= 0 || stopped) return;
    if (pendingReplays >= maxPendingReplays) {
      logger.debug('replay skipped: too many pending replays');
      return;
    }
    pendingReplays += 1;
    void scheduler.sleep(replayMs).then(() => {
      pendingReplays -= 1;
      if (!stopped) push({ event, replay: true });
    });
  };

  /** True when delivered, false when dropped after the last retry. */
  const deliver = async (event: GatewayEvent): Promise<boolean> => {
    const body = Buffer.from(JSON.stringify(event), 'utf8');
    const signature = signBody(secret, body);
    let failure: string | null = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      failure = await attemptOnce(body, signature);
      if (failure === null) return true;
      if (attempt < retries) {
        const delay = baseDelayMs * 2 ** attempt;
        logger.debug(
          { type: event.type, attempt: attempt + 1, outcome: failure, retry_in_ms: delay },
          'webhook delivery failed; retrying',
        );
        await scheduler.sleep(delay);
      }
    }
    logger.warn(
      { type: event.type, attempts: retries + 1, outcome: failure },
      'webhook event dropped after the last retry',
    );
    return false;
  };

  const runLane = async (key: string, lane: Queued[]): Promise<void> => {
    while (lane.length > 0) {
      const { event, replay } = lane[0]!;
      const delivered = await deliver(event);
      if (delivered && !replay) scheduleReplay(event);
      lane.shift();
      total -= 1;
    }
    lanes.delete(key);
    if (lanes.size === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  };

  function push(item: Queued): void {
    if (total >= maxQueued) {
      logger.warn({ type: item.event.type }, 'webhook queue full; event dropped');
      return;
    }
    total += 1;
    const key = laneKey(item.event);
    const lane = lanes.get(key);
    if (lane) {
      lane.push(item);
      return;
    }
    const fresh = [item];
    lanes.set(key, fresh);
    void runLane(key, fresh);
  }

  return {
    enqueue(event) {
      push({ event, replay: false });
    },
    stop() {
      stopped = true;
    },
    idle() {
      if (lanes.size === 0) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
    queued() {
      return total;
    },
  };
}
