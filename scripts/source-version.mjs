// Public source provenance travels with an image; it never reads installation state.
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

function version(value) {
  if (!value || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.commit ?? '')
    || typeof value.committedAt !== 'string' || !Number.isFinite(Date.parse(value.committedAt))
    || typeof value.modified !== 'boolean') return null;
  return { commit: value.commit, committedAt: new Date(value.committedAt).toISOString(), modified: value.modified };
}

/** Git is optional, bounded and local. A parent repository is never this source. */
export function gitSourceVersion(root) {
  const git = args => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  try {
    const top = git(['rev-parse', '--show-toplevel']);
    if (!top || realpathSync(top) !== realpathSync(root)) return null;
    const head = git(['log', '-1', '--format=%H%n%cI']);
    const status = git(['status', '--porcelain', '--untracked-files=normal']);
    if (head === null || status === null) return null;
    const [commit, committedAt] = head.split('\n');
    return version({ commit, committedAt, modified: status !== '' });
  } catch { return null; }
}

/** An image's sealed manifest wins over any checkout beside it. */
export function sourceVersion(root) {
  const manifest = path.join(root, 'container-source.json');
  let stat;
  try { stat = lstatSync(manifest); }
  catch (error) { return error.code === 'ENOENT' ? gitSourceVersion(root) : null; }
  try {
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) return null;
    const source = JSON.parse(readFileSync(manifest, 'utf8'));
    return source.schema === 'noticeos-container-source/1' ? version(source.version) : null;
  } catch { return null; }
}
