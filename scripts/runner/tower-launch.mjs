import path from 'node:path';
import { accessSync, constants } from 'node:fs';
import { runCommand } from '../run-command.mjs';
import { developmentDependencies } from '../../deploy/compose/development.mjs';

// pnpm 12 exec gives its runtime another process group. Verify prepared
// dependencies through pnpm, then supervise Node/Vite directly so group kill
// and ingest-door ownership describe the same child on every host.
export function towerLaunch(root, node = process.execPath) {
  const cwd = path.join(root, 'apps/tower');
  return { command: node, cwd, entry: path.join(cwd, 'node_modules/vite/bin/vite.js') };
}

export async function towerDependenciesReady({ root, env = process.env, run = runCommand } = {}) {
  if (root === '/opt/noticeos' && env.NOTICEOS_LIVE_SOURCE_ROOT === '/source') {
    // pnpm also compares patch modification times, which differ when the
    // byte-identical checkout and Linux dependencies come from separate mounts.
    try {
      developmentDependencies({ metadataFile: '/dependency-image.json' });
      accessSync(towerLaunch(root).entry, constants.R_OK);
      return true;
    } catch { return false; }
  }
  const result = await run('pnpm', ['exec', process.execPath, '--version'], {
    cwd: root, env, timeoutMs: 30_000,
  });
  return result.code === 0;
}
