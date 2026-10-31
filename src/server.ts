/**
 * Composition: dedupe store + receipt relay + webhook sender + HTTP API around one WaClient.
 * `index.ts` builds the real Baileys client and calls this; tests pass a fake client, a fake
 * fetch and a fake scheduler.
 */
import type { Logger } from 'pino';

import { createApp, type GatewayApp } from './app.js';
import type { WaClient } from './client.js';
import type { GatewayConfig } from './config.js';
import { openDedupeStore, type DedupeStore } from './dedupe.js';
import { createEventRelay, type EventRelay } from './relay.js';
import { realScheduler, type Scheduler } from './scheduler.js';
import { createWebhookSender, type WebhookSender } from './webhook.js';

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const SHUTDOWN_FLUSH_MS = 5000;

export interface GatewayDeps {
  config: GatewayConfig;
  client: WaClient;
  logger: Logger;
  fetch?: typeof fetch;
  scheduler?: Scheduler;
}

export interface Gateway {
  app: GatewayApp;
  dedupe: DedupeStore;
  relay: EventRelay;
  webhook: WebhookSender;
  /** Listen on GATEWAY_HOST:GATEWAY_PORT, then start the WhatsApp client. */
  listen(): Promise<string>;
  /** Stop accepting requests, close the WhatsApp socket, give queued webhooks a moment. */
  close(): Promise<void>;
}

export async function createGateway(deps: GatewayDeps): Promise<Gateway> {
  const { config, client, logger } = deps;
  const scheduler = deps.scheduler ?? realScheduler;

  const dedupe = await openDedupeStore({
    file: config.dedupeFile,
    ttlDays: config.dedupeTtlDays,
    logger,
  });
  const webhook = createWebhookSender({
    url: config.webhookUrl,
    secret: config.webhookSecret,
    logger,
    scheduler,
    retries: config.webhookRetries,
    baseDelayMs: config.webhookRetryBaseMs,
    timeoutMs: config.webhookTimeoutMs,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  const relay = createEventRelay({
    deliver: (event) => webhook.enqueue(event),
    scheduler,
    statusDelayMs: config.statusDelayMs,
  });
  client.onEvent((event) => relay.handle(event));

  const app = createApp({ client, apiKey: config.apiKey, dedupe, logger, observer: relay });

  const pruneTimer = setInterval(() => {
    dedupe.prune().then(
      (removed) => {
        if (removed > 0) logger.info({ removed }, 'dedupe store pruned');
      },
      (error: unknown) =>
        logger.error({ code: (error as NodeJS.ErrnoException).code }, 'dedupe prune failed'),
    );
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  return {
    app,
    dedupe,
    relay,
    webhook,
    async listen() {
      const address = await app.listen({ host: config.host, port: config.port });
      await client.start();
      return address;
    },
    async close() {
      clearInterval(pruneTimer);
      await app.close();
      await client.stop?.();
      let flushTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        webhook.idle(),
        new Promise<void>((resolve) => {
          flushTimer = setTimeout(resolve, SHUTDOWN_FLUSH_MS);
        }),
      ]);
      clearTimeout(flushTimer);
    },
  };
}
