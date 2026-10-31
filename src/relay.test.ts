import { describe, expect, it } from 'vitest';

import type { GatewayEvent } from './client.js';
import { createEventRelay } from './relay.js';
import { FakeScheduler } from './test/fakes.js';

const status = (id: string, state: 'delivered' | 'read' | 'failed'): GatewayEvent => ({
  type: 'status',
  provider_message_id: id,
  state,
});

function setup(options: { pendingTimeoutMs?: number } = {}) {
  const scheduler = new FakeScheduler();
  const out: GatewayEvent[] = [];
  const relay = createEventRelay({
    deliver: (event) => out.push(event),
    scheduler,
    statusDelayMs: 2000,
    ...options,
  });
  return { scheduler, out, relay };
}

describe('receipt relay', () => {
  it('test_status_events_are_delayed_after_the_send_response', async () => {
    const { scheduler, out, relay } = setup();
    relay.sendResolved('A');
    // The receipt arrives before the HTTP answer has even been written.
    relay.handle(status('A', 'delivered'));
    await scheduler.advance(10_000);
    expect(out).toEqual([]); // held while the send response is outstanding

    relay.sendResponded('A');
    await scheduler.advance(1999);
    expect(out).toEqual([]);
    await scheduler.advance(1);
    expect(out).toEqual([status('A', 'delivered')]);
  });

  it('test_status_observed_after_the_response_waits_the_delay_from_observation', async () => {
    const { scheduler, out, relay } = setup();
    relay.sendResolved('A');
    relay.sendResponded('A');
    await scheduler.advance(500);
    relay.handle(status('A', 'delivered')); // observed 500 ms after the response
    await scheduler.advance(1999);
    expect(out).toEqual([]); // due at observed + delay (later than response + delay)
    await scheduler.advance(1);
    expect(out).toEqual([status('A', 'delivered')]);
  });

  it('test_status_for_an_unknown_id_is_delayed_from_when_it_was_observed', async () => {
    const { scheduler, out, relay } = setup();
    relay.handle(status('OLD', 'read'));
    await scheduler.advance(1999);
    expect(out).toEqual([]);
    await scheduler.advance(1);
    expect(out).toEqual([status('OLD', 'read')]);
  });

  it('test_relay_keeps_delivered_before_read', async () => {
    const { scheduler, out, relay } = setup();
    relay.sendResolved('A');
    relay.handle(status('A', 'delivered'));
    relay.handle(status('A', 'read'));
    relay.handle(status('B', 'delivered'));
    relay.sendResponded('A');
    await scheduler.runAll();
    expect(out.filter((e) => e.type === 'status' && e.provider_message_id === 'A')).toEqual([
      status('A', 'delivered'),
      status('A', 'read'),
    ]);
    expect(out).toContainEqual(status('B', 'delivered'));
  });

  it('test_connection_events_are_not_delayed', () => {
    const { out, relay } = setup();
    relay.handle({ type: 'connection', state: 'qr' });
    expect(out).toEqual([{ type: 'connection', state: 'qr' }]);
  });

  it('test_a_send_that_never_answers_releases_its_receipts_after_the_pending_timeout', async () => {
    const { scheduler, out, relay } = setup({ pendingTimeoutMs: 30_000 });
    relay.sendResolved('A');
    relay.handle(status('A', 'delivered'));
    await scheduler.advance(30_000 + 1999);
    expect(out).toEqual([]);
    await scheduler.advance(1);
    expect(out).toEqual([status('A', 'delivered')]);
  });

  it('test_duplicate_answer_replays_the_latest_receipt', async () => {
    const { scheduler, out, relay } = setup();
    relay.sendResolved('A');
    relay.sendResponded('A');
    relay.handle(status('A', 'delivered'));
    relay.handle(status('A', 'read'));
    await scheduler.runAll();
    expect(out).toHaveLength(2);

    // The worker lost the first answer and asked again: the backend may have dropped the
    // receipts as unknown, so the latest state is sent once more after the delay.
    relay.sendResponded('A');
    await scheduler.advance(1999);
    expect(out).toHaveLength(2);
    await scheduler.advance(1);
    expect(out).toEqual([status('A', 'delivered'), status('A', 'read'), status('A', 'read')]);

    // Nothing to replay for an id without receipts.
    relay.sendResponded('NONE');
    await scheduler.runAll();
    expect(out).toHaveLength(3);
  });
});
