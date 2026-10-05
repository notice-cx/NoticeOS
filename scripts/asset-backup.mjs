// An explicitly approved package task writes SQL into this attempt's private
// directory. Never discover or run production tasks automatically.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

export function validateAssetBackups(sources = []) {
  if (!Array.isArray(sources)) throw new Error('assetBackups must be an array');
  const assets = new Set();
  for (const source of sources) {
    if (!source || !/^[a-z0-9][a-z0-9._-]*$/i.test(source.asset ?? '')
      || assets.has(source.asset) || typeof source.repo !== 'string' || !source.repo
      || !/^[a-f0-9]{64}$/.test(source.scriptSha256 ?? '')
      || !Array.isArray(source.args) || source.args.some((arg) => typeof arg !== 'string')) {
      throw new Error('Each asset backup needs a unique asset, repo, scriptSha256 and args array');
    }
    assets.add(source.asset);
  }
  return sources;
}

export async function backupAsset({ source, repoRoot, output, directory, io, command }) {
  const checkout = await io.realpath(path.resolve(repoRoot, source.repo));
  const pkg = JSON.parse(await io.readFile(path.join(checkout, 'package.json'), 'utf8'));
  const script = pkg.scripts?.['backup:prod'];
  if (typeof script !== 'string'
    || createHash('sha256').update(script).digest('hex') !== source.scriptSha256) {
    throw new Error('backup:prod changed or is missing; review and approve the task before updating scriptSha256');
  }
  try {
    // Suppress implicit pre/post npm lifecycle hooks. The pinned task is the
    // entire production operation the owner reviewed, with explicit arguments.
    await command('npm', ['--ignore-scripts', 'run', 'backup:prod', '--', ...source.args], {
      cwd: checkout, processGroup: true, env: { ...process.env, BACKUP_OUTPUT_DIR: directory },
    });
    const fresh = [];
    for (const name of await io.readdir(directory)) {
      if (!name.endsWith('.sql')) throw new Error('Asset task produced unexpected non-SQL output');
      const file = path.join(directory, name);
      if (!(await io.lstat(file)).isFile()) throw new Error('Asset export must be a regular SQL file');
      fresh.push(file);
    }
    if (!fresh.length) throw new Error('backup:prod produced no new SQL files');
    await io.mkdir(output, { recursive: true });
    for (const file of fresh) {
      if (!(await io.stat(file)).size) throw new Error('Asset SQL export is empty');
      const input = await io.open(file, 'r');
      try {
        const compressed = await io.open(path.join(output, `${path.basename(file)}.gz`), 'wx', 0o600);
        try {
          await pipeline(input.createReadStream(), createGzip(), compressed.createWriteStream());
        } finally { await compressed.close(); }
      } finally { await input.close(); }
    }
  } finally {
    await io.rm(directory, { recursive: true, force: true });
  }
}
