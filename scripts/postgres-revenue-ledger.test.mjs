import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findPostgres } from './postgres-dev.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';
import { applyMigrations } from './postgres-migrate.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { openStore } from '../packages/postgres/src/store.mjs';

// Migration 0015: a store that saved Mediavine days before the revenue ledger
// keeps every one of them in it, in order, under the numbers readers were
// shown, and its months read the same from financial_ledger.

const MONTHS_SQL = `SELECT asset_id, to_char(period_month, 'YYYY-MM') AS period, entry_number::text AS number,
       amount_minor::text AS amount, source, booking_state
  FROM noticeos.financial_ledger WHERE kind = 'revenue' ORDER BY workspace_id, asset_id, period_month, source`;

/** One workspace's site, its Mediavine mapping, `days` saved by one run and a
 * re-fetch of the first day, as a release before the ledger wrote them. */
function savedBeforeTheLedger(owner, workspace, slug, days) {
  const day = (offset) => `'2026-08-01'::date + ${offset}`;
  owner.sql(`BEGIN;
    SELECT set_config('noticeos.workspace_id', '${workspace}', true);
    INSERT INTO noticeos.workspaces (workspace_id, slug, display_name, status) VALUES ('${workspace}', '${slug}', '${slug}', 'active');
    INSERT INTO noticeos.assets (workspace_id, asset_id, domain, display_name, status)
      VALUES ('${workspace}', '${slug}.example', '${slug}.example', '${slug}', 'live');
    INSERT INTO noticeos.mediavine_sites (workspace_id, site_id, asset_id) VALUES ('${workspace}', 'mv-${slug}', '${slug}.example');
    INSERT INTO noticeos.mediavine_runs (workspace_id, run_id, asset_id, site_id, start_date, end_date, attempted_at, outcome)
      VALUES ('${workspace}', 'run-${slug}-1', '${slug}.example', 'mv-${slug}', ${day(0)}, ${day(days - 1)}, now(), 'success'),
             ('${workspace}', 'run-${slug}-2', '${slug}.example', 'mv-${slug}', ${day(0)}, ${day(0)}, now(), 'success');
    INSERT INTO noticeos.mediavine_daily (workspace_id, run_seq, asset_id, site_id, report_date, amount_minor, recorded_at)
      SELECT '${workspace}', r.run_seq, '${slug}.example', 'mv-${slug}', ${day('n')}, 100 + n, now()
        FROM noticeos.mediavine_runs r, generate_series(0, ${days - 1}) AS n WHERE r.run_id = 'run-${slug}-1' ORDER BY n;
    INSERT INTO noticeos.mediavine_daily (workspace_id, run_seq, asset_id, site_id, report_date, amount_minor, recorded_at)
      SELECT '${workspace}', run_seq, '${slug}.example', 'mv-${slug}', ${day(0)}, 999, now()
        FROM noticeos.mediavine_runs WHERE run_id = 'run-${slug}-2';
    COMMIT;`);
}

/** One read as the store's owner role, which row security binds, inside the
 * named workspace. */
const inWorkspace = (owner, workspace, sql) => owner.script(`BEGIN;
SET LOCAL ROLE noticeos_owner;
\\o /dev/null
SELECT set_config('noticeos.workspace_id', '${workspace}', true);
\\o
${sql};
COMMIT;
`);

test('the revenue ledger keeps every Mediavine day an existing store saved, and its months read the same', { timeout: 90000 }, async t => {
  const tools = findPostgres();
  const root = mkdtempSync(path.join(os.tmpdir(), 'n-revenue-ledger-'));
  let owner, store, primaryError;
  try {
    owner = await skipWithoutPostgres(t, () => openOnLoopbackPort(path.join(root, 'pg'), tools)); if (!owner) return;
    const older = path.join(root, 'older'); mkdirSync(older);
    // The store as it was before the ledger: every migration numbered below it.
    for (const name of readdirSync(path.join(REPO_ROOT, 'db/postgres/migrations')).filter(name => name < '0015_')) {
      copyFileSync(path.join(REPO_ROOT, 'db/postgres/migrations', name), path.join(older, name));
    }
    applyMigrations(owner, { dir: older });
    const a = randomUUID(), b = randomUUID();
    savedBeforeTheLedger(owner, a, 'first', 31);
    savedBeforeTheLedger(owner, b, 'second', 3);
    const before = [a, b].flatMap(workspace => inWorkspace(owner, workspace, MONTHS_SQL));
    const daily = [a, b].map(workspace => inWorkspace(owner, workspace, `SELECT d.daily_number::text AS number, d.asset_id, d.site_id,
        d.report_date::text AS day, d.amount_minor::text AS amount, r.run_id
      FROM noticeos.mediavine_daily d JOIN noticeos.mediavine_runs r USING (workspace_id, run_seq) ORDER BY d.daily_id`));

    assert.equal(applyMigrations(owner).applied[0], '0015_revenue_ledger');

    // Every saved day, in each workspace, in the order it was written, under
    // the number readers were shown, naming the run that reported it.
    for (const [index, workspace] of [a, b].entries()) {
      const ledger = inWorkspace(owner, workspace, `SELECT observation_number::text AS number, asset_id, account_ref AS site_id,
          revenue_date::text AS day, amount_minor::text AS amount, run_ref AS run_id, source, currency, item_ref
        FROM noticeos.revenue_observations ORDER BY observation_id`);
      assert.deepEqual(ledger.map(({ source, currency, item_ref, ...row }) => row), daily[index]);
      assert.ok(ledger.every(row => row.source === 'mediavine-journey' && row.currency === 'USD' && row.item_ref === null));
    }
    // A re-fetched day is one current figure, the newest.
    const first = inWorkspace(owner, a, `SELECT amount_minor::text AS amount FROM noticeos.current_revenue WHERE revenue_date = '2026-08-01'`);
    assert.deepEqual(first, [{ amount: '999' }]);

    // Each month reads the same total, number and booking state; its source
    // is the one the ledger names it by.
    const after = [a, b].flatMap(workspace => inWorkspace(owner, workspace, MONTHS_SQL));
    assert.deepEqual(after, before);
    assert.ok(after.length === 2 && after.every(row => row.source === 'mediavine-journey'), JSON.stringify(after));

    // An older release still running after the migration writes Mediavine's
    // table; the day reaches the ledger as the application role writes it, and
    // the ledger's numbering continues past every number it kept.
    store = openStore(owner.applicationLogin().url());
    await store.inWorkspace(a, tx => tx.execute(`INSERT INTO noticeos.mediavine_daily
        (workspace_id, run_seq, asset_id, site_id, report_date, amount_minor, recorded_at)
      SELECT workspace_id, run_seq, asset_id, site_id, '2026-09-01', 4321, now()
        FROM noticeos.mediavine_runs WHERE run_id = 'run-first-2'`));
    const mirrored = await store.inWorkspace(a, tx => tx.query(`SELECT observation_number::int AS number, source, run_ref
      FROM noticeos.current_revenue WHERE revenue_date = '2026-09-01'`));
    assert.deepEqual(mirrored, [{ number: 33, source: 'mediavine-journey', run_ref: 'run-first-2' }]);
    // The other workspace saw none of it.
    assert.equal((await store.inWorkspace(b, tx => tx.query(`SELECT count(*)::int AS n FROM noticeos.revenue_observations
      WHERE revenue_date = '2026-09-01'`)))[0].n, 0);
  } catch (error) { primaryError = error; throw error; } finally {
    const failures = [];
    for (const cleanup of [() => store?.close(), () => owner?.close()]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (existsSync(path.join(root, 'pg/data/postmaster.pid'))) failures.push(new Error('Owned Postgres PID marker remains'));
    if (failures.length) throw new AggregateError(primaryError ? [primaryError, ...failures] : failures, 'Revenue ledger fixture retirement refused');
  }
});
