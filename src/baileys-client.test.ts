/**
 * The Baileys client wiring, driven through a fake socket, fake timers and a manual clock
 * (no network, no real WhatsApp).
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createBaileysClient, DisconnectReason, STABLE_CONNECTION_MS } from './baileys.js';
import type { GatewayEvent } from './client.js';
import { closeWith, fakeBaileysDeps, type FakeDepsOptions } from './test/fake-socket.js';
import { captureLogger, flush, silentLogger, withTempDir } from './test/fakes.js';

function warnings(lines: string[]): string[] {
  return lines.filter((line) => line.includes('"level":40'));
}

async function startClient(
  dir: string,
  logger = silentLogger(),
  fakeOptions: FakeDepsOptions = {},
) {
  const fake = fakeBaileysDeps(fakeOptions);
  const client = createBaileysClient({
    authDir: join(dir, 'auth'),
    logger,
    baileysLogLevel: 'silent',
    deps: fake.deps,
  });
  const events: GatewayEvent[] = [];
  client.onEvent((event) => events.push(event));
  await client.start();
  await fake.waitForSockets(1);
  return { client, fake, events };
}

describe('Baileys client wiring', () => {
  for (const [code, name] of [
    [DisconnectReason.connectionReplaced, 'replaced'],
    [DisconnectReason.forbidden, 'forbidden'],
    [DisconnectReason.loggedOut, 'logged out'],
  ] as const) {
    it(`test_terminal_close_${name.replace(' ', '_')}_stays_disconnected_and_warns_once`, async () => {
      await withTempDir(async (dir) => {
        const { logger, lines } = captureLogger();
        const { client, fake, events } = await startClient(dir, logger);
        fake.sockets[0]!.emit('connection.update', { connection: 'open' });
        fake.sockets[0]!.emit('connection.update', closeWith(code));
        await flush();

        expect(client.snapshot()).toEqual({ state: 'disconnected', qr: null });
        expect(events.at(-1)).toEqual({ type: 'connection', state: 'disconnected' });
        expect(fake.pendingTimers()).toEqual([]); // no reconnect scheduled
        expect(fake.sockets).toHaveLength(1);
        const warned = warnings(lines);
        expect(warned).toHaveLength(1);
        expect(warned[0]).toContain(`"code":${code}`);
      });
    });
  }

  it('test_flapping_connection_backs_off_and_only_a_stable_one_resets', async () => {
    await withTempDir(async (dir) => {
      const { fake } = await startClient(dir);
      const delays: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const socket = fake.sockets.at(-1)!;
        socket.emit('connection.update', { connection: 'open' });
        fake.clock.now += 5000; // drops after 5 s every time
        socket.emit('connection.update', closeWith(DisconnectReason.connectionClosed));
        delays.push(fake.fireLast().ms);
        await fake.waitForSockets(i + 2);
      }
      expect(delays).toEqual([2000, 4000, 8000]);
      expect(fake.sockets).toHaveLength(4);

      // This one stays open for the stability threshold: the backoff starts over.
      const stable = fake.sockets.at(-1)!;
      stable.emit('connection.update', { connection: 'open' });
      fake.clock.now += STABLE_CONNECTION_MS;
      stable.emit('connection.update', closeWith(DisconnectReason.connectionLost));
      expect(fake.fireLast().ms).toBe(2000);
    });
  });

  it('test_restart_required_restarts_at_once_at_most_three_times_in_a_row', async () => {
    await withTempDir(async (dir) => {
      const { fake } = await startClient(dir);
      const delays: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        fake.sockets.at(-1)!.emit('connection.update', closeWith(DisconnectReason.restartRequired));
        delays.push(fake.fireLast().ms);
        await fake.waitForSockets(i + 2);
      }
      expect(delays).toEqual([0, 0, 0, 2000, 4000]);
    });
  });

  it('test_events_of_a_replaced_socket_are_ignored', async () => {
    await withTempDir(async (dir) => {
      const { client, fake, events } = await startClient(dir);
      const first = fake.sockets[0]!;
      first.emit('connection.update', closeWith(DisconnectReason.connectionClosed));
      fake.fireLast();
      await fake.waitForSockets(2);
      const second = fake.sockets[1]!;
      second.emit('connection.update', { connection: 'open' });
      const before = events.length;

      first.emit('connection.update', closeWith(DisconnectReason.connectionClosed));
      first.emit('messages.update', [{ key: { id: 'OLD', fromMe: true }, update: { status: 3 } }]);
      expect(events).toHaveLength(before);
      expect(client.snapshot().state).toBe('connected');
    });
  });

  it('test_logout_swaps_the_auth_dir_and_old_socket_writes_never_reach_the_new_one', async () => {
    await withTempDir(async (dir) => {
      const auth = join(dir, 'auth');
      let releaseSave: () => void = () => undefined;
      const saveGate = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      let saves = 0;
      const { client, fake } = await startClient(dir, silentLogger(), {
        saveCreds: async (authDir) => {
          saves += 1;
          await saveGate;
          await writeFile(join(authDir, 'creds.json'), `save-${saves}`);
        },
      });
      const old = fake.sockets[0]!;
      old.emit('connection.update', { connection: 'open' });
      old.emit('creds.update', {}); // a credential write of the old session is in flight

      const loggingOut = client.logout();
      await flush();
      // The swap waits for the in-flight write of the old session.
      expect((await readdir(dir)).sort()).toEqual(['auth']);
      releaseSave();
      await loggingOut;
      await fake.waitForSockets(2);

      const entries = (await readdir(dir)).sort();
      expect(entries).toHaveLength(2);
      const oldDir = entries.find((entry) => entry.startsWith('auth.old-'))!;
      expect(await readFile(join(dir, oldDir, 'creds.json'), 'utf8')).toBe('save-1');
      expect(old.logoutCalls).toBe(1);
      expect(old.endCalls).toBe(1);

      // Late writes from the old socket are dropped instead of landing in the new session.
      old.emit('creds.update', {});
      await fake.configs[0]!.auth.keys.set({});
      await flush();
      expect(saves).toBe(1);
      expect(fake.keyWrites).toEqual([]);
      expect(await readdir(auth)).toEqual([]);

      // The new session writes normally.
      fake.sockets[1]!.emit('creds.update', {});
      await fake.configs[1]!.auth.keys.set({});
      releaseSave();
      await flush();
      expect(saves).toBe(2);
      expect(fake.keyWrites).toEqual([auth]);
    });
  });
});
