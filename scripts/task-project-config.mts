// Stored project membership joined to this host's inventory: the task
// projects the runner and the Tower map to Ntasks projects by their prefix.
//
// Authored TypeScript: `pnpm generate` writes the
// `.mjs` the local runner and backups import and the `.d.mts` the Tower's Vite
// task lane reads.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfigSnapshot } from './config-store-client.mjs';
import { TASK_HOST_FILE as HOST_FILE, readablePath } from './installation.mjs';

type Environment = Readonly<Record<string, string | undefined>>;

/** Stored and host JSON as this adapter probes it: any shape, every key guarded. */
type Probe = { readonly [key: string]: unknown } | null | undefined;
type Row = { readonly [key: string]: unknown };

export interface TaskProject {
  asset: string;
  prefix: string;
  database: string | null;
  repo: string;
  unavailableReason?: string;
}
export interface TaskProjectReadOptions {
  repoRoot?: string;
  door?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  readHost?: () => Promise<string>;
  env?: Environment;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The host's task repository links for the checkout at `repoRoot`: this
 * installation's `task-host.json`, else the product's empty default. The home
 * checkout for the live runner and its lanes. */
export function taskHostFile(repoRoot: string = REPO_ROOT, env: Environment = process.env): string {
  return readablePath(HOST_FILE, { root: repoRoot, env });
}

/** Canonical physical database identifier for backup, poll and drift readers. */
export function beadsDatabaseName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return /^[A-Za-z0-9_]+$/.test(name) ? name : null;
}

/** A saved project must match this host's asset, prefix and database binding.
 * Saved repo/hub values never select filesystem paths or service endpoints. */
export function resolveTaskProjects(stored: unknown, host: unknown): TaskProject[] {
  if (!stored || !Array.isArray((stored as Row).spokes)) throw new Error('Saved task projects are invalid.');
  if (!host || !Array.isArray((host as Row).repositories)) throw new Error('Local task repository links are unavailable.');
  const links = new Map<string, Row>();
  for (const row of (host as Row).repositories as Probe[]) {
    if (typeof row?.asset !== 'string' || typeof row?.prefix !== 'string'
      || typeof row?.database !== 'string' || !/^[a-z][a-z0-9_]*$/.test(row.database)
      || (row.repo !== undefined && typeof row.repo !== 'string') || links.has(row.asset)) {
      throw new Error('Local task repository links are invalid or ambiguous.');
    }
    links.set(row.asset, row);
  }
  const assets = new Set<string>();
  const prefixes = new Set<string>();
  return ((stored as Row).spokes as Probe[]).map((row): TaskProject => {
    if (typeof row?.asset !== 'string' || !row.asset.trim()
      || typeof row?.prefix !== 'string' || !/^[a-z]{2,8}$/.test(row.prefix)
      || assets.has(row.asset) || prefixes.has(row.prefix)) {
      throw new Error('Saved task projects are invalid or ambiguous.');
    }
    assets.add(row.asset);
    prefixes.add(row.prefix);
    const linked = links.get(row.asset);
    const available = linked?.prefix === row.prefix && linked.database === row.database;
    return {
      asset: row.asset, prefix: row.prefix,
      database: typeof row.database === 'string' ? row.database : null,
      repo: available && typeof linked!.repo === 'string' ? linked!.repo : '',
      ...(!available ? { unavailableReason: `${row.asset} has no matching task connection on this host` } : {}),
    };
  });
}

/**
 * The host's repository links. `absentLinksNone`: no inventory file at all
 * links nothing — a folder `pnpm db:try-tower` made is not a checkout and has neither
 * its own copy nor the product's default, so its task
 * screens report a missing task connection instead of failing on a missing
 * file. Without it a missing file throws: the managed host's backup must not
 * read a lost inventory as an empty one.
 */
export async function readTaskHost({ repoRoot = REPO_ROOT, readHost, env = process.env, absentLinksNone = false }: Pick<TaskProjectReadOptions, 'repoRoot' | 'readHost' | 'env'> & { absentLinksNone?: boolean } = {}): Promise<{ repositories: unknown[] }> {
  let raw: string;
  try {
    raw = await (readHost ?? (() => fs.readFile(taskHostFile(repoRoot, env), 'utf8')))();
  } catch (error) {
    if (absentLinksNone && (error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { repositories: [] };
    throw error;
  }
  const host = JSON.parse(raw);
  // Backups need physical database names even when a checkout link is broken.
  // Executable links are validated separately by resolveTaskProjects.
  if (!host || !Array.isArray(host.repositories)) throw new Error('Local task inventory is invalid.');
  return host;
}

export async function readTaskProjects({ repoRoot = REPO_ROOT, readHost, env = process.env, ...storeOptions }: TaskProjectReadOptions = {}): Promise<TaskProject[]> {
  const snapshot = await readConfigSnapshot(storeOptions);
  const saved = snapshot.get('config/beads.json');
  if (!saved) throw new Error('Task projects are not stored yet. Run pnpm config:seed before using task projects.');
  return resolveTaskProjects(saved.body, await readTaskHost({ repoRoot, readHost, env, absentLinksNone: true }));
}

/** The runner's existing parsers consume one JSON map; host topology is absent. */
export async function readTaskProjectConfig(options?: TaskProjectReadOptions): Promise<string> {
  return JSON.stringify({ spokes: await readTaskProjects(options) });
}
