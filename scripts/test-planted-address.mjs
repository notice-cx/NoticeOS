// What the end-to-end proofs of the database address share:
// scripts/start.test.mjs starts `pnpm start`, and
// scripts/runner-database.test.mjs the runner's own Tower child, each on a
// throwaway Postgres whose application login has a PLANTED password — one no
// other run uses — so the proofs can then look for it everywhere the OS
// wrote, in every process it started and in what its Tower answers. Tests
// only; nothing at runtime imports this.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { openStore } from '../packages/postgres/src/store.mjs';

/** A copy of `cluster`'s store whose application login answers only to a new,
 * recognizable password. Returns the address a secrets file would hold. */
export async function plantedDatabase(cluster) {
  const password = `planted-${randomBytes(9).toString('hex')}`;
  const database = await cluster.createDatabase();
  await cluster.asOwner(database, `ALTER ROLE noticeos_app PASSWORD '${password}';`);
  const url = new URL(cluster.url(database));
  url.password = password;
  return { url: url.toString(), password };
}

/** Every file under `dirs` holding `secret`, but the files `except` names. */
export function filesHolding(secret, dirs, { except = [], io = { readdirSync, readFileSync } } = {}) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = io.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && !except.includes(file)) {
        try {
          if (io.readFileSync(file).includes(secret)) found.push(file);
        } catch (error) {
          // Wrangler can remove a registry file after the directory listing.
          // Only absence is harmless; unreadable files cannot prove safety.
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
  };
  for (const dir of dirs) walk(dir);
  return found;
}

/** Inspect only the explicitly owned process and children discovered beneath
 * it. Never collect unrelated processes' arguments and filter them afterward. */
export function processTree(pid, { exec = execFileSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('An owned process id is required.');
  const pending = [{ pid, parent: null }];
  const seen = new Set([pid]);
  const result = [];
  const query = (command, args) => exec(command, args, { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const absent = error => error.status === 1 && !String(error.stdout ?? '').trim() && !String(error.stderr ?? '').trim();
  for (let index = 0; index < pending.length; index++) {
    const current = pending[index];
    let listed;
    try { listed = query('ps', ['-p', String(current.pid), '-o', 'pid=,ppid=,args=']); }
    catch (error) {
      // A child may finish between discovery and inspection. Losing the root
      // or being unable to inspect it is never evidence of secret absence.
      if (current.parent !== null && absent(error)) continue;
      throw error;
    }
    const match = /^\s*(\d+)\s+(\d+)\s+([^\n]+)\s*$/u.exec(listed);
    if (!match || Number(match[1]) !== current.pid ||
      (current.parent !== null && Number(match[2]) !== current.parent)) throw new Error('Owned process identity changed during inspection.');
    result.push({ pid: current.pid, ppid: Number(match[2]), args: match[3].trim() });
    let children;
    try { children = query('pgrep', ['-P', String(current.pid)]).trim(); }
    catch (error) { if (absent(error)) continue; throw error; }
    if (!children) throw new Error('Child process inspection returned no result.');
    for (const value of children.split(/\s+/u)) {
      const child = Number(value);
      if (!/^\d+$/u.test(value) || !Number.isSafeInteger(child) || child <= 0 || seen.has(child) || seen.size >= 1024) {
        throw new Error('Child process inspection returned an invalid tree.');
      }
      seen.add(child);
      pending.push({ pid: child, parent: current.pid });
    }
  }
  return result;
}

/** What a Tower answers that a page or a script reads. */
export const TOWER_READS = Object.freeze([
  '/',
  '/api/config',
  '/api/settings',
  '/api/wall',
  '/api/workflows',
  '/api/scheduled-jobs',
  '/api/integrations/providers',
]);

/** The routes whose answer from `tower` holds `secret`. */
export async function answersHolding(secret, tower) {
  const holding = [];
  for (const route of TOWER_READS) {
    const text = await (await fetch(new URL(route, tower), { signal: AbortSignal.timeout(60_000) })).text();
    if (text.includes(secret)) holding.push(route);
  }
  return holding;
}

/**
 * The operator's clock saved through `tower` as its Settings page saves it
 * (PUT /api/config, same origin), to a zone other than the one it shows, then
 * read back from /api/settings once the ingest's one-second cache has let it
 * through. Returns the zone saved and the clock read back.
 */
export async function saveClockThroughTower(tower) {
  const read = async () => (await (await fetch(new URL('/api/settings', tower))).json()).clock;
  const before = await read();
  const zone = Intl.supportedValuesOf('timeZone').find((name) => name !== before.timeZone && name.includes('/'));
  const saved = await fetch(new URL('/api/config', tower), {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin: new URL(tower).origin },
    body: JSON.stringify({
      ops: [{ kind: 'file-json-set', file: 'config/constants.json', pointer: '/os_time_zone', expect: before.timeZone, value: zone }],
    }),
  });
  if (saved.status !== 200) throw new Error(`the save answered ${saved.status}: ${await saved.text()}`);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const clock = await read();
    if (clock.timeZone === zone || Date.now() > deadline) return { zone, clock };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Every job whose firing reached the store, byte order, read from Postgres
 * as the application login. */
export async function storedJobs(url) {
  const store = openStore(url, { maxConnections: 1 });
  try {
    const workspace = await store.onlyWorkspace();
    const rows = await store.inWorkspace(
      workspace,
      (tx) => tx.query('SELECT job FROM noticeos.job_runs GROUP BY job ORDER BY job COLLATE "C"'),
      { readOnly: true },
    );
    return rows.map((row) => row.job);
  } finally {
    await store.close();
  }
}

/** The settings document the save wrote, read from Postgres as the application login. */
export async function storedClock(url) {
  const store = openStore(url, { maxConnections: 1 });
  try {
    const workspace = await store.onlyWorkspace();
    const [row] = await store.inWorkspace(
      workspace,
      (tx) =>
        tx.query(
          "SELECT version, updated_by, body::jsonb->>'os_time_zone' AS time_zone FROM noticeos.config_documents WHERE document_key = 'constants'",
        ),
      { readOnly: true },
    );
    return row ?? null;
  } finally {
    await store.close();
  }
}
