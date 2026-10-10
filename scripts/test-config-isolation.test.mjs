// Unit tests run on fixture configuration, never the checkout's own config/.
// scripts/test-config-isolation.mjs holds the
// guards and the allowlist; this pins that each guard refuses what it must,
// allows only the listed seed-validation tests, and is actually wired into the
// Tower, ingest and contract suites and the root script suite.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import * as nodeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { CONFIG_DOCUMENT_FILES } from './config-documents.mjs';
import {
  OWNER_CONFIG_DIR,
  OWNER_INSTALLATION_DIR,
  REPO_ROOT,
  SEED_VALIDATION_TESTS,
  fixtureConfigPlugin,
  matchesFilePattern,
  mayReadOwnerConfig,
  ownerConfigFile,
  scriptTestFile,
} from './test-config-isolation.mjs';

// These subprocesses stub every data read. Only existing generated code may
// load, including the guard's canonical configuration-catalog dependency.
const guardCodeFiles = ['scripts', 'packages/contract/src'].flatMap(dir =>
  fs.readdirSync(path.join(REPO_ROOT, dir)).filter(name => name.endsWith('.mjs'))
    .map(name => path.join(REPO_ROOT, dir, name)));

const GUARD = pathToFileURL(path.join(REPO_ROOT, 'scripts', 'test-config-isolation.mjs')).href;
const OWNER_CONSTANTS = path.join(OWNER_CONFIG_DIR, 'constants.json');
const OWNER_PULL = path.join(OWNER_CONFIG_DIR, 'pull.json');
const REFUSAL = /reads the checkout's config\/[a-z-]+\.json\. Unit tests run on fixture configuration:/;

/** A public clone may have no installation directory or a truly empty one.
 * Any nonempty installation keeps the strict saved-file checks. */
function assertSeedFilesExist(file, files, { root = REPO_ROOT, installation = OWNER_INSTALLATION_DIR } = {}) {
  const installed = fs.existsSync(installation) && fs.readdirSync(installation).length > 0;
  const configFiles = [[path.join(root, 'config'), 'config'], [installation, 'installation']]
    .filter(([dir]) => fs.existsSync(dir))
    .flatMap(([dir, prefix]) => fs.readdirSync(dir, { recursive: true })
      .filter(name => fs.statSync(path.join(dir, String(name))).isFile())
      .map(name => `${prefix}/${String(name).split(path.sep).join('/')}`));
  for (const config of files) {
    assert.match(config, /^(config|installation)\//, `${file} lists ${config}, which is in neither config/ nor the installation folder`);
    if (config.startsWith('installation/') && !installed) continue;
    const full = config.startsWith('installation/')
      ? path.join(installation, config.slice('installation/'.length)) : path.join(root, config);
    if (!config.includes('*')) {
      assert.ok(fs.existsSync(full), `${file} lists ${config}, which does not exist`);
      if (root === REPO_ROOT && installation === OWNER_INSTALLATION_DIR) assert.equal(ownerConfigFile(full), config);
    } else {
      assert.ok(configFiles.some(owner => matchesFilePattern(config, owner)),
        `${file} lists ${config}, which matches no file in config/ or installation/`);
    }
  }
}

test('every listed seed-validation test exists and names present defaults and installed files', () => {
  const entries = Object.entries(SEED_VALIDATION_TESTS);
  assert.ok(entries.length > 0);
  for (const [file, entry] of entries) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, file)), `${file} is listed but does not exist`);
    assert.match(file, /^((apps\/tower|workers\/ingest)\/test\/[^/]+\.test\.ts|scripts\/[^/]+\.test\.mjs)$/,
      `${file} is not a Tower, ingest or root script test`);
    assert.ok(entry.files.length > 0 && entry.why.trim().length > 20, `${file} must say which files and why`);
    assertSeedFilesExist(file, entry.files);
  }
});

test('absent and empty public installation folders do not require private seeds; nonempty installations stay strict', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-seed-allowance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installation = path.join(root, 'installation'); const options = { root, installation };
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config/integrations.json'), '{}');
  const files = ['config/integrations.json', 'installation/integrations.json', 'installation/*.json'];
  assertSeedFilesExist('synthetic-seed.test', files, options);
  fs.mkdirSync(installation);
  assertSeedFilesExist('synthetic-seed.test', files, options);
  for (const missing of ['config/missing.json', 'config/missing-*.json']) {
    assert.throws(() => assertSeedFilesExist('synthetic-seed.test', [missing], options), /does not exist|matches no file/u);
  }
  fs.writeFileSync(path.join(installation, 'unrelated.txt'), 'synthetic');
  assert.throws(() => assertSeedFilesExist('synthetic-seed.test', files, options), /installation\/integrations.json, which does not exist/u);
  fs.mkdirSync(path.join(installation, 'empty-subdirectory'));
  fs.rmSync(path.join(installation, 'unrelated.txt'));
  assert.throws(() => assertSeedFilesExist('synthetic-seed.test', files, options), /does not exist/u, 'an empty nested directory still makes an installation nonempty');
  fs.writeFileSync(path.join(installation, 'integrations.json'), '{}');
  assertSeedFilesExist('synthetic-seed.test', files, options);
  assert.throws(() => assertSeedFilesExist('synthetic-seed.test', ['installation/missing-*.json'], options), /matches no file/u);
});

test('a files pattern crosses directories only with **', () => {
  const registers = path.join(REPO_ROOT, 'scripts/config-registers.test.mjs');
  assert.equal(mayReadOwnerConfig(registers, 'config/pull.json'), true);
  assert.equal(mayReadOwnerConfig(registers, 'config/changesets/0001_verify-alpha-up.json'), false, '* stays inside config/');
  assert.equal(mayReadOwnerConfig(registers, 'config/dolt-server.yaml'), false);
  assert.equal(mayReadOwnerConfig(registers, 'config/xjson'), false, 'a dot is a dot');
  const prose = path.join(REPO_ROOT, 'scripts/grep-visible.test.mjs');
  assert.equal(mayReadOwnerConfig(prose, 'config/beads.README.md'), true);
  assert.equal(mayReadOwnerConfig(prose, 'config/changesets/README.md'), true, '** crosses directories');
  assert.equal(mayReadOwnerConfig(prose, 'config/constants.json'), false);
});

test('generation may read exactly the canonical product documents and never installation or unrelated config', () => {
  const generation = path.join(REPO_ROOT, 'scripts/config-contract-generation.test.mjs');
  assert.deepEqual(SEED_VALIDATION_TESTS['scripts/config-contract-generation.test.mjs'].files, CONFIG_DOCUMENT_FILES);
  for (const file of CONFIG_DOCUMENT_FILES) assert.equal(mayReadOwnerConfig(generation, file), true, file);
  for (const file of ['installation/constants.json', 'installation/beads.json', 'installation/task-host.json', 'config/beads.README.md', 'config/unregistered.json']) {
    assert.equal(mayReadOwnerConfig(generation, file), false, file);
  }
});

test('only the checkout\'s own config directory counts as owner config', () => {
  assert.equal(ownerConfigFile(OWNER_CONSTANTS), 'config/constants.json');
  assert.equal(ownerConfigFile(pathToFileURL(OWNER_PULL)), 'config/pull.json');
  assert.equal(ownerConfigFile(pathToFileURL(OWNER_PULL).href), 'config/pull.json');
  assert.equal(ownerConfigFile(path.join(REPO_ROOT, 'apps/tower/e2e/fixture-repo/installation/task-host.json')), null);
  assert.equal(ownerConfigFile(path.join(REPO_ROOT, 'workers/ingest/test/fixture-config/constants.json')), null);
  assert.equal(ownerConfigFile(path.join(os.tmpdir(), 'config', 'constants.json')), null);
  assert.equal(ownerConfigFile(OWNER_CONFIG_DIR), null);
});

// This installation's own folder is guarded exactly like
// config/, under the name `installation/…` wherever the folder really is, and
// product code may not compile it in.
test('this installation\'s folder counts as owner config, and product code may not import it', (t) => {
  const installed = path.join(OWNER_INSTALLATION_DIR, 'pull.json');
  assert.equal(ownerConfigFile(installed), 'installation/pull.json');
  assert.equal(ownerConfigFile(path.join(OWNER_INSTALLATION_DIR, 'changesets', '0001_x.json')), 'installation/changesets/0001_x.json');
  assert.equal(ownerConfigFile(path.join(os.tmpdir(), 'installation', 'pull.json')), null);
  const registers = path.join(REPO_ROOT, 'scripts/config-registers.test.mjs');
  assert.equal(mayReadOwnerConfig(registers, 'installation/pull.json'), true);
  assert.equal(mayReadOwnerConfig(path.join(REPO_ROOT, 'scripts/config-seed.test.mjs'), 'installation/pull.json'), false);

  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-config-'));
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
  const plugin = fixtureConfigPlugin({ fixtureDir, testDir: path.join(REPO_ROOT, 'workers/ingest/test') });
  assert.throws(() => plugin.resolveId(installed, path.join(REPO_ROOT, 'workers/ingest/src/pull.ts')), /product code reads the store instead/);
});

test('a seed-validation test may read only the files it is listed for', () => {
  const seeds = path.join(REPO_ROOT, 'workers/ingest/test/config-seeds.test.ts');
  assert.equal(mayReadOwnerConfig(seeds, 'config/serp-panel.json'), true);
  assert.equal(mayReadOwnerConfig(seeds, 'config/counters.json'), false);
  assert.equal(mayReadOwnerConfig(seeds, 'config/constants.json'), false);
  assert.equal(mayReadOwnerConfig(path.join(REPO_ROOT, 'apps/tower/test/mcp-route.test.ts'), 'config/integrations.json'), false);
});

test('the import guard answers source imports with the fixture copy and refuses test imports', (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-config-'));
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixtureDir, 'constants.json'), '{}');
  const testDir = path.join(REPO_ROOT, 'workers/ingest/test');
  const plugin = fixtureConfigPlugin({ fixtureDir, testDir });
  const source = path.join(REPO_ROOT, 'workers/ingest/src/config-store.ts');
  const contract = path.join(REPO_ROOT, 'packages/contract/src/os-time-zone.ts');

  // Source code — the Worker's compiled fallback, the contract's clock — gets
  // the suite's copy, query suffix and all.
  assert.equal(plugin.resolveId('../../../config/constants.json', source), path.join(fixtureDir, 'constants.json'));
  assert.equal(plugin.resolveId('../../../config/constants.json', `${contract}?v=1`), path.join(fixtureDir, 'constants.json'));
  assert.equal(plugin.resolveId('../../../config/constants.json?raw', source), `${path.join(fixtureDir, 'constants.json')}?raw`);
  assert.equal(plugin.resolveId(OWNER_CONSTANTS, source), path.join(fixtureDir, 'constants.json'));
  // A config file the suite holds no copy of fails; it never falls through.
  assert.throws(() => plugin.resolveId('../../../config/pull.json', source), /imports config\/pull\.json, and this suite holds no fixture copy of it/);

  // Test code importing the owner's config is refused, naming the file.
  assert.throws(() => plugin.resolveId('../../../config/constants.json', path.join(testDir, 'crons.test.ts')),
    /workers\/ingest\/test\/crons\.test\.ts reads the checkout's config\/constants\.json/);
  assert.throws(() => plugin.resolveId('../../../../config/constants.json', path.join(testDir, 'nested', 'helper.ts')), REFUSAL);
  // …bar a listed seed-validation test, for exactly its listed files.
  const seeds = path.join(testDir, 'config-seeds.test.ts');
  assert.equal(plugin.resolveId('../../../config/serp-panel.json', seeds), null);
  assert.throws(() => plugin.resolveId('../../../config/constants.json', seeds), REFUSAL);

  // Everything else resolves as it always did.
  assert.equal(plugin.resolveId('./fixture-config/serp-panel.json', path.join(testDir, 'x.test.ts')), null);
  assert.equal(plugin.resolveId('../../../db/postgres/x.json', source), null);
  assert.equal(plugin.resolveId('./helpers.js', source), null);
  assert.equal(plugin.resolveId('@noticeos/contract', source), null);
  assert.equal(plugin.resolveId('../../../config/constants.json', undefined), null);
});

test('the read guard refuses TEST code reading owner config before touching it, and nothing else', (t) => {
  // Real path: Node names a module by its resolved path (macOS /var is /private/var).
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owner-config-guard-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reader = `import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
export const sync = (file) => fs.readFileSync(file, 'utf8');
export const promised = (file) => readFile(file, 'utf8');
export const callback = (file) => new Promise((resolve, reject) =>
  fs.readFile(file, 'utf8', (error, value) => (error ? reject(error) : resolve(value))));
`;
  for (const file of ['test/reader.mjs', 'test/allowed.mjs', 'tool/reader.mjs']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), reader);
  }
  const fixture = path.join(REPO_ROOT, 'apps/tower/test/fixture-config/constants.json');
  // The fs primitives are stubs installed BEFORE the guard, so a broken guard
  // reaches a stub and never the operator's real file.
  const probe = `
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const reached = [];
// Keep only public guard code and these synthetic readers loadable on Node 24.
const moduleFiles = new Set(${JSON.stringify([...guardCodeFiles, ...['test/reader.mjs', 'test/allowed.mjs', 'tool/reader.mjs'].map(file => path.join(root, file))])});
const sourceRead = fs.readFileSync.bind(fs);
fs.readFileSync = (file, ...args) => {
  if (moduleFiles.has(file instanceof URL ? fileURLToPath(file) : String(file))) return sourceRead(file, ...args);
  reached.push('readFileSync ' + file); return '';
};
fs.promises.readFile = async (file) => { reached.push('promises.readFile ' + file); return ''; };
fs.readFile = (file, _encoding, done) => { reached.push('readFile ' + file); done(null, ''); };
const { installOwnerConfigReadGuard } = await import(${JSON.stringify(GUARD)});
const root = ${JSON.stringify(root)};
installOwnerConfigReadGuard({ testDir: path.join(root, 'test'),
  allowed: (caller, config) => path.basename(caller) === 'allowed.mjs' && config === 'config/constants.json' });
const test = await import(path.join(root, 'test/reader.mjs'));
const allowed = await import(path.join(root, 'test/allowed.mjs'));
const tool = await import(path.join(root, 'tool/reader.mjs'));
const outcomes = {};
const attempt = async (name, run) => {
  try { await run(); outcomes[name] = 'allowed'; } catch (error) { outcomes[name] = String(error.message); }
};
await attempt('test sync constants', () => test.sync(${JSON.stringify(OWNER_CONSTANTS)}));
await attempt('test promises pull', () => test.promised(${JSON.stringify(OWNER_PULL)}));
await attempt('test callback constants', () => test.callback(${JSON.stringify(OWNER_CONSTANTS)}));
await attempt('test sync fixture copy', () => test.sync(${JSON.stringify(fixture)}));
await attempt('seed test sync constants', () => allowed.sync(${JSON.stringify(OWNER_CONSTANTS)}));
await attempt('seed test sync pull', () => allowed.sync(${JSON.stringify(OWNER_PULL)}));
await attempt('tooling sync constants', () => tool.sync(${JSON.stringify(OWNER_CONSTANTS)}));
process.stdout.write(JSON.stringify({ reached, outcomes }));
`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 30_000,
  });
  assert.equal(run.status, 0, run.stderr);
  const { reached, outcomes } = JSON.parse(run.stdout);
  for (const name of ['test sync constants', 'test promises pull', 'test callback constants', 'seed test sync pull']) {
    assert.match(outcomes[name], REFUSAL, name);
  }
  assert.match(outcomes['test sync constants'], /owner-config-guard-[^/]+\/test\/reader\.mjs reads the checkout's config\/constants\.json/);
  assert.equal(outcomes['test sync fixture copy'], 'allowed');
  assert.equal(outcomes['seed test sync constants'], 'allowed');
  // A server a test boots (Vite loading vite.config.ts) is tooling, not test code.
  assert.equal(outcomes['tooling sync constants'], 'allowed');
  assert.deepEqual(reached, [
    `readFileSync ${fixture}`,
    `readFileSync ${OWNER_CONSTANTS}`,
    `readFileSync ${OWNER_CONSTANTS}`,
  ]);
});

test('the Tower and ingest suites are wired to both guards', () => {
  const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const tower = read('apps/tower/vitest.config.ts');
  assert.match(tower, /fixtureConfigPlugin\(\{ fixtureDir: path\.resolve\(rootDir, "test\/fixture-config"\), testDir: path\.resolve\(rootDir, "test"\) \}\)/);
  assert.match(tower, /setupFiles: \["\.\/test\/setup\.ts"\]/);
  assert.match(read('apps/tower/test/setup.ts'), /^installOwnerConfigReadGuard\(\{ testDir: /m);
  const ingest = read('workers/ingest/vitest.config.ts');
  assert.match(ingest, /fixtureConfigPlugin\(\{\s*fixtureDir: fileURLToPath\(new URL\('\.\/test\/fixture-config', import\.meta\.url\)\),\s*testDir: fileURLToPath\(new URL\('\.\/test', import\.meta\.url\)\),\s*\}\)/);
  // Every config file the ingest Worker compiles in has a fixture copy, so no
  // source import can fall through to the owner's.
  const imported = new Set();
  for (const file of fs.readdirSync(path.join(REPO_ROOT, 'workers/ingest/src'), { recursive: true })) {
    if (!String(file).endsWith('.ts')) continue;
    for (const match of read(path.join('workers/ingest/src', String(file))).matchAll(/from '(?:\.\.\/)+config\/([a-z0-9-]+\.json)'/g)) imported.add(match[1]);
  }
  // The config store shares its generic fallback values with provisioning;
  // inspect that actual compiled source too, not just its former inline imports.
  for (const match of read('scripts/config-defaults.mts').matchAll(/from '(?:\.\.\/)+config\/([a-z0-9-]+\.json)'/g)) imported.add(match[1]);
  assert.ok(imported.size >= 10, `found only ${[...imported].join(', ')}`);
  for (const name of imported) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'workers/ingest/test/fixture-config', name)), `no ingest fixture copy of config/${name}`);
  }
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'apps/tower/test/fixture-config/constants.json')), "no Tower fixture copy of the contract's compiled clock");
});

// ---------------------------------------------------------------------------
// The contract package and the root script suite
// ---------------------------------------------------------------------------

test('the contract suite is wired to both guards, with a copy of every config file it compiles in', () => {
  const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const contract = read('packages/contract/vitest.config.ts');
  assert.match(contract, /fixtureConfigPlugin\(\{\s*fixtureDir: fileURLToPath\(new URL\('\.\/test\/fixture-config', import\.meta\.url\)\),\s*testDir: fileURLToPath\(new URL\('\.\/test', import\.meta\.url\)\),\s*\}\)/);
  assert.match(contract, /setupFiles: \['\.\/test\/setup\.mjs'\]/);
  assert.match(read('packages/contract/test/setup.mjs'), /^installOwnerConfigReadGuard\(\{ testDir: /m);
  const imported = new Set();
  for (const file of fs.readdirSync(path.join(REPO_ROOT, 'packages/contract/src'))) {
    if (!/\.m?ts$/.test(file) || file.endsWith('.d.mts')) continue;
    for (const match of read(path.join('packages/contract/src', file)).matchAll(/from '(?:\.\.\/)+config\/([a-z0-9-]+\.json)'/g)) imported.add(match[1]);
  }
  assert.deepEqual([...imported], ['constants.json'], 'the contract compiles in only its clock; a new config import needs a fixture copy');
  for (const name of imported) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'packages/contract/test/fixture-config', name)), `no contract fixture copy of config/${name}`);
  }
});

test('the root script suite preloads its guard into every test file', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.match(manifest.scripts['test:scripts'], /^node --import \.\/scripts\/script-tests-setup\.mjs --test-global-setup=\.\/scripts\/script-tests-global\.mjs --test scripts\/\*\.test\.mjs$/);
  assert.match(fs.readFileSync(path.join(REPO_ROOT, 'scripts/script-tests-setup.mjs'), 'utf8'), /^installScriptTestConfigGuard\(\);$/m);
});

test('only a root script test is a script test', () => {
  assert.equal(scriptTestFile(path.join(REPO_ROOT, 'scripts/os-up.test.mjs')), 'scripts/os-up.test.mjs');
  assert.equal(scriptTestFile(pathToFileURL(path.join(REPO_ROOT, 'scripts/os-up.test.mjs'))), 'scripts/os-up.test.mjs');
  assert.equal(scriptTestFile(path.join(REPO_ROOT, 'scripts/os-up.mjs')), null, 'a script run on its own');
  assert.equal(scriptTestFile(path.join(REPO_ROOT, 'scripts/launchd/x.test.mjs')), null);
  assert.equal(scriptTestFile(path.join(REPO_ROOT, 'apps/tower/test/a.test.mjs')), null);
  assert.equal(scriptTestFile(undefined), null, 'the node --test runner has no test file of its own');
});

test('the script guard refuses every read of owner config in a test process, whoever asks', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'script-config-guard-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Code the test drives, outside scripts/ — a script's own default path is
  // refused exactly like the test's.
  fs.mkdirSync(path.join(root, 'tool'));
  fs.writeFileSync(path.join(root, 'tool/reader.mjs'), `import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
export const sync = (file) => fs.readFileSync(file, 'utf8');
export const promised = (file) => readFile(file, 'utf8');
export const callback = (file) => new Promise((resolve, reject) =>
  fs.readFile(file, 'utf8', (error, value) => (error ? reject(error) : resolve(value))));
`);
  const ownerReadme = path.join(OWNER_CONFIG_DIR, 'beads.README.md');
  const fixture = path.join(REPO_ROOT, 'scripts/fixture-config/pull.json');
  const testFile = path.join(REPO_ROOT, 'scripts/imaginary.test.mjs');
  // The fs primitives are stubs installed BEFORE the guard, so a broken guard
  // reaches a stub and never the operator's real file.
  const probe = `
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
const reached = [];
const moduleFiles = new Set(${JSON.stringify([...guardCodeFiles, path.join(root, 'tool/reader.mjs')])});
const sourceRead = fs.readFileSync.bind(fs);
fs.readFileSync = (file, ...args) => {
  if (moduleFiles.has(file instanceof URL ? fileURLToPath(file) : String(file))) return sourceRead(file, ...args);
  reached.push('readFileSync ' + (file instanceof URL ? fileURLToPath(file) : String(file))); return '{}';
};
fs.promises.readFile = async (file) => { reached.push('promises.readFile ' + file); return ''; };
fs.readFile = (file, _encoding, done) => { reached.push('readFile ' + file); done(null, ''); };
const { installScriptTestConfigGuard } = await import(${JSON.stringify(GUARD)});
const armed = {
  runner: installScriptTestConfigGuard({ testFile: undefined }),
  plainScript: installScriptTestConfigGuard({ testFile: ${JSON.stringify(path.join(REPO_ROOT, 'scripts/os-up.mjs'))} }),
  test: installScriptTestConfigGuard({ testFile: ${JSON.stringify(testFile)},
    allowed: (test, config) => test.endsWith('imaginary.test.mjs') && config === 'config/beads.README.md' }),
  again: installScriptTestConfigGuard({ testFile: ${JSON.stringify(testFile)} }),
};
const tool = await import(${JSON.stringify(pathToFileURL(path.join(root, 'tool/reader.mjs')).href)});
const outcomes = {};
const attempt = async (name, run) => {
  try { await run(); outcomes[name] = 'allowed'; } catch (error) { outcomes[name] = String(error.message); }
};
await attempt('tool sync constants', () => tool.sync(${JSON.stringify(OWNER_CONSTANTS)}));
await attempt('tool promises pull', () => tool.promised(${JSON.stringify(OWNER_PULL)}));
await attempt('tool callback constants', () => tool.callback(${JSON.stringify(OWNER_CONSTANTS)}));
await attempt('listed README', () => tool.sync(${JSON.stringify(ownerReadme)}));
await attempt('fixture copy', () => tool.sync(${JSON.stringify(fixture)}));
await attempt('import constants', () => import(pathToFileURL(${JSON.stringify(OWNER_CONSTANTS)}).href, { with: { type: 'json' } }));
await attempt('import fixture', () => import(pathToFileURL(${JSON.stringify(fixture)}).href, { with: { type: 'json' } }));
process.stdout.write(JSON.stringify({ armed, reached, outcomes }));
`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 30_000,
  });
  assert.equal(run.status, 0, run.stderr);
  const { armed, reached, outcomes } = JSON.parse(run.stdout);
  assert.deepEqual(armed, { runner: false, plainScript: false, test: true, again: false });
  for (const name of ['tool sync constants', 'tool promises pull', 'tool callback constants']) {
    assert.match(outcomes[name], REFUSAL, name);
    assert.match(outcomes[name], /^scripts\/imaginary\.test\.mjs reads the checkout's config\//, `${name} names the test, not the frame`);
    assert.match(outcomes[name], /scripts\/fixture-config\//, `${name} says where the frozen copies are`);
  }
  assert.equal(outcomes['listed README'], 'allowed');
  assert.equal(outcomes['fixture copy'], 'allowed');
  if (typeof nodeModule.registerHooks === 'function') {
    assert.match(outcomes['import constants'], /scripts\/imaginary\.test\.mjs reads the checkout's config\/constants\.json/);
  }
  assert.equal(outcomes['import fixture'], 'allowed');
  assert.deepEqual(reached.slice(0, 2), [`readFileSync ${ownerReadme}`, `readFileSync ${fixture}`]);
  // Node 24's JSON loader also reaches the stub. It may read only the fixture.
  assert.ok(reached.slice(2).every(file => file === `readFileSync ${fixture}`), JSON.stringify(reached));
});

test('this very process runs under the script guard when the suite runs', (t) => {
  if (!process.execArgv.some((arg) => arg.includes('script-tests-setup.mjs'))) {
    t.skip('run without the suite preload (pnpm test:scripts adds it)');
    return;
  }
  assert.throws(
    () => fs.readFileSync(OWNER_CONSTANTS, 'utf8'),
    /^Error: scripts\/test-config-isolation\.test\.mjs reads the checkout's config\/constants\.json/,
  );
});
