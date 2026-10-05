// A CONFIG SAVE IS ATOMIC AGAINST A COMPETING WRITER (epic `ro-syok`; on
// Postgres, bead ro-ujb9.76.4.1): the whole changeset lands with its audit
// rows, or nothing does.

import { env } from 'cloudflare:test';
import type { WorkspaceStore } from '@noticeos/postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyConfigOps, forgetConfigCache, seedConfigDocuments } from '../src/config-store.js';
import { emptyTables, reset } from './helpers.js';

const NOW = Date.parse('2026-09-09T12:00:00.000Z');
const TOWER = 'config/tower.json';
const PANELS = 'config/signal-panels.json';

beforeEach(async () => {
  await reset();
  await emptyTables(['config_documents', 'config_changes']);
  forgetConfigCache();
});
afterEach(() => forgetConfigCache());

/** The test's store, whose next `write` first lets `compete` run: the pause
 * at the actual read/write boundary. All SQL still goes to real Postgres;
 * fabricated results would miss both partial saves and false audits. */
function beforeWrite(compete: () => Promise<void>): IngestEnv {
  let pending = true;
  const store = env.STORE;
  const raced: WorkspaceStore = {
    ...store,
    write: async (work) => {
      if (pending) {
        pending = false;
        await compete();
      }
      return store.write(work);
    },
  };
  return { ...env, STORE: raced };
}

async function seed(includePanels: boolean) {
  const result = await seedConfigDocuments(env, {
    documents: {
      [TOWER]: { countdown: { label: 'Original', target: '2026-10-01' } },
      ...(includePanels ? { [PANELS]: { refresh: { windowDays: 35 } } } : {}),
    },
    actor: 'seed',
  }, NOW);
  expect(result.ok).toBe(true);
}

const towerOp = {
  kind: 'file-json-set' as const, file: TOWER, pointer: '/countdown/label',
  expect: 'Original', value: 'Updated',
};
const panelOp = {
  kind: 'file-json-set' as const, file: PANELS, pointer: '/refresh/windowDays',
  expect: 35, value: 20,
};

async function documents() {
  return env.STORE.read((tx) =>
    tx.query('SELECT document_key, body, version, updated_by FROM noticeos.config_documents ORDER BY document_key'),
  );
}

async function auditRows(actor: string): Promise<number> {
  const [row] = await env.STORE.read((tx) =>
    tx.query<{ count: number }>('SELECT count(*)::int AS count FROM noticeos.config_changes WHERE actor = $1', [actor]),
  );
  return row?.count ?? -1;
}

describe('configuration saves are atomic against competing writers', () => {
  it.each([
    { name: 'single existing document', seeded: true, ops: [panelOp] },
    { name: 'conflict after an otherwise valid document', seeded: true, ops: [towerOp, panelOp] },
    { name: 'conflict before an otherwise valid document', seeded: true, ops: [panelOp, towerOp] },
    { name: 'single document seeded concurrently', seeded: false, ops: [panelOp] },
    { name: 'mixed seeded and existing documents', seeded: false, ops: [towerOp, panelOp] },
  ])('rejects $name without changing any requested row or adding audit', async ({ seeded, ops }) => {
    await seed(seeded);
    let afterCompetitor: Awaited<ReturnType<typeof documents>> = [];
    const racedEnv = beforeWrite(async () => {
      await env.STORE.write((tx) =>
        tx.execute(
          `INSERT INTO noticeos.config_documents AS d (workspace_id, document_key, body, version, updated_at, updated_by)
           VALUES ($1::uuid, 'signal-panels', $2::json, 1, $3::timestamptz, 'competitor')
           ON CONFLICT (workspace_id, document_key) DO UPDATE SET body = excluded.body,
             version = d.version + 1, updated_by = excluded.updated_by`,
          [tx.workspaceId, JSON.stringify({ refresh: { windowDays: 45 } }), new Date(NOW).toISOString()],
        ),
      );
      afterCompetitor = await documents();
    });
    const result = await applyConfigOps(racedEnv, { ops, actor: 'losing-save' }, NOW);
    expect(result).toEqual({
      ok: false, error: 'version_mismatch',
      files: [{ file: PANELS, expected: seeded ? 1 : 0, observed: seeded ? 2 : 1 }],
    });
    expect(await documents()).toEqual(afterCompetitor);
    expect(await auditRows('losing-save')).toBe(0);
  });

  it('saves an existing and a newly seeded document together with truthful audit versions', async () => {
    await seed(false);
    const result = await applyConfigOps(env, {
      ops: [towerOp, panelOp], actor: 'winning-save', reason: 'Update both preferences',
    }, NOW);
    expect(result).toMatchObject({ ok: true, applied: 2, documents: [
      { file: TOWER, version: 2, body: { countdown: { label: 'Updated' } } },
      { file: PANELS, version: 1, body: { refresh: { windowDays: 20 } } },
    ] });
    const audit = await env.STORE.read((tx) =>
      tx.query(
        `SELECT document_key, version_before, version_after, reason FROM noticeos.config_changes
          WHERE actor = 'winning-save' ORDER BY document_key`,
      ),
    );
    expect(audit).toEqual([
      { document_key: 'signal-panels', version_before: 0, version_after: 1, reason: 'Update both preferences' },
      { document_key: 'tower', version_before: 1, version_after: 2, reason: 'Update both preferences' },
    ]);
  });

  it('rolls back every document when recording its audit fails', async () => {
    await seed(true);
    const before = await documents();
    // The documents are written for real; the audit's statement then fails,
    // inside the same transaction, and nothing of it may be kept.
    const store = env.STORE;
    const failingAudit: WorkspaceStore = {
      ...store,
      write: (work) =>
        store.write((tx) =>
          work({
            workspaceId: tx.workspaceId,
            query: (sql, params) => tx.query(sql, params),
            execute: async (sql, params) => {
              if (/INSERT INTO noticeos\.config_changes/u.test(sql)) throw new Error('audit unavailable');
              return tx.execute(sql, params);
            },
          }),
        ),
    };
    await expect(applyConfigOps({ ...env, STORE: failingAudit }, { ops: [towerOp, panelOp], actor: 'failed-audit' }, NOW)).rejects.toThrow(
      'audit unavailable',
    );
    expect(await documents()).toEqual(before);
    expect(await auditRows('failed-audit')).toBe(0);
  });
});


describe('Product use presentation preserves a competing measurement declaration', () => {
  const file='config/value-events.json';
  const stage={eventName:'document_open',label:'Opened a document',group:'primary'};
  const row=(index:number)=>({eventName:`document_${index}`,label:`Document ${index}`,group:'primary'});
  const list='/assets/example.com/productUseStages';
  it.each([
    {name:'duplicate append',stages:[row(0)],op:{kind:'file-json-insert' as const,pointer:`${list}/-`,value:row(0)}},
    {name:'duplicate indexed insert',stages:[row(0)],op:{kind:'file-json-insert' as const,pointer:`${list}/0`,value:row(0)}},
    {name:'33rd append',stages:Array.from({length:32},(_,i)=>row(i)),op:{kind:'file-json-insert' as const,pointer:`${list}/-`,value:row(32)}},
    {name:'duplicate event edit',stages:[row(0),row(1)],op:{kind:'file-json-set' as const,pointer:`${list}/1/eventName`,value:'document_0',expect:'document_1'}},
    {name:'self comparison edit',stages:[row(0)],op:{kind:'file-json-set' as const,pointer:`${list}/0/compareTo`,value:'document_0',expectAbsent:true as const}},
  ])('refuses final invalid $name before persistence or audit',async({stages,op})=>{
    await seedConfigDocuments(env,{documents:{[file]:{assets:{'example.com':{valueEvents:['purchase'],productUseStages:stages}}}},actor:'seed'},NOW);
    const before=await documents();
    const result=await applyConfigOps(env,{ops:[{...op,file}],actor:'invalid-stage-save'},NOW);
    expect(result).toMatchObject({ok:false,error:'invalid_changeset'});
    expect(await documents()).toEqual(before);
    expect(await auditRows('invalid-stage-save')).toBe(0);
  });
  it('checks the final multi-op list and permits deletion to recover malformed stored stages',async()=>{
    await seedConfigDocuments(env,{documents:{[file]:{assets:{'example.com':{valueEvents:['purchase'],productUseStages:[row(0),row(1)]}}}},actor:'seed'},NOW);
    const result=await applyConfigOps(env,{ops:[
      {kind:'file-json-set',file,pointer:`${list}/0/eventName`,expect:'document_0',value:'document_1'},
      {kind:'file-json-set',file,pointer:`${list}/1/eventName`,expect:'document_1',value:'document_2'},
    ],actor:'valid-stage-batch'},NOW);
    expect(result.ok).toBe(true);
    expect(await auditRows('valid-stage-batch')).toBe(1);
    await env.STORE.write(tx=>tx.execute(`UPDATE noticeos.config_documents SET body=$2::json,version=version+1 WHERE workspace_id=$1::uuid AND document_key='value-events'`,
      [tx.workspaceId,JSON.stringify({assets:{'example.com':{valueEvents:['purchase'],productUseStages:[row(0),row(0)]}}})]));
    forgetConfigCache();
    const recovered=await applyConfigOps(env,{ops:[{kind:'file-json-delete',file,pointer:`${list}/1`,expect:row(0)}],actor:'stage-recovery'},NOW);
    expect(recovered.ok).toBe(true);
    const body=(await documents()).find(doc=>doc.document_key==='value-events')!.body;
    if(typeof body!=='string')throw new Error('Expected serialized fixture document');
    expect(JSON.parse(body)).toEqual({assets:{'example.com':{valueEvents:['purchase'],productUseStages:[row(0)]}}});
  });
  it('refuses a concurrent holder birth, then initializes and undoes only its own list', async () => {
    await seedConfigDocuments(env,{documents:{[file]:{assets:{}}},actor:'seed'},NOW);
    const measurement={kind:'file-json-insert' as const,file,pointer:'/assets/example.com',value:{valueEvents:['purchase']}};
    const presentation={kind:'file-json-insert' as const,file,pointer:'/assets/example.com',value:{productUseStages:[stage]}};
    let competitor:Awaited<ReturnType<typeof documents>>=[];
    const raced=beforeWrite(async()=>{
      const won=await applyConfigOps(env,{ops:[measurement],actor:'measurement-save'},NOW);
      expect(won.ok).toBe(true); competitor=await documents();
    });
    const lost=await applyConfigOps(raced,{ops:[presentation],actor:'presentation-lost'},NOW);
    expect(lost).toMatchObject({ok:false,error:'version_mismatch'});
    expect(await documents()).toEqual(competitor);
    expect(await auditRows('presentation-lost')).toBe(0);
    forgetConfigCache();
    const created=await applyConfigOps(env,{ops:[{...presentation,pointer:'/assets/example.com/productUseStages',value:[stage]}],actor:'presentation-save'},NOW);
    expect(created.ok).toBe(true);
    const body=(await documents()).find(row=>row.document_key==='value-events')!.body;
    if (typeof body !== 'string') throw new Error('Expected serialized fixture document');
    expect(JSON.parse(body)).toEqual({assets:{'example.com':{valueEvents:['purchase'],productUseStages:[stage]}}});
    const undone=await applyConfigOps(env,{ops:[{kind:'file-json-delete',file,pointer:'/assets/example.com/productUseStages',expect:[stage]}],actor:'presentation-undo'},NOW);
    expect(undone.ok).toBe(true);
    const restored=(await documents()).find(row=>row.document_key==='value-events')!.body;
    if (typeof restored !== 'string') throw new Error('Expected serialized fixture document');
    expect(JSON.parse(restored)).toEqual({assets:{'example.com':{valueEvents:['purchase']}}});
  });
});
