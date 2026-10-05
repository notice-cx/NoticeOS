import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { serverWorkspaceProfile, workspaceWorkerConfig } from '../apps/tower/vite/workspace-profile.ts';

const towerRequire = createRequire(new URL('../apps/tower/package.json', import.meta.url));
const { unstable_readConfig, unstable_getMiniflareWorkerOptions } = towerRequire('wrangler');
const wranglerRequire = createRequire(towerRequire.resolve('wrangler/package.json'));
const { Miniflare } = wranglerRequire('miniflare');
const { build } = wranglerRequire('esbuild');
const selector = 'NOTICEOS_WORKSPACE_PROFILE';
const config = profile => ({ vars: { [selector]: profile } });

test('two server configs and process selector agree; absent/foreign/environment overrides refuse', () => {
  for (const profile of ['standalone', 'hosted', 'demo']) {
    assert.equal(serverWorkspaceProfile([config(profile), config(profile)], {}), profile);
    assert.equal(serverWorkspaceProfile([config(profile), config(profile)], { [selector]: profile }), profile);
  }
  for (const inputs of [[], [config('hosted')], [config('hosted'), config('standalone')], [{}, {}], [config('unknown'), config('unknown')]]) {
    assert.throws(() => serverWorkspaceProfile(inputs, {}));
  }
  assert.throws(() => serverWorkspaceProfile([config('hosted'), config('hosted')], { [selector]: 'standalone' }));
  const selected = { ...config('standalone'), env: { fixture: config('demo') } };
  assert.equal(serverWorkspaceProfile([selected, selected], { CLOUDFLARE_ENV: 'fixture' }), 'demo');
  assert.throws(() => serverWorkspaceProfile([selected, selected], { CLOUDFLARE_ENV: 'missing' }));
});

test('actual production Vite composition omits host lanes and pins both final Worker profiles', { timeout: 60000 }, async () => {
  const checkout = path.resolve(new URL('..', import.meta.url).pathname);
  const root = mkdtempSync(path.join(os.tmpdir(), 'noticeos-profile-vite-'));
  const source = path.join(checkout, 'apps/tower/vite.config.ts');
  const output = path.join(root, 'configuration.mjs');
  const keys = ['NOTICEOS_WORKER_CONFIG_ROOT', 'NOTICEOS_VITE_CACHE_DIR', 'NOTICEOS_INSTALLATION_DIR', 'NOTICEOS_HOME', 'NOTICEOS_DEMO_VIEWER_FILE', selector, 'CLOUDFLARE_ENV', 'CLOUDFLARE_INCLUDE_PROCESS_ENV', 'CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let server;
  try {
    for (const key of keys) delete process.env[key];
    process.env.NOTICEOS_WORKER_CONFIG_ROOT = root;
    process.env.NOTICEOS_VITE_CACHE_DIR = path.join(root, 'cache');
    // A guarded nonexistent host selector catches accidental eager adapter
    // construction. No actual installation or local secret file is selected.
    process.env.NOTICEOS_INSTALLATION_DIR = path.join(root, 'not-an-installation');
    process.env.NOTICEOS_HOME = path.join(root, 'not-a-host');
    const invalidLaunch = path.join(root, 'invalid-viewer.json');
    writeFileSync(invalidLaunch, '{');
    process.env.NOTICEOS_DEMO_VIEWER_FILE = invalidLaunch;
    await build({
      entryPoints: [source], outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent',
      define: { 'import.meta.url': JSON.stringify(pathToFileURL(source).href) },
      plugins: [{ name: 'public-profile-fixture', setup(builder) {
        builder.onResolve({ filter: /config\/[^/]+\.json$/ }, args => {
          const file = path.resolve(args.resolveDir, args.path);
          if (path.dirname(file) === path.join(checkout, 'config')) return ['beads.json', 'integrations.json'].includes(path.basename(file))
            ? { path: path.basename(file), namespace: 'profile-fixture' }
            : { path: path.join(checkout, 'workers/ingest/test/fixture-config', path.basename(file)) };
          return undefined;
        });
        builder.onLoad({ filter: /.*/, namespace: 'profile-fixture' }, args => ({ contents: JSON.stringify(args.path === 'beads.json' ? { hub: null, spokes: [] } : { catalog: [], assets: {} }), loader: 'json' }));
        builder.onResolve({ filter: /^[^./]/ }, async args => {
          if (args.pluginData === 'resolved') return undefined;
          const resolved = await builder.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: 'resolved' });
          return resolved.errors.length ? undefined : { path: resolved.path, external: true };
        });
      } }],
    });
    const { createServer } = await import(pathToFileURL(towerRequire.resolve('vite')).href);
    for (const profile of ['hosted', 'demo']) for (const localSource of ['.dev.vars', '.env', '.dev.vars.fixture', 'process']) {
      delete process.env[selector]; delete process.env.CLOUDFLARE_ENV; delete process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV;
      if (localSource === '.dev.vars.fixture') process.env.CLOUDFLARE_ENV = 'fixture';
      if (localSource === 'process') { process.env[selector] = profile; process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'true'; }
      for (const [relative, name] of [['apps/tower', 'tower'], ['workers/ingest', 'ingest']]) {
        const folder = path.join(root, relative); mkdirSync(folder, { recursive: true });
        writeFileSync(path.join(folder, 'worker.mjs'), `export default { async fetch(request, env) { return Response.json({profile:env.${selector},secondary:env.INGEST ? await (await env.INGEST.fetch(request)).json() : null}); }};`);
        const selected = { name: `noticeos-profile-${name}`, vars: { [selector]: profile }, ...(name === 'tower' ? { services: [{ binding: 'INGEST', service: 'noticeos-profile-ingest' }] } : {}) };
        writeFileSync(path.join(folder, 'wrangler.jsonc'), JSON.stringify({ ...selected, main: './worker.mjs', compatibility_date: '2026-07-06', env: { fixture: selected } }));
        for (const local of ['.dev.vars', '.env', '.dev.vars.fixture']) rmSync(path.join(folder, local), { force: true });
        if (localSource !== 'process') writeFileSync(path.join(folder, localSource), `${selector}=${profile}\nOPTIONAL_FIXTURE=synthetic\n`);
      }
      const configuration = (await import(`${pathToFileURL(output).href}?profile=${profile}&source=${localSource}`)).default({ command: 'serve', mode: 'development' });
      const names = configuration.plugins.flat(Infinity).filter(Boolean).map(plugin => plugin.name);
      for (const hostLane of ['noticeos:ingest-door', 'noticeos:config-write-lane', 'noticeos:task-lane', 'scheduled-jobs', 'noticeos:env-import-lane']) assert.equal(names.includes(hostLane), false, hostLane);
      server = await createServer({ ...configuration, configFile: false, root, server: { ...configuration.server, host: '127.0.0.1', port: 0, strictPort: true }, optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'silent' });
      await server.listen();
      const address = server.httpServer.address(); assert.ok(address && typeof address === 'object');
      const response = await fetch(`http://127.0.0.1:${address.port}/api/config`);
      assert.equal(response.status, 200);
      const body = await response.json(); assert.equal(body.profile, profile); assert.equal(body.secondary.profile, profile);
      assert.ok(Object.keys(server.environments).some(name => name.includes('ingest')));
      await server.close(); server = undefined;
    }
    // Positive control: the same invalid host-only launch custody is read by
    // explicit standalone composition, while hosted/demo never touched it.
    delete process.env[selector]; delete process.env.CLOUDFLARE_ENV; delete process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV;
    for (const relative of ['apps/tower', 'workers/ingest']) {
      const file = path.join(root, relative, 'wrangler.jsonc');
      const config = JSON.parse(readFileSync(file, 'utf8')); config.vars[selector] = 'standalone';
      writeFileSync(file, JSON.stringify(config));
      writeFileSync(path.join(root, relative, '.dev.vars'), `${selector}=standalone\n`);
    }
    const standalone = (await import(`${pathToFileURL(output).href}?profile=standalone`)).default;
    assert.throws(() => standalone({ command: 'serve', mode: 'development' }));
  } finally {
    if (server) await server.close();
    for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
    rmSync(root, { recursive: true, force: true });
  }
});

test('pinned plugin conversion keeps reserved binding sealed across local sources and later reload', async () => {
  // This is the public conversion API used by vite-plugin 1.43.0 after its
  // config callback. A dependency upgrade must review this compatibility pin.
  assert.equal(JSON.parse(readFileSync(new URL('../apps/tower/node_modules/@cloudflare/vite-plugin/package.json', import.meta.url), 'utf8')).version, '1.43.0');
  assert.equal(JSON.parse(readFileSync(towerRequire.resolve('wrangler/package.json'), 'utf8')).version, '4.107.0');
  const root = mkdtempSync(path.join(os.tmpdir(), 'noticeos-profile-'));
  const keys = ['CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV', 'CLOUDFLARE_INCLUDE_PROCESS_ENV', 'CLOUDFLARE_ENV', selector];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let runtime;
  const script = `export default {fetch(_request, env) { return Response.json({profile:env.${selector},optional:env.OPTIONAL_FIXTURE !== undefined}); }};`;
  try {
    for (const key of keys) delete process.env[key];
    const file = path.join(root, 'wrangler.json');
    writeFileSync(file, JSON.stringify({ name: 'noticeos-profile-fixture', main: './worker.mjs', compatibility_date: '2026-07-06', vars: { [selector]: 'hosted' } }));
    writeFileSync(path.join(root, 'worker.mjs'), script);
    for (const source of ['.dev.vars', '.env', '.dev.vars.fixture', 'process']) {
      for (const name of ['.dev.vars', '.env', '.dev.vars.fixture']) rmSync(path.join(root, name), { force: true });
      delete process.env[selector]; delete process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV;
      const environment = source === '.dev.vars.fixture' ? 'fixture' : undefined;
      if (source === 'process') { process.env[selector] = 'hosted'; process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'true'; }
      else writeFileSync(path.join(root, source), `${selector}=hosted\nOPTIONAL_FIXTURE=synthetic\n`);
      const resolved = unstable_readConfig({ config: file });
      const override = workspaceWorkerConfig(resolved, 'hosted', 'serve', environment);
      Object.assign(resolved, override);
      assert.equal(resolved.secrets.required.includes(selector), false);
      const options = unstable_getMiniflareWorkerOptions(resolved, environment).workerOptions;
      assert.equal(options.bindings[selector], 'hosted');
      const runtimeOptions = { ...options, modules: true, script, outboundService: async () => { throw new Error('No outside traffic in profile fixture'); } };
      if (runtime) await runtime.setOptions(runtimeOptions); else runtime = new Miniflare(runtimeOptions);
      assert.equal((await (await runtime.dispatchFetch('https://fixture.example.test')).json()).profile, 'hosted');
      if (source === 'process') process.env[selector] = 'demo';
      else writeFileSync(path.join(root, source), `${selector}=demo\nOPTIONAL_FIXTURE=synthetic\n`);
      // The plugin's secret reload reuses the sealed config, not secret-selected
      // authority. Even a later different profile cannot replace plain vars.
      const reload = unstable_getMiniflareWorkerOptions(resolved, environment).workerOptions;
      assert.equal(reload.bindings[selector], 'hosted');
      await runtime.setOptions({ ...runtimeOptions, ...reload });
      assert.equal((await (await runtime.dispatchFetch('https://fixture.example.test')).json()).profile, 'hosted');
      assert.throws(() => workspaceWorkerConfig(unstable_readConfig({ config: file }), 'hosted', 'serve', environment));
    }
    for (const name of ['.dev.vars', '.env', '.dev.vars.fixture']) rmSync(path.join(root, name), { force: true });
    delete process.env[selector]; delete process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV;
    const plain = unstable_readConfig({ config: file });
    delete plain.secrets;
    const built = workspaceWorkerConfig(plain, 'hosted', 'build');
    assert.equal(built.secrets, undefined, 'production optional secret requirements remain unchanged');
  } finally {
    if (runtime) await runtime.dispose();
    for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
    rmSync(root, { recursive: true, force: true });
  }
});
