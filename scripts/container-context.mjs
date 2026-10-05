#!/usr/bin/env node
// Only this public source allowlist is ever sent to the image builder.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gitSourceVersion } from './source-version.mjs';

const ROOT_FILES = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md']);
const TOOL_NOTICES = ['deploy/compose/licenses/beads-1.3.1-LICENSE.txt',
  'deploy/compose/licenses/dolt-2.4.0-LICENSE.txt', 'deploy/compose/licenses/sources.json'];
const PRIVATE_SEGMENTS = /(?:^|\/)(?:\.[^/]+|installation|node_modules|secrets?|backups?|artifacts|test-results|playwright-report)(?:\/|$)/u;
const PUBLIC_PATHS = [
  /^apps\/tower\/(?:src|shared|worker|vite|public)\/[^\0]+$/u,
  /^apps\/tower\/(?:package\.json|index\.html|vite\.config\.ts|wrangler\.jsonc|tsconfig\.[a-z]+\.json|components\.json)$/u,
  /^workers\/ingest\/(?:src\/[^\0]+|package\.json|wrangler\.jsonc|tsconfig\.json)$/u,
  /^packages\/(?:contract|mediavine|postgres)\/(?:src\/[^\0]+|package\.json|tsconfig(?:\.build)?\.json)$/u,
  /^scripts\/[^/]+\.(?:mjs|mts)$/u,
  /^scripts\/runner\/[^/]+\.mjs$/u,
  /^config\/[^/]+\.json$/u,
  /^db\/postgres\/(?:migrations\/[^/]+\.sql|roles\.sql|tables\.json)$/u,
  /^db\/dolt\/host\/backup-metadata\.sh$/u,
  /^deploy\/compose\/(?:Dockerfile|(?:backup-)?health\.mjs|(?:backup-)?entrypoint\.mjs)$/u,
  /^deploy\/compose\/licenses\/(?:beads-1\.3\.1-LICENSE\.txt|dolt-2\.4\.0-LICENSE\.txt|sources\.json)$/u,
];

export function publicContainerPath(file) {
  if (typeof file !== 'string' || file.includes('\\') || file.includes('\0') || file.split('/').some(part => !part || part === '..')) return false;
  if (file.startsWith('postgres/') || PRIVATE_SEGMENTS.test(file)) return false;
  if (/(?:^|\/)(?:[^/]*\.(?:test|spec)\.[^/]+|[^/]*\.(?:pem|key|sqlite|db|dump|tar|gz))$/iu.test(file)) return false;
  return ROOT_FILES.has(file) || PUBLIC_PATHS.some(pattern => pattern.test(file));
}

function regularSource(root, relative) {
  let current = root;
  for (const [index, part] of relative.split('/').entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (index === relative.split('/').length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error('Container source must contain only regular files and directories.');
    }
  }
  return current;
}

export function prepareContainerContext({ root, destination, files } = {}) {
  if (!path.isAbsolute(root ?? '') || !path.isAbsolute(destination ?? '') || fs.existsSync(destination)) throw new Error('Use an explicit source and a new absolute build-context folder.');
  root = fs.realpathSync(root);
  const parent = fs.realpathSync(path.dirname(destination));
  destination = path.join(parent, path.basename(destination));
  if (destination === root || destination.startsWith(root + path.sep)) throw new Error('The build context must be outside the source checkout.');
  if (!files) {
    const result = spawnSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    if (result.status !== 0) throw new Error('The public source inventory could not be read.');
    files = result.stdout.split('\0').filter(Boolean);
  }
  const selected = [...new Set(files.filter(publicContainerPath))].sort();
  for (const required of [...ROOT_FILES, ...TOOL_NOTICES, 'apps/tower/wrangler.jsonc', 'workers/ingest/wrangler.jsonc', 'db/postgres/tables.json', 'deploy/compose/Dockerfile', 'deploy/compose/entrypoint.mjs', 'deploy/compose/health.mjs']) {
    if (!selected.includes(required)) throw new Error('A required public build input is missing.');
  }
  const sources = selected.map(file => ({ file, source: regularSource(root, file) }));
  fs.mkdirSync(destination, { mode: 0o700 });
  try {
    const inventory = [];
    for (const { file, source } of sources) {
      const bytes = fs.readFileSync(source);
      const target = path.join(destination, file);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
      fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o644 });
      inventory.push({ file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    // A second guard applies even if somebody mistakenly builds the checkout.
    fs.writeFileSync(path.join(destination, '.dockerignore'), '**/.git\n**/.beads\n**/.env*\n**/.dev.*\n**/node_modules\ninstallation\n.local\n.wrangler\nartifacts\npostgres\n**/secrets\n**/backups\n', { flag: 'wx' });
    const version = gitSourceVersion(root);
    fs.writeFileSync(path.join(destination, 'container-source.json'), JSON.stringify({ schema: 'noticeos-container-source/1', version, files: inventory }, null, 2) + '\n', { flag: 'wx' });
    return { directory: destination, files: inventory, version };
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--destination') throw new Error('Invalid args.');
    const result = prepareContainerContext({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), destination: process.argv[3] });
    process.stdout.write(`Public container context: ${result.directory} (${result.files.length} files)\n`);
  } catch { process.stderr.write('Container context refused: use --destination with a new absolute folder outside the checkout.\n'); process.exitCode = 1; }
}
