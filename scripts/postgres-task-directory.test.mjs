import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {appendFileSync,existsSync,mkdtempSync,rmSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {stopLocalSecretReads} from './worker-config-folder.mjs';
import {findPostgres,LOOPBACK_HBA} from './postgres-dev.mjs';
import {openOnLoopbackPort} from './postgres-test-cluster.mjs';
import { skipWithoutPostgres } from './postgres-test-skip.mjs';
import {applyMigrations} from './postgres-migrate.mjs';
import {REPO_ROOT} from './test-config-isolation.mjs';
import {openTaskDirectory} from '../packages/postgres/src/task-directory.mjs';
import {openTaskCatalogSetup} from '../packages/postgres/src/task-catalog.mjs';

const require=createRequire(path.join(REPO_ROOT,'packages/postgres/package.json'));
const {Pool}=require('pg');
test('directory construction and malformed input open no socket',async()=>{
  let connections=0;
  const server=net.createServer(socket=>{connections++;socket.destroy();});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const reader=openTaskDirectory({connectionString:`postgresql://noticeos_task_directory:generated@127.0.0.1:${server.address().port}/fixture`});
  try{
    await assert.rejects(reader.project('invalid',randomUUID()),{name:'TaskDirectoryRefused'});
    await reader.close();
    assert.equal(connections,0);
  }finally{await reader.close();await new Promise(resolve=>server.close(resolve));}
});

test('established PostgreSQL socket stalls are bounded and retired',{timeout:10000},async()=>{
  const sockets=new Set();let queried=false;
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
    let startup=true;
    socket.on('data',bytes=>{
      if(startup){
        startup=false;
        // Minimal fixture handshake; deliberately withhold every query result.
        const auth=Buffer.alloc(9);auth[0]=82;auth.writeInt32BE(8,1);
        const ready=Buffer.from([90,0,0,0,5,73]);socket.write(Buffer.concat([auth,ready]));
      }else if(bytes[0]===81)queried=true;
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const reader=openTaskDirectory({connectionString:`postgresql://noticeos_task_directory:generated@127.0.0.1:${server.address().port}/fixture?sslmode=disable&query_timeout=0&statement_timeout=0`});
  try{
    const started=Date.now();
    await assert.rejects(reader.project(randomUUID(),randomUUID()),{name:'TaskDirectoryRefused',message:'Task directory connection refused'});
    assert.ok(queried);assert.ok(Date.now()-started<8000);
    await reader.close();
  }finally{
    await reader.close();
    // Fixture server owns these sockets; await normal client retirement first.
    for(const socket of sockets)await new Promise(resolve=>socket.once('close',resolve));
    await new Promise(resolve=>server.close(resolve));
  }
  assert.equal(sockets.size,0);
});

async function workerProof(root,connectionString,facts,revoke){
  const wranglerRequire=createRequire(createRequire(path.join(REPO_ROOT,'workers/ingest/package.json')).resolve('wrangler/package.json'));
  const wranglerPath=wranglerRequire.resolve('wrangler/package.json');
  const metadata=JSON.parse(readFileSync(wranglerPath,'utf8'));
  const build=path.join(root,'build');mkdirSync(build);
  const config=path.join(root,'wrangler.json');
  writeFileSync(config,JSON.stringify({name:'noticeos-directory-proof',main:path.join(REPO_ROOT,'scripts/task-directory-worker.fixture.mjs'),compatibility_date:'2026-07-06',compatibility_flags:['nodejs_compat'],send_metrics:false}));
  const home=path.join(root,'build-client');mkdirSync(home);
  const env={PATH:`${path.dirname(process.execPath)}:/usr/bin:/bin`,HOME:home,TMPDIR:root,
    XDG_CONFIG_HOME:path.join(home,'config'),XDG_CACHE_HOME:path.join(home,'cache'),
    NODE_OPTIONS:`--import=${path.join(REPO_ROOT,'scripts/script-tests-setup.mjs')}`,
    WRANGLER_SEND_METRICS:'false',WRANGLER_HIDE_BANNER:'true',DO_NOT_TRACK:'1',NO_COLOR:'1'};
  stopLocalSecretReads(env);
  const compiled=spawnSync(process.execPath,[path.join(path.dirname(wranglerPath),metadata.bin.wrangler),'deploy','--dry-run','--config',config,'--outdir',build],{cwd:root,env,encoding:'utf8',timeout:30000});
  assert.equal(compiled.error,undefined);assert.equal(compiled.status,0,compiled.stderr);
  const {Miniflare}=wranglerRequire('miniflare');let outside=0;
  const runtime=new Miniflare({modules:true,modulesRoot:build,scriptPath:path.join(build,'task-directory-worker.fixture.js'),
    compatibilityDate:'2026-07-06',compatibilityFlags:['nodejs_compat'],bindings:{FIXTURE_CONNECTION:connectionString},
    outboundService:async()=>{outside++;throw new Error('No outside HTTP');}});
  const read=async(workspace,project=facts.project)=>{
    const response=await runtime.dispatchFetch(`https://directory.example.test/?workspace=${workspace}&project=${project}`);
    return {status:response.status,body:await response.json()};
  };
  try{
    for(const [workspace,credential,database]of [[facts.a,facts.credentialA,facts.databaseA],[facts.b,facts.credentialB,facts.databaseB]]){
      assert.deepEqual(await read(workspace),{status:200,body:{workspaceId:workspace,projectId:facts.project,executorRef:facts.executor,credentialRef:credential,databaseKey:database}});
    }
    assert.deepEqual(await read(randomUUID()),{status:200,body:null});
    assert.deepEqual(await read(facts.a,randomUUID()),{status:200,body:null});
    assert.deepEqual(await read('invalid'),{status:403,body:{refused:true}});
    await revoke();
    assert.deepEqual(await read(facts.a),{status:200,body:null});
    assert.equal((await read(facts.b)).body.workspaceId,facts.b);
    assert.equal(outside,0);
  }finally{await runtime.dispose();}
}

test('platform task directory has immutable ownership and no customer grants',{timeout:60000},async t=>{
  const tools = findPostgres();
  const root=mkdtempSync(path.join(os.tmpdir(),'n-directory-'));
  let owner,admin,reader;const clients=[],readers=[];
  try{
    owner = await skipWithoutPostgres(t, () => openOnLoopbackPort(path.join(root,'pg'), tools)); if (!owner) return;
    admin=new Pool({host:owner.socketDir,port:owner.loopbackPort,database:'noticeos_dev',user:'postgres',max:2});
    applyMigrations(owner);
    const baseConnection=owner.applicationLogin().url();
    async function runtime(role){
      const password=randomBytes(32).toString('base64url');
      await admin.query(`ALTER ROLE ${role} LOGIN`);
      await admin.query(`ALTER ROLE ${role} PASSWORD '${password}'`);
      appendFileSync(path.join(owner.root,LOOPBACK_HBA),`host all ${role} 127.0.0.1/32 scram-sha-256\n`);
      execFileSync(tools.pgCtl,['reload','-D',path.join(owner.root,'data')],{stdio:'pipe'});
      const url=new URL(baseConnection);url.username=role;url.password=password;
      const client=new Pool({connectionString:url.href,max:2});clients.push(client);
      client.fixtureConnection=url.href;
      assert.equal((await client.query('SELECT session_user,current_user')).rows[0].session_user,role);
      return client;
    }
    const platform=await runtime('noticeos_platform'),directory=await runtime('noticeos_task_directory');
    const app=await runtime('noticeos_app'),identity=await runtime('noticeos_identity');
    const a=randomUUID(),b=randomUUID(),pa=randomUUID(),pb=pa;
    const executor=randomUUID(),credentialA=randomUUID(),credentialB=randomUUID();
    const databaseA='n_'+randomUUID().replaceAll('-',''),databaseB='n_'+randomUUID().replaceAll('-','');
    for(const id of[a,b])await admin.query("INSERT INTO noticeos.workspaces(workspace_id,slug,display_name) VALUES($1,$2,$2)",[id,`fixture-${id}`]);
    const insert='INSERT INTO noticeos_platform.task_project_directory(workspace_id,project_id,executor_ref,credential_ref,database_key) VALUES($1,$2,$3,$4,$5)';
    await platform.query(insert,[a,pa,executor,credentialA,databaseA]);
    await platform.query(insert,[b,pb,executor,credentialB,databaseB]);
    reader=await openTaskDirectory({connectionString:directory.fixtureConnection});
    readers.push(reader);
    const facts=await reader.project(a,pa);assert.ok(Object.isFrozen(facts));
    assert.deepEqual(facts,{workspaceId:a,projectId:pa,executorRef:executor,credentialRef:credentialA,databaseKey:databaseA});
    assert.equal(await reader.project(a,randomUUID()),null);
    await assert.rejects(reader.project('invalid',pa),{name:'TaskDirectoryRefused'});
    const wrongRole=openTaskDirectory({connectionString:platform.fixtureConnection});readers.push(wrongRole);
    await assert.rejects(wrongRole.project(a,pa),{name:'TaskDirectoryRefused',message:'Task directory connection refused'});
    assert.throws(()=>openTaskDirectory({connectionString:'postgresql://bad:do-not-echo@'}),{name:'TaskDirectoryRefused',message:'Task directory requires an explicit PostgreSQL connection'});
    // Separate factories coordinate through PostgreSQL, not an in-process queue.
    const peer=openTaskDirectory({connectionString:directory.fixtureConnection});readers.push(peer);
    const budget=()=>({deadline:Date.now()+30_000});
    let entered,release;const enteredPromise=new Promise(r=>{entered=r});
    const released=new Promise(r=>{release=r});let escaped;
    const held=reader.withProjectMutation(a,pa,budget(),async lease=>{
      escaped=lease;assert.deepEqual(await lease.project(),facts);entered();await released;
      assert.deepEqual(await lease.project(),facts);return 'retired';
    });
    await enteredPromise;
    await assert.rejects(peer.withProjectMutation(a,pa,budget(),async()=>assert.fail('busy callback ran')),
      {name:'TaskDirectoryRefused',message:'Task project is busy'});
    // Same opaque project UUID in another workspace is independent. Two held
    // pool slots still permit mapping refresh because each uses its own client.
    await reader.withProjectMutation(b,pb,budget(),async lease=>assert.equal((await lease.project()).workspaceId,b));
    release();assert.equal(await held,'retired');
    await assert.rejects(escaped.project(),{name:'TaskDirectoryRefused',message:'Task mutation lease is closed'});
    await assert.rejects(reader.withProjectMutation(a,pa,budget(),async()=>{throw new Error('owned synthetic failure')}),
      {name:'TaskDirectoryRefused',message:'Task mutation lease refused'});
    await peer.withProjectMutation(a,pa,budget(),async lease=>assert.deepEqual(await lease.project(),facts));
    // Aborting stops work, but the lock stays held until awaited retirement.
    const cancel=new AbortController();let cancelEntered,retire;
    const cancelReady=new Promise(r=>{cancelEntered=r}),retired=new Promise(r=>{retire=r});
    const cancelled=reader.withProjectMutation(a,pa,{...budget(),signal:cancel.signal},async lease=>{
      cancelEntered();await new Promise(r=>lease.signal.addEventListener('abort',r,{once:true}));await retired;
    });
    const cancelledAssertion=assert.rejects(cancelled,{name:'TaskDirectoryRefused'});
    await cancelReady;cancel.abort();
    await assert.rejects(peer.withProjectMutation(a,pa,budget(),async()=>assert.fail('early unlock')),
      {name:'TaskDirectoryRefused',message:'Task project is busy'});
    retire();await cancelledAssertion;
    await peer.withProjectMutation(a,pa,budget(),async()=>{});
    const lostUrl=new URL(directory.fixtureConnection),ownedName=`directory-loss-${randomUUID()}`;
    lostUrl.searchParams.set('application_name',ownedName);
    const losing=openTaskDirectory({connectionString:lostUrl.href});readers.push(losing);
    let lossEntered,lossRetire,lossObserved;
    const lossReady=new Promise(r=>{lossEntered=r}),lossCleanup=new Promise(r=>{lossRetire=r}),
      lossSignal=new Promise(r=>{lossObserved=r});
    let settled=false;
    const losingWork=losing.withProjectMutation(a,pa,budget(),async lease=>{
      lossEntered();await new Promise(r=>lease.signal.addEventListener('abort',r,{once:true}));
      lossObserved();await lossCleanup;
      await assert.rejects(lease.project(),{name:'TaskDirectoryRefused'});
    });
    const lossAssertion=assert.rejects(losingWork,{name:'TaskDirectoryRefused'}).then(()=>{settled=true});
    await lossReady;
    const ownedBackend=(await admin.query('SELECT pid FROM pg_catalog.pg_stat_activity WHERE application_name=$1 AND usename=$2',
      [ownedName,'noticeos_task_directory'])).rows;
    assert.equal(ownedBackend.length,1);
    assert.equal((await admin.query('SELECT pg_catalog.pg_terminate_backend($1) stopped',[ownedBackend[0].pid])).rows[0].stopped,true);
    await lossSignal;assert.equal(settled,false,'Connection loss waits for owned work cleanup');
    lossRetire();await lossAssertion;
    await peer.withProjectMutation(a,pa,budget(),async()=>{});
    const resolve='SELECT * FROM noticeos_platform.resolve_task_project($1::uuid,$2::uuid)';
    assert.deepEqual((await directory.query(resolve,[a,pa])).rows,[{workspace_id:a,project_id:pa,executor_ref:executor,credential_ref:credentialA,database_key:databaseA}]);
    assert.deepEqual((await directory.query(resolve,[randomUUID(),pb])).rows,[]);
    assert.deepEqual((await directory.query(resolve,[a,randomUUID()])).rows,[]);
    await assert.rejects(directory.query(resolve,['invalid',pa]),error=>error.code==='22P02');
    await assert.rejects(platform.query(insert,[b,randomUUID(),executor,randomUUID(),databaseA]),error=>error.code==='23505');
    await assert.rejects(platform.query(insert,[b,randomUUID(),randomUUID(),credentialA,databaseB]),error=>error.code==='23505');
    await assert.rejects(platform.query(insert,[a,randomUUID(),executor,randomUUID(),'caller/path']),error=>error.code==='23514');
    await assert.rejects(platform.query(insert,[randomUUID(),randomUUID(),executor,randomUUID(),'n_'+randomUUID().replaceAll('-','')]),error=>error.code==='23503');
    for(const column of['workspace_id','project_id','executor_ref','credential_ref','database_key'])
      await assert.rejects(platform.query(`UPDATE noticeos_platform.task_project_directory SET ${column}=${column}`),error=>error.code==='42501');
    await assert.rejects(platform.query('DELETE FROM noticeos_platform.task_project_directory'),error=>error.code==='42501');
    await assert.rejects(directory.query('SELECT * FROM noticeos_platform.task_project_directory'),error=>error.code==='42501');
    for(const client of[app,identity]){
      await assert.rejects(client.query(resolve,[a,pa]),error=>error.code==='42501');
      await assert.rejects(client.query('SELECT * FROM noticeos_platform.task_project_directory'),error=>error.code==='42501');
    }
    for(const client of[platform,directory]){
      await assert.rejects(client.query('SELECT * FROM noticeos.assets'),error=>error.code==='42501');
      await assert.rejects(client.query('SELECT * FROM noticeos_identity.auth_session'),error=>error.code==='42501');
      await assert.rejects(client.query('CREATE TABLE noticeos_platform.refused(id integer)'),error=>error.code==='42501');
      await assert.rejects(client.query('SET ROLE noticeos_owner'),error=>error.code==='42501');
    }
    await t.test('catalog setup is verified, audited, set-once and active-workspace scoped',async()=>{
      for(const id of[a,b])await admin.query('INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at) VALUES($1,$2,$2,now())',[id,`fixture-${id}`]);
      assert.deepEqual(await reader.catalog(a),[],'Old mappings are not silently adopted');
      let verifyCalls=0,deny=true;
      const setup=openTaskCatalogSetup({connectionString:platform.fixtureConnection,verifyProject:async(mapping,budget)=>{
        verifyCalls++;assert.equal(mapping.projectId,pa);assert.ok(Object.isFrozen(mapping));
        assert.equal(budget.expectedPrefix,'tt');assert.ok(budget.deadline>Date.now());
        if(deny)throw new Error('Synthetic physical verification refused');
      }});
      try{
        const configuration=workspaceId=>({workspaceId,projectId:pa,logicalKey:'example',displayName:'Example',prefix:'tt'});
        await assert.rejects(setup.configure(configuration(a)),{name:'TaskCatalogRefused'});
        assert.equal((await platform.query('SELECT count(*)::int AS count FROM noticeos_platform.task_project_catalog_changes')).rows[0].count,0);
        assert.deepEqual(await reader.catalog(a),[]);
        deny=false;await setup.configure(configuration(a));await setup.configure(configuration(b));
        assert.deepEqual(await reader.catalog(a),[],'Provisioning workspaces expose no runtime catalog');
        for(const id of[a,b])await admin.query("UPDATE noticeos.workspaces SET status='active' WHERE workspace_id=$1",[id]);
        const expected=[{projectId:pa,logicalKey:'example',displayName:'Example',prefix:'tt'}];
        const catalog=await reader.catalog(a);assert.deepEqual(catalog,expected);assert.ok(Object.isFrozen(catalog)&&Object.isFrozen(catalog[0]));
        assert.deepEqual(await reader.catalog(b),expected,'Colliding names/prefixes are separate workspace selectors');
        await setup.configure(configuration(a));
        assert.equal((await platform.query('SELECT count(*)::int AS count FROM noticeos_platform.task_project_catalog_changes')).rows[0].count,2,'Idempotency never invents a second audit');
        assert.deepEqual((await platform.query('SELECT DISTINCT actor::text AS actor FROM noticeos_platform.task_project_catalog_changes')).rows,[{actor:'noticeos_platform'}]);
        await assert.rejects(setup.configure({...configuration(a),displayName:'Changed'}),{name:'TaskCatalogRefused'});
        const before=verifyCalls;
        await assert.rejects(setup.configure({...configuration(a),actor:'forged'}),{name:'TaskCatalogRefused'});assert.equal(verifyCalls,before);
        await admin.query("UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=$1",[a]);
        assert.deepEqual(await reader.catalog(a),[]);
        await assert.rejects(setup.configure(configuration(a)),{name:'TaskCatalogRefused'});assert.equal(verifyCalls,before);
        await admin.query("UPDATE noticeos.workspaces SET status='active' WHERE workspace_id=$1",[a]);
        for(const column of['logical_key','display_name','issue_prefix'])
          await assert.rejects(platform.query(`UPDATE noticeos_platform.task_project_directory SET ${column}=${column}`),error=>error.code==='42501');
        for(const client of[app,identity,directory]){
          await assert.rejects(client.query('SELECT * FROM noticeos_platform.task_project_catalog_changes'),error=>error.code==='42501');
          await assert.rejects(client.query('SELECT noticeos_platform.lock_task_catalog($1,$2)',[a,pa]),error=>error.code==='42501');
        }
      }finally{await setup.close();}
    });
    await t.test('ordinary Worker reads same logical project separately and observes revocation',async()=>{
      await workerProof(root,directory.fixtureConnection,{a,b,project:pa,executor,credentialA,credentialB,databaseA,databaseB},async()=>{
        await platform.query('UPDATE noticeos_platform.task_project_directory SET revoked_at=clock_timestamp() WHERE workspace_id=$1 AND project_id=$2',[a,pa]);
      });
    });
    await platform.query('UPDATE noticeos_platform.task_project_directory SET revoked_at=clock_timestamp() WHERE workspace_id=$1 AND project_id=$2',[a,pa]);
    assert.deepEqual((await directory.query(resolve,[a,pa])).rows,[]);
    assert.equal(await reader.project(a,pa),null,'Previously returned mapping is not a lasting readiness or authority claim');
    assert.equal((await directory.query(resolve,[b,pb])).rows.length,1);
    const fn=(await admin.query("SELECT proconfig,provolatile,prosecdef FROM pg_proc WHERE oid='noticeos_platform.resolve_task_project(uuid,uuid)'::regprocedure")).rows[0];
    assert.deepEqual(fn,{proconfig:['search_path=pg_catalog, pg_temp'],provolatile:'s',prosecdef:true});
    assert.equal((await admin.query("SELECT has_function_privilege('public','noticeos_platform.resolve_task_project(uuid,uuid)','EXECUTE') allowed")).rows[0].allowed,false);
    for(const privilege of ['INSERT','UPDATE(revoked_at)']){
      await admin.query(`GRANT ${privilege} ON noticeos_platform.task_project_directory TO noticeos_task_directory`);
      const drift=openTaskDirectory({connectionString:directory.fixtureConnection});readers.push(drift);
      await assert.rejects(drift.project(b,pb),{name:'TaskDirectoryRefused',message:'Task directory connection refused'});
      await admin.query(`REVOKE ${privilege} ON noticeos_platform.task_project_directory FROM noticeos_task_directory`);
    }
    const originalFunction=(await admin.query("SELECT pg_get_functiondef('noticeos_platform.resolve_task_project(uuid,uuid)'::regprocedure) definition")).rows[0].definition;
    const budgetUrl=new URL(directory.fixtureConnection);
    for(const key of ['statement_timeout','lock_timeout','query_timeout'])budgetUrl.searchParams.set(key,'0');
    budgetUrl.searchParams.set('options','-c statement_timeout=0');
    const bounded=openTaskDirectory({connectionString:budgetUrl.href});readers.push(bounded);
    await bounded.project(b,pb);
    await admin.query(`CREATE OR REPLACE FUNCTION noticeos_platform.resolve_task_project(requested_workspace uuid,requested_project uuid)
      RETURNS TABLE(workspace_id uuid,project_id uuid,executor_ref uuid,credential_ref uuid,database_key text)
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
      BEGIN PERFORM pg_catalog.pg_sleep(8); RETURN; END $$`);
    const started=Date.now();
    await assert.rejects(bounded.project(b,pb),{name:'TaskDirectoryRefused',message:'Task directory read refused'});
    assert.ok(Date.now()-started<7000,'URL cannot disable the fixed server query deadline');
    await admin.query(originalFunction);
    const read=reader.project(b,pb);const close=reader.close();assert.equal(reader.close(),close);
    assert.equal((await read).workspaceId,b);await close;
    await assert.rejects(reader.project(b,pb),{name:'TaskDirectoryRefused',message:'Task directory is closed'});
  }finally{
    const closed=await Promise.allSettled([...readers.map(client=>client.close()),...clients.map(client=>client.end()),admin?.end()]);
    await owner?.close();assert.equal(existsSync(path.join(root,'pg','data','postmaster.pid')),false);
    rmSync(root,{recursive:true,force:true});
    for(const result of closed)if(result.status==='rejected')throw result.reason;
  }
});
