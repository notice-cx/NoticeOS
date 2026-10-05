import { abortAllDurableObjects, env } from 'cloudflare:test';
import { openWorkspaceStore } from '@noticeos/postgres';
import { expect, it } from 'vitest';
import { asOwner } from './helpers';

const LEFT = Symbol.for('noticeos.ingest.reset-boundary-probe');
type Runtime = typeof globalThis & { [LEFT]?: 'a' | 'b' };

/** Two files share one runtime: the later file proves clean-start did the work. */
export function resetBoundaryProbe(self: 'a' | 'b'): void {
  const runtime = globalThis as Runtime;
  const earlier = runtime[LEFT];
  it(earlier ? `starts clean after aborted probe ${earlier} in this runtime` : 'starts clean', async () => {
    expect((await env.RAW_SIGNALS.list()).objects).toEqual([]);
    const other = openWorkspaceStore(env.POSTGRES_OTHER.connectionString);
    try {
      expect(await other.workspaceId()).toBe(await env.STORE.workspaceId());
    } finally {
      await other.close();
    }
  });
  it('leaves 73 saved objects in detached bucket storage for the next file', async () => {
    const keys = Array.from({ length: 73 }, (_, index) => `reset-file-${self}/${index}`);
    await Promise.all(keys.map(key => env.RAW_SIGNALS.put(key, 'synthetic archive')));
    expect((await env.RAW_SIGNALS.list()).objects).toHaveLength(73);
    await asOwner('TRUNCATE noticeos.workspaces CASCADE;', { other: true });
    const other = openWorkspaceStore(env.POSTGRES_OTHER.connectionString);
    try {
      await expect(other.workspaceId()).rejects.toThrow('the store names no single workspace');
    } finally {
      await other.close();
    }
    await abortAllDurableObjects();
    runtime[LEFT] = self;
  });
}
