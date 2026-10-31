/**
 * The WhatsApp client contract. `baileys.ts` is the only real implementation (and the only file
 * that imports Baileys); every other module depends on this interface, so tests use a fake.
 */

export type ConnectionStateName = 'connected' | 'connecting' | 'qr' | 'disconnected';

export type ReceiptState = 'delivered' | 'read' | 'failed';

export type GatewayEvent =
  | { type: 'status'; provider_message_id: string; state: ReceiptState }
  | { type: 'connection'; state: ConnectionStateName };

export interface ClientSnapshot {
  state: ConnectionStateName;
  qr: string | null;
}

export interface WaClient {
  /** Open the session (resolves once the connection attempt has started, not when it is open). */
  start(): Promise<void>;
  /** Send a text message; resolves with the WhatsApp message id once WhatsApp accepted it. */
  sendText(phone: string, text: string): Promise<{ id: string }>;
  /** True when the E.164 number (`+62...`) has a WhatsApp account. */
  isOnWhatsApp(phone: string): Promise<boolean>;
  /** Unlink the device, wipe the stored session and start over so a fresh QR is produced. */
  logout(): Promise<void>;
  /** Subscribe to receipts for sent messages and connection changes. */
  onEvent(handler: (event: GatewayEvent) => void): void;
  snapshot(): ClientSnapshot;
  /** Close the socket for a graceful shutdown (optional for fakes). */
  stop?(): Promise<void>;
}

/** The session is not connected; the caller may retry later (HTTP 503). */
export class DisconnectedError extends Error {
  constructor(message = 'WhatsApp session is not connected') {
    super(message);
    this.name = 'DisconnectedError';
  }
}

/** The number has no WhatsApp account (HTTP 404 `not_on_whatsapp`). */
export class NotOnWhatsAppError extends Error {
  constructor(message = 'Number is not on WhatsApp') {
    super(message);
    this.name = 'NotOnWhatsAppError';
  }
}
