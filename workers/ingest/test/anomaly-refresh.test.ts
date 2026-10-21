import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openWorkspaceStore } from '@noticeos/postgres';
import { flowPoissonAnomaly } from '@noticeos/contract';
import { refreshAnomalies, REFRESH_PLAN_MS } from '../src/anomaly-refresh.js';
import { writePulse, shiftDate } from '../src/db.js';
import { appendReading, holdCountAlerts } from '../src/alert-store.js';
import { asOwner, call, insertFlag, insertPulse, pgCount, pgRows, reset } from './helpers.js';
import { OPERATOR_TOKEN } from './fixtures.js';

const ASSET = 'meadow.example';
const NOW = Date.parse('2026-10-21T12:00:00Z');
const at = (ms: number) => new Date(ms).toISOString();
const report = (date: string, value: number) => ({ asset: ASSET, generatedAt: `${date}T03:00:00.000Z`,
  capabilities: ['signups'], metrics: { signups: { last24h: value, avg7d: 50, total: 1000 } } });

beforeEach(reset);
afterEach(() => { vi.restoreAllMocks(); });

async function seed(observed = 0, now = NOW) {
  const today = at(now).slice(0, 10);
  const rows = Array.from({ length: 132 }, (_, back) => {
    const date = shiftDate(today, -back), envelope = report(date, back === 0 ? observed : 50);
    if (back === 0 && Date.parse(envelope.generatedAt) > now) envelope.generatedAt = at(now);
    return { date, envelope, at: envelope.generatedAt };
  });
  await env.STORE.write(async (tx) => {
    await tx.execute(`INSERT INTO noticeos.config_documents (workspace_id,document_key,body,version,updated_at,updated_by)
      VALUES ($1,'constants',$2::json,1,$3::timestamptz,'synthetic') ON CONFLICT (workspace_id,document_key) DO UPDATE SET body=excluded.body, version=excluded.version`,
    [tx.workspaceId, JSON.stringify({ flag_defaults: { alpha: 0.01, max_window_days: 14 } }), at(now)]);
    await tx.execute(`INSERT INTO noticeos.pulses (workspace_id,asset_id,pulse_date,revision,generated_at,received_at,capabilities,envelope)
      SELECT $1,$2,(d->>'date')::date,1,(d->>'at')::timestamptz,(d->>'at')::timestamptz,'["signups"]'::jsonb,d->'envelope'
      FROM jsonb_array_elements($3::jsonb) d`, [tx.workspaceId, ASSET, JSON.stringify(rows)]);
  });
  const [row] = await pgRows<{ id: bigint }>(`SELECT pulse_id AS id FROM noticeos.current_pulses WHERE asset_id=$1 AND pulse_date=$2::date`, [ASSET, today]);
  return { pulseId: row!.id, envelope: rows[0]!.envelope, today };
}

const old = (pulseId?: bigint) => insertFlag({ asset: ASSET, pulseId, firedAt: '2026-10-20T03:00:00Z', severity: 'warn', kind: 'anomaly',
  ruleId: 'flow-poisson-low', metric: 'signups', message: 'old arithmetic', ruleInputs: JSON.stringify(flowPoissonAnomaly('signups', 0, 50).inputs) });
async function state() {
  const rows = await env.STORE.read(async (tx) => ({
    pulses: await tx.query(`SELECT pulse_id::text,envelope::text,received_at FROM noticeos.pulses ORDER BY pulse_id`),
    flags: await tx.query(`SELECT * FROM noticeos.flags ORDER BY flag_id`),
    jobs: await tx.query(`SELECT * FROM noticeos.job_runs ORDER BY job_run_id`),
    notifications: await tx.query(`SELECT * FROM noticeos.notification_outbox`),
    evidence: await tx.query(`SELECT * FROM noticeos.flag_evidence`),
  }));
  return rows;
}

describe('stored count refresh preview and atomic apply', () => {
  it('previews without writing, then retires and creates only current count warnings without provider calls', async () => {
    const { pulseId } = await seed();
    const superseded = await old(pulseId);
    const technical = await insertFlag({ asset: ASSET, firedAt: at(NOW), severity: 'error', kind: 'anomaly', ruleId: 'uptime-down' });
    const freshness = await insertFlag({ asset: ASSET, firedAt: at(NOW), severity: 'warn', kind: 'anomaly', ruleId: 'ingest-freshness' });
    const before = await state();
    const noProvider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no external requests'));
    const preview = await refreshAnomalies(env.STORE, ASSET, undefined, NOW);
    expect(preview).toMatchObject({ mode: 'preview', retire: [{ flag: String(superseded) }], create: [{ metric: 'signups' }] });
    expect(await state()).toEqual(before);
    const applied = await refreshAnomalies(env.STORE, ASSET, String(preview.applyToken), NOW + 1000);
    expect(applied).toMatchObject({ mode: 'applied', replayed: false });
    const after = await state();
    expect(after.pulses).toEqual(before.pulses);
    expect(after.notifications).toEqual(before.notifications);
    expect(after.jobs).toHaveLength(1);
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.flags WHERE flag_number=ANY($1::bigint[]) AND resolved_at IS NULL`, [[technical, freshness]])).toBe(2);
    const [created] = await pgRows<{ fired: string; pulse: bigint; inputs: string }>(`SELECT fired_at AS fired,pulse_id AS pulse,rule_inputs::text AS inputs FROM noticeos.flags WHERE metric='signups' AND resolved_at IS NULL`);
    expect(created!.fired).toContain('2026-10-21T03:00:00');
    expect(created!.pulse).toBe(pulseId);
    expect(JSON.parse(created!.inputs).prediction.model).toBe('weekday-log-predictive-v1');
    expect(JSON.parse(created!.inputs).storedReportRefresh).toMatchObject({ source: 'stored-report', reportId: String(pulseId) });
    expect(noProvider).not.toHaveBeenCalled();
    const committed = await state();
    expect(await refreshAnomalies(env.STORE, ASSET, String(preview.applyToken), NOW + REFRESH_PLAN_MS * 2)).toMatchObject({ replayed: true });
    expect(await state()).toEqual(committed);
    const again = await refreshAnomalies(env.STORE, ASSET, undefined, NOW + 1000);
    expect(again.retire).toEqual([]); expect(again.create).toEqual([]);
  });

  it('does not create warnings from insufficient history, and records why old warnings are retired', async () => {
    const { pulseId, today } = await seed();
    await asOwner(`DELETE FROM noticeos.pulses WHERE pulse_date < '${shiftDate(today, -28)}'`);
    await old(pulseId);
    const plan = await refreshAnomalies(env.STORE, ASSET, undefined, NOW);
    expect(plan).toMatchObject({ retire: [{ reason: 'superseded-insufficient-evidence' }], create: [], evaluations: [{ outcome: 'not-applicable' }] });
    await refreshAnomalies(env.STORE, ASSET, String(plan.applyToken), NOW);
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.flags WHERE resolved_at IS NULL`)).toBe(0);
  });

  it.each(['ack', 'snooze', 'resolved', 'earlier-revision'])('preserves %s decisions and does not reopen the current report', async (decision) => {
    const { pulseId, envelope, today } = await seed();
    const ownPulse = decision === 'earlier-revision' ? await insertPulse({ asset: ASSET, date: today, receivedAt: envelope.generatedAt, generatedAt: envelope.generatedAt, capabilities: envelope.capabilities, envelope }) : pulseId;
    await insertFlag({ asset: ASSET, pulseId, firedAt: envelope.generatedAt, metric: 'signups', severity: 'warn', kind: 'anomaly', ruleId: 'flow-lowvol-window',
      disposition: decision === 'resolved' ? null : decision === 'snooze' ? 'snooze' : 'ack', dispositionAt: decision === 'resolved' ? null : at(NOW),
      ruleInputs: JSON.stringify(flowPoissonAnomaly('signups', 0, 50).inputs),
      snoozeUntil: decision === 'snooze' ? at(NOW + 86400000) : null, resolvedAt: decision === 'resolved' ? at(NOW) : null });
    expect(ownPulse).toBeDefined();
    const before = await state();
    const plan = await refreshAnomalies(env.STORE, ASSET, undefined, NOW);
    expect(plan.create).toEqual([]); expect(plan.retire).toEqual([]);
    await refreshAnomalies(env.STORE, ASSET, String(plan.applyToken), NOW);
    expect((await state()).flags).toEqual(before.flags);
  });

  it('recognizes legacy warnings only from the owning report, and honors a cross-day legacy snooze', async () => {
    await seed();
    const envelope = report('2026-10-20', 0);
    const pulse = await insertPulse({ asset: ASSET, date: '2026-10-20', receivedAt: envelope.generatedAt, generatedAt: envelope.generatedAt, capabilities: envelope.capabilities, envelope });
    const legacy = { source: 'envelope', kind: 'anomaly', severity: 'warn', metric: 'signups', msg: 'last24h 0 vs avg7d 50.0 (rule poisson-24h, P<=1e-20)' };
    const recognized = await insertFlag({ asset: ASSET, pulseId: pulse, firedAt: envelope.generatedAt, metric: 'signups', severity: 'warn', kind: 'anomaly', ruleId: 'asset-declared', ruleInputs: JSON.stringify(legacy),
      disposition: 'snooze', dispositionAt: at(NOW - 86400000), snoozeUntil: at(NOW + 60000) });
    const custom = await insertFlag({ asset: ASSET, pulseId: pulse, firedAt: envelope.generatedAt, metric: 'signups', severity: 'warn', kind: 'anomaly', ruleId: 'asset-declared', ruleInputs: JSON.stringify({ ...legacy, msg: legacy.msg.replace('50.0', '99.0') }) });
    const plan = await refreshAnomalies(env.STORE, ASSET, undefined, NOW);
    expect(plan.create).toEqual([]); expect(plan.retire).toEqual([]);
    expect(plan.preserve).toEqual(expect.arrayContaining([{ flag: String(custom), metric: 'signups', reason: 'independent-or-unknown-warning' },
      { flag: String(recognized), metric: 'signups', reason: 'operator-or-settled-history' }]));
    await expect(refreshAnomalies(env.STORE, ASSET, String(plan.applyToken), NOW + 60001)).rejects.toThrow('stale_plan');
  });

  it.each(['report', 'history', 'settings', 'decision', 'evidence'])('refuses a plan after %s changes with no further writes', async (change) => {
    const { pulseId, today } = await seed();
    const flag = await old(pulseId);
    const plan = await refreshAnomalies(env.STORE, ASSET, undefined, NOW);
    if (change === 'report' || change === 'history') {
      const date = change === 'report' ? today : shiftDate(today, -7), envelope = report(date, 12);
      await insertPulse({ asset: ASSET, date, receivedAt: envelope.generatedAt, generatedAt: envelope.generatedAt, capabilities: envelope.capabilities, envelope });
    } else if (change === 'settings') await env.STORE.write((tx) => tx.execute(`UPDATE noticeos.config_documents SET version=version+1 WHERE document_key='constants'`));
    else if (change === 'decision') await env.STORE.write((tx) => tx.execute(`UPDATE noticeos.flags SET disposition='ack',disposition_at=$2::timestamptz WHERE flag_number=$1`, [flag, at(NOW)]));
    else await env.STORE.write((tx) => tx.query<{ id: bigint }>(`SELECT flag_id AS id FROM noticeos.flags WHERE flag_number=$1`, [flag]).then((rows) => appendReading(tx, [rows[0]!.id], { observedAt: at(NOW), severity: 'warn', message: 'new evidence', ruleInputs: '{"changed":true}' })));
    const before = await state();
    await expect(refreshAnomalies(env.STORE, ASSET, String(plan.applyToken), NOW + 1000)).rejects.toThrow('stale_plan');
    expect(await state()).toEqual(before);
  });

  it('rolls back retirement if adding the replacement fails', async () => {
    const { pulseId } = await seed(); await old(pulseId);
    const plan = await refreshAnomalies(env.STORE, ASSET, undefined, NOW);
    const before = await state();
    const broken = { ...env.STORE, write: <T>(work: Parameters<typeof env.STORE.write<T>>[0]) => env.STORE.write((tx) => work({ ...tx, execute: (sql, params) => {
      if (sql.includes('INSERT INTO noticeos.flags')) throw new Error('synthetic insert failure');
      return tx.execute(sql, params);
    } })) };
    await expect(refreshAnomalies(broken, ASSET, String(plan.applyToken), NOW)).rejects.toThrow('synthetic insert failure');
    expect(await state()).toEqual(before);
  });

  it('serializes concurrent applies and normal report ingestion without duplicates', async () => {
    const { envelope } = await seed();
    const plan = await refreshAnomalies(env.STORE, ASSET, undefined, NOW);
    const results = await Promise.all([refreshAnomalies(env.STORE, ASSET, String(plan.applyToken), NOW), refreshAnomalies(env.STORE, ASSET, String(plan.applyToken), NOW)]);
    expect(results.filter((r) => r.replayed === true)).toHaveLength(1);
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.job_runs`)).toBe(1);
    await writePulse(env, { ...envelope, metrics: { signups: { last24h: 50, avg7d: 50, total: 1000 } } });
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.current_flags WHERE metric='signups' AND resolved_at IS NULL`)).toBe(0);
  });

  it('reads normal report history only after acquiring the shared refresh lock', async () => {
    const { envelope, today } = await seed();
    let acquired!: () => void, attempted!: () => void;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const waiting = new Promise<void>((resolve) => { attempted = resolve; });
    const held = env.STORE.write(async (tx) => {
      await holdCountAlerts(tx, ASSET); acquired();
      await waiting;
      await tx.execute(`INSERT INTO noticeos.pulses (workspace_id,asset_id,pulse_date,revision,generated_at,received_at,capabilities,envelope)
        SELECT workspace_id,asset_id,pulse_date,revision+1,generated_at,received_at,capabilities,
          jsonb_set(envelope::jsonb,'{metrics,signups,last24h}','0'::jsonb)::json
        FROM noticeos.current_pulses WHERE asset_id=$1 AND pulse_date<$2::date`, [ASSET, today]);
    });
    await ready;
    const observed = { ...env.STORE, write: <T>(work: Parameters<typeof env.STORE.write<T>>[0]) => env.STORE.write((tx) => work({ ...tx,
      query: (sql, params) => { if (sql.includes('pg_advisory_xact_lock')) attempted(); return tx.query(sql, params); },
    })) };
    try {
      const [result] = await Promise.all([writePulse({ STORE: observed }, envelope), held]);
      expect(result.centralFlags).toBe(0);
    } finally { attempted(); await held; }
  });

  it('refuses expired plans and does not reapply after an expired receipt was pruned', async () => {
    await seed(); const plan = await refreshAnomalies(env.STORE, ASSET, undefined, NOW);
    await expect(refreshAnomalies(env.STORE, ASSET, String(plan.applyToken), NOW + REFRESH_PLAN_MS + 1)).rejects.toThrow('expired_plan');
    await refreshAnomalies(env.STORE, ASSET, String(plan.applyToken), NOW);
    await asOwner('DELETE FROM noticeos.job_runs');
    const before = await state();
    await expect(refreshAnomalies(env.STORE, ASSET, String(plan.applyToken), NOW + REFRESH_PLAN_MS + 1)).rejects.toThrow('expired_plan');
    expect(await state()).toEqual(before);
  });

  it.each(['base', 'message', 'note'])('binds %s evidence even when another reading supplies the visible inputs', async (change) => {
    const { pulseId } = await seed(); const flag = await old(pulseId);
    await env.STORE.write(async (tx) => {
      const [row] = await tx.query<{ id: bigint }>('SELECT flag_id AS id FROM noticeos.flags WHERE flag_number=$1', [flag]);
      await appendReading(tx, [row!.id], { observedAt: at(NOW), severity: 'warn', message: 'visible evidence', ruleInputs: '{"observed":0}' });
    });
    const plan = await refreshAnomalies(env.STORE, ASSET, undefined, NOW);
    if (change === 'base') await asOwner(`UPDATE noticeos.flags SET rule_inputs='{"different":1}'::jsonb WHERE flag_number=${flag}`);
    else if (change === 'note') await asOwner(`UPDATE noticeos.flags SET disposition_note='Updated operator context' WHERE flag_number=${flag}`);
    else await asOwner(`UPDATE noticeos.flag_evidence SET message='Updated visible explanation'`);
    const before = await state();
    await expect(refreshAnomalies(env.STORE, ASSET, plan.applyToken, NOW)).rejects.toThrow('stale_plan');
    expect(await state()).toEqual(before);
  });

  it('requires a new preview if the report ages out while a plan is reviewed', async () => {
    await seed();
    const nearExpiry = Date.parse('2026-10-21T03:00:00Z') + 48 * 3600000 - 1000;
    const plan = await refreshAnomalies(env.STORE, ASSET, undefined, nearExpiry);
    await expect(refreshAnomalies(env.STORE, ASSET, plan.applyToken, nearExpiry + 2000)).rejects.toThrow('stale_report');
  });

  it('observes evidence committed while apply waits for its flag lock', async () => {
    const { pulseId } = await seed(); const flag = await old(pulseId);
    const plan = await refreshAnomalies(env.STORE, ASSET, undefined, NOW);
    let inserted!: () => void, attempting!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { inserted = resolve; });
    const waiting = new Promise<void>((resolve) => { attempting = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const pending = env.STORE.write(async (tx) => {
      const [row] = await tx.query<{ id: bigint }>('SELECT flag_id AS id FROM noticeos.flags WHERE flag_number=$1', [flag]);
      await appendReading(tx, [row!.id], { observedAt: at(NOW), severity: 'warn', message: 'Concurrent evidence',
        ruleInputs: JSON.stringify(flowPoissonAnomaly('signups', 1, 50).inputs) });
      inserted(); await released;
    });
    await ready;
    let applyPid = 0;
    const observed = { ...env.STORE, write: <T>(work: Parameters<typeof env.STORE.write<T>>[0]) => env.STORE.write(async (tx) => {
      const [backend] = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'); applyPid = backend!.pid;
      return work({ ...tx, query: (sql, params) => { if (sql.includes('FOR UPDATE OF f')) attempting(); return tx.query(sql, params); } });
    }) };
    const checked = expect(refreshAnomalies(observed, ASSET, plan.applyToken, NOW)).rejects.toThrow('stale_plan');
    try {
      await waiting;
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        const [row] = await pgRows<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1::int)) > 0 AS blocked', [applyPid]);
        blocked = row!.blocked;
      }
      expect(blocked).toBe(true);
    } finally { release(); await pending; await checked; }
    expect(await pgCount('SELECT count(*) AS n FROM noticeos.job_runs')).toBe(0);
    expect(await pgCount('SELECT count(*) AS n FROM noticeos.flags WHERE resolved_at IS NOT NULL')).toBe(0);
  });

  it('retires expired snoozes while retaining their disposition history', async () => {
    const { pulseId } = await seed(); const flag = await old(pulseId);
    await env.STORE.write((tx) => tx.execute(`UPDATE noticeos.flags SET disposition='snooze',disposition_at=$2::timestamptz,snooze_until=$3::timestamptz WHERE flag_number=$1`,
      [flag, at(NOW - 86400000), at(NOW - 1)]));
    const plan = await refreshAnomalies(env.STORE, ASSET, undefined, NOW);
    expect(plan.retire).toHaveLength(1); expect(plan.create).toHaveLength(1);
    await refreshAnomalies(env.STORE, ASSET, plan.applyToken, NOW);
    expect(await pgRows(`SELECT disposition FROM noticeos.flags WHERE flag_number=$1 AND resolved_at IS NOT NULL`, [flag])).toEqual([{ disposition: 'snooze' }]);
  });

  it.each([null, [], { prediction: { model: 'weekday-log-predictive-v1' } }, { prediction: { model: 'future-v2' } }])('preserves unsupported central evidence %j', async (inputs) => {
    const { pulseId } = await seed();
    const flag = await insertFlag({ asset: ASSET, pulseId, firedAt: at(NOW), metric: 'signups', severity: 'warn', kind: 'anomaly', ruleId: 'flow-poisson-low', ruleInputs: inputs === null ? null : JSON.stringify(inputs) });
    const plan = await refreshAnomalies(env.STORE, ASSET, undefined, NOW);
    expect(plan.retire).toEqual([]);
    expect(plan.preserve).toContainEqual({ flag: String(flag), metric: 'signups', reason: 'independent-or-unknown-warning' });
    await refreshAnomalies(env.STORE, ASSET, plan.applyToken, NOW);
    expect(await pgCount('SELECT count(*) AS n FROM noticeos.flags WHERE flag_number=$1 AND resolved_at IS NULL', [flag])).toBe(1);
  });

  it('preserves a future base model masked by a supported later reading', async () => {
    const { pulseId } = await seed(); const flag = await old(pulseId);
    await asOwner(`UPDATE noticeos.flags SET rule_inputs='{"prediction":{"model":"future-v2"}}'::jsonb WHERE flag_number=${flag}`);
    await env.STORE.write(async (tx) => {
      const [row] = await tx.query<{ id: bigint }>('SELECT flag_id AS id FROM noticeos.flags WHERE flag_number=$1', [flag]);
      await appendReading(tx, [row!.id], { observedAt: at(NOW), severity: 'warn', message: 'Supported reading', ruleInputs: JSON.stringify(flowPoissonAnomaly('signups', 0, 50).inputs) });
    });
    expect((await refreshAnomalies(env.STORE, ASSET, undefined, NOW)).retire).toEqual([]);
  });

  it('preserves a complete predictive record with reversed range bounds', async () => {
    const { pulseId } = await seed();
    const first = await refreshAnomalies(env.STORE, ASSET, undefined, NOW);
    const inputs = structuredClone(first.create[0]!.inputs);
    const prediction = inputs.prediction as { lower: number; upper: number };
    prediction.lower = prediction.upper + 1;
    const flag = await insertFlag({ asset: ASSET, pulseId, firedAt: at(NOW), metric: 'signups', severity: 'warn', kind: 'anomaly', ruleId: 'flow-poisson-low', ruleInputs: JSON.stringify(inputs) });
    const plan = await refreshAnomalies(env.STORE, ASSET, undefined, NOW);
    expect(plan.retire).toEqual([]);
    expect(plan.preserve).toContainEqual({ flag: String(flag), metric: 'signups', reason: 'independent-or-unknown-warning' });
  });
});

describe('refresh eligibility and authority', () => {
  it('requires seeded settings and refuses oversized text without writing a receipt', async () => {
    await seed();
    await asOwner("DELETE FROM noticeos.config_documents WHERE document_key='constants'");
    await expect(refreshAnomalies(env.STORE, ASSET, undefined, NOW)).rejects.toThrow('settings_not_seeded');
    await env.STORE.write((tx) => tx.execute(`INSERT INTO noticeos.config_documents (workspace_id,document_key,body,version,updated_at,updated_by)
      VALUES ($1,'constants','{}',1,$2::timestamptz,'synthetic')`, [tx.workspaceId, at(NOW)]));
    await insertFlag({ asset: ASSET, firedAt: at(NOW), metric: 'x'.repeat(66000), severity: 'warn', kind: 'anomaly', ruleId: 'flow-poisson-low' });
    await expect(refreshAnomalies(env.STORE, ASSET, undefined, NOW)).rejects.toThrow('input_limit');
    expect(await pgCount('SELECT count(*) AS n FROM noticeos.job_runs')).toBe(0);
  });

  it('refuses an oversized result before any alert changes or receipt writes', async () => {
    await seed();
    await env.STORE.write((tx) => tx.execute(`INSERT INTO noticeos.flags (workspace_id,asset_id,fired_at,severity,kind,rule_id,metric)
      SELECT $1,$2,$3::timestamptz,'warn','anomaly','flow-poisson-low',repeat('x',3000) FROM generate_series(1,200)`, [tx.workspaceId, ASSET, at(NOW)]));
    const before = await state();
    await expect(refreshAnomalies(env.STORE, ASSET, undefined, NOW)).rejects.toThrow('output_limit');
    expect(await state()).toEqual(before);
  });

  it('refuses stale/future reports, retired assets and oversized input', async () => {
    await seed();
    await expect(refreshAnomalies(env.STORE, ASSET, undefined, NOW + 3 * 86400000)).rejects.toThrow('stale_report');
    await expect(refreshAnomalies(env.STORE, ASSET, undefined, NOW - 86400000)).rejects.toThrow('future_report');
    await asOwner(`UPDATE noticeos.assets SET status='retired' WHERE asset_id='${ASSET}'`);
    try { await expect(refreshAnomalies(env.STORE, ASSET, undefined, NOW)).rejects.toThrow('asset_not_active'); }
    finally { await asOwner(`UPDATE noticeos.assets SET status='live' WHERE asset_id='${ASSET}'`); }
    await env.STORE.write((tx) => tx.execute(`UPDATE noticeos.config_documents SET body=$1::json WHERE document_key='constants'`, [JSON.stringify({ pad: 'x'.repeat(66000) })]));
    await expect(refreshAnomalies(env.STORE, ASSET, undefined, NOW)).rejects.toThrow('input_limit');
  });

  it('refuses flag and metric overflow rather than applying a truncated plan', async () => {
    const { today } = await seed();
    await env.STORE.write((tx) => tx.execute(`INSERT INTO noticeos.flags (workspace_id,asset_id,fired_at,severity,kind,rule_id,metric)
      SELECT $1,$2,$3::timestamptz,'warn','anomaly','flow-poisson-low','signups' FROM generate_series(1,201)`, [tx.workspaceId, ASSET, at(NOW)]));
    await expect(refreshAnomalies(env.STORE, ASSET, undefined, NOW)).rejects.toThrow('input_limit');
    const envelope = { ...report(today, 0), metrics: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`counter${i}`, { last24h: 0, avg7d: 10, total: 10 }])) };
    await insertPulse({ asset: ASSET, date: today, generatedAt: envelope.generatedAt, receivedAt: envelope.generatedAt, capabilities: [], envelope });
    await expect(refreshAnomalies(env.STORE, ASSET, undefined, NOW)).rejects.toThrow('input_limit');
    expect(await pgCount('SELECT count(*) AS n FROM noticeos.job_runs')).toBe(0);
  });

  it('keeps colliding asset histories, plans and writes inside their selected workspace', async () => {
    await seed();
    const id = await env.STORE.workspaceId();
    const other = '00000000-0000-4000-8000-000000000098';
    await asOwner(`INSERT INTO noticeos.workspaces (workspace_id,slug,display_name) VALUES ('${other}','count-refresh-other','Other');
      INSERT INTO noticeos.assets (workspace_id,asset_id,display_name,status,list_position) VALUES ('${other}','${ASSET}','Other','live',1);
      INSERT INTO noticeos.config_documents (workspace_id,document_key,body,version,updated_at,updated_by)
        SELECT '${other}',document_key,body,version,updated_at,updated_by FROM noticeos.config_documents WHERE workspace_id='${id}';
      INSERT INTO noticeos.pulses (workspace_id,asset_id,pulse_date,revision,generated_at,received_at,capabilities,envelope)
        SELECT '${other}',asset_id,pulse_date,revision,generated_at,received_at,capabilities,
          jsonb_set(envelope::jsonb,'{metrics,signups,last24h}','50'::jsonb)::json FROM noticeos.pulses WHERE workspace_id='${id}';`);
    const own = openWorkspaceStore(env.POSTGRES.connectionString, { workspaceId: id });
    const scoped = openWorkspaceStore(env.POSTGRES.connectionString, { workspaceId: other });
    try {
      const ownPlan = await refreshAnomalies(own, ASSET, undefined, NOW);
      const otherPlan = await refreshAnomalies(scoped, ASSET, undefined, NOW);
      expect(ownPlan.create).toHaveLength(1); expect(otherPlan.create).toEqual([]);
      await expect(refreshAnomalies(own, ASSET, otherPlan.applyToken, NOW)).rejects.toThrow('stale_plan');
      await refreshAnomalies(own, ASSET, ownPlan.applyToken, NOW);
      expect(await scoped.read((tx) => tx.query('SELECT flag_id FROM noticeos.flags'))).toEqual([]);
      expect(await scoped.read((tx) => tx.query('SELECT job_run_id FROM noticeos.job_runs'))).toEqual([]);
    } finally {
      await scoped.close(); await own.close();
      await asOwner(`DELETE FROM noticeos.pulses WHERE workspace_id='${other}'; DELETE FROM noticeos.config_documents WHERE workspace_id='${other}';
        DELETE FROM noticeos.assets WHERE workspace_id='${other}'; DELETE FROM noticeos.workspace_counters WHERE workspace_id='${other}'; DELETE FROM noticeos.workspaces WHERE workspace_id='${other}';`);
    }
  });

  it('uses the existing operator route, refusing unauthenticated or unbounded scope requests', async () => {
    const request = (body: unknown, token = OPERATOR_TOKEN) => new Request('https://ingest.local/api/anomaly-refresh', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    expect((await call(request({ asset: ASSET }, 'wrong'))).status).toBe(401);
    for (const body of [{}, { asset: ASSET, all: true }, { asset: ASSET, apply: true }, { asset: ASSET, pad: 'x'.repeat(5000) }]) expect((await call(request(body))).status).toBe(400);
    await seed(0, Date.now());
    const result = await call(request({ asset: ASSET }));
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.job_runs`)).toBe(0);
  });
});
