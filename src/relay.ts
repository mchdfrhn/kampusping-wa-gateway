/**
 * Holds delivery receipts until the backend can know the message id.
 *
 * The backend learns a provider_message_id only when its worker commits the send outcome, and
 * it answers 202 for receipts of unknown ids and drops them (it cannot ask for a retry). So a
 * `status` event is passed on no earlier than `statusDelayMs` after the HTTP answer of the send
 * that produced the id:
 *
 * - `sendResolved(id)`: WhatsApp accepted the message; receipts for `id` are held until...
 * - `sendResponded(id)`: ...the answer was written; receipts are due `statusDelayMs` later
 *   (or `statusDelayMs` after they were observed, whichever is later).
 * - A receipt for an id this process never sent (e.g. after a restart) is due `statusDelayMs`
 *   after it was observed. A send whose answer never completes releases its receipts after
 *   `pendingTimeoutMs`.
 * - A repeated answer for an id (duplicate client_ref: the worker probably lost the first one)
 *   replays the latest receipt state after the delay, because the backend may have dropped it.
 *
 * Receipts of one message stay in order. Connection events are passed on immediately.
 */
import type { SendObserver } from './app.js';
import type { GatewayEvent, ReceiptState } from './client.js';
import type { Scheduler } from './scheduler.js';

export interface EventRelayOptions {
  deliver: (event: GatewayEvent) => void;
  scheduler: Scheduler;
  statusDelayMs: number;
  /** Longest hold for a send whose answer never completes (default 60 s). */
  pendingTimeoutMs?: number;
  /** Ids remembered for answer times and replays (default 10000, oldest forgotten first). */
  maxTracked?: number;
}

export interface EventRelay extends SendObserver {
  handle(event: GatewayEvent): void;
  /** Resolves once no receipt is held any more (tests, shutdown). */
  idle(): Promise<void>;
}

interface Held {
  state: ReceiptState;
  observedAt: number;
}

interface Pending {
  released: Promise<void>;
  release: () => void;
}

class BoundedMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
  }
}

export function createEventRelay(options: EventRelayOptions): EventRelay {
  const { deliver, scheduler, statusDelayMs } = options;
  const pendingTimeoutMs = options.pendingTimeoutMs ?? 60_000;
  const maxTracked = options.maxTracked ?? 10_000;

  const pending = new Map<string, Pending>();
  const respondedAt = new BoundedMap<string, number>(maxTracked);
  const lastState = new BoundedMap<string, ReceiptState>(maxTracked);
  const lanes = new Map<string, Held[]>();
  let idleWaiters: (() => void)[] = [];

  const waitWhilePending = async (id: string): Promise<void> => {
    const hold = pending.get(id);
    if (!hold) return;
    let timedOut = false;
    await Promise.race([
      hold.released,
      scheduler.sleep(pendingTimeoutMs).then(() => {
        timedOut = true;
      }),
    ]);
    if (timedOut && pending.get(id) === hold) {
      pending.delete(id);
      respondedAt.set(id, scheduler.now());
    }
  };

  const runLane = async (id: string, lane: Held[]): Promise<void> => {
    while (lane.length > 0) {
      await waitWhilePending(id);
      const head = lane[0]!;
      const due = Math.max(head.observedAt, respondedAt.get(id) ?? -Infinity) + statusDelayMs;
      const wait = due - scheduler.now();
      if (wait > 0) {
        await scheduler.sleep(wait);
        continue; // re-check: a new send for the same id may have started meanwhile
      }
      lane.shift();
      deliver({ type: 'status', provider_message_id: id, state: head.state });
    }
    lanes.delete(id);
    if (lanes.size === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  };

  const hold = (id: string, state: ReceiptState): void => {
    const entry: Held = { state, observedAt: scheduler.now() };
    const lane = lanes.get(id);
    if (lane) {
      lane.push(entry);
      return;
    }
    const fresh = [entry];
    lanes.set(id, fresh);
    void runLane(id, fresh);
  };

  return {
    handle(event) {
      if (event.type !== 'status') {
        deliver(event);
        return;
      }
      lastState.set(event.provider_message_id, event.state);
      hold(event.provider_message_id, event.state);
    },
    sendResolved(id) {
      if (pending.has(id)) return;
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      pending.set(id, { released, release });
      if (pending.size > maxTracked) {
        // An answer that never completed; release the oldest hold rather than grow forever.
        const oldest = pending.entries().next();
        if (!oldest.done) {
          pending.delete(oldest.value[0]);
          oldest.value[1].release();
        }
      }
    },
    sendResponded(id) {
      respondedAt.set(id, scheduler.now());
      const waiting = pending.get(id);
      if (waiting) {
        pending.delete(id);
        waiting.release();
        return;
      }
      const state = lastState.get(id);
      if (state !== undefined && !lanes.has(id)) hold(id, state);
    },
    idle() {
      if (lanes.size === 0) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
  };
}
