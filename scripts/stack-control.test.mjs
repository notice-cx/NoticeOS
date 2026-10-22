import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { actionArgs, main, mcpConnectHelp, readSelector, validateSelector, parseServices, stackControl } from './stack-control.mjs';

const selector = { project: 'synthetic-stack', files: ['/fixture/compose.yaml'], envFile: '/fixture/compose.env', dockerHost: 'unix:///fixture/docker.sock' };
const rows = (backup = true) => ['noticeos','postgres','dolt',...(backup ? ['backup'] : [])].map((Service, i) => ({ Project: selector.project, Service, ID: String(i + 1).repeat(64), State: 'running', Health: 'healthy' }));
function fixture({ inventory = rows(), failure, changeAt, ndjson = false, revision = null, main = 'a'.repeat(40), development=false, at = selector } = {}) {
  const calls = []; let inspections = 0; let output = '';
  const run = async (command, args, options) => {
    assert.ok(options.timeoutMs <= 130000 || ['logs','exec'].includes(args[9]));
    if (command === 'git') return { code:0, stdout:main };
    assert.equal(command, 'docker');
    if (args[2] === 'inspect') {
      assert.deepEqual(args, ['--host',at.dockerHost,'inspect','--format','{{json .Config.Labels}}',inventory[0].ID]);
      return { code:0, stdout:JSON.stringify({ 'com.docker.compose.project':at.project,'com.docker.compose.service':'noticeos','org.opencontainers.image.revision':revision,...(development?{'cx.noticeos.runtime':'development','cx.noticeos.checkout':'/fixture/source'}:{}) }) };
    }
    assert.deepEqual(args.slice(0, 9), ['--host',at.dockerHost,'compose','--project-name',at.project,'-f',at.files[0],'--env-file',at.envFile]);
    assert.equal(options.env.DO_NOT_FORWARD, undefined);
    const step = args.slice(9); calls.push(step);
    if (['logs','exec'].includes(step[0])) assert.equal(options.inherit, true, 'logs and jobs use the terminal');
    if (step[0] === 'ps') { inspections++; const value = inspections === changeAt ? inventory.map((row, i) => ({ ...row, ID: i === 0 ? 'f'.repeat(64) : row.ID })) : inventory;
      return { code: 0, stdout: ndjson ? value.map(JSON.stringify).join('\n') : JSON.stringify(value) }; }
    return { code: step[0] === failure ? 1 : 0, stdout: '', stderr: 'PRIVATE-SENTINEL' };
  };
  return { calls, run, out: { write: text => { output += text; } }, output: () => output, writes: () => calls.filter(step => step[0] !== 'ps'),
    database: async () => ({ ok: true }), drift: async () => ({ changed: [] }) };
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
test('status names the installation folder first, and a stack not yet in one folder by its settings file', async () => {
  const folder = { ...selector, envFile: '/srv/one installation/installation.env' };
  const own = fixture({ at: folder }); await stackControl('status', folder, own);
  assert.equal(own.output().split('\n')[0], 'installation: /srv/one installation');
  const legacy = fixture(); await stackControl('status', selector, legacy);
  assert.equal(legacy.output().split('\n')[0], `installation: legacy, its settings in ${selector.envFile}; pnpm os:convert-legacy moves it into one folder`);
});
test('status distinguishes the deployed source from main without reporting an unknown image as current', async () => {
  for (const [revision,expected] of [['a'.repeat(40),'current'],['b'.repeat(40),'main differs'],['PRIVATE-SENTINEL','unknown']]) {
    const own=fixture({revision}); await stackControl('status',selector,own);
    assert.ok(own.output().includes(`update: ${expected}`));
    assert.ok(!own.output().includes('PRIVATE-SENTINEL'));
    assert.equal(own.writes().length,0);
  }
});
test('from an installation\'s image, main is the newest published version, asked of the registry rather than git', async () => {
  for (const [published, expected] of [['a'.repeat(40), 'current'], ['c'.repeat(40), 'main differs'], [null, 'unknown']]) {
    const own = fixture({ revision: 'a'.repeat(40) });
    const run = async (command, args, options) => command === 'git' ? assert.fail('git was asked') : own.run(command, args, options);
    await stackControl('status', selector, { ...own, run, env: { NOTICEOS_CLI_IMAGE: 'ghcr.io/example/noticeos:main', NOTICEOS_DIR: '/fixture' }, published: async () => published });
    assert.ok(own.output().includes(`main: ${published ?? 'unavailable'}\n`), own.output());
    assert.ok(own.output().includes(`update: ${expected}`), own.output());
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
test('restarting the app or the backup worker restarts that container alone and waits for its health', async () => {
  for (const service of ['noticeos', 'backup']) {
    const own = fixture(); await stackControl('restart', selector, { ...own, args: [service] });
    assert.deepEqual(own.writes(), [['restart','--no-deps',service],['start','--wait','--wait-timeout','90',service]], service);
    assert.match(own.output(), new RegExp(`${service} restart complete\\.\\n$`, 'u'));
  }
});
test('restarting one database stops the app and backup worker until it is healthy again', async () => {
  for (const service of ['postgres', 'dolt']) {
    const own = fixture(); await stackControl('restart', selector, { ...own, args: [service] });
    assert.deepEqual(own.writes(), [['stop','noticeos','backup'],['restart','--no-deps',service],['start','--wait','--wait-timeout','90',service],
      ['start','--wait','--wait-timeout','90','backup'],['start','--wait','--wait-timeout','90','noticeos']], service);
  }
  const lean = fixture({ inventory: rows(false) }); await stackControl('restart', selector, { ...lean, args: ['postgres'] });
  assert.deepEqual(lean.writes(), [['stop','noticeos'],['restart','--no-deps','postgres'],['start','--wait','--wait-timeout','90','postgres'],['start','--wait','--wait-timeout','90','noticeos']]);
});
test('a one-service restart names a service the stack has, and nothing else', async () => {
  for (const args of [['foreign'], ['noticeos', 'dolt'], ['--all']]) assert.throws(() => actionArgs('restart', args), /Usage/u, args.join(' '));
  const lean = fixture({ inventory: rows(false) });
  await assert.rejects(stackControl('restart', selector, { ...lean, args: ['backup'] }), /no backup worker/u);
  assert.deepEqual(lean.writes(), []);
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
test('status says whether the database has every migration this code carries, in the check\'s own words', async () => {
  const current = fixture(); await stackControl('status', selector, current);
  assert.match(current.output(), /database: has every migration this code carries/u);
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

test('stored anomaly refresh uses the selected app and refuses unbounded input before Docker', async () => {
  const args = ['--asset', 'example.com'];
  const own = fixture();
  await stackControl('refresh-anomalies', selector, { ...own, args });
  assert.deepEqual(own.writes(), [['exec','-T','noticeos','node','deploy/compose/entrypoint.mjs','refresh-anomalies',...args]]);
  const refused = fixture();
  await assert.rejects(stackControl('refresh-anomalies', selector, { ...refused, args: ['--all'] }), /Usage/);
  assert.deepEqual(refused.calls, []);
});
test('one asset\'s collection runs inside the running app with exactly the asset, families and window given, and nothing else', async () => {
  for (const args of [['--asset', 'example.com', '--families', 'posthog-inp-targets'], ['--asset', 'example.com'],
    ['--', '--asset', 'example.com', '--families', 'posthog-*', '--start', '2026-09-08', '--end', '2026-09-22'],
    ['--asset', 'example.com', '--families', 'serp-panel,ranked-keywords']]) {
    const own = fixture(); await stackControl('collect', selector, { ...own, args });
    assert.deepEqual(own.writes(), [['exec','-T','noticeos','node','deploy/compose/entrypoint.mjs','collect',...args.filter(arg => arg !== '--')]], args.join(' '));
  }
  // Refused before Docker is asked anything: no site, a site id a shell would read, another door, an unknown or mixed family.
  for (const [args, refusal] of [[[], /pnpm os:collect -- --asset example\.com/u], [['--asset', '$(id)'], /must be an asset id/u],
    [['--asset', 'example.com', '--door', 'http://example.org'], /pnpm os:collect -- --asset/u], [['--asset', 'example.com', '--help'], /pnpm os:collect/u],
    [['--asset', 'example.com', '--families', 'everything'], /Unknown report family: everything/u],
    [['--asset', 'example.com', '--families', 'posthog-events,serp-panel'], /one provider per run/u], [['--asset', 'example.com', '--json', 'yes'], /Unknown option: --json/u]]) {
    assert.throws(() => actionArgs('collect', args), refusal, args.join(' '));
    const own = fixture();
    await assert.rejects(stackControl('collect', selector, { ...own, args }), refusal);
    assert.deepEqual(own.writes(), [], args.join(' '));
  }
});
test('the MCP server and the task client run inside the running app, over this terminal\'s own input and output', async () => {
  for (const [action, args, job] of [['mcp', [], ['mcp']], ['mcp', ['--actor', 'agent-1'], ['mcp', '--actor', 'agent-1']],
    ['bd', ['--project', 'ex', 'ready', '--json'], ['bd', '--project', 'ex', 'ready', '--json']]]) {
    const own = fixture(); await stackControl(action, selector, { ...own, args });
    assert.deepEqual(own.writes(), [['exec','-T','noticeos','node','deploy/compose/entrypoint.mjs',...job]], action);
  }
  assert.throws(() => actionArgs('mcp', ['--http']), /pnpm os:mcp -- --actor <name>/u);
  assert.throws(() => actionArgs('bd', []), /pnpm os:bd -- list/u);
});
test('at a terminal the MCP server does not wait for messages: it says how to connect it and starts nothing', async () => {
  let output = ''; const out = { write: value => { output += value; } };
  const io = { lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 100 }), readFileSync: () => JSON.stringify(selector) };
  const script = fileURLToPath(new URL('./stack-control.mjs', import.meta.url));
  const own = fixture();
  assert.equal(await main(['mcp', '--config', '/fixture/stack.json'], { out, err: out, io, run: own.run, interactive: true }), 0, output);
  assert.equal(output, 'pnpm os:mcp is the MCP server an agent starts itself, so at a terminal it does not run.\n'
    + 'Where the Tower listens is unknown (the settings are in /fixture/compose.env, not an installation.env; pnpm os:convert-legacy moves them), so connect this command instead:\n'
    + `  claude mcp add --scope user noticeos -- node ${script} mcp --actor claude --config /fixture/stack.json\n`);
  assert.deepEqual(own.writes(), []);
  assert.match(mcpConnectHelp(['--actor', 'agent 1'], '/my folder/stack.json'), / mcp --actor 'agent 1' --config '\/my folder\/stack\.json'\n$/u);
  const piped = fixture();
  assert.equal(await main(['mcp', '--config', '/fixture/stack.json'], { out, err: out, io, run: piped.run, interactive: false }), 0);
  assert.deepEqual(piped.writes(), [['exec','-T','noticeos','node','deploy/compose/entrypoint.mjs','mcp']]);
});
test('at a terminal, the Tower is named by an MCP address this machine reaches, whatever address it listens on', async () => {
  const envFile = '/srv/noticeos/installation.env';
  const lines = ['COMPOSE_PROJECT_NAME="noticeos"', 'NOTICEOS_INSTALLATION="/srv/noticeos"', `NOTICEOS_APP_IMAGE="sha256:${'a'.repeat(64)}"`,
    'NOTICEOS_APP_UID="1000"', 'NOTICEOS_APP_GID="1000"', 'NOTICEOS_TOWER_PORT="5180"', 'TOWER_ALLOWED_HOSTS=""', 'NOTICEOS_POSTGRES_PORT="5432"',
    'NOTICEOS_DOLT_PORT="3306"', 'NOTICEOS_POSTGRES_VOLUME="pg"', 'NOTICEOS_DOLT_VOLUME="dolt"', 'NOTICEOS_SPOKES_DIR="/srv/spokes"',
    'NOTICEOS_BACKUP_ASSETS_DIR="/srv/assets"', 'NOTICEOS_BACKUP_OFFSITE_PARENT="/srv/offsite"', 'NOTICEOS_STATE_DIR="x"', 'NOTICEOS_POSTGRES_SECRETS="x"',
    'NOTICEOS_DOLT_SECRETS="x"', 'NOTICEOS_BACKUP_PROFILE_DIR="x"', 'NOTICEOS_BACKUP_STAGING_DIR="x"', 'NOTICEOS_BACKUP_TRANSPORT_DIR="x"',
    'NOTICEOS_DOLT_BACKUP_VOLUME="x"', 'NOTICEOS_NETWORK="x"'];
  const help = async (bind, env = [...lines, ...(bind ? [`NOTICEOS_TOWER_BIND="${bind}"`] : [])].join('\n')) => {
    let output = ''; const out = { write: value => { output += value; } };
    const io = { lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 100 }),
      readFileSync: file => file === envFile ? env : JSON.stringify({ ...selector, envFile }) };
    assert.equal(await main(['mcp', '--actor', 'dev-1', '--config', '/srv/noticeos/stack.json'], { out, err: out, io, run: fixture().run, interactive: true }), 0, output);
    return output;
  };
  // A Tower on every interface answers on loopback too; one bound to an address answers only there.
  for (const [bind, host] of [[null, '127\\.0\\.0\\.1'], ['127.0.0.1', '127\\.0\\.0\\.1'], ['0.0.0.0', '127\\.0\\.0\\.1'], ['192.168.1.20', '192\\.168\\.1\\.20']]) {
    assert.match(await help(bind), new RegExp(`The Tower serves the same tools; connect it for every repository:\\n  claude mcp add --scope user --transport http noticeos http://${host}:5180/api/mcp --header 'X-NoticeOS-Actor: dev-1'\\n$`, 'u'), String(bind));
  }
  // An installation.env the reader refuses still answers, and says what the reader said.
  assert.match(await help(null, lines.filter(line => !line.startsWith('NOTICEOS_NETWORK')).join('\n')),
    /Where the Tower listens is unknown \(\/srv\/noticeos\/installation\.env does not set NOTICEOS_NETWORK\), so connect this command instead:\n  claude mcp add --scope user noticeos -- node /u);
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
