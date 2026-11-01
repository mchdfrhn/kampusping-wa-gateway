/**
 * Safety around WA_AUTH_DIR, the folder holding the Baileys session.
 *
 * `POST /logout` replaces that folder, so a mistyped path (".", the repo root, $HOME, "/") must
 * never be accepted: `authDirProblem` is checked at startup. The swap itself never deletes the
 * session in place: the folder is renamed to `<dir>.old-<epoch ms>` and recreated empty (0700).
 * Only the newest old copy is kept (useful if a disconnect was clicked by mistake while the
 * device was not unlinked yet); older `<dir>.old-*` siblings are deleted.
 */
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
import type { Logger } from 'pino';

export interface AuthDirContext {
  cwd?: string;
  home?: string;
  dedupeFile: string;
}

function normalise(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** True when `ancestor` is `path` itself or one of its parent directories. */
function isSameOrAncestor(ancestor: string, path: string): boolean {
  const a = normalise(ancestor);
  const p = normalise(path);
  if (a === p) return true;
  return p.startsWith(a.endsWith(sep) ? a : a + sep);
}

/** Why `authDir` is unsafe to wipe, or null when it is fine. */
export function authDirProblem(authDir: string, context: AuthDirContext): string | null {
  const cwd = context.cwd ?? process.cwd();
  const home = context.home ?? homedir();
  const resolved = resolve(cwd, authDir);
  const dedupeFile = resolve(cwd, context.dedupeFile);

  if (parse(resolved).root === resolved || basename(resolved) === '') {
    return 'WA_AUTH_DIR must not be a filesystem root.';
  }
  if (isSameOrAncestor(resolved, cwd)) {
    return 'WA_AUTH_DIR must not be the working directory or one of its parents.';
  }
  if (isSameOrAncestor(resolved, home)) {
    return 'WA_AUTH_DIR must not be the home directory or one of its parents.';
  }
  if (isSameOrAncestor(resolved, dedupeFile)) {
    return 'WA_AUTH_DIR must not contain WA_DEDUPE_FILE (or be that file).';
  }
  return null;
}

export interface SwapOptions {
  now?: () => number;
  logger: Logger;
}

/** Move the current session aside and leave an empty `authDir` (mode 0700) behind. */
export async function swapAuthDir(authDir: string, options: SwapOptions): Promise<void> {
  const now = options.now ?? (() => Date.now());
  const target = resolve(authDir);
  const parent = dirname(target);
  const name = basename(target);
  await mkdir(parent, { recursive: true });

  let exists = false;
  try {
    exists = (await stat(target)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  let kept: string | null = null;
  if (exists) {
    kept = `${name}.old-${now()}`;
    await rename(target, join(parent, kept));
  }
  await mkdir(target, { recursive: true, mode: 0o700 });

  const prefix = `${name}.old-`;
  for (const entry of await readdir(parent)) {
    if (entry.startsWith(prefix) && entry !== kept && /^\d+$/.test(entry.slice(prefix.length))) {
      await rm(join(parent, entry), { recursive: true, force: true }).catch((error: unknown) =>
        options.logger.warn(
          { code: (error as NodeJS.ErrnoException).code },
          'could not delete an older session copy',
        ),
      );
    }
  }
}
