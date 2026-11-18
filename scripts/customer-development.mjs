import { createHash } from 'node:crypto';
import { constants, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { developmentDependencies } from '../deploy/compose/development.mjs';
import { readDemoArtifact } from './hosted-demo-server.mjs';
import { buildCustomer } from './local-customer.mjs';

const sourceDirectories = ['apps/tower', 'workers/ingest', 'packages', 'config'];
const sourceFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json'];
const ignored = new Set(['node_modules', 'dist', 'coverage', 'artifacts', 'test-results', 'playwright-report', 'test', 'tests', 'e2e', 'test-fixtures']);
const code = /\.(?:[cm]?[jt]sx?)$/u;
const importPath = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"](\.[^'"]+)['"]/gu;

// Poll because host edits on a VM mount need not emit inotify events. Metadata
// avoids rereading unchanged files, while identical bytes keep one revision.
export function customerSourceRevision(root, cache = new Map()) {
  const hash = createHash('sha256');
  const seen = new Set();
  const scripts = new Set();
  const file = relative => {
    const absolute = path.join(root, relative);
    const stat = lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat?.isFile()) return;
    const signature = JSON.stringify([stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
    let entry = cache.get(relative);
    if (entry?.signature !== signature) {
      const bytes = readFileSync(absolute, { flag: constants.O_RDONLY | constants.O_NOFOLLOW });
      const imports = code.test(relative) ? Array.from(bytes.toString('utf8').matchAll(importPath), ([, name]) =>
        path.posix.normalize(path.posix.join(path.posix.dirname(relative), name.split('?')[0]))) : [];
      entry = { signature, digest: createHash('sha256').update(bytes).digest('hex'), imports };
      cache.set(relative, entry);
    }
    seen.add(relative);
    hash.update(JSON.stringify([relative, entry.digest]));
    for (const imported of entry.imports) {
      if (imported.startsWith('scripts/') && code.test(imported)) scripts.add(imported);
    }
  };
  function walk(relative) {
    const entries = readdirSync(path.join(root, relative), { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || ignored.has(entry.name) || /\.(?:test|spec)\./u.test(entry.name)) continue;
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile() && (!entry.name.endsWith('.md') || name.startsWith('apps/tower/public/'))) file(name);
    }
  }
  for (const relative of sourceFiles) file(relative);
  for (const relative of sourceDirectories) walk(relative);
  for (const relative of scripts) file(relative);
  if (lstatSync(path.join(root, 'patches'), { throwIfNoEntry: false })?.isDirectory()) walk('patches');
  for (const relative of cache.keys()) if (!seen.has(relative)) cache.delete(relative);
  return hash.digest('hex');
}

export function prepareLiveCustomerArtifact(state, release, signal) {
  developmentDependencies({ metadataFile: '/dependency-image.json' });
  const deadline = AbortSignal.timeout(100_000);
  return createArtifact(state, release, signal ? AbortSignal.any([signal, deadline]) : deadline);
}

async function createArtifact(state, release, signal) {
  const folder = mkdtempSync(path.join(realpathSync(state), 'customer-build-'));
  const artifact = path.join(folder, 'app');
  const dispose = () => rmSync(folder, { recursive: true, force: true });
  try {
    await buildCustomer(folder, artifact, { signal, developmentRelease: release });
    readDemoArtifact(artifact);
    return { artifact, dispose };
  } catch (error) { dispose(); throw error; }
}

/** Compile against the mounted source while the prior runtime owns the stores.
 * Only one runtime can hold the archive handles and the scheduler lease. */
export async function runLiveCustomer({ root, state, launch, stop,
  sourceRevision = customerSourceRevision, build = prepareLiveCustomerArtifact,
  wait = (signal, editing) => delay(editing ? 2500 : 10_000, undefined, { signal }), out = process.stderr,
}) {
  const shutdown = new AbortController();
  const { signal } = shutdown;
  void stop.then(() => shutdown.abort());
  let active;
  let loaded;
  let attempted;
  let lost = false;
  let editedAt = 0;
  const cache = new Map();
  const revisionOfSource = () => {
    try { return sourceRevision(root, cache); }
    catch (error) { if (!['ENOENT', 'ELOOP'].includes(error.code)) throw error; }
  };
  const start = async version => {
    const app = await launch(version.artifact);
    active = app;
    void app.whenLost.then(() => {
      if (active !== app) return;
      lost = true;
      out.write('NoticeOS customer runtime lost its scheduler lease.\n');
      shutdown.abort();
    });
  };
  const close = async () => {
    const app = active;
    active = undefined;
    await app?.close();
  };
  try {
    while (!signal.aborted) {
      const revision = revisionOfSource();
      if (revision && revision !== attempted) {
        attempted = revision;
        editedAt = Date.now();
        let candidate;
        try { candidate = await build(state, revision, signal); }
        catch (error) {
          if (signal.aborted) break;
          if (!loaded) throw error;
          out.write('NoticeOS could not build the checkout. The previous app is still serving.\n');
        }
        if (candidate) {
          try {
            if (!signal.aborted && revision === revisionOfSource()) {
              await close();
              if (signal.aborted) break;
              try {
                await start(candidate);
                loaded?.dispose();
                loaded = candidate;
              } catch (error) {
                if (!loaded || signal.aborted) throw error;
                out.write('NoticeOS could not start the checkout build. Reopening the previous app.\n');
                await start(loaded);
              }
            }
          } finally { if (loaded !== candidate) candidate.dispose(); }
        }
      }
      if (!signal.aborted) await wait(signal, Date.now() - editedAt < 30_000)
        .catch(error => { if (!signal.aborted || error.name !== 'AbortError') throw error; });
    }
    return lost ? 1 : 0;
  } finally {
    await close();
    loaded?.dispose();
  }
}
