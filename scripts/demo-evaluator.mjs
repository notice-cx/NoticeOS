// Build the released Worker helpers for one positively owned demo store.
// No scheduler, bindings, provider client or installed dist is selected here.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function buildDemoWorkerHelpers(root, { activity = false, configurationRoot = path.join(root, 'config') } = {}) {
  const output = mkdtempSync(path.join(tmpdir(), 'noticeos-demo-worker-'));
  try {
    // Wrangler's pinned compiler dependency is used directly; Wrangler itself
    // never runs and cannot resolve configuration or contact a service.
    const require = createRequire(realpathSync(path.join(root, 'workers/ingest/node_modules/wrangler/package.json')));
    const { build } = require('esbuild');
    const contract = createRequire(path.join(root, 'packages/contract/package.json'));
    const entries = {
      watch: path.join(root, 'workers/ingest/src/watch-windows.ts'),
      snapshots: path.join(root, 'workers/ingest/src/beads-snapshots.ts'),
      configuration: path.join(root, 'workers/ingest/src/config-store.ts'),
      jobs: path.join(root, 'workers/ingest/src/job-runs.ts'),
      reports: path.join(root, 'workers/ingest/src/db.ts'),
      ...(activity ? { activity: path.join(root, 'workers/ingest/src/demo-activity.ts'), evaluation: path.join(root, 'packages/contract/src/rules.ts') } : {}),
    };
    const result = await build({
      absWorkingDir: root, entryPoints: entries, outdir: output,
      bundle: true, platform: 'node', format: 'esm', target: 'node24',
      outExtension: { '.js': '.mjs' }, metafile: true, logLevel: 'silent',
      alias: {
        '@noticeos/postgres': path.join(root, 'packages/postgres/src/store.mjs'),
      },
      plugins: [{ name: 'released-contract', setup(build) {
        // Resolve each exact exported subpath from this source package. A
        // prefix alias for the root incorrectly turns /money into index.ts/money.
        build.onResolve({ filter: /^@noticeos\/contract(?:\/|$)/ }, args => ({ path: contract.resolve(args.path) }));
        // Disposable proofs use the frozen synthetic config folder. Runtime
        // composition leaves this at the release's generic default documents.
        build.onResolve({ filter: /\.json$/ }, args => {
          const resolved = path.resolve(args.resolveDir, args.path);
          if (path.dirname(resolved) === path.join(root, 'config')) return { path: path.join(configurationRoot, path.basename(resolved)) };
        });
      } }],
      banner: { js: 'import { createRequire as __demoCreateRequire } from "node:module"; const require = __demoCreateRequire(import.meta.url);' },
    });
    const inputs = Object.fromEntries(Object.keys(result.metafile.inputs).sort().map(file => {
      // esbuild distinguishes JSON import attributes in its graph keys; the
      // recorded source remains the exact file rather than that graph suffix.
      const source = file.replace(/ with \{ type: 'json' \}$/u, '');
      return [file, digest(readFileSync(path.resolve(root, source)))];
    }));
    const artifacts = Object.fromEntries(Object.keys(entries).map(name => [name, digest(readFileSync(path.join(output, `${name}.mjs`)))]));
    inputs['packages/contract/package.json'] = digest(readFileSync(path.join(root, 'packages/contract/package.json')));
    const watch = await import(pathToFileURL(path.join(output, 'watch.mjs')).href);
    const snapshots = await import(pathToFileURL(path.join(output, 'snapshots.mjs')).href);
    const configuration = await import(pathToFileURL(path.join(output, 'configuration.mjs')).href);
    const jobs = await import(pathToFileURL(path.join(output, 'jobs.mjs')).href);
    const reports = await import(pathToFileURL(path.join(output, 'reports.mjs')).href);
    const live = activity ? await import(pathToFileURL(path.join(output, 'activity.mjs')).href) : null;
    const evaluation = activity ? await import(pathToFileURL(path.join(output, 'evaluation.mjs')).href) : null;
    if (typeof watch.runWatchWindows !== 'function' || typeof snapshots.writeBeadsSnapshot !== 'function') throw new Error('The released demo Worker helpers are absent.');
    if (['seedConfigDocuments', 'applyConfigOps', 'getConfigDocuments'].some(name => typeof configuration[name] !== 'function')) throw new Error('The released demo config helpers are absent.');
    if (typeof jobs.writeJobRuns !== 'function') throw new Error('The released demo workflow writer is absent.');
    if (typeof reports.runAssetZeroPulse !== 'function') throw new Error('The released demo OS reporter is absent.');
    return { runWatchWindows: watch.runWatchWindows, writeBeadsSnapshot: snapshots.writeBeadsSnapshot,
      seedConfigDocuments: configuration.seedConfigDocuments, applyConfigOps: configuration.applyConfigOps, getConfigDocuments: configuration.getConfigDocuments,
      writeJobRuns: jobs.writeJobRuns, runAssetZeroPulse: reports.runAssetZeroPulse,
      ...(live ? { writeDemoActivity: live.writeDemoActivity, writeDemoCollection: live.writeDemoCollection, writeDemoAdRevenue: live.writeDemoAdRevenue, writeDemoTaskSnapshot: live.writeDemoTaskSnapshot, evaluatePulse: evaluation.evaluatePulse } : {}),
      provenance: { compiler: require('esbuild/package.json').version, inputs, artifacts } };
  } finally { rmSync(output, { recursive: true, force: true }); }
}

/** Same fail-closed capability used by the actual watch test. */
export function demoStoreCapability(store, workspace) {
  const scoped = Object.freeze({
    // Config cache keys need both store and workspace identity. This opaque
    // identity cannot expose an address or share cached rows with another demo.
    where: `synthetic-demo:${randomUUID()}`,
    workspaceId: async () => workspace,
    read: work => store.inWorkspace(workspace, work, { readOnly: true }),
    write: work => store.inWorkspace(workspace, work),
  });
  return new Proxy(Object.freeze({ STORE: scoped }), {
    get(target, key) {
      if (key === 'STORE') return target.STORE;
      throw new Error(`Unexpected demo binding: ${String(key)}`);
    },
  });
}
