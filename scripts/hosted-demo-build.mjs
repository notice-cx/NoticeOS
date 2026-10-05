// Build-only preview artifact. No dev server, account lookup, remote binding,
// deployment, runtime secret resolution or installation discovery.
import path from 'node:path';
import { builtinModules, createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, realpathSync, existsSync, statfsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { stripJsonc } from './jsonc.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function refuse() { throw new Error('Demo artifact build refused.'); }
function inventory(root, relative = '') {
  return readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return inventory(root, name);
    if (!entry.isFile()) refuse();
    return [name];
  });
}
/** Trusted build-time defaults root is useful for disposable fixture builds;
 * it never changes the source code or request-selected configuration. */
export async function buildHostedDemo({ out, configurationRoot = path.join(ROOT, 'config') }) {
  if (typeof out !== 'string' || !path.isAbsolute(out) || existsSync(out)
    || realpathSync(path.dirname(out)) !== path.dirname(out)
    || typeof configurationRoot !== 'string' || !path.isAbsolute(configurationRoot)
    || realpathSync(configurationRoot) !== configurationRoot) refuse();
  const capacity = statfsSync(path.dirname(out));
  if (Number(capacity.bavail) * Number(capacity.bsize) - 2 * 1024 ** 3 < 8 * 1024 ** 3) refuse();
  const require = createRequire(path.join(ROOT, 'apps/tower/package.json'));
  const wrangler = createRequire(require.resolve('wrangler/package.json'));
  const { build: compile } = wrangler('esbuild');
  const work = path.join(out, 'build-config'); mkdirSync(work, { recursive: true, mode: 0o700 });
  for (const [relative, main] of [['apps/tower/wrangler.jsonc', 'apps/tower/worker/index.ts'], ['workers/ingest/wrangler.jsonc', 'workers/ingest/src/index.ts']]) {
    const original = JSON.parse(stripJsonc(readFileSync(path.join(ROOT, relative), 'utf8')));
    const target = path.join(work, relative); mkdirSync(path.dirname(target), { recursive: true });
    const clean = { name: original.name, main: path.join(ROOT, main), compatibility_date: original.compatibility_date,
      compatibility_flags: original.compatibility_flags, vars: { NOTICEOS_WORKSPACE_PROFILE: 'demo' },
      ...(original.assets ? { assets: original.assets } : {}), ...(original.services ? { services: original.services } : {}), send_metrics: false };
    writeFileSync(target, JSON.stringify(clean));
  }
  // Reuse the actual production Vite configuration. Only its static default
  // imports are redirected for a server-owned synthetic build, never tests'
  // fixed defines or fake UI/API modules.
  const source = path.join(ROOT, 'apps/tower/vite.config.ts'), compiled = path.join(work, 'vite.mjs');
  await compile({ entryPoints: [source], outfile: compiled, bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent',
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(source).href) }, plugins: [{ name: 'demo-build-defaults', setup(builder) {
      builder.onResolve({ filter: /config\/[^/]+\.json$/ }, args => {
        const resolved = path.resolve(args.resolveDir, args.path);
        if (path.dirname(resolved) === path.join(ROOT, 'config')) return { path: path.join(configurationRoot, path.basename(resolved)) };
      });
      builder.onResolve({ filter: /^[^./]/ }, async args => {
        if (args.pluginData === 'resolved') return;
        const resolved = await builder.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: 'resolved' });
        return resolved.errors.length ? undefined : { path: resolved.path, external: true };
      });
    } }] });
  const selectors = ['NOTICEOS_WORKER_CONFIG_ROOT', 'NOTICEOS_WORKSPACE_PROFILE', 'CLOUDFLARE_ENV'];
  const previous = Object.fromEntries(selectors.map(key => [key, process.env[key]]));
  if (previous.CLOUDFLARE_ENV !== undefined) refuse();
  process.env.NOTICEOS_WORKER_CONFIG_ROOT = work; process.env.NOTICEOS_WORKSPACE_PROFILE = 'demo';
  let release, towerConfig;
  try {
    const config = (await import(pathToFileURL(compiled).href)).default({ command: 'build', mode: 'production' });
    release = JSON.parse(config.define.__NOTICEOS_RELEASE__);
    const { createBuilder } = await import(require.resolve('vite'));
    const defaults = { name: 'demo-build-source-defaults', enforce: 'pre', resolveId(specifier, importer) {
      if (!importer || !specifier.split('?')[0].endsWith('.json')) return;
      const resolved = path.resolve(path.dirname(importer.split('?')[0]), specifier.split('?')[0]);
      if (path.dirname(resolved) === path.join(ROOT, 'config')) return path.join(configurationRoot, path.basename(resolved));
    } };
    const builder = await createBuilder({ ...config, root: path.join(ROOT, 'apps/tower'), configFile: false, envDir: false,
      plugins: [defaults, ...config.plugins], build: { ...config.build, outDir: out, emptyOutDir: false, sourcemap: false } });
    await builder.buildApp();
    towerConfig = inventory(out).filter(name => name.endsWith('/wrangler.json')).map(name => ({ name, value: JSON.parse(readFileSync(path.join(out, name), 'utf8')) }))
      .find(({ value }) => value.name === 'noticeos-tower');
    if (!towerConfig) refuse();
  } finally {
    for (const key of selectors) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
  const ingestOut = path.join(out, 'ingest');
  const ingestSource = path.join(work, 'compiled-ingest.mjs');
  await compile({ entryPoints: [path.join(ROOT, 'workers/ingest/src/index.ts')], outfile: ingestSource, bundle: true,
    platform: 'neutral', format: 'esm', target: 'es2022', mainFields: ['module', 'main'], conditions: ['workerd', 'browser'], logLevel: 'silent',
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire("/demo-worker.mjs");' },
    external: [...builtinModules, ...builtinModules.map(name => `node:${name}`), 'cloudflare:*', 'pg-native'],
    plugins: [{ name: 'demo-ingest-defaults', setup(builder) {
      builder.onResolve({ filter: /config\/[^/]+\.json$/ }, args => {
        const resolved = path.resolve(args.resolveDir, args.path);
        if (path.dirname(resolved) === path.join(ROOT, 'config')) return { path: path.join(configurationRoot, path.basename(resolved)) };
      });
    } }] });
  const ingestConfig = path.join(work, 'workers/ingest/wrangler.jsonc');
  const ingestMetadata = JSON.parse(readFileSync(ingestConfig, 'utf8'));
  ingestMetadata.main = ingestSource; writeFileSync(ingestConfig, JSON.stringify(ingestMetadata));
  const metadata = wrangler('wrangler/package.json'), wranglerFile = path.join(path.dirname(wrangler.resolve('wrangler/package.json')), metadata.bin.wrangler);
  // An explicit config outside the checkout excludes local .env/.dev.vars.
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'NODE_OPTIONS'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  Object.assign(env, { WRANGLER_SEND_METRICS: 'false', WRANGLER_HIDE_BANNER: 'true', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false' });
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wranglerFile, 'deploy', '--dry-run', '--config', path.join(work, 'workers/ingest/wrangler.jsonc'), '--outdir', ingestOut],
      { cwd: work, env, stdio: 'inherit' });
    let escalation;
    const timeout = setTimeout(() => { child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 5000); }, 60000);
    child.once('error', error => { clearTimeout(timeout); clearTimeout(escalation); reject(error); });
    child.once('close', code => { clearTimeout(timeout); clearTimeout(escalation); code === 0 ? resolve() : reject(new Error('Demo ingest build unavailable.')); });
  });
  const files = Object.fromEntries(inventory(out).filter(name => !name.startsWith('build-config/') && !name.endsWith('.map')).map(name => [name, sha(readFileSync(path.join(out, name)))]));
  const towerRoot = path.dirname(towerConfig.name), client = 'client';
  if (!files['client/index.html'] || !files['ingest/compiled-ingest.js']) refuse();
  const manifest = { version: 1, release, client,
    tower: { main: path.posix.normalize(`${towerRoot}/${towerConfig.value.main}`), modulesRoot: towerRoot, compatibilityDate: towerConfig.value.compatibility_date, compatibilityFlags: towerConfig.value.compatibility_flags },
    ingest: { main: 'ingest/compiled-ingest.js', modulesRoot: 'ingest', compatibilityDate: '2026-07-06', compatibilityFlags: ['nodejs_compat'] },
    files, publicFiles: Object.keys(files).filter(name => name.startsWith('client/') && !name.split('/').some(part => part.startsWith('.'))
      && !/(?:^|\/)wrangler\.json/u.test(name)) };
  writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    const args = process.argv.slice(2);
    if (![2, 4].includes(args.length) || args[0] !== '--out' || args.length === 4 && args[2] !== '--configuration-root') refuse();
    const manifest = await buildHostedDemo({ out: args[1], ...(args.length === 4 ? { configurationRoot: args[3] } : {}) });
    process.stdout.write(`Demo artifact ${manifest.release}\n`);
  } catch { process.stderr.write('Demo artifact build failed.\n'); process.exitCode = 1; }
}
