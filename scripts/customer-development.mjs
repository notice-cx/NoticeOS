import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { developmentDependencies } from '../deploy/compose/development.mjs';
import { readDemoArtifact } from './hosted-demo-server.mjs';
import { buildCustomer } from './local-customer.mjs';

const sourceDirectories = ['apps/tower', 'workers/ingest', 'packages', 'scripts', 'config', 'docs'];
const sourceFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json'];
const ignored = new Set(['node_modules', 'dist', 'coverage', 'artifacts', 'test-results', 'playwright-report', 'test', 'tests', 'e2e']);

// Poll metadata because host edits on a VM mount need not emit an inotify event.
export function customerSourceRevision(root) {
  const hash = createHash('sha256');
  const file = relative => {
    const stat = lstatSync(path.join(root, relative), { throwIfNoEntry: false });
    if (stat?.isFile()) hash.update(JSON.stringify([relative, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]));
  };
  function walk(relative) {
    const entries = readdirSync(path.join(root, relative), { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || ignored.has(entry.name) || /\.(?:test|spec)\./u.test(entry.name)) continue;
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile()) file(name);
    }
  }
  for (const relative of sourceFiles) file(relative);
  for (const relative of sourceDirectories) walk(relative);
  if (lstatSync(path.join(root, 'patches'), { throwIfNoEntry: false })?.isDirectory()) walk('patches');
  return hash.digest('hex');
}

export function prepareLiveCustomerArtifact(state, release, signal) {
  developmentDependencies({ metadataFile: '/dependency-image.json' });
  return createArtifact(state, release, signal);
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
  wait = signal => delay(2500, undefined, { signal }), out = process.stderr,
}) {
  const shutdown = new AbortController();
  const { signal } = shutdown;
  void stop.then(() => shutdown.abort());
  let active;
  let loaded;
  let attempted;
  let lost = false;
  const revisionOfSource = () => {
    try { return sourceRevision(root); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
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
      if (!signal.aborted) await wait(signal).catch(error => { if (!signal.aborted || error.name !== 'AbortError') throw error; });
    }
    return lost ? 1 : 0;
  } finally {
    await close();
    loaded?.dispose();
  }
}
