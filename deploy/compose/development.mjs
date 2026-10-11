// The checkout supplies code; a prepared image supplies Linux dependencies.
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { relocatedWorkerConfig } from '../../scripts/worker-config-folder.mjs';

export const DEPENDENCY_PATHS = ['node_modules','apps/tower/node_modules','workers/ingest/node_modules',
  'packages/contract/node_modules','packages/mediavine/node_modules','packages/postgres/node_modules'];
const MANIFESTS = ['package.json', ...DEPENDENCY_PATHS.slice(1).map(file=>file.replace(/node_modules$/u,'package.json'))];
const DEPENDENCY_FIELDS = ['name','packageManager','dependencies','devDependencies','optionalDependencies','peerDependencies','pnpm'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** A refusal whose message names what to do. The container prints only these:
 * any other error may quote a file it read, secrets included. */
export class ContainerRefusal extends Error {}

export function dependencyDescription(root, io = fs) {
  const read = file => {
    const full = path.join(root,file); const stat = io.lstatSync(full);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size>4*1024*1024) throw new Error('Dependencies need regular bounded checkout files.');
    return io.readFileSync(full);
  };
  return { schema:'noticeos-development-dependencies/1',lock:hash(read('pnpm-lock.yaml')),workspace:hash(read('pnpm-workspace.yaml')),
    manifests:Object.fromEntries(MANIFESTS.map(file=>{
      const value=JSON.parse(read(file));
      return [file,Object.fromEntries(DEPENDENCY_FIELDS.filter(key=>value[key]!==undefined).map(key=>[key,value[key]]))];
    })) };
}

export function developmentDependencies({ fs: io = fs, source = '/source', image = '/opt/noticeos', metadataFile = null } = {}) {
  const stat = io.lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Development needs its explicit source mount.');
  let expected;
  if (metadataFile) {
    const own=io.lstatSync(metadataFile);
    if(!own.isFile() || own.isSymbolicLink() || own.size>1024*1024) throw new Error('Invalid dependency image record.');
    expected=JSON.parse(io.readFileSync(metadataFile,'utf8'));
  } else expected=dependencyDescription(image,io);
  if (expected.schema!=='noticeos-development-dependencies/1' || !isDeepStrictEqual(expected,dependencyDescription(source,io))) {
    throw new ContainerRefusal('The checkout\'s packages changed since this image was built; pnpm os:dev builds a matching one.');
  }
  return expected;
}

/** Keep Wrangler's secret lookup beside generated configs, away from host secrets. */
export function prepareDevelopmentWorkerConfigs({ source='/opt/noticeos', home='/state' }={}) {
  const root=path.join(home,'.local','development-worker-config');
  const mark=path.join(root,'.noticeos-development-config');
  const text='Generated development Worker configs; secrets remain in the installation.\n';
  if (fs.existsSync(root)) {
    const stat=fs.lstatSync(root);
    if(!stat.isDirectory() || stat.isSymbolicLink() || fs.readFileSync(mark,'utf8')!==text) throw new Error('Development Worker config ownership is unknown.');
  } else {fs.mkdirSync(root,{recursive:true,mode:0o700});fs.writeFileSync(mark,text,{flag:'wx',mode:0o600});}
  for(const relative of ['apps/tower/wrangler.jsonc','workers/ingest/wrangler.jsonc']) {
    const file=path.join(source,relative);const target=path.join(root,relative);
    fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
    const value=relocatedWorkerConfig(fs.readFileSync(file,'utf8'),file);
    fs.writeFileSync(target,JSON.stringify(value,null,2)+'\n',{mode:0o600});
  }
  const link=path.join(root,'workers/ingest/.dev.vars');const target=path.join(home,'workers/ingest/.dev.vars');
  const own=fs.lstatSync(link,{throwIfNoEntry:false});
  if(own) {if(!own.isSymbolicLink() || fs.readlinkSync(link)!==target) throw new Error('Development secret link changed.');}
  else fs.symlinkSync(target,link);
  return root;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--check') throw new Error('Use --check.');
    const stat=fs.statfsSync('/opt/noticeos');
    process.stdout.write(JSON.stringify({dependencies:developmentDependencies(),freeBytes:stat.bavail*stat.bsize})+'\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
