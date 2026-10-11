import test from 'node:test';
import assert from 'node:assert/strict';
import { actionArgs, main, readSelector, validateSelector, parseServices, stackControl } from './stack-control.mjs';

const selector = { project: 'synthetic-stack', files: ['/fixture/compose.yaml'], envFile: '/fixture/compose.env', dockerHost: 'unix:///fixture/docker.sock' };
const rows = (backup = true) => ['noticeos','postgres','dolt',...(backup ? ['backup'] : [])].map((Service, i) => ({ Project: selector.project, Service, ID: String(i + 1).repeat(64), State: 'running', Health: 'healthy' }));
function fixture({ inventory = rows(), failure, changeAt, ndjson = false, revision = null, main = 'a'.repeat(40), development=false } = {}) {
  const calls = []; let inspections = 0; let output = '';
  const run = async (command, args, options) => {
    assert.ok(options.timeoutMs <= 130000 || ['logs','exec'].includes(args[9]));
    if (command === 'git') return { code:0, stdout:main };
    assert.equal(command, 'docker');
    if (args[2] === 'inspect') {
      assert.deepEqual(args, ['--host',selector.dockerHost,'inspect','--format','{{json .Config.Labels}}',inventory[0].ID]);
      return { code:0, stdout:JSON.stringify({ 'com.docker.compose.project':selector.project,'com.docker.compose.service':'noticeos','org.opencontainers.image.revision':revision,...(development?{'cx.noticeos.runtime':'development','cx.noticeos.checkout':'/fixture/source'}:{}) }) };
    }
    assert.deepEqual(args.slice(0, 9), ['--host',selector.dockerHost,'compose','--project-name',selector.project,'-f',selector.files[0],'--env-file',selector.envFile]);
    assert.equal(options.env.DO_NOT_FORWARD, undefined);
    const step = args.slice(9); calls.push(step);
    if (['logs','exec'].includes(step[0])) assert.equal(options.inherit, true, 'logs and jobs use the terminal');
    if (step[0] === 'ps') { inspections++; const value = inspections === changeAt ? inventory.map((row, i) => ({ ...row, ID: i === 0 ? 'f'.repeat(64) : row.ID })) : inventory;
      return { code: 0, stdout: ndjson ? value.map(JSON.stringify).join('\n') : JSON.stringify(value) }; }
    return { code: step[0] === failure ? 1 : 0, stdout: '', stderr: 'PRIVATE-SENTINEL' };
  };
  return { calls, run, out: { write: text => { output += text; } }, output: () => output, writes: () => calls.filter(step => step[0] !== 'ps'),
    database: async () => ({ ok: true }) };
}

test('selector requires an explicit local socket and unique absolute declarations', () => {
  assert.deepEqual(validateSelector(selector), selector);
  for (const patch of [{ project: 'Wrong' }, { files: [] }, { files: ['relative'] }, { files: ['/one','/one'] }, { envFile: 'relative' }, { dockerHost: 'tcp://localhost:2375' }, { dockerHost: 'ssh://example.com' }, { dockerHost: 'unix://foreign/socket' }, { dockerHost: 'unix:///socket?foreign=1' }, { extra: 'not allowed' }]) {
    assert.throws(() => validateSelector({ ...selector, ...patch }));
  }
});
test('selector refuses missing, oversized or symlinked files without reading environment secrets', () => {
  const io = { lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 100 }), readFileSync: () => JSON.stringify(selector) };
  assert.deepEqual(readSelector('/fixture/stack.json', io), selector);
  for (const defect of [ { isFile: () => false }, { isSymbolicLink: () => true }, { size: 20000 } ]) {
    assert.throws(() => readSelector('/fixture/stack.json', { ...io, lstatSync: () => ({ ...io.lstatSync(), ...defect }) }), /invalid or missing/u);
  }
});
test('status accepts NDJSON and prints only sanitized service state', async () => {
  const own = fixture({ ndjson: true }); await stackControl('status', selector, { ...own, env: { PATH: '/own/bin', DO_NOT_FORWARD: 'private' } });
  assert.equal(own.writes().length, 0); assert.match(own.output(), /noticeos: running, healthy/u);
  const unknown = parseServices(JSON.stringify(rows().map(row => ({ ...row, State: 'PRIVATE-SENTINEL', Health: 'PRIVATE-SENTINEL' }))), selector.project);
  assert.equal(unknown.get('noticeos').state, 'unknown'); assert.equal(unknown.get('noticeos').health, null);
  assert.match(own.output(), /app source: unknown/u);
});
test('status distinguishes the deployed source from main without reporting an unknown image as current', async () => {
  for (const [revision,expected] of [['a'.repeat(40),'current'],['b'.repeat(40),'main differs'],['PRIVATE-SENTINEL','unknown']]) {
    const own=fixture({revision}); await stackControl('status',selector,own);
    assert.ok(own.output().includes(`update: ${expected}`));
    assert.ok(!own.output().includes('PRIVATE-SENTINEL'));
    assert.equal(own.writes().length,0);
  }
});
test('development status reports mounted HEAD rather than the dependency image revision',async()=>{
 const own=fixture({development:true,revision:'b'.repeat(40)});await stackControl('status',selector,{...own,root:'/fixture/source'});
 assert.match(own.output(),/mode: development/);assert.ok(own.output().includes('app source: '+'a'.repeat(40)));
 assert.match(own.output(),/live source; pnpm os:prod returns to the image/);assert.equal(own.writes().length,0);
});
test('missing, extra, duplicate and foreign services refuse before any mutation', async () => {
  for (const inventory of [rows().slice(1), [...rows(), { ...rows()[0], Service: 'foreign' }], rows().map((row,i) => i === 0 ? { ...row, Project: 'foreign' } : row), rows().map((row,i) => i === 0 ? { ...row, Service: 'backup' } : row)]) {
    const own = fixture({ inventory }); await assert.rejects(stackControl('restart', selector, own)); assert.deepEqual(own.writes(), []);
  }
  assert.throws(() => parseServices('PRIVATE-SENTINEL', selector.project), /invalid/u);
});
test('start waits databases, optional backup and app without creating resources', async () => {
  const own = fixture(); await stackControl('start', selector, own);
  assert.deepEqual(own.writes(), [['start','--wait','--wait-timeout','90','postgres','dolt'],['start','--wait','--wait-timeout','90','backup'],['start','--wait','--wait-timeout','90','noticeos']]);
});
test('stop shuts down app, backup then databases', async () => {
  const own = fixture(); await stackControl('stop', selector, own);
  assert.deepEqual(own.writes(), [['stop','noticeos'],['stop','backup'],['stop','postgres','dolt']]);
});
test('restart stops consumers before databases and waits each restarted layer', async () => {
  const own = fixture(); await stackControl('restart', selector, own);
  assert.deepEqual(own.writes(), [['stop','noticeos','backup'],['restart','--no-deps','postgres','dolt'],['start','--wait','--wait-timeout','90','postgres','dolt'],['restart','--no-deps','backup'],['start','--wait','--wait-timeout','90','backup'],['restart','--no-deps','noticeos'],['start','--wait','--wait-timeout','90','noticeos']]);
});
test('the three-service profile omits backup and only uses existing-container operations', async () => {
  const own = fixture({ inventory: rows(false) }); await stackControl('restart', selector, own);
  assert.ok(own.writes().every(step => !step.includes('backup') && ['start','stop','restart'].includes(step[0])));
  assert.equal(own.writes().length, 5);
});
test('health failure stops later steps and never exposes raw subprocess errors', async () => {
  const own = fixture({ failure: 'start' }); await assert.rejects(stackControl('start', selector, own), /postgres \(running, healthy\), dolt \(running, healthy\) did not become healthy; nothing after it was started\. pnpm os:logs -- postgres shows why\./u);
  assert.equal(own.writes().length, 1); assert.ok(!own.output().includes('PRIVATE-SENTINEL'));
});
test('a replaced container refuses the next mutation', async () => {
  const own = fixture({ changeAt: 2 }); await assert.rejects(stackControl('stop', selector, own), /containers changed/u); assert.deepEqual(own.writes(), []);
});
test('help performs no configuration or Docker access and CLI failures remain redacted', async () => {
  let output = ''; const out = { write: value => { output += value; } };
  const run = async () => { throw new Error('PRIVATE-SENTINEL'); };
  assert.equal(await main(['--help'], { out, err: out, run }), 0); assert.match(output, /Usage:/u);
  const io = { lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 100 }), readFileSync: () => JSON.stringify(selector) };
  assert.equal(await main(['status','--config','/fixture/stack.json'], { out, err: out, io, run }), 1);
  assert.ok(!output.includes('PRIVATE-SENTINEL'));
});
test('status says whether the database has every migration in this checkout, in the check\'s own words', async () => {
  const current = fixture(); await stackControl('status', selector, current);
  assert.match(current.output(), /database: has every migration in this checkout/u);
  const behind = fixture(); await stackControl('status', selector, { ...behind, database: async () => ({ ok: false, line: 'it is 1 migration behind this code; pnpm os:migrate -- --apply brings it up to date' }) });
  assert.match(behind.output(), /database: it is 1 migration behind this code; pnpm os:migrate -- --apply/u);
});
test('logs read the stack through this terminal, bounded unless followed', async () => {
  const own = fixture(); await stackControl('logs', selector, { ...own, args: [] });
  assert.deepEqual(own.writes(), [['logs','--tail','200']]);
  const followed = fixture(); await stackControl('logs', selector, { ...followed, args: ['--follow', '--lines', '50', 'noticeos'] });
  assert.deepEqual(followed.writes(), [['logs','--tail','50','--follow','noticeos']]);
  for (const args of [['--lines','0'], ['--lines','many'], ['foreign'], ['noticeos','dolt'], ['--follow','-f']]) assert.throws(() => actionArgs('logs', args), /Usage/u, args.join(' '));
});
test('a backup, one schedule or the capacity report runs inside the running app container and nowhere else', async () => {
  for (const [action, args, job] of [['backup', [], ['backup']], ['run-job', ['0 6 * * *'], ['run-job','0 6 * * *']], ['capacity', ['--json'], ['capacity','--json']], ['capacity', [], ['capacity']]]) {
    const own = fixture(); await stackControl(action, selector, { ...own, args });
    assert.deepEqual(own.writes(), [['exec','-T','noticeos','node','deploy/compose/entrypoint.mjs',...job]], action);
  }
  assert.throws(() => actionArgs('run-job', []), /one cron expression/u);
  assert.throws(() => actionArgs('run-job', ['$(id)']), /one cron expression/u);
  assert.throws(() => actionArgs('backup', ['--now']), /Usage/u);
  const stopped = fixture({ inventory: rows().map(row => row.Service === 'noticeos' ? { ...row, State: 'exited', Health: '' } : row) });
  await assert.rejects(stackControl('backup', selector, stopped), /pnpm os:start/u);
  assert.deepEqual(stopped.writes(), []);
});
test('the command line takes the action\'s arguments and --config in any order', async () => {
  let output = ''; const out = { write: value => { output += value; } };
  const io = { lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 100 }), readFileSync: () => JSON.stringify(selector) };
  const own = fixture();
  assert.equal(await main(['logs','--','--follow','--config','/fixture/stack.json'], { out, err: out, io, run: own.run, database: own.database }), 0, output);
  assert.deepEqual(own.writes(), [['logs','--tail','200','--follow']]);
  assert.equal(await main(['run-job','--','not a cron'], { out, err: out, io, run: own.run }), 1);
  assert.match(output, /one cron expression/u);
});
test('an app that does not become healthy is named, with its logs and the database state', async () => {
  const inventory = rows().map(row => row.Service === 'noticeos' ? { ...row, Health: 'unhealthy' } : row);
  let calls = 0;
  const own = fixture({ inventory });
  const run = async (command, args, options) => {
    if (args.slice(9).join(' ') === 'start --wait --wait-timeout 90 noticeos') { calls++; return { code: 1, stdout: '', stderr: 'PRIVATE-SENTINEL' }; }
    return own.run(command, args, options);
  };
  const behind = async () => ({ ok: false, line: 'it is 2 migrations behind this code; pnpm os:migrate -- --apply brings it up to date' });
  await assert.rejects(stackControl('start', selector, { ...own, run, database: behind }), (error) => {
    assert.match(error.message, /^noticeos \(running, unhealthy\) did not become healthy; nothing after it was started\. pnpm os:logs -- noticeos shows why\.\nThe database: it is 2 migrations behind/u);
    assert.doesNotMatch(error.message, /PRIVATE-SENTINEL/u);
    return true;
  });
  assert.equal(calls, 1);
  await assert.rejects(stackControl('start', selector, { ...own, run, database: own.database }), (error) => !/The database/u.test(error.message));
});
