import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CONSTRAINTS_PATH,
  MATRIX_END,
  MATRIX_START,
  constraintsMarkdown,
  consumersMarkdown,
  findConsumers,
  matrixMarkdown,
  nullableIdentityColumns,
  readCatalog,
} from './postgres-docs.mjs';
import {
  MODEL_DIR,
  PROOF_WORKSPACES,
  PostgresUnavailable,
  createWorkspace,
  inWorkspace,
  migrationFiles,
  withDisposablePostgres,
} from './postgres-dev.mjs';
import { FROZEN_MIGRATIONS, applyMigrations, frozenMigrationProblems } from './postgres-migrate.mjs';

// THE POSTGRES MODEL AND ITS ISOLATION HOLD (ro-ujb9.76.81).
// Static proofs compare model.json with the complete migration set, frozen
// hashes, generated docs, capacity joins and retention/NULL identity rules.
// Disposable Postgres proofs retain the full schema, permission, row-security,
// numeric, trigger, constraint and concurrent workspace-numbering checks.
// No source database, legacy schema or installation folder is required.

const definition = JSON.parse(readFileSync(path.join(MODEL_DIR, 'model.json'), 'utf8'));
const migrations = migrationFiles();
const schemaSql = migrations.map((file) => readFileSync(file, 'utf8')).join('\n');

/** The top-level statements that shape noticeos tables and views, in order. */
const SHAPING = new RegExp(
  [
    String.raw`^CREATE TABLE (?:IF NOT EXISTS )?noticeos\.(?<created>[a-z_]+) \(\n(?<body>[\s\S]*?)\n\);$`,
    String.raw`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?noticeos\.(?<altered>[a-z_]+)\s+(?<actions>[\s\S]*?);$`,
    String.raw`^DROP TABLE (?:IF EXISTS )?(?<dropped>noticeos\.[a-z_]+(?:,\s*noticeos\.[a-z_]+)*)`,
    String.raw`^CREATE (?:OR REPLACE )?VIEW noticeos\.(?<view>[a-z_]+)`,
    String.raw`^DROP VIEW (?:IF EXISTS )?noticeos\.(?<droppedView>[a-z_]+)`,
  ].join('|'),
  'gmu',
);

/** An ALTER TABLE's actions, split at the commas outside parentheses. */
function alterActions(text) {
  const actions = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') depth -= 1;
    else if (text[i] === ',' && depth === 0) {
      actions.push(text.slice(start, i));
      start = i + 1;
    }
  }
  actions.push(text.slice(start));
  return actions.map((action) => action.replace(/\s+/gu, ' ').trim());
}

/**
 * `{ tables: { name: [columns] }, views: [names] }`: the schema the whole
 * migration set produces, read statement by statement in order — CREATE
 * TABLE, ALTER TABLE's ADD, DROP and RENAME of a column or the table, DROP
 * TABLE, and CREATE or DROP VIEW (bead ro-ujb9.76.20). Other actions (a
 * constraint, row security) change no column. The live proof compares this
 * reading with what Postgres built, so a form it cannot read fails there.
 */
function modelSchema(sql) {
  const tables = {};
  const views = [];
  const name = '([a-z_][a-z0-9_]*)';
  for (const { groups: g } of sql.matchAll(SHAPING)) {
    if (g.created) {
      tables[g.created] = [...g.body.matchAll(/^ {2}([a-z_][a-z0-9_]*)\s+[a-z]/gmu)].map((column) => column[1]);
    } else if (g.altered) {
      let table = g.altered;
      for (const action of alterActions(g.actions)) {
        const columns = tables[table] ?? [];
        const added = new RegExp(`^ADD (?:COLUMN )?(?:IF NOT EXISTS )?(?!(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE)\\b)${name} `, 'u').exec(action);
        const dropped = new RegExp(`^DROP (?:COLUMN )?(?:IF EXISTS )?(?!CONSTRAINT\\b)${name}\\b`, 'u').exec(action);
        const renamedColumn = new RegExp(`^RENAME (?:COLUMN )?(?!TO\\b|CONSTRAINT\\b)${name} TO ${name}$`, 'u').exec(action);
        const renamedTable = new RegExp(`^RENAME TO ${name}$`, 'u').exec(action);
        if (added && !columns.includes(added[1])) tables[table] = [...columns, added[1]];
        else if (dropped) tables[table] = columns.filter((column) => column !== dropped[1]);
        else if (renamedColumn) tables[table] = columns.map((column) => (column === renamedColumn[1] ? renamedColumn[2] : column));
        else if (renamedTable) {
          tables[renamedTable[1]] = columns;
          delete tables[table];
          table = renamedTable[1];
        }
      }
    } else if (g.dropped) {
      for (const dropped of g.dropped.split(',')) delete tables[dropped.trim().replace(/^noticeos\./u, '')];
    } else if (g.view) {
      if (!views.includes(g.view)) views.push(g.view);
    } else if (g.droppedView && views.includes(g.droppedView)) {
      views.splice(views.indexOf(g.droppedView), 1);
    }
  }
  return { tables, views };
}

const model = modelSchema(schemaSql);

test('the capacity catalog names every operational table and valid arrival joins', () => {
  const catalog = JSON.parse(readFileSync(path.join(MODEL_DIR, 'tables.json'), 'utf8')).tables;
  assert.deepEqual(Object.keys(catalog).sort(), Object.keys(model.tables).sort());
  for (const [name, entry] of Object.entries(catalog)) {
    assert.ok(['history', 'state', 'cache'].includes(entry.shape), `${name}: unknown table shape`);
    if (entry.arrival === null) {
      assert.notEqual(entry.shape, 'history', `${name}: history needs an arrival stamp`);
      continue;
    }
    const parent = entry.arrivalVia;
    if (parent) {
      assert.ok(model.tables[name].includes(parent.column), `${name}.${parent.column} does not exist`);
      assert.ok(model.tables[parent.table]?.includes(parent.key), `${parent.table}.${parent.key} does not exist`);
      assert.ok(model.tables[parent.table].includes('workspace_id'), `${name}: arrival join must be workspace scoped`);
    }
    assert.ok(model.tables[parent?.table ?? name].includes(entry.arrival), `${name}: arrival stamp does not exist`);
  }
});

test('every table and view in the model has its revision rule, over columns it really has', () => {
  const declared = Object.keys(definition.targets).sort();
  assert.deepEqual(declared, [...Object.keys(model.tables), ...model.views].sort());
  for (const [name, target] of Object.entries(definition.targets)) {
    if (target.view) {
      assert.ok(model.views.includes(name), `${name} is declared a view`);
      continue;
    }
    const { insert, update, delete: remove } = target.revision;
    assert.equal(typeof insert, 'boolean', `${name}: insert`);
    assert.equal(typeof remove, 'boolean', `${name}: delete`);
    assert.ok(update === 'all' || Array.isArray(update), `${name}: update is "all" or a column list`);
    if (Array.isArray(update)) {
      for (const column of update) assert.ok(model.tables[name].includes(column), `${name}.${column} is not a column`);
    }
    assert.ok(model.tables[name].includes('workspace_id'), `${name}: every table carries workspace_id (D27)`);
  }
});

test('the README matrix is the one model.json generates', () => {
  const readme = readFileSync(path.join(MODEL_DIR, 'README.md'), 'utf8');
  const block = readme.slice(readme.indexOf(MATRIX_START) + MATRIX_START.length, readme.indexOf(MATRIX_END)).trim();
  assert.equal(block, matrixMarkdown(definition), 'run: node scripts/postgres-docs.mjs --write');
});

test('consumers.md lists every file that names each Postgres table or view today (ro-ujb9.76.23)', () => {
  // A stale inventory can hide a current reader or writer of a table.
  assert.equal(
    readFileSync(path.join(MODEL_DIR, 'consumers.md'), 'utf8'),
    consumersMarkdown(findConsumers()),
    'db/postgres/consumers.md is stale: run node scripts/postgres-docs.mjs --write',
  );
});

test('the consumer inventory needs only the Postgres model and distinguishes exact qualified names', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'noticeos-consumers-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file, text) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  put('db/postgres/model.json', JSON.stringify({
    targets: { assets: {}, current_pulses: { view: true } },
    reference: { _rule: 'shared vocabulary', integrations: {} },
  }));
  put('workers/ingest/src/store.ts', `SELECT * FROM noticeos.assets;
SELECT * FROM "noticeos" . "current_pulses";
INSERT INTO noticeos_ref.integrations VALUES (1);`);
  put('scripts/consumer.test.mjs', 'UPDATE noticeos.assets SET status = $1;');
  put('packages/store/unrelated.ts', 'SELECT * FROM assets; SELECT * FROM noticeos.assets_extra;');
  put('scripts/generated.mts', 'SELECT * FROM noticeos.current_pulses;');
  put('scripts/generated.mjs', 'SELECT * FROM noticeos.assets;');
  assert.equal(existsSync(path.join(root, 'db/migrations')), false);
  assert.equal(existsSync(path.join(root, 'installation')), false);
  assert.deepEqual(findConsumers(root), {
    'noticeos.assets': { runtime: ['workers/ingest/src/store.ts'], tests: ['scripts/consumer.test.mjs'] },
    'noticeos.current_pulses': { runtime: ['workers/ingest/src/store.ts', 'scripts/generated.mts'], tests: [] },
    'noticeos_ref.integrations': { runtime: ['workers/ingest/src/store.ts'], tests: [] },
  });
});

test('the Postgres migrations are numbered without gaps and hold plain SQL only', () => {
  assert.ok(migrations.length >= 1, 'db/postgres/migrations/ holds the baseline');
  migrations.forEach((file, index) => {
    const name = path.basename(file);
    assert.equal(name.slice(0, 4), String(index + 1).padStart(4, '0'), `${name}: numbered in order from 0001`);
    const sql = readFileSync(file, 'utf8');
    // The runner owns the transaction; a psql command would tie the migration to one client.
    assert.doesNotMatch(sql, /^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\s*;/imu, `${name}: no transaction control`);
    assert.doesNotMatch(sql, /^\s*\\/mu, `${name}: no psql commands`);
  });
  assert.match(path.basename(migrations[0]), /^0001_baseline\.sql$/u);
});

test('a frozen migration never changes: every file frozen-migrations.sha256 lists keeps the hash recorded there', () => {
  // Empty or absent: no kept development database has applied the migrations yet (ro-ujb9.76.20).
  const marker = existsSync(FROZEN_MIGRATIONS) ? readFileSync(FROZEN_MIGRATIONS, 'utf8') : '';
  assert.deepEqual(frozenMigrationProblems(marker), [], 'db/postgres/README.md "Changing the schema" says what to do');
});

test("the reading of the migrations follows a later migration's ALTER, RENAME and DROP", () => {
  const read = modelSchema(`CREATE TABLE noticeos.first (
  workspace_id uuid NOT NULL,
  a            numeric(14,6),
  b            text,
  PRIMARY KEY (workspace_id)
);
CREATE TABLE noticeos.second (
  workspace_id uuid NOT NULL
);
CREATE VIEW noticeos.first_view WITH (security_invoker = true) AS SELECT 1;
ALTER TABLE noticeos.first ADD COLUMN c numeric(14,6) CHECK (c IN (1, 2)), DROP COLUMN a,
  ADD CONSTRAINT first_c CHECK (c > 0);
ALTER TABLE noticeos.first RENAME COLUMN b TO body;
ALTER TABLE noticeos.first ENABLE ROW LEVEL SECURITY;
ALTER TABLE noticeos.first RENAME TO renamed;
DROP TABLE noticeos.second;
DROP VIEW noticeos.first_view;
CREATE VIEW noticeos.later_view WITH (security_invoker = true) AS SELECT 1;
`);
  assert.deepEqual(read, { tables: { renamed: ['workspace_id', 'body', 'c'] }, views: ['later_view'] });
});

/** The retention entries (`_rule` aside), and those a trigger guards: moved to a dataset, dated by a column. */
const retention = Object.fromEntries(Object.entries(definition.retention).filter(([key]) => !key.startsWith('_')));
const guarded = Object.fromEntries(
  Object.entries(retention).filter(([, rule]) => rule.by && /^dataset /u.test(rule.beyond)),
);

test('retention names real tables and the columns that date them, and maintenance inserts only where it records', () => {
  for (const [table, rule] of Object.entries(retention)) {
    assert.ok(model.tables[table], `retention.${table} is not a table`);
    assert.ok(rule.keep && rule.beyond, `retention.${table}: say what stays and where the rest goes`);
    if (rule.by) assert.ok(model.tables[table].includes(rule.by), `retention.${table}.by: ${rule.by} is not a column`);
    if (rule.by) assert.match(rule.keep, /^\d+ (days|months)$/u, `retention.${table}.keep is an interval`);
  }
  assert.ok(Object.keys(guarded).length > 0, 'some history moves to the analytical store');
  for (const table of definition.maintenance.insert) assert.ok(model.tables[table], `maintenance.insert: ${table} is not a table`);
  assert.ok(definition.maintenance._rule && definition.reference._rule, 'maintenance and reference say what they are');
});

test('a site keeps as many insight snapshots as the Tower reads: the store, the model and the capacity count agree (ro-ujb9.76.17)', () => {
  const repo = path.resolve(MODEL_DIR, '..', '..');
  const lastNumber = (text, pattern, where) => {
    const found = [...text.matchAll(pattern)].at(-1)?.[1];
    assert.ok(found, `${where}: not found`);
    return Number(found);
  };
  const feed = readFileSync(path.join(repo, 'apps', 'tower', 'worker', 'wall-feed.ts'), 'utf8');
  const towerReads = lastNumber(feed, /export const FEED_INSIGHTS_SQL = `[^`]*?LIMIT (\d+)\)[^`]*`/gu, "the Wall feed's FEED_INSIGHTS_SQL");
  const capacity = readFileSync(path.join(repo, 'workers', 'ingest', 'src', 'capacity.ts'), 'utf8');
  const keep = /^each site's (two|[1-9][0-9]*) newest$/u.exec(definition.retention.asset_insight_snapshots.keep);
  assert.ok(keep, 'the model states an explicit insight snapshot count');
  const modelKeeps = keep[1] === 'two' ? 2 : Number(keep[1]);
  assert.deepEqual(
    {
      storeKeeps: lastNumber(schemaSql, /FUNCTION noticeos\.insight_snapshot_is_kept\([\s\S]*?LIMIT (\d+)\)/gu, 'noticeos.insight_snapshot_is_kept'),
      modelKeeps,
      capacityCountsRead: lastNumber(capacity, /const SNAPSHOTS_READ_PER_SITE = (\d+);/gu, 'SNAPSHOTS_READ_PER_SITE'),
    },
    { storeKeeps: towerReads, modelKeeps: towerReads, capacityCountsRead: towerReads },
  );
});

test('model.json decides what every NULL in a key or a link means, in its own words', () => {
  const { _rule: rule, ...decisions } = definition.nullIdentity;
  assert.ok(rule, 'nullIdentity states its vocabulary');
  for (const [column, decision] of Object.entries(decisions)) {
    const [table, name] = column.split('.');
    assert.ok(model.tables[table]?.includes(name), `${column} is not a column`);
    assert.ok(decision.means, `${column}: say what its NULL means`);
    if ('unique' in decision) assert.ok(['one', 'many', 'excluded'].includes(decision.unique), `${column}: unique is one, many or excluded`);
  }
});

/**
 * The whole proof on one throwaway cluster: the runner applies the migrations
 * (and creates the two roles), then the fixture fills every table for both
 * workspaces as the owner, then the denial suite and the edge cases run.
 * Throws on the first failed assertion (psql ON_ERROR_STOP).
 */
function loadModelProof(dev) {
  applyMigrations(dev);
  const script = path.join(dev.socketDir, 'proof.sql');
  const lines = ['SET ROLE noticeos_owner;'];
  for (const { ws, slug, site } of PROOF_WORKSPACES) {
    lines.push(`\\set ws '${ws}'`, `\\set slug ${slug}`, `\\set site ${site}`, `\\i '${path.join(MODEL_DIR, 'tests', 'fixture.sql')}'`);
  }
  lines.push(
    'RESET ROLE;',
    `\\i '${path.join(MODEL_DIR, 'tests', 'rls-denial.sql')}'`,
    `\\i '${path.join(MODEL_DIR, 'tests', 'edge-cases.sql')}'`,
    '',
  );
  writeFileSync(script, lines.join('\n'));
  dev.psql(null, { file: script });
}

/** What Postgres built in schema noticeos, in modelSchema's shape (views sorted). */
function builtSchema(psql) {
  const rows = psql(
    `SELECT c.relkind::text || ':' || c.relname || ':' || string_agg(a.attname, ',' ORDER BY a.attnum)
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = 'noticeos' AND c.relkind IN ('r', 'v')
      GROUP BY c.relkind, c.relname ORDER BY c.relname`,
  )
    .trim()
    .split('\n')
    .map((line) => line.split(':'));
  return {
    tables: Object.fromEntries(rows.filter(([kind]) => kind === 'r').map(([, name, columns]) => [name, columns.split(',')])),
    views: rows.filter(([kind]) => kind === 'v').map(([, name]) => name),
  };
}

const sortedViews = ({ tables, views }) => ({ tables, views: [...views].sort() });

/** Run `fn` against Postgres, or skip with the reason where none can start
 * (a failure where NOTICEOS_REQUIRE_POSTGRES=1). */
async function live(t, fn) {
  try {
    await fn();
  } catch (error) {
    if (error instanceof PostgresUnavailable && process.env.NOTICEOS_REQUIRE_POSTGRES !== '1') {
      t.skip(error.message);
      return;
    }
    throw error;
  }
}

test("on a disposable Postgres: a later migration's changes are read the way Postgres builds them", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nos-later-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const file of migrations) copyFileSync(file, path.join(dir, path.basename(file)));
  const next = String(migrations.length + 1).padStart(4, '0');
  writeFileSync(
    path.join(dir, `${next}_later.sql`),
    `ALTER TABLE noticeos.annotations ADD COLUMN source text CHECK (source IN ('a', 'b')), DROP COLUMN ref;
ALTER TABLE noticeos.annotations RENAME COLUMN note TO body;
CREATE TABLE noticeos.example_later (
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces,
  example_id   bigint GENERATED ALWAYS AS IDENTITY,
  amount       numeric(14,6),
  PRIMARY KEY (workspace_id, example_id)
);
ALTER TABLE noticeos.example_later ENABLE ROW LEVEL SECURITY;
ALTER TABLE noticeos.example_later RENAME TO example_renamed;
CREATE VIEW noticeos.example_view WITH (security_invoker = true) AS SELECT workspace_id FROM noticeos.example_renamed;
DROP TABLE noticeos.counter_readings;
`,
  );
  await live(t, () =>
    withDisposablePostgres(async (dev) => {
      assert.equal(applyMigrations(dev, { dir }).applied.at(-1), `${next}_later`);
      const read = modelSchema(migrationFiles(dir).map((file) => readFileSync(file, 'utf8')).join('\n'));
      assert.deepEqual(read.tables.annotations, ['workspace_id', 'annotation_id', 'annotation_number', 'asset_id', 'at', 'kind', 'body', 'created_at', 'source']);
      assert.equal('counter_readings' in read.tables, false);
      assert.deepEqual(builtSchema(dev.psql), sortedViews(read));
    }),
  );
});

test('on a disposable Postgres: the migrations apply, D27 isolation holds, edge cases keep their outcomes, privileges equal the revision rules', async (t) => {
  await live(t, () =>
    withDisposablePostgres(async (dev) => {
      const { psql } = dev;
      loadModelProof(dev);

      // The static reading of the migrations is what Postgres built: the same
      // tables with the same columns in order, and the same views.
      assert.deepEqual(builtSchema(psql), sortedViews(model), "the migrations' reading disagrees with Postgres");

      // The application role's privileges are exactly the revision rules.
      const tablePrivileges = new Map(
        psql(
          `SELECT c.relname || ':' || concat_ws(',',
                    has_table_privilege('noticeos_app', c.oid, 'SELECT'),
                    has_table_privilege('noticeos_app', c.oid, 'INSERT'),
                    has_table_privilege('noticeos_app', c.oid, 'UPDATE'),
                    has_table_privilege('noticeos_app', c.oid, 'DELETE'))
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'noticeos' AND c.relkind IN ('r', 'v')`,
        )
          .trim()
          .split('\n')
          .map((line) => {
            const [name, flags] = line.split(':');
            const [select, insert, update, remove] = flags.split(',').map((flag) => flag === 't');
            return [name, { select, insert, update, remove }];
          }),
      );
      const columnUpdates = new Set(
        psql(
          `SELECT table_name || '.' || column_name FROM information_schema.columns
            WHERE table_schema = 'noticeos'
              AND has_column_privilege('noticeos_app', 'noticeos.' || quote_ident(table_name), column_name, 'UPDATE')`,
        )
          .trim()
          .split('\n')
          .filter(Boolean),
      );
      assert.deepEqual([...tablePrivileges.keys()].sort(), Object.keys(definition.targets).sort());
      for (const [name, target] of Object.entries(definition.targets)) {
        const has = tablePrivileges.get(name);
        assert.equal(has.select, true, `${name}: the application reads it`);
        if (target.view) {
          assert.deepEqual([has.insert, has.update, has.remove], [false, false, false], `${name}: a view is read-only`);
          continue;
        }
        const { insert, update, delete: remove } = target.revision;
        assert.equal(has.insert, insert, `${name}: INSERT privilege`);
        assert.equal(has.remove, remove, `${name}: DELETE privilege`);
        assert.equal(has.update, update === 'all', `${name}: table-wide UPDATE privilege`);
        for (const column of model.tables[name]) {
          const allowed = update === 'all' || update.includes(column);
          assert.equal(columnUpdates.has(`${name}.${column}`), allowed, `${name}.${column}: UPDATE privilege`);
        }
      }

      // The maintenance role (REVIEW.md item 3): reads every table, removes
      // rows only where retention lets them go, inserts only its records of
      // moves and exports, changes nothing.
      const privilegesOf = (role, schema) =>
        new Map(
          psql(
            `SELECT c.relname || ':' || concat_ws(',',
                      has_table_privilege('${role}', c.oid, 'SELECT'),
                      has_table_privilege('${role}', c.oid, 'INSERT'),
                      has_table_privilege('${role}', c.oid, 'UPDATE'),
                      has_table_privilege('${role}', c.oid, 'DELETE'))
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = '${schema}' AND c.relkind IN ('r', 'v')`,
          )
            .trim()
            .split('\n')
            .map((line) => {
              const [name, flags] = line.split(':');
              const [select, insert, update, remove] = flags.split(',').map((flag) => flag === 't');
              return [name, { select, insert, update, remove }];
            }),
        );
      for (const [name, has] of privilegesOf('noticeos_maint', 'noticeos')) {
        assert.equal(has.select, true, `noticeos_maint reads ${name}`);
        assert.equal(has.update, false, `noticeos_maint changes nothing in ${name}`);
        assert.equal(has.remove, name in retention, `${name}: noticeos_maint DELETE follows model.json retention`);
        assert.equal(has.insert, definition.maintenance.insert.includes(name), `${name}: noticeos_maint INSERT follows model.json maintenance`);
      }
      const maintColumnUpdates = psql(
        `SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'noticeos'
            AND has_column_privilege('noticeos_maint', 'noticeos.' || quote_ident(table_name), column_name, 'UPDATE')`,
      ).trim();
      assert.equal(maintColumnUpdates, '0', 'noticeos_maint may update no column');

      // The capacity readback runs as noticeos_maint (REVIEW.md
      // "Observability"): every table's size and live-row estimate come from
      // pg_total_relation_size and pg_stat_user_tables, exact and free, with
      // no grant beyond the model's.
      const capacity = psql(
        `SET ROLE noticeos_maint;
         SELECT count(*) FILTER (WHERE pg_total_relation_size(c.oid) > 0 AND s.n_live_tup IS NOT NULL) || '/' || count(*)
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
          WHERE n.nspname = 'noticeos' AND c.relkind = 'r'`,
      ).trim();
      const tableCount = Object.keys(model.tables).length;
      assert.equal(capacity, `${tableCount}/${tableCount}`, 'noticeos_maint reads every table\'s size and row estimate');

      // The shared vocabulary (REVIEW.md item 1): read by both, written by neither.
      const reference = [...privilegesOf('noticeos_app', 'noticeos_ref')];
      assert.deepEqual(reference.map(([name]) => name).sort(), ['check_kinds', 'integrations', 'metric_kinds']);
      for (const role of ['noticeos_app', 'noticeos_maint']) {
        for (const [name, has] of privilegesOf(role, 'noticeos_ref')) {
          assert.deepEqual(has, { select: true, insert: false, update: false, remove: false }, `${role} on noticeos_ref.${name}`);
        }
      }

      // Retention (REVIEW.md item 4): the guard trigger's day column and window
      // are exactly the ones model.json states, on exactly those tables.
      const guards = Object.fromEntries(
        psql(
          `SELECT c.relname || ':' || encode(t.tgargs, 'escape')
             FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
            WHERE t.tgname = 'history_leaves_only_when_exported'`,
        )
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [table, args] = line.split(':');
            const [by, keep] = args.split('\\000');
            return [table, { by, keep }];
          }),
      );
      assert.deepEqual(
        guards,
        Object.fromEntries(Object.entries(guarded).map(([table, rule]) => [table, { by: rule.by, keep: rule.keep }])),
        'history_leaves_only_when_exported guards exactly the tables model.json retention moves to a dataset',
      );

      // Every NULL a key or a link can hold is a decided one, and the decision
      // names what Postgres enforces (ro-ujb9.71).
      const catalog = readCatalog(psql);
      const { _rule: _vocabulary, ...decided } = definition.nullIdentity;
      const enforced = nullableIdentityColumns(catalog);
      assert.deepEqual(Object.keys(decided).sort(), Object.keys(enforced).sort(), 'model.json nullIdentity lists exactly these columns');
      for (const [column, { unique }] of Object.entries(enforced)) {
        assert.equal(decided[column].unique, unique, `${column}: its unique-key NULL semantics`);
      }

      // Every fractional number in the model refuses NaN and both infinities,
      // by its type or by a check on that column alone (ro-ujb9.76.46): numeric
      // holds 'NaN' at any declared precision, and 'NaN' >= 0 and
      // 'Infinity' >= 0 are true, so a range check alone lets them through.
      const probed = psql(
        `CREATE FUNCTION pg_temp.admits(col name, typ text, checks text[], candidate text) RETURNS boolean
         LANGUAGE plpgsql AS $probe$
         DECLARE expression text; passes boolean;
         BEGIN
           BEGIN
             EXECUTE format('SELECT %L::%s', candidate, typ);
           EXCEPTION WHEN numeric_value_out_of_range THEN RETURN false;
           END;
           FOREACH expression IN ARRAY checks LOOP
             EXECUTE format('SELECT %s FROM (SELECT %L::%s AS %I) AS probe', expression, candidate, typ, col) INTO passes;
             IF passes IS FALSE THEN RETURN false; END IF;
           END LOOP;
           RETURN true;
         END $probe$;
         SELECT c.relname || '.' || a.attname || ':' || candidate || ':' ||
                pg_temp.admits(a.attname, format_type(a.atttypid, a.atttypmod),
                  ARRAY(SELECT pg_get_expr(k.conbin, k.conrelid) FROM pg_constraint k
                         WHERE k.conrelid = c.oid AND k.contype = 'c' AND k.conkey = ARRAY[a.attnum]),
                  candidate)
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN unnest(ARRAY['NaN', 'Infinity', '-Infinity']) AS candidate
          WHERE n.nspname IN ('noticeos', 'noticeos_ref') AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
            AND a.atttypid IN ('numeric'::regtype, 'double precision'::regtype, 'real'::regtype)
          ORDER BY 1`,
      )
        .trim()
        .split('\n')
        .map((line) => line.split(':'));
      const probedColumns = new Set(probed.map(([column]) => column));
      for (const known of ['archive_runs.cost_usd', 'research_log.cost_usd', 'alert_daily_counts.median_open_age_hours']) {
        assert.ok(probedColumns.has(known), `the probe reached ${known}`);
      }
      assert.deepEqual(
        probed.filter(([, , admits]) => admits === 't').map(([column, candidate]) => `${column} admits ${candidate}`),
        [],
        'a fractional column stores NaN or an infinity',
      );

      // The constraint matrix is what Postgres built.
      assert.equal(
        readFileSync(CONSTRAINTS_PATH, 'utf8'),
        constraintsMarkdown(catalog),
        'db/postgres/constraints.md is stale: run node scripts/postgres-docs.mjs --write',
      );
    }),
  );
});

/** `probe()` once it is truthy, polled every 20 ms for at most `ms`; null past that. */
async function eventually(probe, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value || Date.now() >= deadline) return value || null;
    await delay(20);
  }
}

/**
 * A psql session held open on `dev`, fed one line at a time. `mark(name)`
 * queues `\echo name`; `printed(name)` waits until the session reaches it
 * (everything sent before it has run) and returns what it printed since the
 * previous mark; `reached(name)` says whether it has, without waiting.
 */
function psqlSession(dev) {
  const child = dev.spawnInteractive();
  let out = '';
  let err = '';
  let cursor = 0;
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  child.stderr.on('data', (chunk) => {
    err += chunk;
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const reached = (name) => out.includes(`${name}\n`);
  return {
    send: (sql) => child.stdin.write(`${sql}\n`),
    mark: (name) => child.stdin.write(`\\echo ${name}\n`),
    reached,
    async printed(name) {
      await eventually(() => reached(name) || child.exitCode !== null);
      if (!reached(name)) throw new Error(`psql never reached ${name}: ${err.trim() || out.trim()}`);
      const end = out.indexOf(`${name}\n`);
      const text = out.slice(cursor, end).trim();
      cursor = end + name.length + 1;
      return text;
    },
    end() {
      child.stdin.end();
      return exited;
    },
    kill() {
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

test("on a disposable Postgres: each workspace numbers the rows readers show from 1, never counting another's, and writers numbering at once never share a number", async (t) => {
  await live(t, () =>
    withDisposablePostgres(async (dev) => {
      applyMigrations(dev);
      const [a, b, c] = ['a', 'b', 'c'].map((slug) => createWorkspace(dev, { slug }));
      for (const ws of [a, b, c]) {
        inWorkspace(
          dev,
          ws,
          "INSERT INTO noticeos.assets (workspace_id, asset_id, display_name, status) VALUES (:'workspace_id'::uuid, 'site.example', 'Site', 'live')",
        );
      }
      const annotate = (ws, count) =>
        inWorkspace(
          dev,
          ws,
          `INSERT INTO noticeos.annotations (workspace_id, asset_id, at, kind)
           SELECT :'workspace_id'::uuid, 'site.example', now(), 'deploy' FROM generate_series(1, :'count'::int)`,
          { vars: { count } },
        );
      const column = (ws, name) =>
        inWorkspace(dev, ws, null, { read: `SELECT ${name} FROM noticeos.annotations ORDER BY ${name}` }).map((row) => Number(row[name]));

      // Two workspaces, writing in turn through the application's transaction.
      annotate(a, 3);
      annotate(b, 2);
      annotate(a, 1);
      assert.deepEqual(column(a, 'annotation_number'), [1, 2, 3, 4]);
      assert.deepEqual(column(b, 'annotation_number'), [1, 2], "B's numbers do not count A's writes");
      assert.deepEqual(column(b, 'annotation_id'), [4, 5], 'while the identity underneath is one sequence for both');
      assert.deepEqual(
        inWorkspace(dev, b, null, { read: 'SELECT counter, last_number FROM noticeos.workspace_counters ORDER BY counter' }),
        [{ counter: 'annotation_number', last_number: '2' }, { counter: 'list_position', last_number: '1' }],
        'B sees its own counters (its one site took place 1) and no other',
      );

      // Two transactions numbering in one workspace at the same moment: the
      // second waits on the counter until the first ends, then takes the next
      // number, or the first's own number when the first rolled back.
      const opening = `BEGIN; SET LOCAL ROLE noticeos_app; SET LOCAL noticeos.workspace_id = '${c}';`;
      const insert =
        "INSERT INTO noticeos.annotations (workspace_id, asset_id, at, kind) VALUES (noticeos.current_workspace_id(), 'site.example', now(), 'deploy') RETURNING annotation_number;";
      const first = psqlSession(dev);
      const second = psqlSession(dev);
      t.after(() => {
        first.kill();
        second.kill();
      });
      const waiting = () => Number(dev.sql("SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock'")[0].n);
      let round = 0;
      const race = async (ending) => {
        round += 1;
        first.send(opening);
        first.send(insert);
        first.mark(`first-inserted-${round}`);
        const firstNumber = Number(await first.printed(`first-inserted-${round}`));
        second.send(opening);
        second.send(insert);
        second.mark(`second-inserted-${round}`);
        assert.ok(await eventually(() => waiting() >= 1), `round ${round}: the second writer waits for the first`);
        assert.equal(second.reached(`second-inserted-${round}`), false, `round ${round}: and holds no number yet`);
        first.send(`${ending};`);
        first.mark(`first-ended-${round}`);
        await first.printed(`first-ended-${round}`);
        const secondNumber = Number(await second.printed(`second-inserted-${round}`));
        second.send('COMMIT;');
        second.mark(`second-committed-${round}`);
        await second.printed(`second-committed-${round}`);
        return [firstNumber, secondNumber];
      };
      // The workspace's first numbers: neither transaction finds a counter yet.
      assert.deepEqual(await race('COMMIT'), [1, 2], 'the second writer gets the next number once the first commits');
      assert.deepEqual(await race('ROLLBACK'), [3, 3], 'a rolled-back number goes to the writer that waited');
      assert.deepEqual(await Promise.all([first.end(), second.end()]), [0, 0]);
      assert.deepEqual(column(c, 'annotation_number'), [1, 2, 3]);

      // Three sessions, ten transactions each, all at once: every number once, none skipped.
      const burst = [1, 2, 3].map(() => {
        const child = dev.spawnInteractive();
        child.stdout.resume();
        child.stderr.resume();
        const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
        child.stdin.end(`${Array.from({ length: 10 }, () => `${opening}\n${insert}\nCOMMIT;`).join('\n')}\n`);
        return exited;
      });
      assert.deepEqual(await Promise.all(burst), [0, 0, 0]);
      assert.deepEqual(column(c, 'annotation_number'), Array.from({ length: 33 }, (_, i) => i + 1));
      assert.deepEqual(column(a, 'annotation_number'), [1, 2, 3, 4], "C's writers moved nothing of A's");
    }),
  );
});
