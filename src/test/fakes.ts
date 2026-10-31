/** Test doubles shared by the unit tests (excluded from the build). */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import pino, { type Logger } from 'pino';

import type { ClientSnapshot, ConnectionStateName, GatewayEvent, WaClient } from '../client.js';
import type { Scheduler } from '../scheduler.js';

export class FakeClient implements WaClient {
  state: ConnectionStateName = 'connected';
  qr: string | null = null;
  readonly unregistered = new Set<string>();
  readonly sent: { phone: string; text: string; id: string }[] = [];
  /** Replace the default send behaviour (e.g. to fail or to block until released). */
  sendImpl: ((phone: string, text: string) => Promise<{ id: string }>) | undefined;
  logoutCalls = 0;
  startCalls = 0;
  private readonly handlers: ((event: GatewayEvent) => void)[] = [];
  private counter = 0;

  start(): Promise<void> {
    this.startCalls += 1;
    return Promise.resolve();
  }

  sendText(phone: string, text: string): Promise<{ id: string }> {
    if (this.sendImpl) return this.sendImpl(phone, text);
    this.counter += 1;
    const id = `wamid-${this.counter}`;
    this.sent.push({ phone, text, id });
    return Promise.resolve({ id });
  }

  isOnWhatsApp(phone: string): Promise<boolean> {
    return Promise.resolve(!this.unregistered.has(phone));
  }

  logout(): Promise<void> {
    this.logoutCalls += 1;
    this.state = 'qr';
    this.qr = 'fresh-qr';
    return Promise.resolve();
  }

  onEvent(handler: (event: GatewayEvent) => void): void {
    this.handlers.push(handler);
  }

  emit(event: GatewayEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  snapshot(): ClientSnapshot {
    return { state: this.state, qr: this.qr };
  }
}

/** Let pending promise chains (including fake fetch responses) run to completion. */
export async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

interface Timer {
  at: number;
  seq: number;
  resolve: () => void;
}

/** Manual clock: `sleep` only resolves when the test advances time past its due moment. */
export class FakeScheduler implements Scheduler {
  readonly sleeps: number[] = [];
  private current: number;
  private seq = 0;
  private timers: Timer[] = [];

  constructor(start = 1_000_000) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    return new Promise<void>((resolve) => {
      this.seq += 1;
      this.timers.push({ at: this.current + ms, seq: this.seq, resolve });
    });
  }

  get pendingTimers(): number {
    return this.timers.length;
  }

  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      await flush();
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.current = Math.max(this.current, due.at);
      due.resolve();
    }
    this.current = target;
    await flush();
  }

  /** Advance until no timer is left (bounded, so a bug cannot hang the test run). */
  async runAll(maxSteps = 1000): Promise<void> {
    for (let step = 0; step < maxSteps; step += 1) {
      await flush();
      const next = [...this.timers].sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!next) return;
      await this.advance(next.at - this.current);
    }
    throw new Error('FakeScheduler.runAll: too many steps');
  }
}

/** A pino logger whose output lines are collected in `lines` (JSON strings). */
export function captureLogger(level = 'trace'): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { logger: pino({ level }, stream), lines };
}

export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'kp-gateway-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
