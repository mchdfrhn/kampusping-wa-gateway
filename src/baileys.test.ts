/**
 * Pure mapping helpers of the Baileys client, checked against the real Baileys enums (re-exported
 * by baileys.ts, the only module that imports Baileys). The socket
 * wiring itself is covered by the manual smoke test (a real phone is needed).
 */
import { describe, expect, it } from 'vitest';

import {
  closeDecision,
  DisconnectReason,
  eventFromMessageUpdate,
  isConnectionError,
  nextSnapshot,
  receiptStateFromStatus,
  reconnectDelayMs,
  WAMessageStatus,
} from './baileys.js';
import type { ClientSnapshot } from './client.js';

const boom = (statusCode: number) => Object.assign(new Error('closed'), { output: { statusCode } });

describe('Baileys mapping helpers', () => {
  it('test_connection_update_maps_to_state', () => {
    const start: ClientSnapshot = { state: 'disconnected', qr: null };
    const connecting = nextSnapshot(start, { connection: 'connecting' });
    expect(connecting).toEqual({ state: 'connecting', qr: null });

    const qr = nextSnapshot(connecting, { qr: '2@abc' });
    expect(qr).toEqual({ state: 'qr', qr: '2@abc' });
    expect(nextSnapshot(qr, { qr: '2@def' })).toEqual({ state: 'qr', qr: '2@def' });
    // Updates without connection or qr (e.g. receivedPendingNotifications) change nothing.
    expect(nextSnapshot(qr, { receivedPendingNotifications: true })).toEqual(qr);

    const open = nextSnapshot(qr, { connection: 'open' });
    expect(open).toEqual({ state: 'connected', qr: null });
    expect(nextSnapshot(open, { connection: 'close', lastDisconnect: undefined })).toEqual({
      state: 'disconnected',
      qr: null,
    });
  });

  it('test_close_reason_decides_reconnect', () => {
    expect(closeDecision(boom(DisconnectReason.loggedOut))).toBe('logged_out');
    expect(closeDecision(boom(DisconnectReason.restartRequired))).toBe('restart_now');
    expect(closeDecision(boom(DisconnectReason.connectionLost))).toBe('reconnect');
    expect(closeDecision(boom(DisconnectReason.connectionClosed))).toBe('reconnect');
    expect(closeDecision(boom(DisconnectReason.badSession))).toBe('reconnect');
    expect(closeDecision(new Error('no status code'))).toBe('reconnect');
    expect(closeDecision(undefined)).toBe('reconnect');
  });

  it('test_reconnect_backoff_is_exponential_and_capped', () => {
    expect([0, 1, 2, 3].map((attempt) => reconnectDelayMs(attempt, 1000, 60_000))).toEqual([
      1000, 2000, 4000, 8000,
    ]);
    expect(reconnectDelayMs(10, 1000, 60_000)).toBe(60_000);
    expect(reconnectDelayMs(1000, 1000, 60_000)).toBe(60_000);
  });

  it('test_ack_status_maps_to_receipt_state', () => {
    expect(receiptStateFromStatus(WAMessageStatus.DELIVERY_ACK)).toBe('delivered');
    expect(receiptStateFromStatus(WAMessageStatus.READ)).toBe('read');
    expect(receiptStateFromStatus(WAMessageStatus.PLAYED)).toBe('read');
    expect(receiptStateFromStatus(WAMessageStatus.ERROR)).toBe('failed');
    expect(receiptStateFromStatus(WAMessageStatus.SERVER_ACK)).toBeNull();
    expect(receiptStateFromStatus(WAMessageStatus.PENDING)).toBeNull();
    expect(receiptStateFromStatus(null)).toBeNull();
    expect(receiptStateFromStatus(undefined)).toBeNull();
  });

  it('test_message_update_maps_to_status_event_only_for_our_messages', () => {
    const jid = '6281234567890@s.whatsapp.net';
    expect(
      eventFromMessageUpdate({
        key: { remoteJid: jid, fromMe: true, id: '3EB0A1' },
        update: { status: WAMessageStatus.DELIVERY_ACK },
      }),
    ).toEqual({ type: 'status', provider_message_id: '3EB0A1', state: 'delivered' });
    expect(
      eventFromMessageUpdate({
        key: { remoteJid: jid, fromMe: true, id: '3EB0A1' },
        update: { status: WAMessageStatus.READ },
      }),
    ).toEqual({ type: 'status', provider_message_id: '3EB0A1', state: 'read' });

    // Incoming messages, missing ids, other updates and non-receipt statuses are ignored.
    expect(
      eventFromMessageUpdate({
        key: { remoteJid: jid, fromMe: false, id: 'IN1' },
        update: { status: WAMessageStatus.READ },
      }),
    ).toBeNull();
    expect(
      eventFromMessageUpdate({
        key: { remoteJid: jid, fromMe: true },
        update: { status: WAMessageStatus.READ },
      }),
    ).toBeNull();
    expect(
      eventFromMessageUpdate({ key: { remoteJid: jid, fromMe: true, id: '3EB0A1' }, update: {} }),
    ).toBeNull();
    expect(
      eventFromMessageUpdate({
        key: { remoteJid: jid, fromMe: true, id: '3EB0A1' },
        update: { status: WAMessageStatus.SERVER_ACK },
      }),
    ).toBeNull();
  });

  it('test_connection_errors_are_recognised', () => {
    expect(isConnectionError(boom(DisconnectReason.connectionClosed))).toBe(true);
    expect(isConnectionError(boom(DisconnectReason.connectionLost))).toBe(true);
    expect(isConnectionError(boom(DisconnectReason.connectionReplaced))).toBe(true);
    expect(isConnectionError(boom(400))).toBe(false);
    expect(isConnectionError(new Error('x'))).toBe(false);
  });
});
