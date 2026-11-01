import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { authDirProblem, removeOldAuthCopies, swapAuthDir } from './authdir.js';
import { captureLogger, silentLogger, withTempDir } from './test/fakes.js';

describe('auth directory', () => {
  it('test_auth_dir_must_not_be_root_cwd_home_or_hold_the_dedupe_file', () => {
    const cwd = resolve('/srv/kampusping-wa-gateway');
    const home = resolve('/home/kampusping');
    const ctx = { cwd, home, dedupeFile: join(cwd, 'data', 'sent-refs.json') };

    expect(authDirProblem('./auth_state', ctx)).toBeNull();
    expect(authDirProblem('/var/lib/kampusping/auth', ctx)).toBeNull();
    expect(authDirProblem('../auth_state', ctx)).toBeNull(); // a sibling of cwd is fine

    expect(authDirProblem(parse(cwd).root, ctx)).toMatch(/root/);
    expect(authDirProblem('.', ctx)).toMatch(/working directory/);
    expect(authDirProblem('./', ctx)).toMatch(/working directory/);
    expect(authDirProblem('..', ctx)).toMatch(/working directory/);
    expect(authDirProblem(home, ctx)).toMatch(/home/);
    expect(authDirProblem(resolve('/home'), ctx)).toMatch(/home/);
    expect(authDirProblem('./data', ctx)).toMatch(/WA_DEDUPE_FILE/);
    expect(authDirProblem('./data/sent-refs.json', ctx)).toMatch(/WA_DEDUPE_FILE/);
    // A similar prefix is not an ancestor.
    expect(authDirProblem('./dat', ctx)).toBeNull();
  });

  it('test_swap_auth_dir_renames_the_old_session_and_keeps_one_old_copy', async () => {
    await withTempDir(async (dir) => {
      const auth = join(dir, 'auth_state');
      await mkdir(auth);
      await writeFile(join(auth, 'creds.json'), 'first');
      // Neighbours that a careless wipe could hit.
      await writeFile(join(dir, '.env'), 'SECRET=1');
      await mkdir(join(dir, 'data'));
      await writeFile(join(dir, 'data', 'sent-refs.json'), '{}');

      let now = 1000;
      await swapAuthDir(auth, { now: () => now, logger: silentLogger() });
      expect(await readdir(auth)).toEqual([]);
      expect(await readFile(join(dir, 'auth_state.old-1000', 'creds.json'), 'utf8')).toBe('first');

      await writeFile(join(auth, 'creds.json'), 'second');
      now = 2000;
      await swapAuthDir(auth, { now: () => now, logger: silentLogger() });
      const entries = (await readdir(dir)).sort();
      expect(entries).toEqual(['.env', 'auth_state', 'auth_state.old-2000', 'data']);
      expect(await readFile(join(dir, 'auth_state.old-2000', 'creds.json'), 'utf8')).toBe('second');
      expect(await readFile(join(dir, '.env'), 'utf8')).toBe('SECRET=1');
      expect(await readdir(join(dir, 'data'))).toEqual(['sent-refs.json']);
    });
  });

  it('test_swap_auth_dir_creates_a_missing_dir', async () => {
    await withTempDir(async (dir) => {
      const auth = join(dir, 'nested', 'auth_state');
      await swapAuthDir(auth, { now: () => 5, logger: silentLogger() });
      expect(await readdir(auth)).toEqual([]);
      expect(await readdir(join(dir, 'nested'))).toEqual(['auth_state']);
    });
  });

  it('test_home_dir_default_is_used', () => {
    expect(authDirProblem(homedir(), { cwd: '/tmp/x', dedupeFile: '/tmp/x/d.json' })).toMatch(
      /home/,
    );
  });

  it('test_remove_old_auth_copies_deletes_only_matching_siblings_and_logs_without_paths', async () => {
    await withTempDir(async (dir) => {
      const auth = join(dir, 'auth_state');
      for (const name of [
        'auth_state',
        'auth_state.old-1',
        'auth_state.old-22',
        'auth_state.old-x',
        'other.old-5',
      ]) {
        await mkdir(join(dir, name));
        await writeFile(join(dir, name, 'creds.json'), name);
      }
      const { logger, lines } = captureLogger();
      expect(await removeOldAuthCopies(auth, logger)).toBe(2);
      expect((await readdir(dir)).sort()).toEqual([
        'auth_state',
        'auth_state.old-x',
        'other.old-5',
      ]);
      expect(await readFile(join(auth, 'creds.json'), 'utf8')).toBe('auth_state');
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain(dir.replace(/\\/g, '\\\\'));
      expect(lines[0]).not.toContain('auth_state');

      // Nothing to remove: nothing logged.
      expect(await removeOldAuthCopies(auth, logger)).toBe(0);
      expect(lines).toHaveLength(1);
    });
  });
});
