import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openDedupeStore, syncDirectoryBestEffort } from './dedupe.js';
import { captureLogger, silentLogger, withTempDir } from './test/fakes.js';

const DAY = 24 * 60 * 60 * 1000;

describe('dedupe store', () => {
  it('test_dedupe_survives_restart', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'nested', 'sent-refs.json');
      const first = await openDedupeStore({ file, ttlDays: 14, logger: silentLogger() });
      await first.record('msg-1', 'wamid-A');
      await first.record('msg-2', 'wamid-B');

      const second = await openDedupeStore({ file, ttlDays: 14, logger: silentLogger() });
      expect(second.get('msg-1')?.provider_message_id).toBe('wamid-A');
      expect(second.get('msg-2')?.provider_message_id).toBe('wamid-B');
      expect(second.get('msg-3')).toBeUndefined();
      expect(second.hasMessageId('wamid-B')).toBe(true);

      // Atomic write: no temp file is left behind.
      expect(await readdir(join(dir, 'nested'))).toEqual(['sent-refs.json']);
    });
  });

  it('test_dedupe_prunes_after_ttl', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'sent-refs.json');
      let now = Date.UTC(2026, 10, 1);
      const clock = (): number => now;
      const store = await openDedupeStore({
        file,
        ttlDays: 14,
        now: clock,
        logger: silentLogger(),
      });
      await store.record('old', 'wamid-old');
      now += 10 * DAY;
      await store.record('young', 'wamid-young');

      now += 5 * DAY; // "old" is 15 days old, "young" 5 days
      expect(store.get('old')).toBeUndefined(); // expired entries are never returned
      expect(store.get('young')?.provider_message_id).toBe('wamid-young');
      expect(await store.prune()).toBe(1);
      expect(store.hasMessageId('wamid-old')).toBe(false);

      const persisted = JSON.parse(await readFile(file, 'utf8')) as {
        entries: Record<string, unknown>;
      };
      expect(Object.keys(persisted.entries)).toEqual(['young']);

      // Pruned on load as well.
      now += 10 * DAY;
      const reloaded = await openDedupeStore({
        file,
        ttlDays: 14,
        now: clock,
        logger: silentLogger(),
      });
      expect(reloaded.size()).toBe(0);
    });
  });

  it('test_dedupe_file_corruption_starts_empty', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'sent-refs.json');
      await writeFile(file, '{"version":1,"entries":{"msg-1":', 'utf8');
      const { logger, lines } = captureLogger();

      const store = await openDedupeStore({ file, ttlDays: 14, logger });
      expect(store.size()).toBe(0);
      expect(lines.some((line) => line.includes('"level":40'))).toBe(true);

      // Still usable afterwards, and the unreadable file is kept aside for inspection.
      await store.record('msg-9', 'wamid-9');
      const reloaded = await openDedupeStore({ file, ttlDays: 14, logger: silentLogger() });
      expect(reloaded.get('msg-9')?.provider_message_id).toBe('wamid-9');
      expect((await readdir(dir)).sort()).toEqual(['sent-refs.json', 'sent-refs.json.corrupt']);
    });
  });

  it('test_dedupe_ignores_malformed_entries_and_missing_file', async () => {
    await withTempDir(async (dir) => {
      const missing = await openDedupeStore({
        file: join(dir, 'absent.json'),
        ttlDays: 14,
        logger: silentLogger(),
      });
      expect(missing.size()).toBe(0);

      const file = join(dir, 'odd.json');
      const sentAt = new Date().toISOString();
      await writeFile(
        file,
        JSON.stringify({
          version: 1,
          entries: {
            good: { provider_message_id: 'wamid-1', sent_at: sentAt },
            noId: { sent_at: sentAt },
            badDate: { provider_message_id: 'wamid-2', sent_at: 'yesterday' },
          },
        }),
        'utf8',
      );
      const store = await openDedupeStore({ file, ttlDays: 14, logger: silentLogger() });
      expect(store.size()).toBe(1);
      expect(store.get('good')?.provider_message_id).toBe('wamid-1');
    });
  });

  it('test_dedupe_read_error_other_than_missing_fails_startup', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'sent-refs.json');
      await mkdir(file); // reading a directory fails with EISDIR
      await expect(openDedupeStore({ file, ttlDays: 14, logger: silentLogger() })).rejects.toThrow(
        /cannot be read \(EISDIR\)/,
      );
      // Nothing was overwritten.
      expect((await stat(file)).isDirectory()).toBe(true);
    });
  });

  it('test_dedupe_cleans_up_stale_temp_files', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'sent-refs.json');
      await writeFile(`${file}.4242.tmp`, 'half written', 'utf8');
      await writeFile(join(dir, 'other.tmp'), 'not ours', 'utf8');
      const store = await openDedupeStore({ file, ttlDays: 14, logger: silentLogger() });
      expect(store.size()).toBe(0);
      expect((await readdir(dir)).sort()).toEqual(['other.tmp']);
    });
  });

  it('test_dedupe_syncs_the_parent_directory_after_each_rename', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'sent-refs.json');
      const synced: string[] = [];
      const store = await openDedupeStore({
        file,
        ttlDays: 14,
        logger: silentLogger(),
        syncDirectory: (path) => {
          synced.push(path);
          return Promise.resolve();
        },
      });
      await store.record('msg-1', 'wamid-1');
      await store.record('msg-2', 'wamid-2');
      expect(synced).toEqual([dir, dir]);
      // The real directory fsync is best effort (unsupported on some platforms) and never throws.
      await expect(syncDirectoryBestEffort(dir)).resolves.toBeUndefined();
    });
  });
});
