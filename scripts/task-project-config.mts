// Stored project membership: the task projects the runner and the Tower
// map to Ntasks projects by their prefix.
//
// Authored TypeScript: `pnpm generate` writes the
// `.mjs` the local runner imports and the `.d.mts` the Tower's Vite
// task lane reads.

import { readConfigSnapshot } from './config-store-client.mjs';

type Environment = Readonly<Record<string, string | undefined>>;

/** Stored JSON as this adapter probes it: any shape, every key guarded. */
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
  env?: Environment;
}

/** Validate legacy database metadata retained in project projections. */
export function taskDatabaseName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return /^[A-Za-z0-9_]+$/.test(name) ? name : null;
}

/** Saved repo/hub values never select filesystem paths or service endpoints.
 * Ntasks resolves each project by its prefix. */
export function resolveTaskProjects(stored: unknown): TaskProject[] {
  if (!stored || !Array.isArray((stored as Row).spokes)) throw new Error('Saved task projects are invalid.');
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
    return {
      asset: row.asset, prefix: row.prefix,
      database: taskDatabaseName(row.database),
      repo: '',
    };
  });
}

export async function readTaskProjects({ repoRoot: _repoRoot, env: _env, ...storeOptions }: TaskProjectReadOptions = {}): Promise<TaskProject[]> {
  const snapshot = await readConfigSnapshot(storeOptions);
  const saved = snapshot.get('config/beads.json');
  if (!saved) throw new Error('Task projects are not stored yet. Run pnpm config:seed before using task projects.');
  return resolveTaskProjects(saved.body);
}

/** The runner's existing parsers consume one JSON map; host topology is absent. */
export async function readTaskProjectConfig(options?: TaskProjectReadOptions): Promise<string> {
  return JSON.stringify({ spokes: await readTaskProjects(options) });
}
