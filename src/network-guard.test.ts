/**
 * The unit-test network guard (src/test/setup.ts): no test may reach WhatsApp or GitHub, even one
 * that forgets to inject fakes. Loopback HTTP (the gateway's own server test) stays allowed.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createBaileysClient, realDeps } from './baileys.js';
import { silentLogger, withTempDir } from './test/fakes.js';

describe('network guard in unit tests', () => {
  it('test_non_loopback_fetch_is_blocked', async () => {
    await expect(fetch('https://raw.githubusercontent.com/x')).rejects.toThrow(
      /network is blocked in unit tests/,
    );
    await expect(fetch(new URL('http://web.whatsapp.com/'))).rejects.toThrow(
      /network is blocked in unit tests/,
    );
  });

  it('test_real_baileys_deps_are_unreachable_by_default', async () => {
    expect(() =>
      realDeps.makeSocket({
        auth: {} as never,
        logger: silentLogger(),
        getMessage: () => Promise.resolve(undefined),
      }),
    ).toThrow(/network is blocked in unit tests/);
    await expect(realDeps.fetchVersion()).rejects.toThrow(/network is blocked in unit tests/);

    // A client built without fake deps fails loudly instead of opening a WhatsApp socket.
    await withTempDir(async (dir) => {
      const client = createBaileysClient({
        authDir: join(dir, 'auth'),
        logger: silentLogger(),
        baileysLogLevel: 'silent',
      });
      await expect(client.start()).rejects.toThrow(/network is blocked in unit tests/);
    });
  });
});
