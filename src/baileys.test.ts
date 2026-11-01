/**
 * Pure mapping helpers of the Baileys client, checked against the real Baileys enums (re-exported
 * by baileys.ts, the only module that imports Baileys). The socket wiring is tested with a fake
 * socket in baileys-client.test.ts; only the real socket factory needs the manual smoke test.
 */
import { describe, expect, it } from 'vitest';

import {
  DisconnectReason,
  INITIAL_RECONNECT_STATE,
  MAX_CONSECUTIVE_RESTARTS,
  pickWaVersion,
  planAfterClose,
  type ReconnectState,
  STABLE_CONNECTION_MS,
  eventFromMessageUpdate,
  isConnectionError,
  nextSnapshot,
  receiptStateFromStatus,
  reconnectDelayMs,
  WAMessageStatus,
} from './baileys.js';
import type { ClientSnapshot } from './client.js';

const POLICY = { baseMs: 2000, capMs: 300_000 };

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

  it('test_reconnect_policy_treats_logged_out_replaced_and_forbidden_as_terminal', () => {
    const cases = [
      [DisconnectReason.loggedOut, 'logged_out'],
      [DisconnectReason.connectionReplaced, 'replaced'],
      [DisconnectReason.forbidden, 'forbidden'],
    ] as const;
    for (const [code, reason] of cases) {
      const { action } = planAfterClose(code, INITIAL_RECONNECT_STATE, 0, POLICY);
      expect(action).toEqual({ kind: 'terminal', reason });
    }
  });

  it('test_reconnect_policy_backs_off_flapping_connections', () => {
    // Every connection opens and drops again after 5 s: the delay must keep growing.
    let state: ReconnectState = INITIAL_RECONNECT_STATE;
    let now = 1_000_000;
    const delays: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      state = { ...state, openedAt: now };
      now += 5000;
      const plan = planAfterClose(DisconnectReason.connectionClosed, state, now, POLICY);
      expect(plan.action.kind).toBe('reconnect');
      if (plan.action.kind === 'reconnect') delays.push(plan.action.delayMs);
      state = plan.next;
      now += 1000;
    }
    expect(delays).toEqual([2000, 4000, 8000, 16000, 32000]);
    // Unknown and missing codes reconnect with backoff too.
    expect(planAfterClose(undefined, state, now, POLICY).action).toEqual({
      kind: 'reconnect',
      delayMs: 64000,
    });
  });

  it('test_reconnect_policy_resets_only_after_a_stable_connection', () => {
    const flapped: ReconnectState = { attempt: 4, restarts: 0, openedAt: 0 };
    const early = planAfterClose(
      DisconnectReason.connectionLost,
      flapped,
      STABLE_CONNECTION_MS - 1,
      POLICY,
    );
    expect(early.action).toEqual({ kind: 'reconnect', delayMs: 32000 });
    const stable = planAfterClose(
      DisconnectReason.connectionLost,
      flapped,
      STABLE_CONNECTION_MS,
      POLICY,
    );
    expect(stable.action).toEqual({ kind: 'reconnect', delayMs: 2000 });
    expect(stable.next).toEqual({ attempt: 1, restarts: 0, openedAt: null });
    // Never opened (openedAt null): no reset however long ago.
    const closedOnly = planAfterClose(
      DisconnectReason.connectionLost,
      { ...flapped, openedAt: null },
      10 * STABLE_CONNECTION_MS,
      POLICY,
    );
    expect(closedOnly.action).toEqual({ kind: 'reconnect', delayMs: 32000 });
  });

  it('test_reconnect_policy_caps_consecutive_restart_required', () => {
    let state: ReconnectState = INITIAL_RECONNECT_STATE;
    const kinds: string[] = [];
    for (let i = 0; i < MAX_CONSECUTIVE_RESTARTS + 2; i += 1) {
      const plan = planAfterClose(DisconnectReason.restartRequired, state, 0, POLICY);
      kinds.push(
        plan.action.kind === 'reconnect' ? `reconnect:${plan.action.delayMs}` : plan.action.kind,
      );
      state = plan.next;
    }
    expect(MAX_CONSECUTIVE_RESTARTS).toBe(3);
    expect(kinds).toEqual([
      'restart_now',
      'restart_now',
      'restart_now',
      'reconnect:2000',
      'reconnect:4000',
    ]);
    // A stable connection clears the restart counter as well.
    const after = planAfterClose(
      DisconnectReason.restartRequired,
      { ...state, openedAt: 0 },
      STABLE_CONNECTION_MS,
      POLICY,
    );
    expect(after.action).toEqual({ kind: 'restart_now' });
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

  it('test_pick_wa_version_accepts_only_three_positive_integers_from_a_successful_fetch', () => {
    expect(pickWaVersion({ version: [2, 3000, 1023], isLatest: true })).toEqual({
      version: [2, 3000, 1023],
      outcome: 'fetched',
    });
    for (const bad of [
      [2, 3000],
      [2, 3000, 1, 4],
      [2, -1, 3],
      [0, 1, 2],
      [2, 1.5, 3],
      ['2', 3, 4],
      null,
      'x',
    ]) {
      expect(pickWaVersion({ version: bad, isLatest: true }), JSON.stringify(bad)).toEqual({
        outcome: 'invalid',
      });
    }
    // A failed fetch (Baileys answers its bundled version with isLatest false) is not "latest".
    expect(pickWaVersion({ version: [2, 3000, 1], isLatest: false })).toEqual({
      outcome: 'failed',
    });
    expect(pickWaVersion(new Error('offline'))).toEqual({ outcome: 'failed' });
  });
});
