// THE CONFIG READ CACHE BELONGS TO ONE STORE AND ONE WORKSPACE (epic
// `ro-syok`; on Postgres, bead ro-ujb9.76.4.1).
//
// One isolate serves many calls, each with a store of its own, so the cache
// is keyed on where the store is and which workspace the call acts for. A
// second store — this runtime's second Postgres copy, `POSTGRES_OTHER`
// (vitest.config.ts) — must never be answered from the first one's cache.

import { env } from 'cloudflare:test';
import { openWorkspaceStore, type WorkspaceStore } from '@noticeos/postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyConfigOps, forgetConfigCache, getConfigDocument, seedConfigDocuments } from '../src/config-store.js';
import { emptyTables, forgetConfigDocuments } from './helpers.js';

const FILE = 'config/tower.json';
const NOW = Date.parse('2026-09-09T12:00:00Z');
const document = (label: string) => ({ countdown: { label, target: '2026-10-01' } });

let otherStore: WorkspaceStore;
let other: IngestEnv;

beforeEach(async () => {
  forgetConfigCache();
  await emptyTables(['config_documents', 'config_changes']);
  await emptyTables(['config_documents', 'config_changes'], { other: true });
  otherStore = openWorkspaceStore(env.POSTGRES_OTHER.connectionString);
  other = { ...env, STORE: otherStore };
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  for (const [binding, label] of [[env, 'First workspace'], [other, 'Second workspace']] as const) {
    const result = await seedConfigDocuments(binding, { documents: { [FILE]: document(label) }, actor: 'test' });
    expect(result.ok).toBe(true);
  }
});
afterEach(async () => {
  forgetConfigCache();
  vi.restoreAllMocks();
  await otherStore.close();
});
const readLabel = async (binding: IngestEnv) => (await getConfigDocument(binding, FILE)).body;
async function externalChange(binding: IngestEnv, label: string) {
  await binding.STORE.write((tx) =>
    tx.execute("UPDATE noticeos.config_documents SET body = $1::json WHERE document_key = 'tower'", [JSON.stringify(document(label))]),
  );
}

describe('configuration cache ownership', () => {
  it('returns each store its own document within the same cache lifetime', async () => {
    expect(env.STORE.where).not.toBe(otherStore.where);
    expect(await readLabel(env)).toEqual(document('First workspace'));
    expect(await readLabel(other)).toEqual(document('Second workspace'));
    expect(await readLabel(env)).toEqual(document('First workspace'));
  });

  it('keeps same-store cache hits and reloads after one second', async () => {
    expect(await readLabel(env)).toEqual(document('First workspace'));
    await externalChange(env, 'Changed elsewhere');
    vi.mocked(Date.now).mockReturnValue(NOW + 999);
    expect(await readLabel(env)).toEqual(document('First workspace'));
    vi.mocked(Date.now).mockReturnValue(NOW + 1000);
    expect(await readLabel(env)).toEqual(document('Changed elsewhere'));
  });

  it('invalidates the store written by a Save while retaining other caches', async () => {
    await readLabel(env);
    await readLabel(other);
    await externalChange(other, 'External second change');
    const saved = await applyConfigOps(env, { actor: 'test', ops: [{
      kind: 'file-json-set', file: FILE, pointer: '/countdown/label',
      expect: 'First workspace', value: 'Saved first change',
    }] });
    expect(saved.ok).toBe(true);
    expect(await readLabel(env)).toEqual(document('Saved first change'));
    expect(await readLabel(other)).toEqual(document('Second workspace'));
    forgetConfigCache(otherStore);
    expect(await readLabel(other)).toEqual(document('External second change'));
  });

  it('invalidates re-seeded documents without evicting the other store', async () => {
    await readLabel(env);
    await readLabel(other);
    await externalChange(other, 'External second change');
    const seeded = await seedConfigDocuments(env, {
      documents: { [FILE]: document('Restored first') }, actor: 'test', force: [FILE], reason: 'Test restore',
    });
    expect(seeded.ok).toBe(true);
    expect(await readLabel(env)).toEqual(document('Restored first'));
    expect(await readLabel(other)).toEqual(document('Second workspace'));
  });

  it('does not reuse a missing document across stores', async () => {
    await forgetConfigDocuments([FILE], { other: true });
    forgetConfigCache();
    expect(await getConfigDocument(other, FILE)).toMatchObject({ source: 'file', version: null });
    expect(await readLabel(env)).toEqual(document('First workspace'));
  });
});
