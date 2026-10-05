#!/usr/bin/env node
// Application-only Docker updates: prepare a sealed image/plan, then apply it.
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareContainerContext, publicContainerPath } from './container-context.mjs';
import { readSelector, validateSelector, parseServices } from './stack-control.mjs';
import { runCommand } from './run-command.mjs';

const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const IMAGE = /^sha256:[a-f0-9]{64}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
export const REVISION_LABEL = 'org.opencontainers.image.revision';
export const SCHEMA_LABEL = 'cx.noticeos.schema';
const SOURCE_LABEL = 'cx.noticeos.source';
const GIB = 1024 ** 3;
const SCHEMA_PATH = /^db\/postgres\/(?:migrations\/[^/]+\.sql|roles\.sql|tables\.json)$/u;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELP = 'Usage: stack-deploy.mjs [--prepare | --apply ABSOLUTE_PLAN | --rollback] [--config ABSOLUTE_SELECTOR] [--baseline-commit COMMIT] [--image sha256:ID]\n       stack-deploy.mjs --build-only --docker-host unix:///absolute/socket --platform linux/arm64|linux/amd64';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a],[b]) => a.localeCompare(b))) : item, 2) + '\n';
const fail = message => { throw new Error(message); };
const ownEnv = env => Object.fromEntries(['PATH','HOME','DOCKER_CONFIG','XDG_CONFIG_HOME','TMPDIR','LANG'].filter(key => env[key] !== undefined).map(key => [key, env[key]]));
const composePrefix = selector => ['--host', selector.dockerHost, 'compose', '--project-name', selector.project,
  ...selector.files.flatMap(file => ['-f',file]), '--env-file', selector.envFile];

function regular(file, maximum = 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) fail('Deployment input must be a bounded regular file.');
  return fs.readFileSync(file);
}
function atomic(file, bytes) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function directory(selectorFile) {
  const parent = path.dirname(selectorFile);
  const dir = path.join(parent, 'stack-deploy');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Deployment storage must be an owned regular directory.');
  return dir;
}
function inputSeal(selectorFile, selector) {
  return Object.fromEntries([selectorFile, ...selector.files, selector.envFile].map(file => [file, hash(regular(file))]));
}
function sameInputs(seal) {
  return Object.entries(seal).every(([file, expected]) => hash(regular(file)) === expected);
}
async function call(run, selector, args, env, label, timeoutMs = 20_000) {
  let result;
  try { result = await run('docker', ['--host', selector.dockerHost, ...args], { env: ownEnv(env), timeoutMs }); }
  catch { throw Object.assign(new Error(`${label} did not complete. Raw subprocess output is withheld.`), { uncertain: true }); }
  if (result.code !== 0) throw Object.assign(new Error(`${label} failed${result.timedOut ? ' or timed out' : ''}. Raw subprocess output is withheld.`), { uncertain: result.timedOut === true });
  return result.stdout;
}
async function compose(run, selector, args, env, label, timeoutMs = 20_000) {
  return call(run, selector, composePrefix(selector).slice(2).concat(args), env, label, timeoutMs);
}
function readJson(raw, label) {
  try { return JSON.parse(raw); } catch { fail(`${label} returned invalid metadata.`); }
}
function metadata(row, project, service) {
  const labels = row?.Config?.Labels ?? {};
  if (!IMAGE.test(row?.Image ?? '') || !/^[a-f0-9]{64}$/u.test(row?.Id ?? '') ||
      labels['com.docker.compose.project'] !== project || labels['com.docker.compose.service'] !== service) fail('Container identity does not match the declared stack.');
  const mounts = (row.Mounts ?? []).map(mount => {
    if (!['bind','volume','tmpfs'].includes(mount.Type) || typeof mount.Source !== 'string' || typeof mount.Destination !== 'string') fail('Container mounts are invalid.');
    return { type: mount.Type, source: mount.Source, target: mount.Destination, writable: mount.RW === true };
  }).sort((a,b) => a.target.localeCompare(b.target));
  return { id: row.Id, image: row.Image, state: row.State?.Status, health: row.State?.Health?.Status ?? null,
    revision: REVISION.test(labels[REVISION_LABEL] ?? '') ? labels[REVISION_LABEL] : null, mounts };
}
async function imageMetadata(run, selector, image, env) {
  if (!IMAGE.test(image)) fail('Use a pinned local image ID.');
  const rows = readJson(await call(run, selector, ['image','inspect',image], env, 'Image inspection'), 'Image inspection');
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0].Id !== image || rows[0].Os !== 'linux' || !['arm64','amd64'].includes(rows[0].Architecture)) fail('The pinned Linux application image is unavailable.');
  const labels = rows[0].Config?.Labels ?? {};
  return { id: image, platform: `linux/${rows[0].Architecture}`,
    revision: REVISION.test(labels[REVISION_LABEL] ?? '') ? labels[REVISION_LABEL] : null,
    schema: DIGEST.test(labels[SCHEMA_LABEL] ?? '') ? labels[SCHEMA_LABEL] : null,
    source: DIGEST.test(labels[SOURCE_LABEL] ?? '') ? labels[SOURCE_LABEL] : null };
}
async function snapshot(run, selector, env) {
  const inventory = parseServices(await compose(run, selector, ['ps','--all','--format','json'], env, 'Stack inspection'), selector.project);
  const result = {};
  for (const [service, { id }] of inventory) {
    const rows = readJson(await call(run, selector, ['inspect',id], env, 'Container inspection'), 'Container inspection');
    if (!Array.isArray(rows) || rows.length !== 1) fail('Container inspection returned an ambiguous identity.');
    result[service] = metadata(rows[0], selector.project, service);
    if (result[service].state !== 'running' || result[service].health !== 'healthy') fail('Every declared service must be running and healthy before deployment.');
  }
  return result;
}
function unchanged(before, after, { appMayChange = false } = {}) {
  if (Object.keys(before).sort().join() !== Object.keys(after).sort().join()) return false;
  return Object.entries(before).every(([service, row]) => service === 'noticeos' && appMayChange
    ? json(row.mounts) === json(after[service].mounts)
    : row.id === after[service].id && row.image === after[service].image && json(row.mounts) === json(after[service].mounts));
}
async function composition(run, selector, env) {
  const raw = await compose(run, selector, ['config','--format','json'], env, 'Compose validation');
  const value = readJson(raw, 'Compose validation');
  const app = value?.services?.noticeos;
  if (!app || app.build || app.pre_start || app.post_start || app.pre_stop || app.post_stop || app.volumes_from ||
      app.deploy?.replicas !== undefined && app.deploy.replicas !== 1) fail('The application declaration must use one prepared image without lifecycle hooks.');
  if (app.read_only !== true || !Array.isArray(app.volumes) || app.volumes.some(mount => !mount.source)) fail('The application needs its existing explicit mounts and read-only image.');
  return { value, seal: hash(json(value)) };
}
async function git(run, root, args) {
  const result = await run('git', args, { cwd: root, timeoutMs: 20_000 });
  if (result.code !== 0) fail('The committed source could not be verified.');
  return result.stdout;
}
async function sourceTree(run, root, ref = 'main') {
  const commit = (await git(run, root, ['rev-parse','--verify',`${ref}^{commit}`])).trim();
  if (!REVISION.test(commit)) fail('The source revision is invalid.');
  const raw = await git(run, root, ['ls-tree','-r','-z','--full-tree',commit]);
  const files = raw.split('\0').filter(Boolean).map(line => {
    const [metadata, file] = line.split('\t');
    const [mode, kind, object] = metadata.split(' ');
    return { file, mode, kind, object };
  }).filter(row => publicContainerPath(row.file));
  if (files.some(row => row.kind !== 'blob' || !['100644','100755'].includes(row.mode))) fail('Container source cannot contain symlinks or nested repositories.');
  const schema = hash(json(files.filter(row => SCHEMA_PATH.test(row.file)).map(row => [row.file,row.object]).sort()));
  return { commit, files, schema };
}
async function currentSource(run, root) {
  const source = await sourceTree(run, root);
  if ((await git(run, root, ['rev-parse','HEAD'])).trim() !== source.commit ||
      (await git(run, root, ['status','--porcelain'])).trim()) fail('Deploy from a clean checkout at main. Commit verified changes first.');
  return source;
}
function sealedPlan(selectorFile, body) {
  const dir = directory(selectorFile);
  const bytes = json(body);
  const file = path.join(dir, `${hash(bytes)}.json`);
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  return { ...body, file };
}
export function readDeploymentPlan(file) {
  if (!path.isAbsolute(file)) fail('Use an absolute prepared plan path.');
  const bytes = regular(file);
  if (path.basename(file) !== `${hash(bytes)}.json`) fail('The prepared deployment plan changed after review.');
  const plan = readJson(bytes.toString(), 'Deployment plan');
  if (plan.schema !== 'noticeos-stack-deploy/1' || !REVISION.test(plan.commit ?? '') || !IMAGE.test(plan.image ?? '') || !IMAGE.test(plan.previous?.image ?? '') ||
      !(DIGEST.test(plan.source ?? '') || plan.rollback === true && plan.legacySource === true && plan.source === null) ||
      !DIGEST.test(plan.schemaHash ?? '') || !path.isAbsolute(plan.root ?? '') || !path.isAbsolute(plan.selectorFile ?? '')) fail('The prepared deployment plan is invalid.');
  validateSelector(plan.selector);
  return plan;
}

/** Build artifact only: no container inventory, endpoints or database access. */
export async function buildApplicationImage({ root = ROOT, dockerHost, platform, run = runCommand,
  env = process.env, out = process.stdout } = {}) {
  const selector = validateSelector({ project: 'build', files: ['/unused/compose'], envFile: '/unused/env', dockerHost });
  if (!['linux/arm64','linux/amd64'].includes(platform)) fail('Use an explicit supported Linux platform.');
  const source = await currentSource(run, root);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-stack-image-'));
  let retain = false;
  try {
    const stats = fs.statfsSync(parent);
    if (stats.bavail * stats.bsize < 12 * GIB) fail('Image preparation needs 4 GiB headroom while keeping 8 GiB free.');
    out.write(`Building main ${source.commit.slice(0,12)}; free ${stats.bavail * stats.bsize} bytes, expected additional allocation 4 GiB.\n`);
    const context = prepareContainerContext({ root, destination: path.join(parent, 'context'), files: source.files.map(row => row.file) });
    const algorithm = (await git(run, root, ['rev-parse','--show-object-format'])).trim();
    if (!['sha1','sha256'].includes(algorithm)) fail('Unsupported Git object format.');
    for (const row of source.files) {
      const bytes = regular(path.join(context.directory,row.file), 64 * 1024 * 1024);
      const blob = createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if (blob !== row.object) fail('The public build input changed while preparing the committed source.');
    }
    const manifest = hash(regular(path.join(context.directory,'container-source.json'), 10 * 1024 * 1024));
    const iid = path.join(parent, 'image.id');
    let result;
    try { result = await run('docker', ['--host',selector.dockerHost,'build','--platform',platform,
      '--file',path.join(context.directory,'deploy/compose/Dockerfile'), '--iidfile',iid,
      '--label',`${REVISION_LABEL}=${source.commit}`, '--label',`${SCHEMA_LABEL}=${source.schema}`,
      '--label',`${SOURCE_LABEL}=${manifest}`, '--tag',`noticeos-local:${source.commit}`,context.directory],
    { env: ownEnv(env), timeoutMs: 600_000 }); }
    catch { retain = true; fail(`Application image build did not terminate reliably. Existing services were untouched. Build context retained at ${parent}.`); }
    retain = result.timedOut === true;
    if (result.code !== 0) fail(`Application image build failed. Existing services were untouched.${retain ? ` Build context retained at ${parent}.` : ''}`);
    const image = await imageMetadata(run, selector, regular(iid,256).toString().trim(), env);
    if (image.revision !== source.commit || image.schema !== source.schema || image.source !== manifest) fail('Prepared image metadata does not match its committed source.');
    return { commit: source.commit, image: image.id, source: manifest, schemaHash: source.schema, platform };
  } finally { if (!retain) fs.rmSync(parent, { recursive: true, force: true }); }
}

/** Prepare a reviewable deployment without changing any service. */
export async function prepareDeployment({ root = ROOT, selectorFile, baselineCommit = null, rollback = false, preparedImage = null,
  run = runCommand, env = process.env, out = process.stdout } = {}) {
  const selector = readSelector(selectorFile);
  const inputHashes = inputSeal(selectorFile, selector);
  const before = await snapshot(run, selector, env);
  const model = await composition(run, selector, env);
  const old = await imageMetadata(run, selector, before.noticeos.image, env);
  const source = await currentSource(run, root);
  const dir = directory(selectorFile);
  let target;
  if (rollback) {
    const previous = readJson(regular(path.join(dir, 'previous.json')).toString(), 'Previous deployment');
    if (previous.schema !== 'noticeos-stack-previous/1' || previous.selectorFile !== selectorFile || previous.activeImage !== old.id) fail('No matching previous application deployment is recorded.');
    const image = await imageMetadata(run, selector, previous.image, env);
    if ((image.schema && image.schema !== source.schema) || previous.schemaHash !== source.schema) fail('A schema change requires an operator maintenance plan, not application rollback.');
    if (image.revision && image.revision !== previous.commit || image.source && image.source !== previous.source) fail('The previous image does not match its recorded provenance.');
    target = { commit: previous.commit, image: image.id, source: previous.source, legacySource: previous.source === null, schemaHash: source.schema };
  } else {
    const baseline = old.schema ?? (baselineCommit ? (await sourceTree(run, root, baselineCommit)).schema : null);
    if (baseline === null) fail('The running image has no schema revision. For this first update, name its recorded source with --baseline-commit.');
    if (baseline !== source.schema) fail('Postgres schema or role changes require a separate operator maintenance plan. Deployment applies no migrations.');
    if (!old.revision && baselineCommit) old.revision = (await sourceTree(run, root, baselineCommit)).commit;
    if (!old.revision) fail('Name the recorded running source with --baseline-commit so rollback has an exact source revision.');
    if (preparedImage) {
      const image = await imageMetadata(run, selector, preparedImage, env);
      if (image.revision !== source.commit || image.schema !== source.schema || !image.source || image.platform !== old.platform) fail('Prepared image does not match main and the current platform/schema.');
      target = { commit: source.commit, image: image.id, source: image.source, schemaHash: source.schema };
    } else target = await buildApplicationImage({ root, dockerHost: selector.dockerHost, platform: old.platform, run, env, out });
  }
  if (!sameInputs(inputHashes)) fail('Stack declarations changed during preparation; prepare a new plan.');
  return sealedPlan(selectorFile, { schema: 'noticeos-stack-deploy/1', rollback, root, selectorFile, selector, inputHashes,
    compositionHash: model.seal, before, previous: { ...old, image: old.id }, ...target, preparedAt: new Date().toISOString() });
}

/** Revalidates the reviewed target, and recreates only noticeos with pinned images. */
export async function applyDeployment(file, { run = runCommand, env = process.env, out = process.stdout, persist = atomic } = {}) {
  const plan = readDeploymentPlan(file);
  const dir = directory(plan.selectorFile);
  const lock = path.join(dir, 'lock');
  let handle;
  try { handle = fs.openSync(lock, 'wx', 0o600); } catch { fail('Another deployment holds the stack lock. Inspect its journal before recovery.'); }
  const active = path.join(dir, 'current.json');
  const previousFile = path.join(dir,'previous.json');
  let selectorWritten = false; let activeWritten = false; let previousWritten = false; let started = false; let retainLock = false;
  let oldSelectorBytes; let oldActive; let oldPrevious; let selected; let activeBytes; let selectorBytes; let previousBytes;
  const journal = value => persist(path.join(dir,'journal.json'),json(value));
  const recoveryJournal = value => { try { journal(value); } catch { /* Recovery still runs when evidence storage fails. */ } };
  const pinned = image => {
    const override = path.join(dir, `image-${image.slice(7)}.json`);
    const bytes = json({ services: { noticeos: { image, pull_policy: 'never' } } });
    if (fs.existsSync(override)) {
      if (regular(override).toString() !== bytes) fail('A pinned image declaration changed.');
    } else fs.writeFileSync(override, bytes, { flag: 'wx', mode: 0o600 });
    return validateSelector({ ...plan.selector, files: [...plan.selector.files.filter(item => item !== active), override] });
  };
  const up = selector => compose(run, selector, ['up','--detach','--no-deps','--no-build','--pull','never','--force-recreate','--wait','--wait-timeout','90','noticeos'], env, 'Application update', 130_000);
  const restoreOwnedDeclarations = () => {
    if (selectorWritten) {
      if (regular(plan.selectorFile).toString() !== selectorBytes) fail('The selector changed during deployment; automatic recovery refused.');
      persist(plan.selectorFile, oldSelectorBytes); selectorWritten = false;
    }
    if (activeWritten) {
      if (regular(active).toString() !== activeBytes) fail('The image declaration changed during deployment; automatic recovery refused.');
      if (oldActive !== null) persist(active, oldActive); else fs.unlinkSync(active);
      activeWritten = false;
    }
    if (previousWritten) {
      if (regular(previousFile).toString() !== previousBytes) fail('The rollback record changed during deployment; automatic recovery refused.');
      if (oldPrevious !== null) persist(previousFile,oldPrevious); else fs.unlinkSync(previousFile);
      previousWritten = false;
    }
  };
  try {
    fs.writeFileSync(handle, json({ pid: process.pid, plan: file }));
    if (!sameInputs(plan.inputHashes) || json(readSelector(plan.selectorFile)) !== json(plan.selector)) fail('Stack declarations changed after review; prepare a new plan.');
    oldSelectorBytes = regular(plan.selectorFile);
    oldActive = fs.existsSync(active) ? regular(active) : null;
    oldPrevious = fs.existsSync(previousFile) ? regular(previousFile) : null;
    const source = await currentSource(run, plan.root);
    if ((!plan.rollback && source.commit !== plan.commit) || source.schema !== plan.schemaHash) fail('Main or its schema changed after review; prepare a new plan.');
    const before = await snapshot(run, plan.selector, env);
    if (!unchanged(plan.before,before)) fail('Stack containers changed after review; prepare a new plan.');
    const beforeConfig = await composition(run,plan.selector,env);
    if (beforeConfig.seal !== plan.compositionHash) fail('Effective Compose configuration changed after review.');
    const image = await imageMetadata(run,plan.selector,plan.image,env);
    if ((!plan.rollback && (image.revision !== plan.commit || image.schema !== plan.schemaHash || image.source !== plan.source)) ||
        (plan.rollback && image.schema && image.schema !== plan.schemaHash)) fail('The prepared image no longer matches the reviewed source.');
    await imageMetadata(run,plan.selector,plan.previous.image,env);
    selected = pinned(plan.image);
    // Compare before writing the selector, including on the second deployment.
    const afterConfig = (await composition(run,selected,env)).value;
    beforeConfig.value.services.noticeos.image = plan.image;
    beforeConfig.value.services.noticeos.pull_policy = 'never';
    if (json(beforeConfig.value) !== json(afterConfig)) fail('The image override changed more than the application image.');
    if (!sameInputs(plan.inputHashes) || !unchanged(before,await snapshot(run,plan.selector,env))) fail('Stack inputs or containers changed during preflight.');
    journal({ phase:'applying',plan:file,previousImage:plan.previous.image,targetImage:plan.image });
    started = true;
    out.write(`Updating ${selected.project}/noticeos to ${plan.commit.slice(0,12)}.\n`);
    await up(selected);
    const after = await snapshot(run, selected, env);
    if (!unchanged(before,after,{appMayChange:true}) || after.noticeos.image !== plan.image) fail('Post-update identity or mounts do not match the reviewed application update.');
    if (!sameInputs(plan.inputHashes)) fail('Stack declarations changed during deployment.');
    activeBytes = json({ services: { noticeos: { image: plan.image, pull_policy: 'never' } } });
    selected = validateSelector({ ...plan.selector, files: [...plan.selector.files.filter(item => item !== active), active] });
    selectorBytes = json(selected);
    persist(active,activeBytes); activeWritten = true;
    persist(plan.selectorFile,selectorBytes); selectorWritten = true;
    previousBytes = json({ schema:'noticeos-stack-previous/1',selectorFile:plan.selectorFile,activeImage:plan.image,
      image:plan.previous.image,commit:plan.previous.revision,source:plan.previous.source,schemaHash:plan.schemaHash });
    persist(previousFile,previousBytes); previousWritten = true;
    journal({ phase:'healthy',plan:file,commit:plan.commit,image:plan.image,appContainer:after.noticeos.id });
    out.write(`Deployed ${plan.commit.slice(0,12)}; databases and backup containers stayed in place.\n`);
    return { commit:plan.commit,image:plan.image,appContainer:after.noticeos.id };
  } catch (error) {
    if (!started) throw error;
    if (error.uncertain) {
      retainLock = true;
      recoveryJournal({ phase:'recovery-required',plan:file,previousImage:plan.previous.image,reason:'command termination uncertain' });
      fail('Application update did not terminate reliably. Automatic recovery refused; retain the journal for operator recovery.');
    }
    recoveryJournal({ phase:'recovering',plan:file,previousImage:plan.previous.image });
    try {
      restoreOwnedDeclarations();
      if (!sameInputs(plan.inputHashes)) fail('Stack declarations changed; automatic recovery refused.');
      const current = await snapshotForRecovery(run,plan.selector,env);
      if (!unchanged(plan.before,current,{appMayChange:true}) || ![plan.previous.image,plan.image].includes(current.noticeos.image)) fail('Unrelated containers, application image or mounts changed; automatic recovery refused.');
      const previous = pinned(plan.previous.image);
      await up(previous);
      const recovered = await snapshot(run,previous,env);
      if (!unchanged(plan.before,recovered,{appMayChange:true}) || recovered.noticeos.image !== plan.previous.image) fail('Previous application did not return with its original mounts.');
      recoveryJournal({ phase:'rolled-back',plan:file,image:plan.previous.image,appContainer:recovered.noticeos.id });
    } catch {
      retainLock = true;
      recoveryJournal({ phase:'recovery-required',plan:file,previousImage:plan.previous.image });
      fail('Application update and recovery did not complete. Keep the journal and previous image for operator recovery.');
    }
    fail('Application update failed; the previous image is healthy again.');
  } finally { fs.closeSync(handle); if (!retainLock) fs.unlinkSync(lock); }
}
async function snapshotForRecovery(run,selector,env) {
  // A failed app may be unhealthy; identity/mount checks still protect siblings.
  const inventory = parseServices(await compose(run,selector,['ps','--all','--format','json'],env,'Recovery inspection'),selector.project);
  const result = {};
  for (const [service,{id}] of inventory) {
    const rows = readJson(await call(run,selector,['inspect',id],env,'Recovery container inspection'),'Recovery container inspection');
    if (!Array.isArray(rows) || rows.length !== 1) fail('Recovery identity is ambiguous.');
    result[service] = metadata(rows[0],selector.project,service);
  }
  return result;
}
export async function main(argv=process.argv.slice(2),options={}) {
  const out=options.out ?? process.stdout; const err=options.err ?? process.stderr;
  if (argv.length===1 && ['--help','-h'].includes(argv[0])) {out.write(HELP+'\n');return 0;}
  try {
    let selectorFile=path.join(ROOT,'.local/stack.json');
    let apply=null; let baselineCommit=null; let rollback=false; let preparedImage=null;
    let buildOnly=false; let dockerHost=null; let platform=null;
    const args=argv.filter(value=>value!=='--'); const seen=new Set();
    for(let i=0;i<args.length;i++) {
      const arg=args[i];
      if(seen.has(arg)) fail(HELP); seen.add(arg);
      if(arg==='--prepare') continue;
      if(arg==='--rollback') {rollback=true;continue;}
      if(arg==='--build-only') {buildOnly=true;continue;}
      if(!['--config','--apply','--baseline-commit','--image','--docker-host','--platform'].includes(arg)||!args[i+1]) fail(HELP);
      const value=args[++i];
      if(arg==='--config') selectorFile=value;
      else if(arg==='--apply') apply=value;
      else if(arg==='--image') preparedImage=value;
      else if(arg==='--docker-host') dockerHost=value;
      else if(arg==='--platform') platform=value;
      else baselineCommit=value;
    }
    if(!path.isAbsolute(selectorFile) || baselineCommit && !REVISION.test(baselineCommit) || preparedImage && !IMAGE.test(preparedImage) ||
        [seen.has('--prepare'),rollback,Boolean(apply),buildOnly].filter(Boolean).length>1 ||
        apply && (baselineCommit || preparedImage || seen.has('--config')) || rollback && (baselineCommit || preparedImage) ||
        buildOnly && (baselineCommit || preparedImage || seen.has('--config')) || !buildOnly && (dockerHost || platform)) fail(HELP);
    if(buildOnly) {
      const built=await buildApplicationImage({...options,dockerHost,platform,out});
      out.write(json(built));
    } else if(apply) await applyDeployment(apply,options);
    else {
      const plan=await prepareDeployment({...options,selectorFile,baselineCommit,rollback,preparedImage,out});
      out.write(`Prepared ${plan.commit.slice(0,12)} for ${plan.selector.project}; existing services were untouched.\n`);
      const quote=value=>"'"+value.replaceAll("'", "'\\''")+"'";
      out.write(`Image: ${plan.image}\nPrevious: ${plan.previous.image}\nReview and approve this application-only update, then run:\npnpm stack:deploy -- --apply ${quote(plan.file)}\n`);
    }
    return 0;
  } catch(error) {err.write(`${error.message}\n`);return 1;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) process.exitCode=await main();
