/**
 * Send a message at most once per `client_ref`.
 *
 * 1. A ref already in the dedupe store answers with the original id; nothing is sent.
 * 2. Concurrent requests with the same ref share one in-flight attempt (single-flight), so they
 *    all get the same outcome and exactly one message goes out.
 * 3. Only a successful send is recorded, so a failed attempt can be retried.
 *
 * The record is written right after `sendText` resolves and before the HTTP answer. If the
 * process dies in between (a window of milliseconds) the ref is lost and a later retry sends
 * again: at-least-once in that window, exactly-once otherwise. If the write itself fails the
 * send still answers 200 (the message did go out) and the in-memory record keeps deduplicating
 * until a restart; the failure is logged as an error.
 */
import type { Logger } from 'pino';

import { DisconnectedError, NotOnWhatsAppError, type WaClient } from './client.js';
import type { DedupeStore } from './dedupe.js';
import { maskPhone } from './phone.js';

export interface SendRequest {
  to: string;
  text: string;
  clientRef: string;
}

export interface SendOutcome {
  providerMessageId: string;
  duplicate: boolean;
}

export interface MessageSender {
  send(request: SendRequest): Promise<SendOutcome>;
}

export interface MessageSenderOptions {
  client: WaClient;
  dedupe: DedupeStore;
  logger: Logger;
  /** Called the moment WhatsApp accepted the message (before the dedupe write and the answer). */
  onSendResolved?: (providerMessageId: string) => void;
}

export function createMessageSender(options: MessageSenderOptions): MessageSender {
  const { client, dedupe, logger } = options;
  const inFlight = new Map<string, Promise<string>>();

  const attempt = async ({ to, text, clientRef }: SendRequest): Promise<string> => {
    if (client.snapshot().state !== 'connected') throw new DisconnectedError();
    if (!(await client.isOnWhatsApp(to))) throw new NotOnWhatsAppError();

    const { id } = await client.sendText(to, text);
    options.onSendResolved?.(id);
    try {
      await dedupe.record(clientRef, id);
    } catch (error) {
      logger.error(
        { ref: clientRef, code: (error as NodeJS.ErrnoException).code },
        'dedupe write failed after a successful send; the ref is only remembered until restart',
      );
    }
    logger.info({ to: maskPhone(to), ref: clientRef }, 'message sent');
    return id;
  };

  return {
    async send(request) {
      const known = dedupe.get(request.clientRef);
      if (known) {
        logger.info({ ref: request.clientRef }, 'duplicate client_ref; answering the original id');
        return { providerMessageId: known.provider_message_id, duplicate: true };
      }

      const running = inFlight.get(request.clientRef);
      if (running) {
        return { providerMessageId: await running, duplicate: true };
      }

      const promise = attempt(request);
      inFlight.set(request.clientRef, promise);
      try {
        return { providerMessageId: await promise, duplicate: false };
      } finally {
        inFlight.delete(request.clientRef);
      }
    },
  };
}
