/**
 * HTTP API used by the backend worker (contract in the README and in the backend's
 * `app/modules/whatsapp/gateway.py`). Every route, including unknown ones, needs
 * `Authorization: Bearer <WA_GATEWAY_API_KEY>`. Bodies are never logged.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import type { Logger } from 'pino';

import {
  ClientRefConflictError,
  DisconnectedError,
  NotOnWhatsAppError,
  type WaClient,
} from './client.js';
import type { DedupeStore } from './dedupe.js';
import { createMessageSender, type SendRequest } from './send.js';

/** Hooks the receipt relay uses to hold delivery receipts until the backend knows the id. */
export interface SendObserver {
  sendResolved(providerMessageId: string): void;
  sendResponded(providerMessageId: string): void;
}

export interface AppOptions {
  client: WaClient;
  apiKey: string;
  dedupe: DedupeStore;
  logger: Logger;
  observer?: SendObserver;
}

const PHONE_PATTERN = /^\+\d{8,15}$/;
const MAX_TEXT_CHARS = 4096;
const MAX_CLIENT_REF_CHARS = 100;
const BODY_LIMIT_BYTES = 64 * 1024;

/** Constant-time string comparison over equal-length SHA-256 digests. */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

function isAuthorized(header: string | undefined, apiKey: string): boolean {
  if (typeof header !== 'string') return false;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  // Compare even when the scheme is wrong, so timing does not reveal which part failed.
  return safeEqual(match?.[1] ?? '', apiKey) && match !== null;
}

function parseSendRequest(body: unknown): SendRequest | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { to, text, client_ref: clientRef } = body as Record<string, unknown>;
  if (typeof to !== 'string' || !PHONE_PATTERN.test(to)) return null;
  if (typeof text !== 'string' || text.trim() === '' || codePoints(text) > MAX_TEXT_CHARS) {
    return null;
  }
  if (
    typeof clientRef !== 'string' ||
    clientRef === '' ||
    codePoints(clientRef) > MAX_CLIENT_REF_CHARS
  ) {
    return null;
  }
  return { to, text, clientRef };
}

function codePoints(value: string): number {
  return Array.from(value).length;
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * What may be logged about an error: its type and a numeric status code. Never its message:
 * library errors can quote JIDs (phone numbers) or even the message text.
 */
export function errorFacts(error: unknown): { err_type: string; err_code?: number } {
  const facts: { err_type: string; err_code?: number } = { err_type: errorType(error) };
  if (typeof error === 'object' && error !== null) {
    const boom = (error as { output?: { statusCode?: unknown } }).output?.statusCode;
    const plain = (error as { statusCode?: unknown }).statusCode;
    const code = typeof boom === 'number' ? boom : plain;
    if (typeof code === 'number') facts.err_code = code;
  }
  return facts;
}

/** The Fastify instance, typed with the pino logger it was given. */
export type GatewayApp = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  Logger
>;

export function createApp(options: AppOptions): GatewayApp {
  const { client, apiKey, dedupe, observer } = options;
  const logger = options.logger;
  const app = Fastify({ loggerInstance: logger, bodyLimit: BODY_LIMIT_BYTES });
  const sender = createMessageSender({
    client,
    dedupe,
    logger,
    ...(observer ? { onSendResolved: (id: string) => observer.sendResolved(id) } : {}),
  });
  const answeredIds = new WeakMap<FastifyRequest, string>();

  app.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done) => {
    if (!isAuthorized(request.headers.authorization, apiKey)) {
      logger.warn({ method: request.method, url: request.url }, 'rejected request: bad API key');
      void reply.code(401).send({ error: 'unauthorized' });
      return; // answered: the route handler never runs
    }
    done();
  });

  app.addHook('onResponse', (request: FastifyRequest, _reply, done) => {
    const id = answeredIds.get(request);
    if (id !== undefined) observer?.sendResponded(id);
    done();
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({ error: 'not_found' });
  });

  app.setErrorHandler(async (error: { statusCode?: number }, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      // Body parsing problems (not JSON, wrong content type, too large): permanent.
      return reply.code(400).send({ error: 'invalid_request' });
    }
    logger.error({ url: request.url, ...errorFacts(error) }, 'unexpected error');
    return reply.code(500).send({ error: 'internal' });
  });

  app.post('/messages', async (request, reply) => {
    const parsed = parseSendRequest(request.body);
    if (!parsed) return reply.code(400).send({ error: 'invalid_request' });

    try {
      const outcome = await sender.send(parsed);
      answeredIds.set(request, outcome.providerMessageId);
      return reply.code(200).send({ provider_message_id: outcome.providerMessageId });
    } catch (error) {
      if (error instanceof ClientRefConflictError) {
        return reply.code(409).send({ error: 'client_ref_conflict' });
      }
      if (error instanceof NotOnWhatsAppError) {
        logger.info({ ref: parsed.clientRef }, 'number is not on WhatsApp');
        return reply.code(404).send({ error: 'not_on_whatsapp' });
      }
      if (error instanceof DisconnectedError) {
        logger.warn({ ref: parsed.clientRef }, 'send refused: session not connected');
        return reply.code(503).send({ error: 'disconnected' });
      }
      logger.error({ ref: parsed.clientRef, ...errorFacts(error) }, 'send failed');
      return reply.code(500).send({ error: 'internal' });
    }
  });

  app.get('/status', (_request, reply) => {
    void reply.code(200).send(client.snapshot());
  });

  app.post('/logout', async (_request, reply) => {
    try {
      await client.logout();
    } catch (error) {
      logger.error(errorFacts(error), 'logout failed');
      return reply.code(500).send({ error: 'internal' });
    }
    return reply.code(200).send({ status: 'ok' });
  });

  return app;
}
