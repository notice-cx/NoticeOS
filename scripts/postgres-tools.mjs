// PostgreSQL binary discovery only: no database connections or cluster lifecycle.
// Commands inspect tool locations and versions; callers own any use of the tools.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const MINIMUM_MAJOR = 15;

function onPath(name) {
  const result = spawnSync('/usr/bin/env', ['which', name], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** The file Linux lists its System V shared-memory segments in. */
const PROC_SEGMENTS = '/proc/sysvipc/shm';

/** A Postgres tool by name: from `pg_config --bindir` where that has it, else PATH; null when neither does. */
function toolPicker() {
  let dir = null;
  const pgConfig = onPath('pg_config');
  if (pgConfig) {
    try {
      dir = execFileSync(pgConfig, ['--bindir'], { encoding: 'utf8' }).trim();
    } catch {
      dir = null;
    }
  }
  return (name) => {
    const inDir = dir ? path.join(dir, name) : null;
    return inDir && existsSync(inDir) ? inDir : onPath(name);
  };
}

/** `{ version, major }` of a psql binary. */
function psqlVersion(psql) {
  const version = execFileSync(psql, ['--version'], { encoding: 'utf8' }).trim();
  return { version, major: Number(/(\d+)(?:\.\d+)?/u.exec(version)?.[1]) };
}

/**
 * `{ psql, version, major }`, or null when this machine has no psql: all a
 * command needs that only connects to a server running elsewhere, in a
 * container or at a provider (bead ro-ujb9.76.39). `checkedSession`, the
 * operator's way into an installation's own database, asks for no more.
 */
export function findPsql() {
  const psql = toolPicker()('psql');
  return psql ? { psql, ...psqlVersion(psql) } : null;
}

/**
 * `{ initdb, pgCtl, psql, version, major, segmentsFile, ipcs, ipcrm }`, or
 * null when this machine has no server. The last three list and remove
 * shared-memory segments: Linux's /proc file, else `ipcs`; null when absent.
 */
export function findPostgres() {
  const pick = toolPicker();
  const tools = { initdb: pick('initdb'), pgCtl: pick('pg_ctl'), psql: pick('psql') };
  if (!tools.initdb || !tools.pgCtl || !tools.psql) return null;
  return {
    ...tools,
    ...psqlVersion(tools.psql),
    segmentsFile: existsSync(PROC_SEGMENTS) ? PROC_SEGMENTS : null,
    ipcs: onPath('ipcs'),
    ipcrm: onPath('ipcrm'),
  };
}

