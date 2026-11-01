/** Fake Baileys socket and dependencies for testing the client wiring in baileys.ts. */
import type {
  AuthHandle,
  BaileysDeps,
  BaileysEventMap,
  SocketEventName,
  SocketLike,
} from '../baileys.js';

type Listener = (arg: unknown) => void;

export class FakeSocket implements SocketLike {
  readonly listeners = new Map<string, Listener[]>();
  readonly sent: { jid: string; text: string }[] = [];
  logoutCalls = 0;
  endCalls = 0;
  registered = true;
  private counter = 0;

  readonly ev: SocketLike['ev'] = {
    on: (event, listener) => {
      const list = this.listeners.get(event) ?? [];
      list.push(listener as Listener);
      this.listeners.set(event, list);
    },
  };

  emit<K extends SocketEventName>(event: K, arg: BaileysEventMap[K]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(arg);
  }

  onWhatsApp(...jids: string[]): Promise<{ jid: string; exists: unknown }[] | undefined> {
    return Promise.resolve(this.registered ? jids.map((jid) => ({ jid, exists: true })) : []);
  }

  sendMessage(jid: string, content: { text: string }) {
    this.counter += 1;
    this.sent.push({ jid, text: content.text });
    return Promise.resolve({
      key: { id: `FAKE${this.counter}`, fromMe: true, remoteJid: jid },
      message: { conversation: content.text },
    } as Awaited<ReturnType<SocketLike['sendMessage']>>);
  }

  logout(): Promise<void> {
    this.logoutCalls += 1;
    return Promise.resolve();
  }

  end(): void {
    this.endCalls += 1;
  }
}

export interface FakeTimer {
  fn: () => void;
  ms: number;
  cancelled: boolean;
}

export interface FakeDepsOptions {
  /** Replaces the default no-op credential save (receives the auth dir of that session). */
  saveCreds?: (authDir: string) => Promise<void>;
  fetchVersion?: BaileysDeps['fetchVersion'];
}

export function fakeBaileysDeps(options: FakeDepsOptions = {}) {
  const sockets: FakeSocket[] = [];
  const timers: FakeTimer[] = [];
  const clock = { now: 1_000_000 };
  const versionsUsed: (number[] | undefined)[] = [];
  let versionFetches = 0;

  const deps: BaileysDeps = {
    loadAuthState(dir: string): Promise<AuthHandle> {
      const handle = {
        state: {
          creds: {},
          keys: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
        },
        saveCreds: () => (options.saveCreds ? options.saveCreds(dir) : Promise.resolve()),
      } as unknown as AuthHandle;
      return Promise.resolve(handle);
    },
    makeSocket(config) {
      versionsUsed.push(config.version);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    fetchVersion() {
      versionFetches += 1;
      return options.fetchVersion
        ? options.fetchVersion()
        : Promise.resolve({ version: [2, 3000, 1], isLatest: true });
    },
    now: () => clock.now,
    setTimer(fn, ms) {
      const timer: FakeTimer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };

  return {
    deps,
    sockets,
    timers,
    clock,
    versionsUsed,
    versionFetches: () => versionFetches,
    /** Timers that are still waiting (not fired, not cancelled). */
    pendingTimers: () => timers.filter((timer) => !timer.cancelled),
    /** Wait (real time, bounded) until `count` sockets were created: connect() does real fs work. */
    async waitForSockets(count: number): Promise<void> {
      for (let i = 0; i < 500 && sockets.length < count; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      if (sockets.length < count)
        throw new Error(`expected ${count} sockets, got ${sockets.length}`);
    },
    /** Fire the most recent pending timer. */
    fireLast(): FakeTimer {
      const timer = [...timers].reverse().find((candidate) => !candidate.cancelled);
      if (!timer) throw new Error('no pending timer');
      timer.cancelled = true;
      timer.fn();
      return timer;
    },
  };
}

export const closeWith = (statusCode: number) => ({
  connection: 'close' as const,
  lastDisconnect: {
    error: Object.assign(new Error('closed'), { output: { statusCode } }),
    date: new Date(0),
  },
});
