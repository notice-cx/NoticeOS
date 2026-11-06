/** The last answers Ntasks gave this installation, kept under `.local/task-cache`
 * so the Tower can show them while Ntasks is unreachable. The Tower's task
 * routes write each answer they read; the runner's change-feed poll
 * (runner/task-service-poll.mjs) rewrites a project's boards when Ntasks
 * reports a change to it. An entry keeps the answer as Ntasks gave it,
 * `readAt` included: a page that shows a cached copy shows when it was read.
 *
 * Authored TypeScript: `pnpm generate` writes the `.mjs` the runner imports
 * and the `.d.mts` the Tower's Vite lanes read.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Every status, the board the Tower asks for when it names none. */
export const ALL_STATUSES = 'open,in_progress,blocked,deferred,closed';

export function taskCacheDir(homeRoot: string): string {
  return path.join(homeRoot, '.local', 'task-cache');
}

/** One project board, as the Tower names it: its site, statuses and closed reach. */
export function boardKey(asset: string, statuses: string = ALL_STATUSES, closedDays?: number): string {
  return `board\u0000${asset}\u0000${statuses}\u0000${closedDays ?? ''}`;
}
export function taskKey(taskId: string): string {
  return `task\u0000${taskId}`;
}

export interface CachedAnswer {
  readonly key: string;
  /** When this machine stored it; the answer's own `readAt` is when Ntasks read it. */
  readonly storedAt: string;
  readonly body: unknown;
}

function fileOf(dir: string, key: string): string {
  return path.join(dir, `${createHash('sha256').update(key).digest('hex')}.json`);
}

async function writeAtomically(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const stage = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(stage, text, { mode: 0o600, flag: 'wx' });
    await fs.rename(stage, file);
  } finally { await fs.rm(stage, { force: true }); }
}

/** Never throws: a cache that cannot be written leaves the page as Ntasks answered it. */
export async function writeCached(dir: string, key: string, body: unknown, now: () => number = Date.now): Promise<void> {
  try {
    await writeAtomically(fileOf(dir, key), JSON.stringify({ key, storedAt: new Date(now()).toISOString(), body } satisfies CachedAnswer));
  } catch { /* See above. */ }
}

/** The stored answer for `key`, or null when none was kept or it cannot be read. */
export async function readCached(dir: string, key: string): Promise<CachedAnswer | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(fileOf(dir, key), 'utf8')) as Partial<CachedAnswer>;
    return parsed?.key === key && typeof parsed.storedAt === 'string' ? { key, storedAt: parsed.storedAt, body: parsed.body } : null;
  } catch { return null; }
}

/** Where the change-feed poll stands: the feed's position for one Ntasks
 * address, and when each project's boards were last read. */
export interface TaskSyncState {
  readonly origin: string;
  readonly cursor: number;
  readonly boards: Readonly<Record<string, string>>;
}
const SYNC_FILE = 'sync.json';

export async function readSyncState(dir: string, origin: string): Promise<TaskSyncState> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, SYNC_FILE), 'utf8')) as Partial<TaskSyncState>;
    // Another address is another feed: its position means nothing here.
    if (parsed?.origin === origin && Number.isSafeInteger(parsed.cursor) && parsed.cursor! >= 0
      && parsed.boards && typeof parsed.boards === 'object' && !Array.isArray(parsed.boards)) {
      return { origin, cursor: parsed.cursor!, boards: Object.fromEntries(Object.entries(parsed.boards).filter(([, at]) => typeof at === 'string')) };
    }
  } catch { /* A missing or unreadable state starts the feed again. */ }
  return { origin, cursor: 0, boards: {} };
}

export async function writeSyncState(dir: string, state: TaskSyncState): Promise<void> {
  await writeAtomically(path.join(dir, SYNC_FILE), JSON.stringify(state));
}
