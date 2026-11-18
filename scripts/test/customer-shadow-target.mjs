import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as deadline } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from '../browser-request-policy.mjs';
import { EMAIL_CODE_PATHS } from '../identity-protocol.mjs';
import { applyMigrations, bootstrapWorkspace } from '../postgres-migrate.mjs';
import { journeyDefinitionId } from '../../packages/contract/src/journeys.mjs';

function command(script, args, input) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../' + script, import.meta.url)), ...args],
    { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  if (input !== undefined) child.stdin.end(input + '\n');
  const output = { stdout: '', stderr: '' };
  for (const key of Object.keys(output)) child[key].on('data', chunk => { output[key] += chunk; });
  const finished = once(child, 'close').then(([code, signal]) => ({ ...output, code, signal }));
  return { child, finished };
}

async function foreground(script, args, ready) {
  const run = command(script, args);
  const starting = new Promise(resolve => {
    let output = '';
    run.child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes(ready)) resolve(null);
    });
  });
  const failure = await Promise.race([starting, run.finished, deadline(40_000, 'Readiness timed out.', { ref: false })]);
  if (failure !== null) {
    run.child.kill('SIGTERM');
    await run.finished;
    assert.fail(typeof failure === 'string' ? failure : failure.stderr);
  }
  return async () => {
    run.child.kill('SIGTERM');
    const result = await run.finished;
    assert.equal(result.code, 0, result.stderr);
  };
}

/** Real worker, platform OTP, native local Ntasks, and a private offline dump. */
export async function assertCustomerShadowTarget({ root, cluster, ntasksOrigin, ntasks, availablePort, targetTest }) {
  const database = 'noticeos_shadow_chain_source';
  cluster.onDatabase('postgres').run('CREATE DATABASE noticeos_shadow_chain_source;');
  const source = cluster.onDatabase(database);
  applyMigrations(source);
  const workspaceId = randomUUID();
  const ownerEmail = 'chain-owner@example.test';
  const date = '2026-11-09';
  const at = date + 'T00:00:00Z';
  const day = new Date().toISOString().slice(0, 10);
  const ga4 = { id: 'signup', label: 'Saved signup journey', kind: 'funnel', status: 'active', goal: 'Create an account', version: 1,
    steps: [{ id: 'begin', label: 'Start', alternatives: [{ eventName: 'form_start' }] },
      { id: 'finish', label: 'Create account', alternatives: [{ eventName: 'sign_up' }] }] };
  const deleted = { ...ga4, id: 'oldSignup', label: 'Removed journey' };
  const firstParty = { ...ga4, id: 'orders', label: 'Saved checkout', source: 'first-party',
    steps: ga4.steps.map(step => ({ id: step.id, label: step.label, alternatives: [] })) };
  const propertyId = '123456';
  const snapshot = (asset, definitions) => JSON.stringify({ asset, journeys: {
    source: 'ga4', countingUnit: 'activeUsers', generatedAt: at, definitions,
    funnels: definitions.map(definition => ({ journeyId: definition.id, definitionId: journeyDefinitionId(definition),
      propertyId, timeZone: 'UTC', identity: 'ga4-active-users', collectedAt: at, prior7: null, current28: null, prior28: null, weekly: [],
      current7: { kind: 'current7', startDate: '2026-11-01', endDate: '2026-11-07', complete: true, quality: 'complete',
        steps: [{ id: 'begin', users: 100 }, { id: 'finish', users: 22 }] } })),
    exploration: { state: 'unsupported', reason: 'No session paths were collected.' },
  } });
  const snapshots = [['chain.example', [ga4, deleted]], ['empty.example', [deleted]], ['skipped.example', [ga4]]]
    .map(([asset, definitions]) => {
      const payload = snapshot(asset, definitions);
      return { asset, payload, sha: createHash('sha256').update(payload).digest('hex') };
    });
  const firstPartyFunnels = Array.from({ length: 21 }, (_, i) => ({
    schemaVersion: 1, source: 'first-party', journeyId: firstParty.id, journeyVersion: 1, definitionId: 'site-ordered-counts',
    date: new Date(Date.parse(day) - (i + 1) * 86400000).toISOString().slice(0, 10), timeZone: 'UTC', unit: 'orders',
    steps: [{ id: 'begin', count: 12 }, { id: 'finish', count: 4 }],
  }));
  bootstrapWorkspace(source, { workspaceId, slug: 'chain', displayName: 'Chain workspace' });
  source.run([
    'INSERT INTO noticeos.assets(workspace_id,asset_id,domain,display_name,status,list_position)',
    "  VALUES (:'workspace'::uuid,'chain.example','chain.example','Chain site','live',1),",
    "    (:'workspace'::uuid,'empty.example','empty.example','Empty site','live',2),",
    "    (:'workspace'::uuid,'skipped.example','skipped.example','Skipped site','live',3);",
    'INSERT INTO noticeos.pulses(workspace_id,pulse_number,asset_id,pulse_date,generated_at,received_at,capabilities,envelope)',
    "  VALUES (:'workspace'::uuid,1,'chain.example',:'day'::date,:'day'::timestamptz,:'day'::timestamptz,'[]',:'report'::json);",
    'INSERT INTO noticeos.asset_insight_snapshots(workspace_id,snapshot_id,asset_id,generated_at,window_start,window_end,source_archive_count,content_sha256,payload)',
    "  SELECT :'workspace'::uuid,'snapshot-' || item.asset,item.asset,:'at'::timestamptz,:'date'::date,:'date'::date,1,item.sha,item.payload::json",
    "  FROM json_to_recordset(:'snapshots'::json) AS item(asset text,sha text,payload text);",
    'INSERT INTO noticeos.signal_runs(workspace_id,run_id,asset_id,integration,credential_ref,property_ref,started_at,finished_at,status,window_start,window_end,data_state,provider_rows,observation_count)',
    "  VALUES (:'workspace'::uuid,'old-skipped-ga4','skipped.example','ga4','fixture-no-copy',:'property'::text,",
    "    :'at'::timestamptz,:'at'::timestamptz,'success',:'date'::date,:'date'::date,'final',0,0);",
    'INSERT INTO noticeos.config_documents(workspace_id,document_key,body,version,updated_at)',
    "  VALUES (:'workspace'::uuid,'value-events',:'valueEvents'::json,2,:'at'::timestamptz),",
    "    (:'workspace'::uuid,'integrations',:'integrations'::json,2,:'at'::timestamptz)",
    '  ON CONFLICT(workspace_id,document_key) DO UPDATE SET body=excluded.body,version=excluded.version;',
  ].join('\n'), { vars: { workspace: workspaceId, day, date, at, snapshots: JSON.stringify(snapshots), property: propertyId,
    report: JSON.stringify({ asset: 'chain.example', generatedAt: day + 'T00:00:00Z', capabilities: [], firstPartyFunnels }),
    valueEvents: JSON.stringify({ assets: {
      'chain.example': { journeys: [ga4, firstParty], valueEvents: ['fixture-no-copy'] },
      'empty.example': { journeys: [] }, 'skipped.example': { journeys: [ga4] },
      'missing.example': { journeys: [deleted] },
    } }),
    integrations: JSON.stringify({ assets: {
      'chain.example': { ga4: { status: 'active', propertyId, secret: 'fixture-no-copy' }, ntasks: { token: 'fixture-no-copy' } },
      'skipped.example': { ga4: { status: 'skipped', propertyId } },
    } }),
  } });
  const evidence = () => source.sql('SELECT (SELECT md5(json_agg(a)::text) FROM noticeos.assets a) AS assets, (SELECT md5(json_agg(p)::text) FROM noticeos.pulses p) AS pulses');
  const before = evidence();
  const dump = path.join(root, 'chain.dmp');
  execFileSync(path.join(path.dirname(cluster.tools.psql), 'pg_dump'), ['--format=custom', '--host', cluster.socketDir,
    '--port', String(cluster.loopbackPort), '--username', 'postgres', '--dbname', database, '--file', dump]);
  chmodSync(dump, 0o600);
  const bundle = path.join(root, 'operator-bundle');
  const prepared = path.join(root, 'operator-target');
  const planFile = path.join(root, 'operator-plan.json');
  const ntasksFile = path.join(root, 'operator-ntasks.json');
  const readOnlyFile = path.join(root, 'operator-ntasks-read-only.json');
  const receiptFile = path.join(prepared, 'shadow-target.json');
  const runtime = path.join(prepared, 'runtime.json');
  const outbox = path.join(prepared, 'mail');
  const attempt = (args, input) => command('customer-shadow-target.mjs', args, input).finished;
  const pass = async (args, input) => {
    const result = await attempt(args, input);
    assert.equal(result.code, 0, result.stderr);
  };
  const refuse = async (args, input) => assert.equal((await attempt(args, input)).code, 1);
  const receipt = () => JSON.parse(readFileSync(receiptFile, 'utf8'));
  const newestOtp = () => {
    const messages = readdirSync(outbox).map(name => JSON.parse(readFileSync(path.join(outbox, name), 'utf8')));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].to, ownerEmail);
    return messages[0].text.match(/\b(\d{6})\.$/u)[1];
  };

  const exported = await command('customer-shadow-export.mjs', ['--dump', dump, '--workspace', workspaceId, '--out', bundle]).finished;
  assert.equal(exported.code, 0, exported.stderr);
  const projected = readFileSync(path.join(bundle, 'settings.json'), 'utf8');
  assert.doesNotMatch(projected, /fixture-no-copy|missing\.example/u);
  const towerPort = await availablePort();
  const databasePort = await availablePort();
  const expectedPlan = { format: 'noticeos-shadow-plan-v1', bundle, workspaceId, ownerEmail, slug: 'chain',
    displayName: 'Chain workspace', towerPort, databasePort };
  let holdProjectRequest;
  const taskProxy = createServer(async (request, reply) => {
    if (request.method !== 'GET' || !['/api/access/me', '/api/tasks/projects'].includes(request.url)) {
      reply.writeHead(403).end();
      return;
    }
    if (holdProjectRequest) { holdProjectRequest(null); return; }
    try {
      const response = await fetch(ntasksOrigin + request.url, { redirect: 'manual', signal: AbortSignal.timeout(5000), headers: {
        authorization: request.headers.authorization, 'x-ntasks-workspace': request.headers['x-ntasks-workspace'],
      } });
      const body = await response.arrayBuffer();
      reply.writeHead(response.status, { 'content-type': 'application/json' }).end(Buffer.from(body));
    } catch { reply.writeHead(502).end(); }
  });
  taskProxy.listen(0, '127.0.0.1');
  targetTest.after(async () => {
    const closed = new Promise(resolve => taskProxy.close(resolve));
    taskProxy.closeAllConnections();
    await closed;
  });
  await once(taskProxy, 'listening');
  const binding = { format: 'noticeos-shadow-ntasks-v1', origin: `http://127.0.0.1:${taskProxy.address().port}`,
    ntasksWorkspaceId: ntasks.workspaceId,
    projectId: ntasks.projectId, serviceToken: ntasks.token };
  writeFileSync(planFile, JSON.stringify(expectedPlan), { mode: 0o600 });
  writeFileSync(ntasksFile, JSON.stringify(binding), { mode: 0o600 });
  writeFileSync(readOnlyFile, JSON.stringify({ ...binding, serviceToken: ntasks.readonlyToken }), { mode: 0o600 });

  await refuse(['prepare', root, planFile, ntasksFile]);
  assert.equal(existsSync(path.join(root, 'postgres')), false);
  await pass(['prepare', prepared, planFile, ntasksFile]);
  assert.equal(existsSync(receiptFile), false);
  const originalRuntime = readFileSync(runtime);
  await refuse(['serve', prepared]);
  await refuse(['activate', prepared, ntasksFile]);
  assert.equal(existsSync(receiptFile), false);
  const enrollmentOtp = newestOtp();
  await pass(['enroll', prepared], enrollmentOtp);
  await refuse(['activate', prepared, readOnlyFile]);
  assert.equal(existsSync(receiptFile), false);

  const verifying = new Promise(resolve => { holdProjectRequest = resolve; });
  const interrupted = command('customer-shadow-target.mjs', ['activate', prepared, ntasksFile]);
  try {
    const failure = await Promise.race([verifying, interrupted.finished, deadline(30000, 'Missing verification request.', { ref: false })]);
    assert.equal(failure, null, typeof failure === 'string' ? failure : failure?.stderr);
  } finally {
    interrupted.child.kill('SIGTERM');
    await interrupted.finished;
    holdProjectRequest = undefined;
  }
  const outcome = await interrupted.finished;
  assert.equal(outcome.code, 1);
  assert.equal(outcome.signal, null);
  assert.equal(existsSync(receiptFile), false);
  for (const file of ['.shadow-target-running', '.shadow-running', 'postgres/data/postmaster.pid']) {
    assert.equal(existsSync(path.join(prepared, file)), false, file);
  }
  await pass(['activate', prepared, ntasksFile]);
  const initial = receipt();
  assert.equal(initial.workspaceId, workspaceId);
  assert.equal(initial.dataDir, path.join(prepared, 'postgres', 'data'));
  assert.equal(existsSync(path.join(prepared, 'platform.json')), false);
  const stateFile = path.join(prepared, 'target-state.json');
  const state = readFileSync(stateFile);
  writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(state), postgresSystemId: String(BigInt(initial.postgresSystemId) + 1n) }));
  await refuse(['serve', prepared]);
  assert.equal(existsSync(path.join(initial.dataDir, 'postmaster.pid')), false);
  writeFileSync(stateFile, state);

  const stopDatabase = await foreground('customer-shadow-target.mjs', ['serve', prepared], 'Private shadow database ready');
  try {
    const live = receipt();
    assert.notEqual(live.socketDir, initial.socketDir);
    assert.equal(live.postgresSystemId, initial.postgresSystemId);
    assert.deepEqual(readFileSync(runtime), originalRuntime);
    const imported = await command('customer-shadow-import.mjs', ['--bundle', bundle, '--target', prepared]).finished;
    assert.equal(imported.code, 0, imported.stderr);
    assert.equal(JSON.parse(imported.stdout).imported, true);
    const origin = 'http://127.0.0.1:' + towerPort;
    const stopTower = await foreground('local-customer-shadow.mjs', [runtime], origin);
    try {
      const http = (route, body, headers = {}) => fetch(origin + route, { signal: AbortSignal.timeout(15000),
        headers: { origin, ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      assert.equal((await http('/api/wall')).status, 403);
      const oldMail = new Set(readdirSync(outbox));
      assert.equal((await http(EMAIL_CODE_PATHS.request, { email: ownerEmail })).status, 202);
      const [newMail] = readdirSync(outbox).filter(name => !oldMail.has(name));
      assert.ok(newMail);
      const message = JSON.parse(readFileSync(path.join(outbox, newMail), 'utf8'));
      assert.equal(message.to, ownerEmail);
      const otp = message.text.match(/\b(\d{6})\.$/u)[1];
      const login = await http(EMAIL_CODE_PATHS.verify, { email: ownerEmail, otp });
      assert.equal(login.status, 200);
      const cookie = login.headers.getSetCookie().map(item => item.split(';')[0]).join('; ');
      const selected = { cookie, [WORKSPACE_SELECTION_HEADER]: workspaceId };
      const session = await (await http('/api/session', undefined, selected)).json();
      assert.equal(session.selectedWorkspace.role, 'owner');
      const wall = await http('/api/wall', undefined, { ...selected, [WORKSPACE_SESSION_HEADER]: session.session.sessionId });
      assert.equal(wall.status, 200, await wall.clone().text());
      assert.deepEqual((await wall.json()).assets.map(asset => asset.id), ['chain.example', 'empty.example', 'skipped.example']);
      const journeys = async asset => {
        const result = await http(`/api/assets/${asset}?view=journeys`, undefined, { ...selected, [WORKSPACE_SESSION_HEADER]: session.session.sessionId });
        assert.equal(result.status, 200, await result.clone().text());
        return result.json();
      };
      const current = await journeys('chain.example');
      assert.deepEqual(current.journeys.definitions.map(row => row.id), ['signup', 'orders']);
      assert.deepEqual(current.journeys.funnels.map(row => row.current7.steps.map(step => step.users)), [[100, 22]]);
      assert.equal(current.firstPartyFunnels[0].journeyId, 'orders');
      assert.ok(current.firstPartyFunnels[0].weekly.some(period => period.quality === 'complete'
        && period.steps[0].users === 84 && period.steps[1].users === 28));
      const empty = await journeys('empty.example');
      assert.deepEqual(empty.journeys.definitions, []);
      assert.deepEqual(empty.journeys.funnels, []);
      const skipped = await journeys('skipped.example');
      assert.deepEqual(skipped.journeys.definitions.map(row => row.id), ['signup']);
      assert.deepEqual(skipped.journeys.funnels, []);
    } finally { await stopTower(); }
  } finally { await stopDatabase(); }
  assert.equal(existsSync(path.join(prepared, 'postgres', 'data', 'postmaster.pid')), false);
  assert.equal(existsSync(path.join(prepared, '.shadow-running')), false);
  assert.equal(existsSync(path.join(prepared, '.shadow-target-running')), false);
  assert.deepEqual(evidence(), before);
}
