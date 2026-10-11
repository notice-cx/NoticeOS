import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildApplicationImage, prepareDeployment, applyDeployment, readDeploymentPlan, main } from './stack-deploy.mjs';
import { runCommand } from './run-command.mjs';

const OLD = 'sha256:' + 'b'.repeat(64);
const NEW = 'sha256:' + 'a'.repeat(64);
const required = ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.base.json','LICENSE','THIRD_PARTY_NOTICES.md',
  'deploy/compose/licenses/beads-1.3.1-LICENSE.txt','deploy/compose/licenses/dolt-2.4.0-LICENSE.txt','deploy/compose/licenses/sources.json',
  'apps/tower/wrangler.jsonc','workers/ingest/wrangler.jsonc','db/postgres/tables.json','db/postgres/roles.sql',
  'db/postgres/migrations/0001_baseline.sql','deploy/compose/Dockerfile','deploy/compose/entrypoint.mjs','deploy/compose/development.mjs','deploy/compose/health.mjs'];
function fixture(t) {
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'noticeos-deploy-test-'));
  t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
  const root=path.join(parent,'source'); fs.mkdirSync(root);
  const env={PATH:process.env.PATH,HOME:parent,TMPDIR:parent,DO_NOT_FORWARD:'PRIVATE-SENTINEL'};
  const write=(file,body='public')=>{ const target=path.join(root,file); fs.mkdirSync(path.dirname(target),{recursive:true}); fs.writeFileSync(target,body); };
  required.forEach(file=>write(file)); write('apps/tower/src/App.tsx');
  write('installation/private.json','PRIVATE-SENTINEL'); write('.beads/config.yaml','PRIVATE-SENTINEL');
  const git=(...args)=>execFileSync('git',args,{cwd:root,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('-c','init.defaultBranch=main','init'); git('config','user.name','Synthetic'); git('config','user.email','synthetic@example.com');
  const commit=()=>{git('add','.');git('-c','core.hooksPath=/dev/null','commit','-m','synthetic');return git('rev-parse','HEAD');};
  const baselineCommit=commit();
  const composeFile=path.join(parent,'compose.json'); const envFile=path.join(parent,'compose.env'); const selectorFile=path.join(parent,'stack.json');
  const selector={project:'synthetic',files:[composeFile],envFile,dockerHost:'unix:///fixture/docker.sock'};
  const model={name:'synthetic',services:{noticeos:{image:OLD,read_only:true,volumes:[{type:'bind',source:'/fixture/state',target:'/state'}],environment:{INTERNAL:'PRIVATE-SENTINEL'}},postgres:{image:'postgres:fixture'},dolt:{image:'dolt:fixture'},backup:{image:'backup:fixture'}}};
  fs.writeFileSync(composeFile,JSON.stringify(model)); fs.writeFileSync(envFile,'PRIVATE-SENTINEL'); fs.writeFileSync(selectorFile,JSON.stringify(selector));
  const containers=Object.fromEntries(['noticeos','postgres','dolt','backup'].map((name,i)=>[name,{
    Id:String(i+1).repeat(64),Image:i===0?OLD:'sha256:'+String(i+2).repeat(64),
    Config:{Labels:{'com.docker.compose.project':'synthetic','com.docker.compose.service':name}},
    State:{Status:'running',Health:{Status:'healthy'}},Mounts:[{Type:'bind',Source:'/fixture/'+name,Destination:'/state',RW:true}],
  }]));
  const images=new Map([[OLD,{Id:OLD,Os:'linux',Architecture:'arm64',Config:{Labels:{}}}]]);
  const calls=[]; const contexts=[]; let output=''; let updates=0;
  const control={database:{ok:true},databaseCalls:0,failUpdate:false,failRecovery:false,drift:false,extraConfig:false,builtImage:NEW,timedOut:false,foreignApp:false,buildThrows:false,buildTimeout:false};
  const run=async(command,args,options)=>{
    if(command==='git') {assert.equal(options.cwd,root);return runCommand(command,args,{...options,env});}
    assert.equal(command,'docker'); assert.equal(args[0],'--host'); assert.equal(args[1],selector.dockerHost);
    assert.equal(options.env.DO_NOT_FORWARD,undefined); assert.ok(options.timeoutMs<=600000);
    const step=args.slice(2); calls.push(step);
    if(step[0]==='build') {
      const context=step.at(-1); contexts.push(path.dirname(context));
      if(control.buildThrows) throw new Error('PRIVATE-SENTINEL');
      if(control.buildTimeout) return {code:124,timedOut:true,stdout:''};
      assert.equal(fs.existsSync(path.join(context,'installation')),false); assert.equal(fs.existsSync(path.join(context,'.beads')),false);
      const version=JSON.parse(fs.readFileSync(path.join(context,'container-source.json'),'utf8')).version;
      assert.equal(version.commit,git('rev-parse','HEAD'));assert.equal(version.modified,false);
      assert.ok(Number.isFinite(Date.parse(version.committedAt)));
      const labels=Object.fromEntries(step.flatMap((word,i)=>word==='--label'?[step[i+1].split('=')]:[]));
      images.set(control.builtImage,{Id:control.builtImage,Os:'linux',Architecture:'arm64',Config:{Labels:labels}});
      fs.writeFileSync(step[step.indexOf('--iidfile')+1],control.builtImage);
      return {code:0,stdout:''};
    }
    if(step[0]==='image') {const row=images.get(step[2]);return {code:row?0:1,stdout:JSON.stringify(row?[row]:[])};}
    if(step[0]==='inspect') return {code:0,stdout:JSON.stringify(Object.values(containers).filter(row=>row.Id===step[1]))};
    assert.equal(step[0],'compose');assert.equal(step[2],selector.project);
    const files=step.flatMap((word,i)=>word==='-f'?[step[i+1]]:[]); const end=step.indexOf('--env-file');assert.equal(step[end+1],envFile);
    const action=step.slice(end+2);
    const config=()=>{const current=structuredClone(model);for(const file of files.slice(1)) Object.assign(current.services.noticeos,JSON.parse(fs.readFileSync(file,'utf8')).services.noticeos);
      if(control.extraConfig && files.length>1) current.services.postgres.image='changed'; return current;};
    if(action[0]==='config') return {code:0,stdout:JSON.stringify(config())};
    if(action[0]==='ps') return {code:0,stdout:JSON.stringify(Object.entries(containers).map(([Service,row])=>({Project:'synthetic',Service,ID:row.Id,State:row.State.Status,Health:row.State.Health.Status})))};
    assert.deepEqual(action,['up','--detach','--no-deps','--no-build','--pull','never','--force-recreate','--wait','--wait-timeout','90','noticeos']);
    assert.equal(options.timeoutMs,130000);updates++;
    const image=config().services.noticeos.image; const failed=updates===1?control.failUpdate:control.failRecovery;
    containers.noticeos={...containers.noticeos,Id:(updates===1?'e':'f').repeat(64),Image:image,Config:{Labels:{...containers.noticeos.Config.Labels,...images.get(image).Config.Labels}},State:{Status:'running',Health:{Status:failed?'unhealthy':'healthy'}}};
    if(control.drift) containers.postgres.Id='c'.repeat(64);
    if(control.foreignApp) containers.noticeos.Image='sha256:'+'d'.repeat(64);
    return {code:failed?1:0,timedOut:control.timedOut,stdout:'',stderr:'PRIVATE-SENTINEL'};
  };
  const out={write:value=>{output+=value;}};
  const database=async(declared,{root:checked})=>{control.databaseCalls++;assert.deepEqual(declared,selector);assert.equal(checked,root);return control.database;};
  const options={root,selectorFile,baselineCommit,run,env,out,database};
  return {parent,root,write,git,commit,baselineCommit,selectorFile,selector,composeFile,model,containers,images,calls,contexts,control,options,output:()=>output,
    prepare:()=>prepareDeployment(options),build:()=>buildApplicationImage({...options,dockerHost:selector.dockerHost,platform:'linux/arm64'}),
    writes:()=>calls.filter(call=>call[0]==='compose'&&call.includes('up'))};
}

test('artifact preparation binds public committed bytes to main and removes its own context',async t=>{
  const f=fixture(t); const built=await f.build();
  assert.equal(built.commit,f.baselineCommit);assert.equal(built.image,NEW);assert.match(built.source,/^[a-f0-9]{64}$/);
  assert.deepEqual(f.calls.map(call=>call[0]),['build','image']);assert.equal(f.writes().length,0);
  assert.ok(f.contexts.every(dir=>!fs.existsSync(dir)));assert.ok(!f.output().includes('PRIVATE-SENTINEL'));
});
test('dirty source and committed symlinks refuse before Docker access',async t=>{
  const f=fixture(t);f.write('apps/tower/src/App.tsx','changed');await assert.rejects(f.build(),/clean checkout/);assert.equal(f.calls.length,0);
  f.git('restore','apps/tower/src/App.tsx');fs.unlinkSync(path.join(f.root,'apps/tower/src/App.tsx'));fs.symlinkSync('/fixture/private',path.join(f.root,'apps/tower/src/App.tsx'));f.commit();
  await assert.rejects(f.build(),/symlinks/);assert.equal(f.calls.length,0);
});
test('first deployment requires the recorded old source and refuses role changes',async t=>{
  const f=fixture(t);await assert.rejects(prepareDeployment({...f.options,baselineCommit:null}),/no schema revision/);
  f.write('db/postgres/roles.sql','changed permissions');f.commit();await assert.rejects(f.prepare(),/changes the Postgres roles; that is operator maintenance/);assert.equal(f.writes().length,0);assert.ok(!f.calls.some(call=>call[0]==='build'));
  assert.equal(f.control.databaseCalls,0);
});
test('main with a new migration updates only once the database has it',async t=>{
  const f=fixture(t);f.write('db/postgres/migrations/0002_next.sql','select 1;');f.commit();
  f.control.database={ok:false,line:'the database is 1 migration behind this code; pnpm os:migrate -- --apply brings it up to date'};
  await assert.rejects(f.prepare(),/does not have yet: the database is 1 migration behind this code; pnpm os:migrate -- --apply brings it up to date\. Then run the update again/);
  assert.ok(!f.calls.some(call=>call[0]==='build'));assert.equal(f.writes().length,0);
  f.control.database={ok:true};const plan=await f.prepare();
  assert.equal(plan.commit,f.git('rev-parse','HEAD'));assert.equal(f.writes().length,0);
});
test('an unchanged schema never asks the database',async t=>{
  const f=fixture(t);await f.prepare();assert.equal(f.control.databaseCalls,0);
});
test('at a terminal the update shows its plan and applies only what was confirmed',async t=>{
  const f=fixture(t);const questions=[];
  const ask=answer=>async q=>{questions.push(q);return answer;};
  assert.equal(await main(['--config',f.selectorFile,'--baseline-commit',f.baselineCommit],{...f.options,interactive:true,question:ask('')}),0);
  assert.match(questions[0],/Type update to apply it/);assert.equal(f.writes().length,0);assert.match(f.output(),/Nothing was changed\. To apply this plan later: pnpm os:update -- --apply/);
  assert.equal(await main(['--config',f.selectorFile,'--baseline-commit',f.baselineCommit],{...f.options,interactive:true,question:ask('update')}),0);
  assert.equal(f.writes().length,1);assert.match(f.output(),/Deployed /);
});
test('without a terminal the update prepares and prints the command that applies it',async t=>{
  const f=fixture(t);
  assert.equal(await main(['--config',f.selectorFile,'--baseline-commit',f.baselineCommit],{...f.options,interactive:false}),0);
  assert.equal(f.writes().length,0);assert.match(f.output(),/To apply it: pnpm os:update -- --apply '\/.+\.json'/);
});
test('a prepared image can be reused without building or changing existing services',async t=>{
  const f=fixture(t);const built=await f.build();f.calls.length=0;
  const plan=await prepareDeployment({...f.options,preparedImage:built.image});
  assert.equal(plan.image,built.image);assert.equal(readDeploymentPlan(plan.file).commit,built.commit);
  assert.ok(!f.calls.some(call=>call[0]==='build'));assert.equal(f.writes().length,0);
});
test('application update preserves siblings/mounts, pins the selector and records rollback',async t=>{
  const f=fixture(t);const plan=await f.prepare();const siblings=structuredClone(f.containers);const prior=fs.readFileSync(f.composeFile,'utf8');
  await applyDeployment(plan.file,f.options);
  assert.equal(f.writes().length,1);for(const name of ['postgres','dolt','backup']) assert.deepEqual(f.containers[name],siblings[name]);
  assert.deepEqual(f.containers.noticeos.Mounts,siblings.noticeos.Mounts);assert.equal(f.containers.noticeos.Image,NEW);assert.equal(fs.readFileSync(f.composeFile,'utf8'),prior);
  const selector=JSON.parse(fs.readFileSync(f.selectorFile,'utf8'));assert.equal(selector.files.length,2);assert.ok(selector.files[1].endsWith('/current.json'));
  const previous=JSON.parse(fs.readFileSync(path.join(f.parent,'stack-deploy/previous.json'),'utf8'));assert.equal(previous.image,OLD);assert.equal(previous.commit,f.baselineCommit);
  assert.equal(fs.existsSync(path.join(f.parent,'stack-deploy/lock')),false);assert.ok(!f.output().includes('PRIVATE-SENTINEL'));
  const rollback=await prepareDeployment({...f.options,rollback:true});assert.equal(rollback.source,null);assert.equal(rollback.legacySource,true);
  await applyDeployment(rollback.file,f.options);assert.equal(f.containers.noticeos.Image,OLD);
});
test('a second deployment compares the existing active override before replacing it',async t=>{
  const f=fixture(t);await applyDeployment((await f.prepare()).file,f.options);
  f.write('apps/tower/src/App.tsx','next release');f.commit();f.control.builtImage='sha256:'+'c'.repeat(64);
  const next=await f.prepare();await applyDeployment(next.file,f.options);assert.equal(f.containers.noticeos.Image,f.control.builtImage);
  assert.equal(JSON.parse(fs.readFileSync(f.selectorFile,'utf8')).files.length,2);
});
test('tampered plan, replaced containers and changed declarations refuse before update without overwriting operator input',async t=>{
  for(const defect of ['plan','container','input','main','image']) {
    const f=fixture(t);const plan=await f.prepare();
    if(defect==='plan') fs.appendFileSync(plan.file,' ');
    if(defect==='container') f.containers.postgres.Id='c'.repeat(64);
    if(defect==='input') fs.appendFileSync(f.composeFile,' ');
    if(defect==='main') {f.write('apps/tower/src/App.tsx','changed');f.commit();}
    if(defect==='image') f.images.get(NEW).Config.Labels['org.opencontainers.image.revision']='d'.repeat(40);
    const input=fs.readFileSync(f.composeFile,'utf8');const selector=fs.readFileSync(f.selectorFile,'utf8');
    await assert.rejects(applyDeployment(plan.file,f.options));assert.equal(f.writes().length,0);
    assert.equal(fs.readFileSync(f.composeFile,'utf8'),input);assert.equal(fs.readFileSync(f.selectorFile,'utf8'),selector);
    assert.equal(fs.existsSync(path.join(f.parent,'stack-deploy/lock')),false);
  }
});
test('effective changes beyond app image refuse before update and a concurrent deploy keeps its lock',async t=>{
  const f=fixture(t);const plan=await f.prepare();f.control.extraConfig=true;await assert.rejects(applyDeployment(plan.file,f.options),/more than/);assert.equal(f.writes().length,0);
  const lock=path.join(f.parent,'stack-deploy/lock');fs.writeFileSync(lock,'other owner');await assert.rejects(applyDeployment(plan.file,f.options),/stack lock/);assert.equal(fs.readFileSync(lock,'utf8'),'other owner');
});
test('failed health restores only the previous app image and leaves the original selector intact',async t=>{
  const f=fixture(t);const plan=await f.prepare();const selector=fs.readFileSync(f.selectorFile,'utf8');const siblings=structuredClone(f.containers);f.control.failUpdate=true;
  await assert.rejects(applyDeployment(plan.file,f.options),/previous image is healthy again/);assert.equal(f.writes().length,2);assert.equal(f.containers.noticeos.Image,OLD);
  for(const name of ['postgres','dolt','backup']) assert.deepEqual(f.containers[name],siblings[name]);assert.equal(fs.readFileSync(f.selectorFile,'utf8'),selector);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.parent,'stack-deploy/journal.json'),'utf8')).phase,'rolled-back');
});
test('unrelated drift or failed recovery retains a recovery journal and never mutates databases',async t=>{
  for(const drift of [true,false]) {
    const f=fixture(t);const plan=await f.prepare();f.control.failUpdate=true;f.control.failRecovery=true;f.control.drift=drift;
    await assert.rejects(applyDeployment(plan.file,f.options),/operator recovery/);assert.equal(f.writes().length,drift?1:2);
    const journal=JSON.parse(fs.readFileSync(path.join(f.parent,'stack-deploy/journal.json'),'utf8'));assert.equal(journal.phase,'recovery-required');assert.equal(journal.previousImage,OLD);assert.ok(fs.existsSync(plan.file));
    assert.ok(fs.existsSync(path.join(f.parent,'stack-deploy/lock')));
  }
});
test('CLI rejects conflicting or duplicate modes without reading a selector or connecting',async()=>{
  let output='';const out={write:value=>{output+=value;}};const run=()=>{throw new Error('PRIVATE-SENTINEL');};
  assert.equal(await main(['--help'],{out,err:out,run}),0);
  for(const args of [['--apply','/unused','--prepare'],['--prepare','--prepare'],['--build-only','--config','/unused'],['--rollback','--image',NEW],['--docker-host','unix:///unused']]) assert.equal(await main(args,{out,err:out,run}),1);
  assert.ok(!output.includes('PRIVATE-SENTINEL'));
});

test('uncertain timeout or a foreign replacement refuses automatic recovery',async t=>{
  for(const timedOut of [true,false]) {
    const f=fixture(t);const plan=await f.prepare();f.control.failUpdate=true;
    f.control.timedOut=timedOut;f.control.foreignApp=!timedOut;
    await assert.rejects(applyDeployment(plan.file,f.options),/operator recovery/);assert.equal(f.writes().length,1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.parent,'stack-deploy/journal.json'),'utf8')).phase,'recovery-required');
    assert.ok(fs.existsSync(path.join(f.parent,'stack-deploy/lock')));
  }
});
test('journal failures still recover the app and restore the prior rollback record',async t=>{
  const f=fixture(t);await applyDeployment((await f.prepare()).file,f.options);
  const previousFile=path.join(f.parent,'stack-deploy/previous.json');const previous=fs.readFileSync(previousFile,'utf8');const selector=fs.readFileSync(f.selectorFile,'utf8');
  f.write('apps/tower/src/App.tsx','next');f.commit();f.control.builtImage='sha256:'+'c'.repeat(64);const plan=await f.prepare();
  let healthyFailed=false;
  const persist=(file,bytes)=>{
    if(file.endsWith('/journal.json') && (healthyFailed || JSON.parse(bytes).phase==='healthy')) {healthyFailed=true;throw new Error('synthetic full disk');}
    fs.writeFileSync(file,bytes);
  };
  await assert.rejects(applyDeployment(plan.file,{...f.options,persist}),/previous image is healthy again/);
  assert.equal(f.containers.noticeos.Image,NEW);assert.equal(fs.readFileSync(previousFile,'utf8'),previous);assert.equal(fs.readFileSync(f.selectorFile,'utf8'),selector);
  assert.equal(fs.existsSync(path.join(f.parent,'stack-deploy/lock')),false);
});

test('uncertain or timed-out build retains its context and never changes services',async t=>{
  for(const throws of [true,false]) {
    const f=fixture(t);f.control.buildThrows=throws;f.control.buildTimeout=!throws;
    // The injected transport owns no actual child/build job, so the test may retire its context.
    t.after(()=>f.contexts.forEach(dir=>fs.rmSync(dir,{recursive:true,force:true})));
    await assert.rejects(f.build(),/context retained/);assert.equal(f.writes().length,0);
    assert.ok(f.contexts.every(dir=>fs.existsSync(dir)));
  }
});
test('an update refused for an unhealthy service names it, its logs, and for the app the database state',async t=>{
  const f=fixture(t);f.containers.noticeos.State={Status:'running',Health:{Status:'unhealthy'}};
  f.control.database={ok:false,line:'it is 1 migration behind this code; pnpm os:migrate -- --apply brings it up to date'};
  await assert.rejects(f.prepare(),/^Error: noticeos is running, unhealthy; an update needs every service running and healthy\. pnpm os:logs -- noticeos shows why\.\nThe database: it is 1 migration behind/);
  assert.ok(!f.calls.some(call=>call[0]==='build'));assert.equal(f.writes().length,0);
  f.containers.noticeos.State={Status:'running',Health:{Status:'healthy'}};f.containers.dolt.State={Status:'exited',Health:{Status:''}};
  await assert.rejects(f.prepare(),(error)=>/^dolt is exited; an update needs/.test(error.message)&&!/The database/.test(error.message));
});
