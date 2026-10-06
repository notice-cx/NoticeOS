import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { generateDemoScenario } from './demo-scenario.mjs';
import { captureHostedDemoServerOptions, readDemoArtifact, readHostedDemoRuntimeFile, startHostedDemoServer } from './hosted-demo-server.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const origin = 'https://demo.example.com', release = 'a'.repeat(64);
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'demo-gateway-'));
  for (const folder of ['client', 'tower', 'ingest', 'worker']) mkdirSync(path.join(root, folder));
  const bodies = { 'client/index.html': '<main>Compiled preview</main>', 'client/brand.zip': 'synthetic-design-system',
    'tower/main.js': `export default {async fetch(request,env){if(new URL(request.url).pathname==='/api/outside'){const refused=await fetch('https://example.invalid/');return new Response('denied:'+refused.status)}return new Response(await env.INGEST.echo(request.url))}}`,
    'ingest/main.js': `import {WorkerEntrypoint} from 'cloudflare:workers';export default class extends WorkerEntrypoint {echo(value){return 'private:'+value}}` };
  for (const [name, value] of Object.entries(bodies)) writeFileSync(path.join(root, name), value);
  const worker = name => ({ main: name + '/main.js', modulesRoot: name, compatibilityDate: '2026-07-06', compatibilityFlags: ['nodejs_compat'] });
  const manifest = { version: 1, release, client: 'client', tower: worker('tower'), ingest: worker('ingest'),
    files: Object.fromEntries(Object.entries(bodies).map(([name, value]) => [name, sha(value)])), publicFiles: ['client/index.html', 'client/brand.zip'] };
  const save = () => writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest)); save();
  const scenario = generateDemoScenario({ seed: 'gateway-fixture', cutoff: '2026-10-04T00:00:00.000Z', release: 'b'.repeat(40) });
  const workspaceId = scenario.manifest.workspaceId;
  const identity = { connectionString: 'postgres://identity:synthetic@127.0.0.1:6400/db', trustedOrigin: origin, sessionSecret: 'synthetic-fixture-session-secret' };
  const tool = { path: '/synthetic/tool', sha256: 'c'.repeat(64) };
  const tasks = { profile: 'demo', trustedOrigin: origin, demoWorkspaceId: workspaceId, identity,
    directoryConnectionString: 'postgres://directory:synthetic@127.0.0.1:6400/db', targets: [], binary: tool, doltBinary: tool, scratchRoot: root };
  const activity = { sourceRoot: root, scenario, workspaceId, serviceId: '11111111-1111-4111-8111-111111111111',
    connectionString: 'postgres://service:synthetic@127.0.0.1:6400/db', grantConnectionString: 'postgres://grant:synthetic@127.0.0.1:6400/db',
    directoryConnectionString: tasks.directoryConnectionString, projects: [], binary: tool, doltBinary: tool, scratchRoot: root };
  const options = { version: 1, publicOrigin: origin, listen: { host: '127.0.0.1', port: 6409 }, artifactRoot: root,
    workerStateRoot: path.join(root, 'worker'), workspaceDatabaseUrl: 'postgres://app:synthetic@127.0.0.1:6400/db', tasks, activity };
  return { root, manifest, save, options, close: () => rmSync(root, { recursive: true, force: true }) };
}
function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ host: '127.0.0.1', port: 6409, path: url, method, headers: { host: 'demo.example.com', ...headers } }, incoming => {
      const chunks = []; incoming.on('data', chunk => chunks.push(chunk)); incoming.on('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, text: Buffer.concat(chunks).toString() }));
    }); outgoing.on('error', reject); outgoing.end(body);
  });
}
function adapters(overrides = {}) {
  const calls = [], closed = [];
  const composed = { openTasks: async () => ({ handle: async proof => { calls.push({ lane: 'tasks', proof }); return Response.json({ projects: [] }); }, close: async () => { closed.push('tasks'); } }),
    startActivity: async () => ({ status: () => ({ running: true, error: null }), close: async () => { closed.push('activity'); } }),
    openWorkers: options => { calls.push({ lane: 'configuration', options }); return { getWorker: async () => ({}),
      dispatchFetch: async (url, init) => { calls.push({ lane: 'worker', proof: new Request(url, init) }); return Response.json({ mode: 'demo' }); },
      dispose: async () => { closed.push('workers'); } }; }, ...overrides };
  return { composed, calls, closed };
}

test('private config and artifact validation refuse overrides, private files and changed bytes before acquisition', () => {
  const f = fixture();
  try {
    assert.equal(captureHostedDemoServerOptions(f.options).publicOrigin, origin);
    for (const changed of [{ ...f.options, profile: 'standalone' }, { ...f.options, publicOrigin: 'http://demo.example.com' },
      { ...f.options, tasks: { ...f.options.tasks, trustedOrigin: 'https://other.example.com' } }]) assert.throws(() => captureHostedDemoServerOptions(changed));
    const runtime = path.join(f.root, 'runtime.json'); writeFileSync(runtime, JSON.stringify(f.options), { mode: 0o600 });
    assert.equal(readHostedDemoRuntimeFile(runtime).version, 1); chmodSync(runtime, 0o644); assert.throws(() => readHostedDemoRuntimeFile(runtime));
    assert.ok(readDemoArtifact(f.root).publicFiles.includes('client/brand.zip'));
    writeFileSync(path.join(f.root, 'client/.env'), 'synthetic'); f.manifest.files['client/.env'] = sha('synthetic'); f.manifest.publicFiles.push('client/.env'); f.save();
    assert.throws(() => readDemoArtifact(f.root)); f.manifest.publicFiles.pop(); f.save();
    writeFileSync(path.join(f.root, 'client/index.html'), 'changed'); assert.throws(() => readDemoArtifact(f.root));
  } finally { f.close(); }
});

test('actual HTTP gateway preserves original proof, refuses hostile Host/release and exposes only built routes', async () => {
  const f = fixture(), a = adapters(); let server;
  try {
    server = await startHostedDemoServer(f.options, a.composed);
    const startup = a.calls.length;
    assert.equal((await request('/api/config', { headers: { host: 'foreign.example.com', 'x-forwarded-host': 'demo.example.com' } })).status, 400);
    assert.equal((await request('/api/tasks', { method: 'POST', headers: { 'x-noticeos-release': 'd'.repeat(64) }, body: '{}' })).status, 409);
    assert.equal(a.calls.length, startup);
    const returned = await request('/api/tasks', { method: 'POST', headers: { origin: 'https://foreign.example.com', 'sec-fetch-site': 'cross-site',
      'x-forwarded-proto': 'https', forwarded: 'host=foreign.example.com', 'x-noticeos-workspace-id': 'foreign', 'content-type': 'application/json' }, body: '{"exact":true}' });
    assert.equal(returned.headers['x-noticeos-release'], release);
    const proof = a.calls.find(call => call.lane === 'tasks').proof;
    assert.equal(proof.url, origin + '/api/tasks'); assert.equal(proof.headers.get('origin'), 'https://foreign.example.com');
    assert.equal(proof.headers.get('sec-fetch-site'), 'cross-site'); assert.equal(proof.headers.get('forwarded'), null);
    assert.equal(proof.headers.get('x-forwarded-proto'), null); assert.equal(await proof.text(), '{"exact":true}');
    for (const address of ['/health', '/health/operations/job', '/workflows/job', '/assets/example.com/search', '/alerts/history', '/wall']) {
      assert.equal((await request(address)).text, '<main>Compiled preview</main>');
    }
    for (const address of ['/@vite/client', '/@fs/etc/passwd', '/src/main.tsx', '/manifest.json', '/client/.env', '/assets/missing.js.map']) assert.equal((await request(address)).status, 404);
    assert.equal((await request('/brand.zip')).status, 200);
    assert.equal((await request('/__noticeos_health')).status, 200);
    const config = a.calls.find(call => call.lane === 'configuration').options;
    assert.equal(config.host, '127.0.0.1'); assert.equal(config.cf, false); assert.equal(config.logRequests, false);
    assert.equal(config.defaultPersistRoot, f.options.workerStateRoot);
    assert.equal((await config.workers[0].outboundService(new Request('https://example.invalid/'))).status, 403);
  } finally { await server?.close(); assert.deepEqual(a.closed.sort(), ['activity', 'tasks', 'workers']); f.close(); }
});

test('startup failure closes each acquired capability without publishing a listener', async () => {
  const f = fixture(), a = adapters({ startActivity: async () => { throw new Error('synthetic'); } });
  try { await assert.rejects(startHostedDemoServer(f.options, a.composed)); assert.deepEqual(a.closed.sort(), ['tasks', 'workers']); }
  finally { f.close(); }
});

test('oversized request never reaches a capability and oversized response closes its owned connection', async () => {
  const f = fixture(), a = adapters(); let server;
  try {
    server = await startHostedDemoServer(f.options, a.composed);
    const refused = await request('/api/tasks', { method: 'POST', body: 'x'.repeat(256 * 1024 + 1) }).catch(error => {
      assert.equal(error.code, 'ECONNRESET'); return { status: 400 };
    });
    assert.equal(refused.status, 400);
    assert.equal(a.calls.filter(call => call.lane === 'tasks').length, 0);
  } finally { await server?.close(); f.close(); }
  const other = fixture(), oversized = adapters({ openTasks: async () => ({ handle: async () => new Response('x'.repeat(8 * 1024 * 1024 + 1)), close: async () => undefined }) });
  try {
    server = await startHostedDemoServer(other.options, oversized.composed);
    await assert.rejects(request('/api/tasks'), error => error.code === 'ECONNRESET');
  } finally { await server?.close(); other.close(); }
});

test('pinned actual workerd receives canonical public URL through private Worker RPC and denies external HTTP', async () => {
  const f = fixture(); const require = createRequire(new URL('../workers/ingest/package.json', import.meta.url));
  const wrangler = createRequire(require.resolve('wrangler/package.json')), { Miniflare, Log } = wrangler('miniflare');
  const a = adapters({ openWorkers: options => new Miniflare({ ...options, log: new Log(0) }) }); let server;
  try {
    server = await startHostedDemoServer(f.options, a.composed);
    assert.equal((await request('/api/proof')).text, 'private:https://demo.example.com/api/proof');
    assert.equal((await request('/api/outside')).text, 'denied:403');
  } finally { await server?.close(); f.close(); }
});


// Exercise the real launcher boundary with the pinned workerd, without databases.
function ownedGroupGone(pid, probe = process.kill) {
  try { probe(-pid, 0); return false; }
  catch (error) {
    // A Darwin group still being reaped may return EPERM. It remains unknown,
    // never absent, until the existing bounded wait obtains ESRCH.
    if (error.code === 'EPERM') return false;
    assert.equal(error.code, 'ESRCH'); return true;
  }
}
test('a refused group probe cannot authorize fixture deletion', () => {
  const refused = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
  assert.equal(ownedGroupGone(123, refused), false);
  assert.equal(ownedGroupGone(123, () => undefined), false);
  assert.equal(ownedGroupGone(123, () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); }), true);
  assert.throws(() => ownedGroupGone(123, () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); }), /EACCES/);
});
/** A port the kernel just had free: launches run side by side (issue #25). */
function loopbackPort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer().once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

async function launchFixture(t, mode, { signal = 'SIGTERM', group = false, graceMs = 3000 } = {}) {
  const f = fixture(), trace = path.join(f.root, 'trace.jsonl');
  f.options.listen.port = await loopbackPort();
  const runtimeFile = path.join(f.root, 'runtime.json'); writeFileSync(runtimeFile, JSON.stringify(f.options), { mode: 0o600 });
  const workerFile = path.join(f.root, 'runtime-child.mjs'), supervisorFile = path.join(f.root, 'supervisor.mjs');
  const url = name => pathToFileURL(path.resolve('scripts', name)).href;
  writeFileSync(workerFile, `
    import { readFileSync, appendFileSync } from 'node:fs';
    import { createRequire } from 'node:module';
    import { spawn } from 'node:child_process';
    import { runHostedDemoWorker } from ${JSON.stringify(url('hosted-demo-worker.mjs'))};
    import { startHostedDemoServer } from ${JSON.stringify(url('hosted-demo-server.mjs'))};
    const mode=${JSON.stringify(mode)}, trace=${JSON.stringify(trace)};
    const note=event=>appendFileSync(trace,JSON.stringify({event,pid:process.pid})+'\\n');
    const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const require=createRequire(${JSON.stringify(pathToFileURL(path.resolve('workers/ingest/package.json')).href)});
    const wrangler=createRequire(require.resolve('wrangler/package.json')); const {Miniflare,Log}=wrangler('miniflare');
    if(mode==='immediate-stop')await delay(150);
    try {
      await runHostedDemoWorker(process.argv[3], async file=>{
        note('startup-entered'); process.stdout.write('startup-entered\\n');
        if(mode==='startup-stop')await delay(150);
        const options=JSON.parse(readFileSync(file,'utf8'));
        const server=await startHostedDemoServer(options,{
          openTasks:async()=>{
            let command,closed;
            if(mode==='detached-normal'){
              command=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});
              closed=new Promise(resolve=>command.once('close',resolve));
              appendFileSync(trace,JSON.stringify({event:'descendant',pid:command.pid})+'\\n');
            }
            return {handle:async()=>Response.json({projects:[]}),close:async()=>{if(command){process.kill(-command.pid,'SIGTERM');await closed}await delay(50);note('tasks-closed')}};
          },
          openWorkers:opts=>{
            const mf=new Miniflare({...opts,log:new Log(0),handleRuntimeStdio:(out,err)=>{out.resume();err.resume()}});
            return {getWorker:name=>mf.getWorker(name),dispatchFetch:(...args)=>mf.dispatchFetch(...args),dispose:async()=>{await mf.dispose();note('workers-closed')}};
          },
          startActivity:async()=>{
            if(mode==='startup-failure')throw new Error('synthetic startup');
            return {status:()=>({running:true,error:null}),close:async()=>{await delay(80);note('activity-closed');if(mode==='close-failure')throw new Error('synthetic close')}};
          }
        });
        note('runtime-acquired');
        if(mode==='disconnect'||mode==='disconnect-deadline'){setImmediate(()=>process.disconnect())}
        if(mode==='unexpected-exit'||mode==='deadline'||mode==='orphan-deadline'||mode==='disconnect-deadline'||mode==='fixture-failure'){
          const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});
          appendFileSync(trace,JSON.stringify({event:'descendant',pid:descendant.pid})+'\\n');
          if(mode==='unexpected-exit')setImmediate(()=>process.exit(7));
        }
        return {close:async()=>{note('close-start');if(mode==='deadline'||mode==='orphan-deadline'||mode==='disconnect-deadline')await new Promise(()=>{});await server.close();note('close-complete')}};
      },{graceMs:mode==='orphan-deadline'?300:3000});
    }catch{note('failed');process.exitCode=1}
  `);
  writeFileSync(supervisorFile, `
    import {appendFileSync} from 'node:fs';
    import {tracingChannel} from 'node:diagnostics_channel';
    import {superviseHostedDemo} from ${JSON.stringify(url('hosted-demo-serve.mjs'))};
    const trace=${JSON.stringify(trace)};
    const channel=tracingChannel('child_process.spawn');
    const observer={end:({process:child})=>{
      child.once('spawn',()=>appendFileSync(trace,JSON.stringify({event:'runtime-forked',pid:child.pid})+'\\n'));
      child.on('message',message=>{
        if(message?.type==='noticeos-demo-group-owned'||message?.type==='noticeos-demo-group-closed')
          appendFileSync(trace,JSON.stringify({event:message.type,pid:message.pid,lease:message.lease,keys:Object.keys(message).sort()})+'\\n');
      });
    }};
    channel.subscribe(observer);
    const sentinel=()=>appendFileSync(trace,JSON.stringify({event:'unrelated-signal-listener'})+'\\n');
    process.on('SIGTERM',sentinel);
    const pending=superviseHostedDemo(${JSON.stringify(runtimeFile)}, {worker:new URL(${JSON.stringify(pathToFileURL(workerFile).href)}),graceMs:${graceMs}});
    if(${JSON.stringify(mode)}==='immediate-stop')process.kill(process.pid,'SIGTERM');
    process.exitCode=await pending;
    channel.unsubscribe(observer);
    appendFileSync(trace,JSON.stringify({event:'supervisor-closed',code:process.exitCode,sentinelKept:process.listeners('SIGTERM').includes(sentinel)})+'\\n');
    process.off('SIGTERM',sentinel);
  `);
  const child=spawn(process.execPath,[supervisorFile],{env:process.env,detached:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',timer;
  child.stdout.on('data',chunk=>{stdout+=chunk}); child.stderr.on('data',chunk=>{stderr+=chunk});
  const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  const events=(publishedOnly=false)=>{
    const text=readFileSync(trace,'utf8');
    const lines=publishedOnly?text.split('\n').slice(0,-1):text.trim().split('\n');
    return lines.map(line=>JSON.parse(line));
  };
  const gone=pid=>{try{process.kill(pid,0);return false}catch(error){assert.equal(error.code,'ESRCH');return true}};
  const wait=predicate=>new Promise((resolve,reject)=>{
    const until=setTimeout(()=>{clearInterval(check);reject(new Error('Owned fixture deadline: '+stdout+' '+stderr))},7000);
    const check=setInterval(()=>{if(predicate()){clearTimeout(until);clearInterval(check);resolve()}},10);
  });
  try {
    if(!['startup-failure','disconnect','disconnect-deadline','unexpected-exit','immediate-stop'].includes(mode)){
      await wait(()=>stdout.includes(mode==='startup-stop'?'startup-entered':'Demo preview ready.'));
      // Readiness arrives on stdout; detached-child custody arrives on IPC.
      // Acquire the recorded child before interrupting either process.
      if(['deadline','orphan-deadline','fixture-failure','detached-normal'].includes(mode))await wait(()=>{
        const saved=events(true),descendants=saved.filter(record=>record.event==='descendant');
        return descendants.length===1&&descendants.every(record=>
          saved.some(owned=>owned.event==='noticeos-demo-group-owned'&&owned.pid===record.pid));
      });
      if(mode==='fixture-failure')assert.fail('Synthetic fixture assertion after acquisition');
      if(mode==='orphan-deadline')child.kill('SIGKILL');else if(group)process.kill(-child.pid,signal);else child.kill(signal);
    }
    const result=await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Supervisor failed to close')),8000)})]);clearTimeout(timer);
    const saved=events();
    for(const record of saved.filter(x=>x.event.startsWith('noticeos-demo-group-')))
      assert.deepEqual(record.keys,['lease','pid','type']);
    for(const record of saved.filter(x=>x.event==='descendant'))
      assert.ok(saved.some(x=>x.event==='noticeos-demo-group-owned'&&x.pid===record.pid),'detached command custody published');
    if(mode==='detached-normal')for(const record of saved.filter(x=>x.event==='descendant'))
      assert.ok(saved.some(x=>x.event==='noticeos-demo-group-closed'&&x.pid===record.pid),'closed command custody revoked');
    for(const record of saved.filter(x=>x.event==='descendant'))await wait(()=>gone(record.pid));
    assert.equal(gone(child.pid),true);
    if(mode==='orphan-deadline'){
      const runtime=saved.find(x=>x.event==='runtime-acquired');
      await wait(()=>gone(runtime.pid));
      assert.equal(result.signal,'SIGKILL');assert.ok(saved.some(x=>x.event==='close-start'));
      t.diagnostic(JSON.stringify({mode,supervisorPid:child.pid,events:saved,result,stderr}));
      return;
    }
    assert.equal(saved.at(-1).event,'supervisor-closed');assert.equal(saved.at(-1).sentinelKept,true);
    if(['startup-failure','close-failure','unexpected-exit','deadline','disconnect-deadline'].includes(mode))assert.equal(result.code,1);else assert.equal(result.code,0);
    assert.equal(result.signal,null);
    if(['normal','detached-normal','startup-stop','disconnect','close-failure','immediate-stop'].includes(mode)){
      for(const event of ['tasks-closed','activity-closed','workers-closed'])assert.ok(saved.some(x=>x.event===event),event);
      if(mode!=='close-failure')assert.ok(saved.some(x=>x.event==='close-complete'));
    }
    if(mode==='startup-failure')for(const event of ['tasks-closed','workers-closed'])assert.ok(saved.some(x=>x.event===event),event);
    if(mode==='startup-stop')assert.equal(stdout.includes('Demo preview ready.'),false);
    if(mode==='normal'&&signal==='SIGTERM')assert.ok(saved.some(x=>x.event==='unrelated-signal-listener'));
    t.diagnostic(JSON.stringify({mode,signal,group,supervisorPid:child.pid,events:saved,result,stderr}));
  }finally{
    clearTimeout(timer);
    const recorded=existsSync(trace)?events():[];
    const groups=[...new Set(recorded.filter(x=>x.event==='runtime-forked'||x.event==='startup-entered'||x.event==='runtime-acquired'||x.event==='descendant').map(x=>x.pid))];
    const descendants=recorded.filter(x=>x.event==='descendant').map(x=>x.pid);
    const groupGone=ownedGroupGone;
    for(const pid of groups){
      if(!groupGone(pid)){try{process.kill(-pid,'SIGKILL')}catch(error){if(error.code!=='ESRCH'&&error.code!=='EPERM')throw error}}
    }
    if(child.exitCode===null&&child.signalCode===null){try{process.kill(-child.pid,'SIGKILL')}catch(error){if(error.code!=='ESRCH')throw error}}
    await closed;
    for(const pid of groups)await wait(()=>groupGone(pid));
    for(const pid of descendants)await wait(()=>gone(pid));
    assert.equal(gone(child.pid),true);
    assert.ok(groups.length,'Unknown runtime ownership: retain fixture '+f.root);
    t.diagnostic(JSON.stringify({cleanup:{supervisorPid:child.pid,runtimeGroups:groups,descendantPids:descendants,allAbsentBeforeFixtureRemoval:true}}));
    f.close();
  }
}

// Each launch owns its fixture folder, port and process groups, so four run
// at once (issue #25): in series they were 13 launches end to end.
describe('supervised fixture launches', { concurrency: 4 }, () => {
  test('real SIGTERM supervisor awaits task, activity and pinned Miniflare closure', {timeout:15000}, t=>launchFixture(t,'normal'));
  test('terminal-group SIGINT reaches supervisor while isolated runtime closes normally', {timeout:15000}, t=>launchFixture(t,'normal',{signal:'SIGINT',group:true}));
  test('stop during startup is latched and acquired capabilities close before exit', {timeout:15000}, t=>launchFixture(t,'startup-stop'));
  test('startup failure retires acquired pinned Worker and task capabilities', {timeout:15000}, t=>launchFixture(t,'startup-failure'));
  test('cleanup failure remains nonzero after all other capabilities close', {timeout:15000}, t=>launchFixture(t,'close-failure'));
  test('IPC disconnect initiates awaited runtime closure', {timeout:15000}, t=>launchFixture(t,'disconnect'));
  test('unexpected runtime exit retires its exact remaining descendant group', {timeout:15000}, t=>launchFixture(t,'unexpected-exit'));
  test('shutdown deadline retires only the exact runtime group and reports failure', {timeout:15000}, t=>launchFixture(t,'deadline',{graceMs:200}));

  test('lost supervisor leaves bounded orphan cleanup in the exact runtime group', {timeout:15000}, t=>launchFixture(t,'orphan-deadline'));

  test('TERM immediately after fork remains latched before runtime IPC listener exists', {timeout:15000}, t=>launchFixture(t,'immediate-stop'));

  test('lost runtime IPC starts supervisor deadline even without an OS signal', {timeout:15000}, t=>launchFixture(t,'disconnect-deadline',{graceMs:200}));

  test('assertion failure after acquisition awaits detached runtime and descendant retirement before fixture removal', {timeout:15000}, async t=>{await assert.rejects(launchFixture(t,'fixture-failure'),/Synthetic fixture assertion after acquisition/)});

  test('normal shutdown awaits detached executor-shaped command and revokes its custody without secret IPC', {timeout:15000}, t=>launchFixture(t,'detached-normal'));
});
