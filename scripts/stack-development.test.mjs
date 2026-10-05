import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { developmentOverride, assertDevelopmentComposition, assertPreserved, developStack, main } from './stack-development.mjs';
import { DEPENDENCY_PATHS, dependencyDescription, developmentDependencies, prepareDevelopmentWorkerConfigs } from '../deploy/compose/development.mjs';

const image='sha256:'+'a'.repeat(64);const other='sha256:'+'b'.repeat(64);
function source() {
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'noticeos-stack-development-')));
 for(const file of ['package.json',...DEPENDENCY_PATHS.slice(1).map(p=>p.replace(/node_modules$/u,'package.json'))]) {
  fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),JSON.stringify({name:file,dependencies:{synthetic:'1.0.0'}}));
 }
 fs.writeFileSync(path.join(root,'pnpm-lock.yaml'),'synthetic\n');fs.writeFileSync(path.join(root,'pnpm-workspace.yaml'),'synthetic\n');
 return {root,close:()=>fs.rmSync(root,{recursive:true,force:true})};
}
function options(f) {return {project:'synthetic-dev',stateSource:'/synthetic/state',dependencyFile:path.join(f.root,'dependency.json')};}
test('directory mounts include atomic saves while Linux dependency volumes shadow host modules',()=>{
 const f=source();try {
  const value=developmentOverride(f.root,image,options(f));const app=value.services.noticeos;
  assert.equal(app.environment.NOTICEOS_CONTAINER_MODE,'development');assert.equal(app.labels['cx.noticeos.checkout'],f.root);
  assert.deepEqual(app.volumes.filter(m=>m.source===f.root).map(m=>m.target),['/source','/opt/noticeos']);
  assert.ok(app.volumes.filter(m=>m.source===f.root).every(m=>m.read_only && !m.bind.create_host_path));
  assert.equal(app.volumes.filter(m=>m.type==='volume').length,6);
  assert.ok(app.volumes.filter(m=>m.type==='volume').every(m=>m.read_only && value.volumes[m.source].labels['cx.noticeos.dependency-image']===image));
  assert.ok(!app.volumes.some(m=>m.type==='bind' && m.target.endsWith('package.json')));
  assert.throws(()=>developmentOverride('relative',image,options(f)));assert.throws(()=>developmentOverride(f.root,'mutable:tag',options(f)));
 }finally{f.close();}
});
test('dependency changes refuse, but script-only package edits do not require reinstalling',()=>{
 const f=source();try {
  const record=path.join(f.root,'dependency.json');fs.writeFileSync(record,JSON.stringify(dependencyDescription(f.root)));
  assert.ok(developmentDependencies({source:f.root,metadataFile:record}));
  const pkg=JSON.parse(fs.readFileSync(path.join(f.root,'package.json')));pkg.scripts={dev:'new script'};fs.writeFileSync(path.join(f.root,'package.json'),JSON.stringify(pkg));
  assert.ok(developmentDependencies({source:f.root,metadataFile:record}));
  pkg.dependencies.synthetic='2.0.0';fs.writeFileSync(path.join(f.root,'package.json'),JSON.stringify(pkg));
  assert.throws(()=>developmentDependencies({source:f.root,metadataFile:record}),/Dependencies changed/);
  pkg.dependencies.synthetic='1.0.0';fs.writeFileSync(path.join(f.root,'package.json'),JSON.stringify(pkg));
  fs.writeFileSync(path.join(f.root,'pnpm-lock.yaml'),'changed');assert.throws(()=>developmentDependencies({source:f.root,metadataFile:record}),/Dependencies changed/);
 }finally{f.close();}
});
test('generated Worker configs point to live code and follow atomic secret-file replacement by a link',()=>{
 const f=source();try {
  for(const dir of ['apps/tower','workers/ingest']) fs.writeFileSync(path.join(f.root,dir,'wrangler.jsonc'),JSON.stringify({main:'src/index.ts',hyperdrive:[{binding:'POSTGRES'}]}));
  const home=path.join(f.root,'state');fs.mkdirSync(path.join(home,'workers/ingest'),{recursive:true});
  const secret=path.join(home,'workers/ingest/.dev.vars');fs.writeFileSync(secret,'SYNTHETIC=first');
  const root=prepareDevelopmentWorkerConfigs({source:f.root,home});
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'apps/tower/wrangler.jsonc'))).main,path.join(f.root,'apps/tower/src/index.ts'));
  fs.writeFileSync(secret+'.new','SYNTHETIC=second');fs.renameSync(secret+'.new',secret);
  assert.equal(fs.readFileSync(path.join(root,'workers/ingest/.dev.vars'),'utf8'),'SYNTHETIC=second');
  assert.equal(prepareDevelopmentWorkerConfigs({source:f.root,home}),root);
 }finally{f.close();}
});
function fixture({failure=false,drift=false,appDrift=false,probeFailure=false}={}) {
 const f=source();const local=path.join(f.root,'.local');fs.mkdirSync(local);
 const file=path.join(local,'stack.json');const base=path.join(local,'compose.json');const envFile=path.join(local,'env');fs.writeFileSync(base,'{}');fs.writeFileSync(envFile,'');
 const selector={project:'synthetic-dev',files:[base],envFile,dockerHost:'unix:///synthetic.sock'};fs.writeFileSync(file,JSON.stringify(selector));
 const mounts=[{Type:'bind',Source:'/synthetic/state',Destination:'/state',RW:true}];
 const baseline={name:selector.project,services:{noticeos:{image,read_only:true,user:'1000:1000',environment:{},labels:{},volumes:[{type:'bind',source:'/synthetic/state',target:'/state',bind:{create_host_path:false}}]},postgres:{image:other},dolt:{image:other},backup:{image:other}}};
 const inventory=new Map(['noticeos','postgres','dolt','backup'].map((s,i)=>[s,{Id:String(i+1).repeat(64),Image:s==='noticeos'?image:other,State:{Status:'running',Health:{Status:'healthy'}},Mounts:structuredClone(mounts),Config:{Labels:{'com.docker.compose.project':selector.project,'com.docker.compose.service':s,'org.opencontainers.image.revision':'a'.repeat(40)}}}]));
 const calls=[];let ups=0;
 const model=args=>{
  const value=structuredClone(baseline);
  for(let i=0;i<args.length;i++) if(args[i]==='-f' && args[i+1]!==base) {
   const all=JSON.parse(fs.readFileSync(args[i+1],'utf8'));const overlay=all.services.noticeos;const app=value.services.noticeos;
   Object.assign(app,{...overlay,environment:{...app.environment,...overlay.environment},labels:{...app.labels,...overlay.labels},volumes:[...app.volumes.filter(m=>!overlay.volumes.some(next=>next.target===m.target)),...overlay.volumes]});value.volumes={...value.volumes,...all.volumes};
  }return value;
 };
 const run=async(command,args,opts)=>{
  calls.push({command,args});assert.equal(command,'docker');assert.ok(opts.timeoutMs<=130000);
  if(args[2]==='run') return {code:probeFailure?1:0,stdout:JSON.stringify({dependencies:dependencyDescription(f.root),freeBytes:1024**4}),stderr:'PRIVATE'};
  if(args[2]==='volume') {assert.equal(args[3],'ls');return {code:0,stdout:''};}
  if(args[2]==='inspect') return {code:0,stdout:JSON.stringify([...inventory.values()].filter(row=>row.Id===args[3]))};
  const start=args.indexOf('--env-file')+2;const step=args.slice(start);
  if(step[0]==='config') return {code:0,stdout:JSON.stringify(model(args))};
  if(step[0]==='ps') return {code:0,stdout:JSON.stringify([...inventory].map(([Service,row])=>({Project:selector.project,Service,ID:row.Id,State:row.State.Status,Health:row.State.Health.Status})))};
  assert.deepEqual(step,['up','--detach','--no-deps','--no-build','--pull','never','--force-recreate','--wait','--wait-timeout','90','noticeos']);
  ups++;const app=model(args).services.noticeos;const row=inventory.get('noticeos');row.Id='e'.repeat(63)+String(ups);row.Image=app.image;
  row.State={Status:'running',Health:{Status:'healthy'}};
  row.Mounts=app.volumes.map(m=>({Type:m.type,Source:m.type==='volume'?'/synthetic/volumes/'+m.source:m.source,Destination:m.target,RW:m.read_only!==true,...(m.type==='volume'?{Name:m.source}:{})}));
  if(drift && ups===1) inventory.get('postgres').Id='f'.repeat(64);
  if(appDrift && ups===1) row.Image='sha256:'+'f'.repeat(64);
  return {code:failure && ups===1?1:0,stdout:'',stderr:'PRIVATE'};
 };
 return {...f,file,selector,run,calls,out:{write(){}},upCount:()=>ups,breakApp:()=>{inventory.get('noticeos').State.Health.Status='unhealthy';}};
}
test('switch and disable touch only the app, preserving the original selector and state mounts',async()=>{
 const f=fixture();try {
  const first=await developStack({root:f.root,selectorFile:f.file,...f});assert.equal(first.mode,'development');assert.equal(first.appOnly,true);
  f.breakApp();
  const back=await developStack({root:f.root,selectorFile:f.file,disable:true,...f});assert.equal(back.mode,'prepared');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),f.selector);assert.equal(f.upCount(),2);
  const probe=f.calls.find(c=>c.args[2]==='run');assert.ok(probe.args.includes('none'));assert.ok(!probe.args.includes('/state'));
 }finally{f.close();}
});
test('failed health restores the prior app; unexpected sibling or app drift retains recovery lock',async()=>{
 for(const settings of [{failure:true},{drift:true},{failure:true,appDrift:true}]) {
  const f=fixture(settings);try {
   await assert.rejects(developStack({root:f.root,selectorFile:f.file,...f}),settings.drift || settings.appDrift?/recovery did not complete/:/previous app is healthy/);
   assert.equal(f.upCount(),settings.drift || settings.appDrift?1:2);
   assert.equal(fs.existsSync(path.join(f.root,'.local/stack-deploy/lock')),Boolean(settings.drift || settings.appDrift));
  }finally{f.close();}
 }
});
test('dependency mismatch refuses before app activation',async()=>{
 const f=fixture({probeFailure:true});try {await assert.rejects(developStack({root:f.root,selectorFile:f.file,...f}),/lockfile/);assert.equal(f.upCount(),0);}finally{f.close();}
});
test('unrelated configuration changes are refused',()=>{
 const f=fixture();try {
  const override=developmentOverride(f.root,image,options(f));const before={services:{noticeos:{image,environment:{},labels:{},volumes:[]},postgres:{image:other}}};
  const after=structuredClone(before);Object.assign(after.services.noticeos,override.services.noticeos);after.volumes=override.volumes;
  assertDevelopmentComposition(before,after,override);after.services.postgres.image=image;
  assert.throws(()=>assertDevelopmentComposition(before,after,override),/more than/);
  const withStore=structuredClone(before);withStore.volumes={store:{name:'store'}};
  assert.throws(()=>assertDevelopmentComposition(withStore,{...before,services:{...before.services,noticeos:after.services.noticeos},volumes:override.volumes},override),/existing volume/);
  const snapshot={noticeos:{id:'a',image,mounts:[]},dolt:{id:'d',image:other,mounts:[]}};
  assert.throws(()=>assertPreserved(snapshot,{...snapshot,dolt:{...snapshot.dolt,id:'new'}},{image}),/store or backup/);
 }finally{f.close();}
});
test('help does not touch a stack',async()=>{let output='';assert.equal(await main(['--help'],{out:{write:s=>output+=s}}),0);assert.match(output,/Usage/);});
