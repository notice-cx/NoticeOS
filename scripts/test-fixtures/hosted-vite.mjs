import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../test-config-isolation.mjs';
import { createTestViteServer } from '../test-vite-server.mjs';
import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from '../browser-request-policy.mjs';
const towerRequire = createRequire(path.join(REPO_ROOT, 'apps/tower/package.json'));
const wranglerRequire = createRequire(towerRequire.resolve('wrangler/package.json'));
const fixtureDir = path.join(REPO_ROOT, 'workers/ingest/test/fixture-config');
const fixture = file => path.basename(file) === 'beads.json' ? { hub: null, spokes: [] }
  : path.basename(file) === 'integrations.json' ? { catalog: [], assets: {} }
  : JSON.parse(readFileSync(path.join(fixtureDir, path.basename(file)), 'utf8'));

/** Rebind only neutral checkout defaults, using the same guard-preserving
 * recipe as workspace-server-profile.test. Actual Vite, Cloudflare plugin,
 * Worker entry modules, and native Tasks plugin all remain in the composition. */
export async function actualViteFactory(root, requests) {
  const { build } = wranglerRequire('esbuild');
  const source = path.join(REPO_ROOT, 'apps/tower/vite.config.ts'), output = path.join(root, 'vite-configuration.mjs');
  await build({ entryPoints: [source], outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent',
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(source).href) },
    plugins: [{ name: 'task-fixture-defaults', setup(builder) {
      builder.onResolve({ filter: /config\/[^/]+\.json$/ }, args => {
        const file = path.resolve(args.resolveDir, args.path);
        return path.dirname(file) === path.join(REPO_ROOT, 'config') ? { path: file, namespace: 'owned-default' } : undefined;
      });
      builder.onLoad({ filter: /.*/, namespace: 'owned-default' }, args => ({ contents: JSON.stringify(fixture(args.path)), loader: 'json' }));
      builder.onResolve({ filter: /^[^./]/ }, async args => {
        if (args.pluginData === 'resolved') return undefined;
        const result = await builder.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: 'resolved' });
        return result.errors.length ? undefined : { path: result.path, external: true };
      });
    } }],
  });
  const { createServer } = await import(towerRequire.resolve('vite'));
  const trace = name => { if (process.env.NOTICEOS_TASK_FIXTURE_TRACE === '1') console.error('Vite fixture phase:', name); };
  return async inline => {
    // Actual startup pins private state before invoking this factory. Only
    // the separate config-only diagnostic needs its own scratch fallback.
    process.env.OS_UP_PERSIST_STATE ??= path.join(root, 'wrangler-state');
    assert.equal(inline.root, path.join(REPO_ROOT, 'apps/tower'));
    assert.equal(inline.configFile, source);
    assert.deepEqual(inline.server, { host: '127.0.0.1', port: 6448, strictPort: true, open: false });
    assert.equal(inline.plugins.length, 1); assert.equal(inline.plugins[0].name, 'noticeos:hosted-tasks');
    trace('config import');
    // Each separately started fixed-profile server evaluates its own config.
    // Node's ESM cache must not carry hosted selectors into the demo restart.
    const imported = await import(pathToFileURL(output).href + '?entry=' + randomUUID());
    trace('config evaluation');
    const configuration = imported.default({ command: 'serve', mode: 'development' });
    trace('config evaluated');
    const names = configuration.plugins.flat(Infinity).filter(Boolean).map(plugin => plugin.name);
    for (const lane of ['noticeos:task-lane', 'noticeos:config-write-lane', 'noticeos:env-import-lane', 'scheduled-jobs']) assert.equal(names.includes(lane), false);
    assert.ok(names.some(name => name.includes('cloudflare')));
    const defaults = { name: 'task-browser-defaults', enforce: 'pre', resolveId(source, importer) {
      if (!importer || !source.split('?')[0].endsWith('.json')) return null;
      const file = path.resolve(path.dirname(importer.split('?')[0]), source.split('?')[0]);
      return path.dirname(file) === path.join(REPO_ROOT, 'config') ? '\0task-default:' + path.basename(file) : null;
    }, load(id) { return id.startsWith('\0task-default:') ? JSON.stringify(fixture(id.slice('\0task-default:'.length))) : null; } };
    const observe = { name: 'task-proof-requests', enforce: 'pre', configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url?.startsWith('/api/tasks') || req.url?.startsWith('/api/gates/')) requests.push({ method: req.method, path: req.url,
          workspace: req.headers[WORKSPACE_SELECTION_HEADER] ?? null, session: req.headers[WORKSPACE_SESSION_HEADER] ?? null });
        next();
      });
    } };
    const plugins = [observe, defaults, ...inline.plugins, ...configuration.plugins];
    trace('actual createServer');
    return createTestViteServer(createServer, { ...configuration, ...inline, configFile: false, envDir: false,
      plugins,
      server: { ...configuration.server, ...inline.server }, logLevel: 'error' }, { pages: true });
  };
}
