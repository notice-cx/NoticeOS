import path from 'node:path';
import { runCommand } from '../run-command.mjs';

// pnpm 12 exec gives its runtime another process group. Verify prepared
// dependencies through pnpm, then supervise Node/Vite directly so group kill
// and ingest-door ownership describe the same child on every host.
export function towerLaunch(root, node = process.execPath) {
  const cwd = path.join(root, 'apps/tower');
  return { command: node, cwd, entry: path.join(cwd, 'node_modules/vite/bin/vite.js') };
}

export async function towerDependenciesReady({ root, env = process.env, run = runCommand } = {}) {
  const result = await run('pnpm', ['exec', process.execPath, '--version'], {
    cwd: root, env, timeoutMs: 30_000,
  });
  return result.code === 0;
}
