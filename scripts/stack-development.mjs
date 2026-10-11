#!/usr/bin/env node
// Switch the installation's app between this checkout's live source and its prepared image.
//
// Only the app container changes; stores and the image's dependencies stay put.
//
//   pnpm os:dev     Run the app from this checkout's live source; edits refresh it.
//   pnpm os:prod    Run the app from the prepared image it ran before.
import * as fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { readSelector, validateSelector } from './stack-control.mjs';
import { runCommand } from './run-command.mjs';
import { DEPENDENCY_PATHS } from '../deploy/compose/development.mjs';
import { buildDevelopmentImage, stackImageMetadata, stackSnapshot, stackRecoverySnapshot, stackComposition, stackCompose,
  stackAtomic, stackInputSeal, stackSameInputs } from './stack-deploy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = /^sha256:[a-f0-9]{64}$/u;
const HELP = 'Usage: pnpm os:dev [-- --config ABSOLUTE_SELECTOR] [-- --image sha256:ID]\n       pnpm os:prod [-- --config ABSOLUTE_SELECTOR]';
const json = value => JSON.stringify(value, null, 2) + '\n';
const fail = message => { throw new Error(message); };

export function developmentOverride(root, image, { project, stateSource, dependencyFile } = {}) {
  if (!path.isAbsolute(root) || /[\r\n\0$,:]/u.test(root) || !IMAGE.test(image)) fail('Use an absolute checkout and an immutable local image.');
  root = fs.realpathSync(root);
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(project ?? '') || !path.isAbsolute(stateSource ?? '') || !path.isAbsolute(dependencyFile ?? '')) fail('Development needs its declared state and dependency record.');
  const bind = (source, target, readOnly=true) => ({ type:'bind',source,target,...(readOnly?{read_only:true}:{}),bind:{create_host_path:false} });
  const volumes=Object.fromEntries(DEPENDENCY_PATHS.map((relative,index)=>{
    const name=`${project}-dev-${image.slice(7,23)}-${index}`;
    return [name,{name,labels:{'cx.noticeos.dependency-image':image}}];
  }));
  const metadata=[];
  const gitFile=path.join(root,'.git');
  if(fs.lstatSync(gitFile,{throwIfNoEntry:false})?.isFile()) {
    const text=regular(gitFile);
    const match=/^gitdir: ([^\r\n]+)\r?\n?$/u.exec(text);
    if(!match) fail('Invalid worktree Git metadata.');
    const gitDir=fs.realpathSync(path.resolve(root,match[1]));
    const common=fs.realpathSync(path.resolve(gitDir,regular(path.join(gitDir,'commondir')).trim()));
    metadata.push(bind(common,common));
    if(!gitDir.startsWith(common+path.sep)) metadata.push(bind(gitDir,gitDir));
  }
  return { services: { noticeos: { image, pull_policy: 'never',
    environment: { NOTICEOS_CONTAINER_MODE: 'development' },
    labels: { 'cx.noticeos.runtime': 'development', 'cx.noticeos.checkout': root },
    volumes: [bind(root,'/source'),bind(root,'/opt/noticeos'),bind(dependencyFile,'/dependency-image.json'),
      bind(path.join(stateSource,'.local'),'/opt/noticeos/.local',false),bind(path.join(stateSource,'.wrangler'),'/opt/noticeos/.wrangler',false),
      ...DEPENDENCY_PATHS.map((relative,index)=>({type:'volume',source:Object.keys(volumes)[index],target:'/opt/noticeos/'+relative,read_only:true})),...metadata,
    ],
  } },volumes };
}

function equal(a, b) { return isDeepStrictEqual(a,b); }
function orderedMounts(mounts) { return [...mounts].sort((a,b) => a.target.localeCompare(b.target)); }
export function assertDevelopmentComposition(before, after, override) {
  const expected = structuredClone(before);
  const app = expected.services.noticeos;
  const changes = override.services.noticeos;
  Object.assign(app, { image: changes.image, pull_policy: 'never',
    environment: { ...app.environment, ...changes.environment }, labels: { ...app.labels, ...changes.labels },
    volumes: orderedMounts([...app.volumes.filter(m => !changes.volumes.some(next => next.target === m.target)), ...changes.volumes]),
  });
  const actual = structuredClone(after);
  for (const [name,volume] of Object.entries(before.volumes ?? {})) {
    if (!equal(volume,actual.volumes?.[name])) fail('An existing volume declaration changed.');
  }
  for (const [name,volume] of Object.entries(actual.volumes ?? {})) {
    if (before.volumes?.[name]) {if(!equal(before.volumes[name],volume)) fail('An existing volume declaration changed.');}
    else if (!override.volumes[name] || volume.name!==name || !equal(volume.labels,override.volumes[name].labels) ||
      Object.keys(volume).some(key=>!['name','labels','driver'].includes(key)) || volume.driver && volume.driver!=='local') fail('Unexpected dependency volume declaration.');
  }
  for (const name of Object.keys(override.volumes)) if(!actual.volumes?.[name]) fail('A dependency volume declaration is missing.');
  expected.volumes=actual.volumes;
  actual.services.noticeos.volumes = orderedMounts(actual.services.noticeos.volumes);
  if (!equal(expected, actual)) fail('Development override changed more than the app source, mode or dependency image.');
}
export function assertPreserved(before, after, { image, added = [] } = {}) {
  if (!equal(Object.keys(before).sort(), Object.keys(after).sort())) fail('Stack service membership changed.');
  for (const [service, row] of Object.entries(before)) {
    const current = after[service];
    if (service !== 'noticeos') {
      if (row.id !== current.id || row.image !== current.image || !equal(row.mounts,current.mounts)) fail('A store or backup identity/mount changed.');
    } else {
      const extra = added.map(m => {
        if(m.type==='volume') {
          const mounted=current.mounts.find(next=>next.target===m.target);
          if(!mounted || mounted.name!==m.source || mounted.writable) fail('Unexpected Linux dependency volume.');
          return mounted;
        }
        return {type:m.type,source:m.source,target:m.target,writable:m.read_only!==true};
      });
      const expected = [...row.mounts.filter(m=>!extra.some(next=>next.target===m.target)),...extra];
      if (current.image !== image || !equal(orderedMounts(expected), current.mounts)) fail('The app image or source/state mounts do not match.');
    }
  }
}

function ownedDirectory(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Stack development records need an owned directory.');
}
function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) fail('Invalid development record.');
  return fs.readFileSync(file,'utf8');
}

export async function developStack({ root = ROOT, selectorFile, disable = false, image = null,
  run = runCommand, env = process.env, out = process.stdout, build = buildDevelopmentImage } = {}) {
  root = fs.realpathSync(root);
  const selector = readSelector(selectorFile);
  const dir = path.join(path.dirname(selectorFile), 'stack-development');
  ownedDirectory(dir);
  // Share the app-deployment lock: simultaneous mode changes cannot race a deploy.
  const deployDir = path.join(path.dirname(selectorFile),'stack-deploy');
  ownedDirectory(deployDir);
  const lock = path.join(deployDir,'lock');
  let handle;
  try { handle = fs.openSync(lock,'wx',0o600); } catch { fail('Another app operation holds the stack lock.'); }
  const previous = path.join(dir,'previous.json');
  const overrideFile = path.join(dir,'source.json');
  const journalFile = path.join(dir,'journal.json');
  let retainLock = false; let started = false;
  const oldSelector = regular(selectorFile);
  let selected; let before; let inputHashes; let targetBefore; let targetImage; let added=[];
  let active = false; let previousOverride = null;
  const journal = value => stackAtomic(journalFile,json(value));
  const up = selection => stackCompose(run,selection,
    ['up','--detach','--no-deps','--no-build','--pull','never','--force-recreate','--wait','--wait-timeout','90','noticeos'],env,'Development app switch',130_000);
  try {
    fs.writeFileSync(handle,json({ pid: process.pid, operation:'os:dev', selectorFile }));
    const model = await stackComposition(run,selector,env);
    active = model.value.services.noticeos.environment?.NOTICEOS_CONTAINER_MODE === 'development';
    // The stack as declared without this command's own override file, which
    // os:dev rewrites when the dependency image changes.
    const declared = active ? validateSelector({ ...selector, files: selector.files.filter(file=>file!==overrideFile) }) : selector;
    const baseModel = active ? await stackComposition(run,declared,env) : model;
    inputHashes = stackInputSeal(selectorFile,declared);
    // A broken edit must not prevent restoring the prepared image. Stores
    // still need to be healthy; only the development app may be unhealthy.
    const inspectStack = active ? stackRecoverySnapshot : stackSnapshot;
    before = await inspectStack(run,selector,env);
    for (const [service,row] of Object.entries(before)) if(service!=='noticeos' &&
      (row.state!=='running' || row.health!=='healthy')) fail('Development needs healthy existing stores and backup services.');
    targetBefore = before;
    if (disable) {
      if (!active || !selector.files.includes(overrideFile)) fail('This selector has no owned development mode to disable.');
      const prior = JSON.parse(regular(previous));
      if (prior.schema !== 'noticeos-stack-development/1' || prior.selectorFile !== selectorFile || !IMAGE.test(prior.image)) fail('The prepared-image recovery record is invalid.');
      selected = validateSelector(prior.selector);
      if (!stackSameInputs(prior.inputs)) fail('The prepared stack declarations changed; restore refused.');
      targetImage = prior.image;
      targetBefore = prior.before;
      assertPreserved(prior.before,before,{ image:before.noticeos.image, added:JSON.parse(regular(overrideFile)).services.noticeos.volumes });
    } else {
      if (active && !selector.files.includes(overrideFile)) fail('This stack uses development mounts owned by another selector.');
      if (!active && model.value.services.noticeos.volumes.some(m => m.target === '/source' || m.target.startsWith('/opt/noticeos/') && m.type !== 'tmpfs')) fail('The app already has conflicting source mounts.');
      const ownEnv = Object.fromEntries(['PATH','HOME','DOCKER_CONFIG','XDG_CONFIG_HOME'].filter(key => env[key] !== undefined).map(key => [key,env[key]]));
      // Does this image's node_modules match the checkout's lockfile and
      // manifests? No installation mounts, network, scheduler or providers.
      const probe = async (candidate) => {
        const name = `noticeos-dev-check-${randomUUID()}`;
        journal({ phase:'checking-dependencies', resource:name, project:selector.project, image:candidate, source:root });
        let result;
        try { result = await run('docker',['--host',selector.dockerHost,'run','--rm','--name',name,'--network','none','--read-only',
          '--user',model.value.services.noticeos.user ?? '1000:1000','--volume',root+':/source:ro','--entrypoint','node',
          candidate,'/source/deploy/compose/development.mjs','--check'],{ env:ownEnv, timeoutMs:30_000 }); }
        catch { retainLock=true; journal({phase:'recovery-required',resource:name,reason:'dependency probe termination uncertain'}); fail('Dependency check termination is uncertain; retain its resource record and stack lock.'); }
        if (result.timedOut) {
          retainLock = true;
          journal({phase:'recovery-required',resource:name,reason:'dependency probe termination uncertain'});
          fail('Dependency check timed out; retain its owned resource record for recovery.');
        }
        return result;
      };
      targetImage = image ?? before.noticeos.image;
      let checked = await probe(targetImage);
      let rebuilt = false;
      if (checked.code !== 0 && image === null) {
        // The checkout's lockfile or manifests changed since the app's image
        // was built: build its packages into a new development image.
        out.write('The checkout\'s packages changed since the app\'s image was built.\n');
        const { platform } = await stackImageMetadata(run, selector, before.noticeos.image, env);
        targetImage = (await build({ root, dockerHost: selector.dockerHost, platform, run, env, out })).image;
        rebuilt = true;
        checked = await probe(targetImage);
      }
      if (checked.code !== 0) fail('The checkout\'s packages do not match this image. Run pnpm os:dev without --image to build a matching one.');
      const stateSource=before.noticeos.mounts.find(m=>m.target==='/state' && m.type==='bind')?.source;
      const dependencyFile=path.join(dir,`dependencies-${targetImage.slice(7)}.json`);
      const override = developmentOverride(root,targetImage,{project:selector.project,stateSource,dependencyFile});
      const oldOverride = active ? regular(overrideFile) : null;
      previousOverride = oldOverride;
      if (oldOverride !== null && oldOverride !== json(override) &&
        !(rebuilt && JSON.parse(oldOverride).services?.noticeos?.labels?.['cx.noticeos.checkout'] === override.services.noticeos.labels['cx.noticeos.checkout'])) {
        fail('Run pnpm os:prod before selecting another checkout or dependency image.');
      }
      stackAtomic(overrideFile,json(override));
      selected = validateSelector({ ...selector, files:[...selector.files.filter(file=>file!==overrideFile),overrideFile] });
      const afterModel = await stackComposition(run,selected,env);
      // Compared with the stack as declared without development, so a new
      // dependency image may replace the old one's volumes.
      assertDevelopmentComposition(baseModel.value,afterModel.value,override);
      const checkedValue=JSON.parse(checked.stdout);
      if(!Number.isSafeInteger(checkedValue.freeBytes) || checkedValue.freeBytes<12*1024**3) fail('Development dependency volumes need 4 GiB headroom while keeping 8 GiB free.');
      const dependencies=checkedValue.dependencies;
      if(dependencies.schema!=='noticeos-development-dependencies/1') fail('Invalid Linux dependency description.');
      const dependencyBytes=json(dependencies);
      if(fs.existsSync(dependencyFile)) {if(regular(dependencyFile)!==dependencyBytes) fail('The dependency image record changed.');}
      else fs.writeFileSync(dependencyFile,dependencyBytes,{flag:'wx',mode:0o644});
      const listed=await run('docker',['--host',selector.dockerHost,'volume','ls','--filter',`name=^${selector.project}-dev-${targetImage.slice(7,23)}-`,'--format','{{.Name}}'],{env:ownEnv,timeoutMs:20_000});
      if(listed.code!==0 || listed.stdout.length>8192) fail('Dependency volume inventory failed.');
      for(const name of listed.stdout.trim().split('\n').filter(Boolean)) {
        if(!Object.hasOwn(override.volumes,name)) fail('Unexpected dependency volume name.');
        const inspected=await run('docker',['--host',selector.dockerHost,'volume','inspect','--format','{{json .Labels}}',name],{env:ownEnv,timeoutMs:20_000});
        if(inspected.code!==0 || JSON.parse(inspected.stdout)?.['cx.noticeos.dependency-image']!==targetImage) fail('Dependency volume ownership is unknown.');
      }
      for(const relative of ['.local','.wrangler']) {
        const point=path.join(root,relative);
        if(!fs.existsSync(point)) fs.mkdirSync(point,{mode:0o700});
        const stat=fs.lstatSync(point);if(!stat.isDirectory() || stat.isSymbolicLink()) fail('Development state mount points must be regular directories.');
      }
      added = override.services.noticeos.volumes;
      if (!active) stackAtomic(previous,json({ schema:'noticeos-stack-development/1', selectorFile, selector, inputs:Object.fromEntries(Object.entries(inputHashes).filter(([file])=>file!==selectorFile)),
        before, image:before.noticeos.image, source:root }));
    }
    if (!stackSameInputs(inputHashes) || !equal(before,await inspectStack(run,selector,env)) ||
      baseModel.seal !== (await stackComposition(run,declared,env)).seal) fail('Stack declarations or containers changed during preparation.');
    journal({ phase:'applying',project:selector.project,source:root,image:targetImage,previousImage:before.noticeos.image,disable,
      expectedAdditionalBytes:4*1024**3,dependencyVolumes:added.filter(m=>m.type==='volume').map(m=>m.source) });
    started = true;
    await up(selected);
    const after = await stackSnapshot(run,selected,env);
    assertPreserved(targetBefore,after,{ image:targetImage, added });
    if (!stackSameInputs(inputHashes)) fail('Stack declarations changed during the app switch.');
    stackAtomic(selectorFile,json(selected));
    const receipt = { schema:'noticeos-stack-development-activation/1', phase:'healthy',mode:disable?'prepared':'development',
      project:selector.project,selectorFile,source:root,image:targetImage,at:new Date().toISOString(),before,after,
      appOnly:true,migrationsApplied:false,addedSourceMounts:added.length };
    journal(receipt);
    out.write(disable ? 'Prepared app image restored; stores stayed in place.\n' : 'Development app follows the checkout; source edits refresh automatically. Stores stayed in place.\n');
    return receipt;
  } catch (error) {
    if (!started) throw error;
    if (error.uncertain) {
      retainLock = true;
      journal({phase:'recovery-required',reason:'app switch termination uncertain'});
      fail('App switch termination is uncertain; retain the journal and stack lock for recovery.');
    }
    try {
      if (!stackSameInputs(inputHashes)) fail('Stack inputs drifted; recovery refused.');
      const current = await stackRecoverySnapshot(run,selected,env);
      for (const s of Object.keys(before).filter(s=>s!=='noticeos')) {
        if (!equal(before[s],current[s])) fail('A sibling changed; recovery refused.');
      }
      const sameApp=(base,extra)=>{try {assertPreserved(base,current,{image:current.noticeos.image,added:extra});return true;}catch{return false;}};
      if(![before.noticeos.image,targetImage].includes(current.noticeos.image) ||
        !(sameApp(before,[]) || sameApp(targetBefore,added))) fail('Unexpected app image or mount drift; recovery refused.');
      if (active && !disable && before.noticeos.health !== 'healthy') {
        // The development app was already broken: going back to it helps no
        // one. It stays on the new image, which the next os:dev or os:prod
        // starts from.
        journal({ phase:'failed-development', image:targetImage, after:current });
        retainLock = false;
        throw Object.assign(new Error(`The development app did not become healthy on the new image; pnpm os:logs -- noticeos shows why, and pnpm os:prod returns to the prepared image.`), { settled:true });
      }
      if (previousOverride !== null) stackAtomic(overrideFile, previousOverride);
      await up(selector);
      const recovered = await stackSnapshot(run,selector,env);
      assertPreserved(before,recovered,{ image:before.noticeos.image });
      stackAtomic(selectorFile,oldSelector);
      journal({ phase:'rolled-back',image:before.noticeos.image,after:recovered });
    } catch (recovery) {
      if (recovery.settled) throw recovery;
      retainLock = true;
      journal({ phase:'recovery-required',previousImage:before.noticeos.image });
      fail('App switch and recovery did not complete; retain the journal and stack lock.');
    }
    fail('App switch failed; the previous app is healthy again.');
  } finally { fs.closeSync(handle); if (!retainLock) fs.unlinkSync(lock); }
}

export async function main(args = process.argv.slice(2), options = {}) {
  const out = options.out ?? process.stdout; const err = options.err ?? process.stderr;
  if (args.length===1 && ['--help','-h'].includes(args[0])) {out.write(HELP+'\n');return 0;}
  try {
    let selectorFile=path.join(ROOT,'.local/stack.json'); let disable=false; let image=null;
    const seen=new Set(); const argv=args.filter(a=>a!=='--');
    for(let i=0;i<argv.length;i++) {
      const key=argv[i]; if(seen.has(key)) fail(HELP); seen.add(key);
      if(key==='--disable') disable=true;
      else if(key==='--config' && argv[i+1]) selectorFile=argv[++i];
      else if(key==='--image' && argv[i+1]) image=argv[++i];
      else fail(HELP);
    }
    if(!path.isAbsolute(selectorFile) || image && (!IMAGE.test(image)||disable)) fail(HELP);
    await developStack({ ...options,selectorFile,disable,image,out }); return 0;
  } catch(error) {err.write(error.message+'\n');return 1;}
}
if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode=await main();
