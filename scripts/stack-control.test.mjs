import test from 'node:test';
import assert from 'node:assert/strict';
import { main, readSelector, validateSelector, parseServices, stackControl } from './stack-control.mjs';

const selector = { project: 'synthetic-stack', files: ['/fixture/compose.yaml'], envFile: '/fixture/compose.env', dockerHost: 'unix:///fixture/docker.sock' };
const rows = (backup = true) => ['noticeos','postgres','dolt',...(backup ? ['backup'] : [])].map((Service, i) => ({ Project: selector.project, Service, ID: String(i + 1).repeat(64), State: 'running', Health: 'healthy' }));
function fixture({ inventory = rows(), failure, changeAt, ndjson = false, revision = null, main = 'a'.repeat(40), development=false } = {}) {
  const calls = []; let inspections = 0; let output = '';
  const run = async (command, args, options) => {
    assert.ok(options.timeoutMs <= 130000);
    if (command === 'git') return { code:0, stdout:main };
    assert.equal(command, 'docker');
    if (args[2] === 'inspect') {
      assert.deepEqual(args, ['--host',selector.dockerHost,'inspect','--format','{{json .Config.Labels}}',inventory[0].ID]);
      return { code:0, stdout:JSON.stringify({ 'com.docker.compose.project':selector.project,'com.docker.compose.service':'noticeos','org.opencontainers.image.revision':revision,...(development?{'cx.noticeos.runtime':'development','cx.noticeos.checkout':'/fixture/source'}:{}) }) };
    }
    assert.deepEqual(args.slice(0, 9), ['--host',selector.dockerHost,'compose','--project-name',selector.project,'-f',selector.files[0],'--env-file',selector.envFile]);
    assert.equal(options.env.DO_NOT_FORWARD, undefined);
    const step = args.slice(9); calls.push(step);
    if (step[0] === 'ps') { inspections++; const value = inspections === changeAt ? inventory.map((row, i) => ({ ...row, ID: i === 0 ? 'f'.repeat(64) : row.ID })) : inventory;
      return { code: 0, stdout: ndjson ? value.map(JSON.stringify).join('\n') : JSON.stringify(value) }; }
    return { code: step[0] === failure ? 1 : 0, stdout: '', stderr: 'PRIVATE-SENTINEL' };
  };
  return { calls, run, out: { write: text => { output += text; } }, output: () => output, writes: () => calls.filter(step => step[0] !== 'ps') };
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
 assert.match(own.output(),/live source; deployments unnecessary/);assert.equal(own.writes().length,0);
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
  const own = fixture({ failure: 'start' }); await assert.rejects(stackControl('start', selector, own), /no later stack steps/u);
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
