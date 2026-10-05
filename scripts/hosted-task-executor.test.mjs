import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { WORKSPACE_SESSION_HEADER, WORKSPACE_SELECTION_HEADER } from './browser-request-policy.mjs';
import { beadsClosedSince, beadsPollArgs } from './task-snapshot-summary.mjs';
import { createHostedTaskExecutor, HostedTaskRefused } from './hosted-task-executor.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const P = '33333333-3333-4333-8333-333333333333';
const PERSON = '44444444-4444-4444-8444-444444444444';
const R = '55555555-5555-4555-8555-555555555555';
const C = '66666666-6666-4666-8666-666666666666';
const SESSION = '77777777-7777-4777-8777-777777777777';
const OTHER_SESSION = '88888888-8888-4888-8888-888888888888';
const DATABASE = 'n_11111111111141118111111111111111';
const otherDatabase = 'n_22222222222242228222222222222222';
const request = (workspace = A) => new Request('https://tower.example.com/api/tasks', {
  method: 'POST', headers: { origin: 'https://tower.example.com', 'sec-fetch-site': 'same-origin',
    [WORKSPACE_SELECTION_HEADER]: workspace, [WORKSPACE_SESSION_HEADER]: SESSION },
});
const task = operation => ({ projectId: P, operation });
const mapping = (workspaceId = A) => Object.freeze({ workspaceId, projectId: P,
  executorRef: workspaceId === A ? R : C, credentialRef: C,
  databaseKey: workspaceId === A ? DATABASE : otherDatabase });

async function fixture(work) {
  const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'noticeos-executor-unit-'));
  await fs.chmod(base, 0o700);
  try {
    for (const name of ['scratch', 'client', 'project-a', 'project-b']) await fs.mkdir(path.join(base, name), { mode: 0o700 });
    const credentials = path.join(base, 'credentials');
    await fs.writeFile(credentials, '[127.0.0.1:13383]\npassword=' + randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
    const profile = path.join(base, 'client.json');
    await fs.writeFile(profile, JSON.stringify({ host: '127.0.0.1', port: 13383, user: 'tenant_a',
      credentialsFile: credentials, clientHome: path.join(base, 'client') }), { mode: 0o600 });
    const profileB = path.join(base, 'client-b.json');
    await fs.writeFile(profileB, JSON.stringify({ ...JSON.parse(await fs.readFile(profile, 'utf8')), user: 'tenant_b' }), { mode: 0o600 });
    const inspectorCredentials = path.join(base, 'inspection-credentials');
    await fs.writeFile(inspectorCredentials, '[127.0.0.1:13383]\npassword=' + randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
    const inspectionProfile = path.join(base, 'inspection.json');
    await fs.writeFile(inspectionProfile, JSON.stringify({ host: '127.0.0.1', port: 13383, user: 'inspector',
      credentialsFile: inspectorCredentials, clientHome: path.join(base, 'client') }), { mode: 0o600 });
    const binary = path.join(base, 'bd');
    await fs.writeFile(binary, `#!${process.execPath}
import fs from 'node:fs';
import net from 'node:net';
const args=process.argv.slice(2), cwd=process.cwd();
fs.appendFileSync(cwd+'/commands.jsonl',JSON.stringify({args,home:process.env.HOME,tls:process.env.BEADS_DOLT_SERVER_TLS,keys:Object.keys(process.env).sort()})+'\\n');
const c=JSON.parse(fs.readFileSync(cwd+'/control.json'));
if(args[0]==='--version'){console.log('bd version 1.3.1');process.exit(0)}
if(c.hang){fs.writeFileSync(cwd+'/hung-pid',String(process.pid));setInterval(()=>{},1000)}
else if(args.includes('sql')){
 const sql=args.at(-1), db=c.database;
 if(sql.startsWith('SELECT DATABASE()')) console.log(JSON.stringify({rows:[{database_key:db,dolt_version:'2.4.0',branch:'main',schema_version:c.schema??66,project_id:'${P}'}]}));
 else if(sql.startsWith('SELECT TABLE_NAME')) console.log(JSON.stringify({rows:['comments','config','events','issues','metadata','schema_migrations'].map(table_name=>({table_name}))}));
 else if(sql==='SHOW GRANTS'){
  const grants=['GRANT USAGE ON *.* TO \u0060tenant\u0060@\u0060%\u0060','GRANT SELECT, INSERT, UPDATE, DELETE ON \u0060'+db+'\u0060.* TO \u0060tenant\u0060@\u0060%\u0060',...['dolt_add','dolt_checkout','dolt_commit'].map(p=>'GRANT EXECUTE ON PROCEDURE \u0060'+db+'\u0060.\u0060'+p+'\u0060 TO \u0060tenant\u0060@\u0060%\u0060')];
  if(c.elevated) grants.push('GRANT FILE ON *.* TO \u0060tenant\u0060@\u0060%\u0060');
  console.log(JSON.stringify({rows:grants.map(g=>({grant:g}))}));
 }else if(sql.startsWith('SELECT value AS issue_prefix')) console.log(JSON.stringify({rows:[{issue_prefix:c.prefix??'tt'}]}));
 else console.log(JSON.stringify({rows:[{database:db,branch:'main',user:process.env.BEADS_DOLT_SERVER_USER,host:'%',permissions:'write'}]}));
}else if(c.failBlocked&&args.includes('blocked')){process.exit(1)}
else if(c.overflow){process.stdout.write('x'.repeat(9*1024*1024))}
else if(args.includes('show')){console.log(JSON.stringify({database:c.database,args,value:c.value,id:args.at(-1),issue_type:c.taskType??'task',status:c.taskStatus??'open',labels:c.human?['human']:[],await_type:c.awaitType,close_reason:c.closeReason}))}
else if((args.includes('human')||args.includes('gate'))&&args.some(value=>['respond','dismiss','resolve'].includes(value))){
 if(c.decisionFailure)process.exit(1);
 const response=args.find(a=>a.startsWith('--response='))?.slice(11), reason=args.find(a=>a.startsWith('--reason='))?.slice(9);
 c.taskStatus='closed';c.closeReason=args.includes('respond')?'Responded':args.includes('dismiss')?(reason===undefined?'Dismissed':'Dismissed: '+reason):(reason??'Resolved');
 if(response!==undefined)c.response={issue_id:args.at(-1),author:args.find(a=>a.startsWith('--actor='))?.slice(8),text:'Response: '+response};
 fs.writeFileSync(cwd+'/control.json',JSON.stringify(c));console.log('Decision recorded');
}else if(args.includes('comments')&&args.includes('--readonly')){console.log(JSON.stringify(c.response?[c.response]:[]))}
else if(c.hangWrite){fs.writeFileSync(cwd+'/hung-write-pid.tmp',String(process.pid));fs.renameSync(cwd+'/hung-write-pid.tmp',cwd+'/hung-write-pid');if(c.readinessSocket){const peer=net.createConnection(c.readinessSocket,()=>peer.end(String(process.pid)));peer.on('error',()=>process.exit(2))}setInterval(()=>{},1000)}
else {console.log(JSON.stringify({database:c.database,args,value:c.value}))}
`, { mode: 0o700 });
    const doltBinary = path.join(base, 'dolt');
    await fs.writeFile(doltBinary, `#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2);
const own=args.at(-1)==='--query=SHOW GRANTS';
const forB=args.at(-1).includes('tenant_b');
const db=forB?'${otherDatabase}':'${DATABASE}', user=forB?'tenant_b':'tenant_a';
const c=JSON.parse(fs.readFileSync('${base}/'+(forB?'project-b':'project-a')+'/control.json'));
if(args[0]==='config'){
 if(c.configFail)process.exit(1);
 fs.mkdirSync(process.env.HOME+'/.dolt',{recursive:true});
 fs.writeFileSync(process.env.HOME+'/.dolt/config_global.json',JSON.stringify({'versioncheck.disabled':'true'}));process.exit(0)
}
if(args[0]==='version'){
 if(JSON.parse(fs.readFileSync(process.env.HOME+'/.dolt/config_global.json'))['versioncheck.disabled']!=='true')process.exit(2);
 console.log(c.doltVersion??'dolt version 2.4.0');process.exit(0)
}
let grants;
if(own)grants=['GRANT USAGE ON *.* TO \u0060inspector\u0060@\u0060%\u0060','GRANT SELECT ON \u0060mysql\u0060.* TO \u0060inspector\u0060@\u0060%\u0060'];
else grants=['GRANT USAGE ON *.* TO \u0060'+user+'\u0060@\u0060%\u0060','GRANT SELECT, INSERT, UPDATE, DELETE ON \u0060'+db+'\u0060.* TO \u0060'+user+'\u0060@\u0060%\u0060',...['dolt_add','dolt_checkout','dolt_commit'].map(p=>'GRANT EXECUTE ON PROCEDURE \u0060'+db+'\u0060.\u0060'+p+'\u0060 TO \u0060'+user+'\u0060@\u0060%\u0060')];
if(own?c.inspectorElevated:c.elevated)grants.push('GRANT FILE ON *.* TO \u0060'+(own?'inspector':user)+'\u0060@\u0060%\u0060');
console.log(JSON.stringify({rows:grants.map(grant=>({grant}))}));
`, { mode: 0o700 });
    for (const [name, database, value] of [['project-a', DATABASE, 'a only'], ['project-b', otherDatabase, 'b only']]) {
      await fs.writeFile(path.join(base, name, 'control.json'), JSON.stringify({ database, value }));
    }
    const state = { role: 'operator', sessionId: SESSION, active: true, selected: mapping(),
      membershipReads: 0, directoryCalls: 0, resolves: 0, effects: 0, onResolve: () => {}, onDirectory: () => {} };
    const admission = createWorkspaceAdmission({ kind: 'hosted', profile: Symbol(), trustedOrigin: 'https://tower.example.com',
      membership: async (_headers, workspaceId) => {
        state.membershipReads++;
        return state.active ? { principalId: PERSON, sessionId: state.sessionId,
          expiresAt: new Date(Date.now() + 60_000).toISOString(), workspaceId, role: state.role, workspaceStatus: 'active' } : null;
      } });
    const project = async (workspaceId, projectId) => {
      state.directoryCalls++; state.onDirectory();
      return projectId === P && [A, B].includes(workspaceId) ? (workspaceId === A ? state.selected : mapping(B)) : null;
    };
    const options = { admission, directory: { project,
      withProjectMutation: async (workspaceId, projectId, controls, work) => {
        // Pure adapter only; native tests prove the actual database lock.
        if (controls.signal?.aborted) throw new Error('aborted lease');
        return work(Object.freeze({ project: () => project(workspaceId, projectId),
          signal: controls.signal ?? new AbortController().signal }));
      },
    }, resolveTarget: async selected => {
      state.resolves++; state.onResolve(); return { cwd: path.join(base, selected.workspaceId === A ? 'project-a' : 'project-b'),
        clientProfile: selected.workspaceId === A ? profile : profileB, grantVerifierProfile: inspectionProfile, beadsProjectId: P, tls: false };
    }, doltBinary: { path: doltBinary, sha256: createHash('sha256').update(await fs.readFile(doltBinary)).digest('hex') }, binary: { path: binary, sha256: createHash('sha256').update(await fs.readFile(binary)).digest('hex') }, scratchRoot: path.join(base, 'scratch') };
    const executor = createHostedTaskExecutor(options);
    const commands = async (workspaceId = A) => {
      try { return (await fs.readFile(path.join(base, workspaceId === A ? 'project-a' : 'project-b', 'commands.jsonl'), 'utf8'))
        .trim().split('\n').map(JSON.parse); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    };
    const control = async patch => {
      const file = path.join(base, 'project-a/control.json');
      await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), ...patch }));
    };
    await work({ base, state, executor, options, commands, control });
    assert.deepEqual(await fs.readdir(path.join(base, 'scratch')), [], 'All command-local profiles retired');
  } finally { await fs.rm(base, { recursive: true, force: true }); }
  assert.equal(await fs.lstat(base).then(() => true, () => false), false);
}
const refused = work => assert.rejects(work, HostedTaskRefused);

test('mutation requires the trusted shared directory lease; fact-only adapters remain read-only',()=>fixture(async f=>{
  const factOnly=createHostedTaskExecutor({...f.options,directory:{project:f.options.directory.project}});
  await refused(()=>factOnly.execute(request(),A,task({kind:'comment',taskId:'tt-collision',text:'No uncoordinated write'})));
  assert.equal(f.state.directoryCalls,0);assert.equal(f.state.resolves,0);assert.deepEqual(await f.commands(),[]);
  await factOnly.execute(request(),A,task({kind:'show',taskId:'tt-collision'}));
}));

test('fixed decision verbs validate the current target and require authoritative post-write readback', () => fixture(async f => {
  for (const [operation, state] of [
    [{ kind: 'respond', taskId: 'tt-human', response: '--file=literal answer' }, { taskType: 'task', human: true }],
    [{ kind: 'dismiss', taskId: 'tt-human', reason: '--database=literal reason' }, { taskType: 'task', human: true }],
    [{ kind: 'resolve-gate', taskId: 'tt-human', reason: 'Operator approved' }, { taskType: 'gate', human: false, awaitType: 'human' }],
  ]) {
    await f.control({ ...state, taskStatus: 'open', closeReason: undefined, response: undefined });
    assert.deepEqual(await f.executor.execute(request(), A, task(operation)), { id: 'tt-human', status: 'closed' });
    const command = (await f.commands()).findLast(row => row.args.includes('human') || row.args.includes('gate'));
    assert.equal(command.args[2], '--actor=' + PERSON);
  }
}));

test('generic closure and human-marker removal cannot bypass a current decision target', () => fixture(async f => {
  for (const state of [{ human: true, taskType: 'task' }, { human: false, taskType: 'gate', awaitType: 'human' }]) {
    await f.control(state);
    for (const operation of [{ kind: 'close', taskId: 'tt-human', reason: 'Not a decision' },
      { kind: 'update', taskId: 'tt-human', status: 'closed' },
      { kind: 'update', taskId: 'tt-human', removeLabels: ['human'] }]) {
      await refused(() => f.executor.execute(request(), A, task(operation)));
    }
  }
  await f.control({ human: false, taskType: 'task' });
  await refused(() => f.executor.execute(request(), A, task({ kind: 'update', taskId: 'tt-human', status: 'closed', addLabels: ['human'] })));
  assert.equal((await f.commands()).filter(row => row.args.includes('close') || row.args.includes('update')).length, 0);
}));

test('wrong target, already decided and failed decision refuse without close/comment fallbacks', () => fixture(async f => {
  for (const [operation, state] of [
    [{ kind: 'respond', taskId: 'tt-human', response: 'Answer' }, { taskType: 'task', human: false, taskStatus: 'open' }],
    [{ kind: 'respond', taskId: 'tt-human', response: 'Answer' }, { taskType: 'task', human: true, taskStatus: 'closed' }],
    [{ kind: 'resolve-gate', taskId: 'tt-human' }, { taskType: 'gate', awaitType: 'timer', taskStatus: 'open' }],
    [{ kind: 'resolve-gate', taskId: 'tt-human' }, { taskType: 'task', human: true, taskStatus: 'open' }],
  ]) {
    await f.control(state); await refused(() => f.executor.execute(request(), A, task(operation)));
  }
  assert.equal((await f.commands()).filter(row => row.args.includes('human') || row.args.includes('gate')).length, 0);
  await f.control({ taskType: 'task', human: true, taskStatus: 'open', decisionFailure: true });
  await refused(() => f.executor.execute(request(), A, task({ kind: 'respond', taskId: 'tt-human', response: 'Answer' })));
  assert.equal((await f.commands()).filter(row => row.args.includes('human')).length, 1);
  assert.equal((await f.commands()).filter(row => row.args.includes('close') || row.args.includes('add')).length, 0);
}));

test('service and aborted decision requests cannot acquire directory or credentials', () => fixture(async f => {
  const service = createWorkspaceAdmission({ kind: 'service', profile: Symbol(), authority: async () =>
    ({ principalId: 'service', workspaceId: A, workspaceStatus: 'active', expiresAt: new Date(Date.now() + 60000).toISOString(), actions: ['tasks.write', 'tasks.decide'] }) });
  const executor = createHostedTaskExecutor({ ...f.options, admission: service });
  await refused(() => executor.execute(request(), A, task({ kind: 'dismiss', taskId: 'tt-human' })));
  const controller = new AbortController(); controller.abort();
  const aborted = new Request(request(), { signal: controller.signal });
  await refused(() => f.executor.execute(aborted, A, task({ kind: 'resolve-gate', taskId: 'tt-human' })));
  assert.equal(f.state.directoryCalls, 0); assert.equal(f.state.resolves, 0);
  assert.deepEqual(await f.commands(), []);
}));

test('current membership is checked again before decision dispatch', () => fixture(async f => {
  await f.control({ human: true });
  f.state.onResolve = () => { f.state.active = false; };
  await refused(() => f.executor.execute(request(), A, task({ kind: 'respond', taskId: 'tt-human', response: 'Answer' })));
  assert.equal((await f.commands()).filter(row => row.args.includes('human')).length, 0);
}));

test('two workspaces with colliding project/task IDs execute only their fixed physical project', () => fixture(async f => {
  for (const workspace of [A, B]) {
    const result = await f.executor.execute(request(workspace), workspace, task({ kind: 'show', taskId: 'tt-collision' }));
    assert.equal(result.database, workspace === A ? DATABASE : otherDatabase);
    assert.equal(result.value, workspace === A ? 'a only' : 'b only');
    assert.deepEqual(result.args, ['--sandbox', '--json', '--actor=' + PERSON, '--readonly', 'show', '--', 'tt-collision']);
  }
  for (const row of await f.commands()) {
    assert.ok(row.home.startsWith(path.join(f.base, 'scratch/task-')));
    assert.equal(row.tls, 'false');
    assert.equal(row.keys.some(key => /NOTICEOS|CLOUDFLARE|NODE_OPTIONS|BEADS_DOLT_PASSWORD/u.test(key)), false);
  }
}));
test('every structured operation produces a fixed plan and server actor', () => fixture(async f => {
  const operations = [{ kind: 'list', limit: 10 }, { kind: 'show', taskId: 'tt-a' },
    { kind: 'history', taskId: 'tt-a', limit: 5 }, { kind: 'create', title: '--file=/foreign', description: '--sql=bad' },
    { kind: 'update', taskId: 'tt-a', title: '--database=foreign' },
    { kind: 'comment', taskId: 'tt-a', text: '--file=/foreign' }, { kind: 'close', taskId: 'tt-a', reason: '--sql=bad' }];
  for (const operation of operations) {
    const output = await f.executor.execute(request(), A, task(operation));
    assert.equal(output.args[2], '--actor=' + PERSON);
    assert.equal(output.args.includes('--database=foreign'), false);
  }
}));
test('malformed/raw operations and foreign projects refuse before operational effects', () => fixture(async f => {
  for (const value of [task({ kind: 'sql', query: 'LOAD_FILE' }), task({ kind: 'branch', branch: 'foreign' }),
    { ...task({ kind: 'list', limit: 1 }), actor: 'owner' }, task({ kind: 'create', title: 'task', file: '/foreign' }),
    { projectId: R, operation: { kind: 'show', taskId: 'tt-a' } },
    { projectId: P, operation: { kind: 'list', limit: 1 }, workspaceId: B }]) {
    await refused(() => f.executor.execute(request(), A, value));
  }
  assert.equal(f.state.resolves, 0);
  assert.deepEqual(await f.commands(), []);
}));
test('viewer writes and revoked membership deny before directory/credential/file/subprocess', () => fixture(async f => {
  f.state.role = 'viewer';
  await refused(() => f.executor.execute(request(), A, task({ kind: 'create', title: 'not allowed' })));
  f.state.active = false;
  await refused(() => f.executor.execute(request(), A, task({ kind: 'list', limit: 1 })));
  assert.equal(f.state.directoryCalls, 0); assert.equal(f.state.resolves, 0);
}));
test('revocation and same-person session replacement during readiness prevent task dispatch', () => fixture(async f => {
  for (const replacement of ['revoked', 'session']) {
    f.state.active = true; f.state.sessionId = SESSION;
    f.state.onResolve = () => { if (replacement === 'revoked') f.state.active = false; else f.state.sessionId = OTHER_SESSION; };
    await refused(() => f.executor.execute(request(), A, task({ kind: 'create', title: 'not dispatched' })));
  }
  assert.equal((await f.commands()).some(row => row.args.includes('create')), false);
}));
test('rebinding a directory row during readiness prevents task dispatch', () => fixture(async f => {
  f.state.onResolve = () => { f.state.selected = Object.freeze({ ...mapping(), executorRef: C }); };
  await refused(() => f.executor.execute(request(), A, task({ kind: 'create', title: 'not dispatched' })));
  assert.equal((await f.commands()).some(row => row.args.includes('create')), false);
}));
test('actual metadata and exact restricted grants are required, not target booleans', () => fixture(async f => {
  for (const patch of [{ schema: 99 }, { schema: 66, elevated: true }, { elevated: false, database: otherDatabase }]) {
    await f.control(patch);
    await refused(() => f.executor.execute(request(), A, task({ kind: 'create', title: 'not dispatched' })));
  }
  assert.equal((await f.commands()).some(row => row.args.includes('create')), false);
}));
test('platform verification is factory-custodied and exact-mapping-bound', () => fixture(async f => {
  const result = await f.executor.verifyProject(mapping());
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.mapping), true);
  f.executor.assertVerifiedProject(result, mapping());
  assert.throws(() => f.executor.assertVerifiedProject(result, mapping()), HostedTaskRefused);
  for (const input of [{ ...result }, JSON.parse(JSON.stringify(result)), null]) {
    assert.throws(() => f.executor.assertVerifiedProject(input, mapping()), HostedTaskRefused);
  }
  assert.throws(() => f.executor.assertVerifiedProject(result, mapping(B)), HostedTaskRefused);
  const other = createHostedTaskExecutor(f.options);
  assert.throws(() => other.assertVerifiedProject(result, mapping()), HostedTaskRefused);
}));
test('platform catalog verification checks the actual project prefix without changing task commands', () => fixture(async f => {
  const result = await f.executor.verifyProject(mapping(), { expectedPrefix: 'tt' });
  f.executor.assertVerifiedProject(result, mapping());
  const queries = (await f.commands()).filter(row => row.args.includes('sql'));
  assert.equal(queries.some(row => row.args.at(-1) === "SELECT value AS issue_prefix FROM config WHERE `key`='issue_prefix'"), true);
  await f.control({ prefix: 'foreign' });
  await refused(() => f.executor.verifyProject(mapping(), { expectedPrefix: 'tt' }));
  const before = (await f.commands()).length;
  await refused(() => f.executor.verifyProject(mapping(), { expectedPrefix: '--sql=foreign' }));
  assert.equal((await f.commands()).length, before, 'Malformed server metadata never acquires a child');
}));
test('excess output refuses and awaits child close before retiring its profile', () => fixture(async f => {
  await f.control({ overflow: true });
  await refused(() => f.executor.execute(request(), A, task({ kind: 'show', taskId: 'tt-a' })));
}));


test('verification controls refuse before resources and await a cancelled owned process', () => fixture(async f => {
  const aborted = new AbortController(); aborted.abort();
  for (const controls of [{ signal: aborted.signal }, { deadline: Date.now() - 1 }, { deadline: NaN }, { signal: {} }, { profile: 'hosted' }]) {
    await refused(() => f.executor.verifyProject(mapping(), controls));
  }
  assert.equal(f.state.directoryCalls, 0);
  await f.control({ hang: true });
  await refused(() => f.executor.verifyProject(mapping(), { signal: AbortSignal.timeout(800) }));
  const pid = Number(await fs.readFile(path.join(f.base, 'project-a/hung-pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), /ESRCH/u);
  assert.deepEqual(await fs.readdir(path.join(f.base, 'scratch')), []);
}));

test('expired verification awaits in-flight directory work before refusing', () => fixture(async f => {
  let release, completed = false, settled = false;
  const pending = new Promise(resolve => { release = resolve; });
  const abort = new AbortController();
  const executor = createHostedTaskExecutor({ ...f.options, directory: { project: async () => { await pending; completed = true; return mapping(); } } });
  const work = refused(() => executor.verifyProject(mapping(), { signal: abort.signal })).finally(() => { settled = true; });
  abort.abort();
  await Promise.resolve(); assert.equal(settled, false);
  release(); await work;
  assert.equal(completed, true); assert.equal(f.state.resolves, 0);
}));


test('fixed deadline kills the owned process and rejects unsupported plaintext remote targets', () => fixture(async f => {
  await f.control({ hang: true });
  await refused(() => f.executor.verifyProject(mapping(), { deadline: Date.now() + 800 }));
  const pid = Number(await fs.readFile(path.join(f.base, 'project-a/hung-pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), /ESRCH/u);
  const file = path.join(f.base, 'client.json');
  const client = JSON.parse(await fs.readFile(file, 'utf8'));
  client.host = 'remote.example.com';
  await fs.writeFile(client.credentialsFile, '[remote.example.com:13383]\npassword=synthetic-value\n');
  await fs.writeFile(file, JSON.stringify(client));
  const before = (await f.commands()).length;
  await refused(() => f.executor.verifyProject(mapping()));
  assert.equal((await f.commands()).length, before);
}));


test('inspection identities never fall back to task/admin or accept excess grants', () => fixture(async f => {
  await f.control({ inspectorElevated: true });
  await refused(() => f.executor.verifyProject(mapping()));
  const before = (await f.commands()).length;
  const inspector = path.join(f.base, 'inspection.json');
  const supplied = JSON.parse(await fs.readFile(inspector, 'utf8'));
  for (const user of ['root', 'noticeos_owner', 'tenant_a']) {
    await fs.writeFile(inspector, JSON.stringify({ ...supplied, user }));
    await refused(() => f.executor.verifyProject(mapping()));
    assert.equal((await f.commands()).length, before);
  }
}));


test('directory keys outside the canonical registry shape deny before target resolution', () => fixture(async f => {
  f.state.selected = { ...mapping(), databaseKey: DATABASE.replace('n_', 'nX') };
  await refused(() => f.executor.execute(request(), A, task({ kind: 'show', taskId: 'tt-collision' })));
  assert.equal(f.state.resolves, 0); assert.deepEqual(await f.commands(), []);
}));

// Exact captured optional warning was mistaken for a task-write failure. The
// fixed config command must succeed first; only the pinned leading version is
// accepted and neither another version nor arbitrary trailing output qualifies.
test('version suppression is mandatory and observed warning preserves the exact pin', () => fixture(async f => {
  await f.control({ doltVersion: 'dolt version 2.4.0\nWarning: unable to query latest released Dolt version' });
  const verified = await f.executor.verifyProject(mapping()); f.executor.assertVerifiedProject(verified, mapping());
  for (const doltVersion of ['dolt version 2.3.4', 'unknown\ndolt version 2.4.0', 'dolt version 2.4.0\nunrecognized output']) {
    await f.control({ doltVersion }); await refused(() => f.executor.verifyProject(mapping()));
  }
  await f.control({ doltVersion: 'dolt version 2.4.0', configFail: true });
  await refused(() => f.executor.verifyProject(mapping()));
}));

test('fixed demo reads ignore customer cookies and refuse foreign selection or writes before acquisition', () => fixture(async f => {
  const admission = createWorkspaceAdmission({ kind: 'demo', profile: Symbol(), workspaceId: A, workspaceStatus: async () => 'active' });
  const executor = createHostedTaskExecutor({ ...f.options, admission });
  const customer = request(); customer.headers.set('cookie', 'not-demo-authority');
  await refused(() => executor.execute(customer, A, task({ kind: 'comment', taskId: 'tt-a', text: 'not allowed' })));
  await refused(() => executor.execute(customer, B, task({ kind: 'show', taskId: 'tt-a' })));
  assert.equal(f.state.directoryCalls, 0); assert.equal(f.state.resolves, 0);
  const result = await executor.execute(customer, A, task({ kind: 'show', taskId: 'tt-a' }));
  assert.equal(result.value, 'a only'); assert.ok(result.args.includes('--actor=demo-reader')); assert.ok(result.args.includes('--readonly'));
}));

test('execution snapshots truthful request metadata without retaining or consuming its body', () => fixture(async f => {
  const command = task({ kind: 'show', taskId: 'tt-a' });
  const original = new Request(request(), { body: JSON.stringify(command) });
  original.clone = () => { throw new Error('An unused body branch is forbidden'); };
  const result = await f.executor.execute(original, A, command);
  assert.equal(result.value, 'a only'); assert.equal(original.bodyUsed, false);
  assert.deepEqual(await original.json(), command);
}));
test('labels and handoff metadata are captured before asynchronous authority/target reads', () => fixture(async f => {
  const labels = ['asset:example'], metadata = { noticeos_key: 'original join' };
  f.state.onDirectory = () => { labels[0] = '--file=changed'; metadata.noticeos_key = 'changed'; };
  const result = await f.executor.execute(request(), A, task({ kind: 'create', title: 'Snapshot task', labels, metadata }));
  assert.ok(result.args.includes('--labels=asset:example'));
  assert.deepEqual(JSON.parse(result.args.find(arg => arg.startsWith('--metadata=')).slice(11)), { noticeos_key: 'original join' });
}));

test('aborted original or server signal refuses mutations before authority and capability acquisition', () => fixture(async f => {
  const abort = new AbortController(); abort.abort();
  const operation = task({ kind: 'comment', taskId: 'tt-a', text: 'never issued' });
  await refused(() => f.executor.execute(new Request(request(), { signal: abort.signal }), A, operation));
  await refused(() => f.executor.execute(new Request(request(), { signal: abort.signal }), A, operation,
    { signal: new AbortController().signal }));
  await refused(() => f.executor.execute(request(), A, operation, { signal: abort.signal }));
  assert.equal(f.state.membershipReads, 0);
  assert.equal(f.state.directoryCalls, 0); assert.equal(f.state.resolves, 0);
  assert.deepEqual(await f.commands(), []);
}));

async function ownedChildReadiness(marker) {
  const socketPath = path.join(path.dirname(marker), 'child-ready.sock');
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {}); // Joined by the owner, including setup failures.
  const peers = new Map();
  const checks = [];
  const server = net.createServer(peer => {
    const closed = new Promise(resolve => peer.once('close', resolve));
    peers.set(peer, closed);
    let body = '';
    peer.setEncoding('utf8');
    peer.on('data', value => {
      body += value;
      if (body.length > 16) { rejectReady(new Error('Invalid child readiness PID')); peer.destroy(); }
    });
    peer.on('error', () => rejectReady(new Error('Child readiness connection failed')));
    peer.on('end', () => {
      const check = (async () => {
        assert.match(body, /^[1-9][0-9]{0,9}$/u);
        assert.equal(await fs.readFile(marker, 'utf8'), body, 'Announcement must match the owned durable marker');
        resolveReady(Number(body));
      })().catch(rejectReady);
      checks.push(check);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  const deadline = setTimeout(() => rejectReady(new Error('Child readiness deadline expired')), 10_000);
  return { socketPath, ready, async close() {
    clearTimeout(deadline); rejectReady(new Error('Child readiness closed'));
    for (const peer of peers.keys()) peer.destroy();
    await Promise.all(peers.values());
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await Promise.all(checks);
    await ready.catch(() => {});
  } };
}

test('child readiness requires its announced PID to match the durable marker without filesystem notifications', () => fixture(async f => {
  const marker = path.join(f.base, 'project-a/hung-write-pid');
  for (const expected of ['123', '456']) {
    await fs.writeFile(marker, expected);
    const handshake = await ownedChildReadiness(marker);
    try {
      await new Promise((resolve, reject) => {
        const peer = net.createConnection(handshake.socketPath, () => peer.end('123'));
        peer.once('error', reject); peer.once('close', resolve);
      });
      if (expected === '123') assert.equal(await handshake.ready, 123);
      else await assert.rejects(handshake.ready, /Announcement must match/u);
    } finally { await handshake.close(); }
  }
}));

test('original and server cancellation stop an issued mutation and await exact child/profile retirement', () => fixture(async f => {
  for (const source of ['original', 'server']) {
    const marker = path.join(f.base, 'project-a/hung-write-pid');
    await fs.rm(marker, { force: true });
    const abort = new AbortController();
    const handshake = await ownedChildReadiness(marker);
    const original = source === 'original' ? new Request(request(), { signal: abort.signal }) : request();
    let work;
    try {
      await f.control({ hangWrite: true, readinessSocket: handshake.socketPath });
      work = refused(() => f.executor.execute(original, A,
        task({ kind: 'comment', taskId: 'tt-a', text: 'outcome may be unknown' }),
        { signal: source === 'server' ? abort.signal : new AbortController().signal }));
      const pid = await Promise.race([handshake.ready, work.then(() => {
        throw new Error('The executor finished before its child readiness marker');
      })]);
      abort.abort(); await work;
      assert.throws(() => process.kill(pid, 0), /ESRCH/u);
      assert.throws(() => process.kill(-pid, 0), /ESRCH/u);
      assert.deepEqual(await fs.readdir(path.join(f.base, 'scratch')), []);
      assert.ok((await f.commands()).some(call => call.args.includes('comments')));
    } catch (error) {
      const calls = await f.commands();
      const markerExists = await fs.stat(marker).then(() => true, () => false);
      const args = calls.at(-1)?.args ?? [];
      const phase = args.includes('comments') ? 'mutation' : args.includes('show') ? 'target-read'
        : args.includes('sql') ? 'verification' : args[0] === '--version' ? 'version' : 'none';
      throw new Error(`Cancellation readiness failed: source=${source}; marker=${markerExists}; commands=${calls.length}; phase=${phase}`, { cause: error });
    } finally {
      abort.abort();
      try { if (work) await work; }
      finally { await handshake.close(); }
    }
  }
}));


function snapshotExecutor(f) {
  const admission = createWorkspaceAdmission({ kind: 'service', profile: Symbol(), authority: async () => {
    f.state.membershipReads++;
    return f.state.active ? { principalId: PERSON, workspaceId: A, workspaceStatus: 'active',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), actions: ['tasks.read'] } : null;
  } });
  return createHostedTaskExecutor({ ...f.options, admission });
}

test('snapshot executes the ordinary fixed read batch in one owned profile with fresh admission for every command', () => fixture(async f => {
  const result = await snapshotExecutor(f).execute(request(), A, task({ kind: 'snapshot', closedSince: beadsClosedSince(Date.now()) }));
  const reads = Object.values(beadsPollArgs('.', beadsClosedSince(Date.now())));
  assert.deepEqual(Object.keys(result), Object.keys(beadsPollArgs('.', beadsClosedSince(Date.now()))));
  const commands = (await f.commands()).filter(row => !row.args.includes('sql') && row.args[0] !== '--version');
  assert.deepEqual(commands.map(row => row.args), reads.map(argv => ['--sandbox', '--readonly', '--json', '--actor=' + PERSON, ...argv.slice(2)]));
  assert.equal(new Set(commands.map(row => row.home)).size, 1);
  assert.ok(f.state.membershipReads >= reads.length + 3);
  assert.ok(commands.every(row => row.args.includes('--readonly') && !row.args.includes('-C')));
}));

test('snapshot required read failure stays failed and a between-read revoke cannot produce a stale photograph', () => fixture(async f => {
  await f.control({ failBlocked: true });
  const result = await snapshotExecutor(f).execute(request(), A, task({ kind: 'snapshot', closedSince: beadsClosedSince(Date.now()) }));
  assert.equal(result.blocked.code, 1); assert.equal(result.blocked.stdout, '');
  f.state.onDirectory = () => { if (f.state.directoryCalls > 20) f.state.active = false; };
  await refused(() => snapshotExecutor(f).execute(request(), A, task({ kind: 'snapshot', closedSince: beadsClosedSince(Date.now()) })));
  assert.equal(f.state.active, false);
}));

test('snapshot refuses nonservice principals and expanded historical windows before directory or credentials', () => fixture(async f => {
  await refused(() => f.executor.execute(request(), A, task({ kind: 'snapshot', closedSince: beadsClosedSince(Date.now()) })));
  await refused(() => snapshotExecutor(f).execute(request(), A, task({ kind: 'snapshot', closedSince: '2000-01-01' })));
  const demo = createWorkspaceAdmission({ kind: 'demo', profile: Symbol(), workspaceId: A, workspaceStatus: async () => 'active' });
  await refused(() => createHostedTaskExecutor({ ...f.options, admission: demo }).execute(request(), A,
    task({ kind: 'snapshot', closedSince: beadsClosedSince(Date.now()) })));
  assert.equal(f.state.directoryCalls, 0); assert.equal(f.state.resolves, 0);
  assert.deepEqual(await f.commands(), []);
}));
