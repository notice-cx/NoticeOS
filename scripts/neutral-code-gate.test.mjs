// The neutral-code gate (bead ro-ujb9.118): product code names no
// installation's own sites or clock, and the list it forbids is read from the
// installation itself — never written into the gate.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  PROVIDER_ZONE_FILE,
  REPO_ROOT,
  check,
  findOffenders,
  formatReport,
  installationNames,
  OLD_NAME_TEST,
  isProductFile,
  isTestFile,
  productFiles,
  testFiles,
} from './neutral-code-gate.mjs';
import { readablePath } from './installation.mjs';

const GATE = path.join(REPO_ROOT, 'scripts', 'neutral-code-gate.mjs');

/** A scratch installation: its own document in its installation folder, its
 * own historical name inventory and one product file holding `source`. */
function scratchInstallation(source, { git = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'neutral-gate-'));
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  write('installation/integrations.json', JSON.stringify({
    assets: { 'home-os': {}, 'shop.example': { clarity: {}, gsc: { ref: 'GOOGLE_SIGNAL_ACCOUNTS shop-signals -> sc-domain:shop.example' } } },
  }));
  write('config/integrations.json', JSON.stringify({ assets: {} }));
  write('installation/neutral-names.json', JSON.stringify({ assets: [
    { id: 'home-os', domain: 'os.home.example', displayName: 'Home OS', isOs: true },
    { id: 'shop.example', domain: 'shop.example', displayName: 'Shop', isOs: false },
  ] }));
  write('apps/tower/src/planted.ts', source);
  if (git) {
    for (const args of [['init', '-q'], ['config', 'user.email', 'gate@example.com'], ['config', 'user.name', 'Gate']]) {
      spawnSync('git', args, { cwd: root });
    }
  }
  return root;
}

function runGate(args, cwd = REPO_ROOT) {
  return spawnSync(process.execPath, [GATE, ...args], { cwd, encoding: 'utf8' });
}

// Whole-source checks use generic defaults. Configured-name behavior is proved
// against scratch installations below, never against an operator's live files.
function withFreshInstallation(run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'neutral-source-'));
  const previous = process.env.NOTICEOS_INSTALLATION_DIR;
  process.env.NOTICEOS_INSTALLATION_DIR = dir;
  try { return run(); }
  finally {
    if (previous === undefined) delete process.env.NOTICEOS_INSTALLATION_DIR;
    else process.env.NOTICEOS_INSTALLATION_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the list comes from this installation, never from the gate', () => {
  test("every configured asset id and the inventory's OS asset are protected", (t) => {
    const root = scratchInstallation('export {};\n');
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(path.join(root, 'installation/beads.json'), JSON.stringify({ spokes: [{ asset: 'home-os' }, { asset: 'shop.example' }] }));
    const names = installationNames(root);
    const integrations = JSON.parse(readFileSync(readablePath('config/integrations.json', { root }), 'utf8'));
    for (const asset of Object.keys(integrations.assets)) {
      assert.ok(names.has(asset.toLowerCase()), `${asset} (integrations.json) is forbidden`);
    }
    const beads = JSON.parse(readFileSync(readablePath('config/beads.json', { root }), 'utf8'));
    for (const spoke of beads.spokes) assert.ok(names.has(spoke.asset.toLowerCase()), `${spoke.asset} (beads.json)`);
    const os = [...names.values()].filter((entry) => entry.kind === 'os-asset');
    assert.equal(os.length, 1, 'exactly one OS asset, read from the installation inventory');
    assert.match(os[0].source, /^installation\/neutral-names\.json/);
  });

  test('a fresh source-only checkout has no private name inventory and still rejects product time zones', (t) => {
    const root = scratchInstallation('export {};\n');
    t.after(() => rmSync(root, { recursive: true, force: true }));
    rmSync(path.join(root, 'installation'), { recursive: true });
    assert.equal(installationNames(root).size, 0);
    const clean = check({ root });
    assert.ok(clean.files > 0, 'the scanner still reads product source');
    assert.equal(clean.names, 0);
    assert.deepEqual(clean.offenders, []);
    const names = runGate(['--root', root, '--names', '--json']);
    assert.equal(names.status, 0, names.stderr);
    assert.deepEqual(JSON.parse(names.stdout), []);
    writeFileSync(path.join(root, 'apps/tower/src/planted.ts'), "export const clock = 'Europe/Warsaw';\n");
    const blocked = runGate(['--root', root]);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /a time zone "Europe\/Warsaw"/);
  });

  test('a different installation forbids its own names, and none of this one', () => {
    const root = scratchInstallation('export {};\n');
    const names = installationNames(root);
    assert.deepEqual(
      [...names.values()].map(({ name, kind }) => `${kind} ${name}`).sort(),
      ['account google_service_account_shop_signals', 'account shop-signals', 'asset shop.example', 'display-name Shop', 'domain os.home.example', 'os-asset home-os'],
    );
  });

  test('without migrations, historical ids, domains and display names remain protected', () => {
    const root = scratchInstallation('export {};\n');
    const inventory = path.join(root, 'installation/neutral-names.json');
    const document = JSON.parse(readFileSync(inventory, 'utf8'));
    document.assets.push({ id: 'retired-site', domain: 'old.example', displayName: "Old's Site", isOs: false });
    writeFileSync(inventory, JSON.stringify(document));
    assert.equal(existsSync(path.join(root, 'db/migrations')), false);
    const run = runGate(['--root', root, '--names', '--json']);
    assert.equal(run.status, 0, run.stderr);
    const names = JSON.parse(run.stdout);
    for (const name of ['home-os', 'os.home.example', 'Shop', 'retired-site', 'old.example', "Old's Site"]) {
      assert.ok(names.some(row => row.name === name && row.source.startsWith('installation/neutral-names.json')), name);
    }
    const hits = findOffenders("const x = ['home-os', 'retired-site', 'old.example', \"Old's Site\"];", 'apps/tower/src/x.ts', installationNames(root));
    assert.equal(hits.length, 4);
  });

  test('the inventory follows the installation resolver, with no product fallback', () => {
    const root = scratchInstallation('export {};\n');
    renameSync(path.join(root, 'installation'), path.join(root, 'own'));
    const previous = process.env.NOTICEOS_INSTALLATION_DIR;
    process.env.NOTICEOS_INSTALLATION_DIR = 'own';
    try { assert.equal(installationNames(root).get('home-os').kind, 'os-asset'); }
    finally {
      if (previous === undefined) delete process.env.NOTICEOS_INSTALLATION_DIR;
      else process.env.NOTICEOS_INSTALLATION_DIR = previous;
    }
    rmSync(path.join(root, 'own'), { recursive: true });
    assert.equal(installationNames(root).size, 0, 'a neutral clone has only generic defaults');
  });

  test('a damaged inventory refuses rather than silently losing blocked names', () => {
    const root = scratchInstallation('export {};\n');
    const inventory = path.join(root, 'installation/neutral-names.json');
    for (const broken of ['{', '{}', '{"assets":[{}]}', '{"assets":[{"id":"home-os","isOs":"true","domain":null,"displayName":null}]}']) {
      writeFileSync(inventory, broken);
      const run = runGate(['--root', root, '--names']);
      assert.equal(run.status, 2, run.stderr);
      assert.match(run.stderr, /neutral-code gate: (cannot read|invalid) installation\/neutral-names\.json/);
    }
  });

  // Bead ro-ujb9.157: a site's display name and the Google accounts its sources
  // route through name the installation as surely as its domain does.
  test("a site's display name, its Google account and a name inside a path are caught", () => {
    const root = scratchInstallation('export {};\n');
    const names = installationNames(root);
    const hits = (text) => findOffenders(text, 'docs/x.md', names).map((offender) => offender.name);
    assert.deepEqual(hits('Shop measured 31px wide.'), ['Shop']);
    assert.deepEqual(hits('a shop, a Shopify store, the Shops'), [], 'a display name matches as written, as a whole word');
    assert.deepEqual(hits('"shop-signals": { … } and GOOGLE_SERVICE_ACCOUNT_SHOP_SIGNALS'), ['shop-signals', 'GOOGLE_SERVICE_ACCOUNT_SHOP_SIGNALS']);
    assert.deepEqual(hits('.local/reclamation/shop.example-open.json and shop.example_x and shop.example/panel'),
      ['shop.example', 'shop.example', 'shop.example']);
    assert.deepEqual(hits('shop.examples or myshop.example'), []);
  });
});

describe('zero offenders in generic source', () => {
  test('product source passes with generic defaults and no private inventory', () => {
    const result = withFreshInstallation(() => check({ root: REPO_ROOT }));
    assert.ok(result.files > 100, 'the gate read the product');
    const files = productFiles(REPO_ROOT);
    assert.ok(files.includes('config/integrations.json'), 'the gate read the product defaults');
    // Bead ro-ujb9.120: the local runner and the host scripts are product too,
    // a generated `.mjs` judged as its authored `.mts`, and never a test.
    assert.ok(files.includes('scripts/os-up.mjs'), 'the gate read the runner');
    assert.ok(files.includes('scripts/host-backup.mjs'), 'the gate read the backup');
    assert.ok(files.includes('scripts/installation.mts'), 'the gate read an authored .mts');
    assert.ok(!files.includes('scripts/installation.mjs'), 'a generated .mjs is judged as its .mts');
    assert.ok(!files.some((file) => /^scripts\/.*\.test\.mjs$/.test(file)), 'no script test is product');
    assert.ok(files.filter((file) => file.startsWith('scripts/')).length > 40, 'the gate read the scripts');
    // Bead ro-ujb9.157: the operator documents that ship are read too, and the
    // dated records are not.
    for (const doc of ['docs/06-operations.md', 'docs/playbooks/README.md', 'scripts/README.md', 'workers/ingest/README.md',
      'db/README.md', 'apps/tower/README.md']) {
      assert.ok(files.includes(doc), `the gate read ${doc}`);
    }
    // Legacy secret examples stay private, but remain scanned where retained.
    for (const doc of ['workers/ingest/.dev.vars.example', 'workers/ingest/.dev.secrets.example.json']) {
      if (existsSync(path.join(REPO_ROOT, doc))) assert.ok(files.includes(doc), `the gate read ${doc}`);
    }
    assert.ok(files.filter((file) => file.startsWith('docs/')).length > 30, 'the gate read the docs');
    assert.ok(!files.some((file) => /^docs\/(?:reports|briefs|artifacts)\//.test(file)), 'no dated record is read');
    // Bead ro-ujb9.149: the READMEs, the decision log and the changeset format
    // ship beside the defaults, so they are read too.
    for (const prose of ['config/decisions.md', 'config/serp-panel.README.md', 'config/changesets/README.md']) {
      assert.ok(files.includes(prose), `the gate read ${prose}`);
    }
    // A public checkout has no private inventory; configured names and an
    // absent inventory are proved independently above.
    assert.deepEqual(result.offenders, [], formatReport(result));
  });

  test('the CLI agrees, and exits 0', () => {
    const run = withFreshInstallation(() => runGate([]));
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /name none of this installation's/);
  });
});

describe('it fails on a planted name', () => {
  test('a planted asset domain, a planted OS id and a planted zone each fail, with the fixed instructions', () => {
    const root = scratchInstallation(
      [
        'export const home = "https://shop.example/pricing";',
        "export const os = 'home-os';",
        "export const clock = 'Europe/Warsaw';",
        '',
      ].join('\n'),
    );
    const run = runGate(['--root', root]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /apps\/tower\/src\/planted\.ts:1 {2}a domain "shop\.example"|apps\/tower\/src\/planted\.ts:1 {2}an asset id "shop\.example"/);
    assert.match(run.stderr, /planted\.ts:2 {2}the OS asset's id "home-os"/);
    assert.match(run.stderr, /planted\.ts:3 {2}a time zone "Europe\/Warsaw"/);
    assert.match(run.stderr.trimEnd(), /There is no baseline and no allowance: the names come from this installation's own asset list\.$/);
  });

  test("configured names fail wherever product code would plant them", (t) => {
    const root = scratchInstallation('export {};\n');
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const names = installationNames(root);
    assert.ok(names.size > 0, 'the configured-name proof cannot be empty');
    const planted = 'apps/tower/src/planted.ts';
    for (const { name, kind } of names.values()) {
      const offenders = findOffenders(`const x = "${name}";\n// see ${name} for details\n`, planted, names)
        .filter((offender) => offender.name.toLowerCase() === name.toLowerCase());
      assert.deepEqual(offenders.map((offender) => offender.line), [1, 2], `${kind} ${name} is caught in code and in a comment`);
    }
  });

  test("the product's own name is not the OS asset's id", () => {
    const root = scratchInstallation('');
    const names = installationNames(root);
    const clean = [
      'import { x } from "@home-os/contract";',
      'const KEY = "home-os:theme";',
      'const repo = "https://github.com/home-os/home-os";',
      'const db = "home-os-central";',
      'const mark = Symbol.for("home-os.runner-door");',
      "const info = 'home-os/oauth-state/v1';",
    ].join('\n');
    assert.deepEqual(findOffenders(clean, 'apps/tower/src/x.ts', names), []);
    const leaks = findOffenders("project: 'home-os',\n// home-os's own row\n", 'apps/tower/src/x.ts', names);
    assert.equal(leaks.length, 2);
  });

  // Bead ro-ujb9.125: a fresh clone seeds config/, so a name or a zone there
  // is in every stranger's installation.
  test('a product default in config/ that names a site or a zone fails', () => {
    const root = scratchInstallation('export {};\n');
    writeFileSync(path.join(root, 'config/integrations.json'), JSON.stringify({ assets: { 'shop.example': {} } }));
    writeFileSync(path.join(root, 'config/constants.json'), JSON.stringify({ os_time_zone: 'Europe/Warsaw' }));
    writeFileSync(path.join(root, 'config/dolt-server.yaml'), 'data_dir: /srv/os.home.example/beads\n');
    const run = runGate(['--root', root]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /config\/integrations\.json:1 {2}(an asset id|a domain) "shop\.example"/);
    assert.match(run.stderr, /config\/constants\.json:1 {2}a time zone "Europe\/Warsaw"/);
    assert.match(run.stderr, /config\/dolt-server\.yaml:1 {2}a domain "os\.home\.example"/);
    // The installation's own folder is its data, never judged.
    assert.equal(isProductFile('installation/integrations.json'), false);
  });

  // Bead ro-ujb9.149: a stranger learns the product from the READMEs and the
  // decision log beside the defaults, so they name nobody's sites or clock; one
  // installation's own history and decisions live in its installation folder.
  test('a README, the decision log or the changeset format naming a site or a zone fails', () => {
    const root = scratchInstallation('export {};\n');
    mkdirSync(path.join(root, 'config/changesets'), { recursive: true });
    writeFileSync(path.join(root, 'config/serp-panel.README.md'), '# panel\n\n`shop.example` is at 28 of 31.\n');
    writeFileSync(path.join(root, 'config/decisions.md'), '| D1 | clock | Europe/Warsaw |\n');
    writeFileSync(path.join(root, 'config/changesets/README.md'), '`/assets/shop.example/gsc` is an edit\n');
    writeFileSync(path.join(root, 'installation/decisions.md'), '| D4 | `shop.example` repos | Europe/Warsaw |\n');
    const run = runGate(['--root', root]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /config\/serp-panel\.README\.md:3 {2}(an asset id|a domain) "shop\.example"/);
    assert.match(run.stderr, /config\/decisions\.md:1 {2}a time zone "Europe\/Warsaw"/);
    assert.match(run.stderr, /config\/changesets\/README\.md:1 {2}(an asset id|a domain) "shop\.example"/);
    assert.doesNotMatch(run.stderr, /installation\/decisions\.md/);
  });

  // Bead ro-ujb9.120: a runner that files against, backs up to or describes
  // somebody else's sites fails like any other product code — and since bead
  // ro-ujb9.151 so does its test.
  test('a planted name in a runner or host script fails, and so does the same name in its test', () => {
    const root = scratchInstallation('export {};\n');
    writeFileSync(path.join(root, 'apps/tower/src/planted.ts'), 'export {};\n');
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(path.join(root, 'scripts/runner.mjs'), "const proof = { assets: ['home-os'] };\n");
    writeFileSync(path.join(root, 'scripts/runner.test.mjs'), "const fixture = { assets: ['home-os'] };\n");
    const run = runGate(['--root', root]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /scripts\/runner\.mjs:1 {2}the OS asset's id "home-os"/);
    assert.match(run.stderr, /scripts\/runner\.test\.mjs:1 {2}the OS asset's id "home-os"/);
    // `--files` judges the named files by the rule each falls under.
    const named = runGate(['--root', root, '--files', 'scripts/runner.test.mjs']);
    assert.equal(named.status, 1);
    assert.match(named.stderr, /scripts\/runner\.test\.mjs:1/);
  });

  // Bead ro-ujb9.151: the suites, the e2e walks, their frozen fixtures and the
  // dev seed name invented sites. A zone there is test data, not a clock.
  test('test code names none of the installation’s sites, and may name a zone', () => {
    const names = installationNames(scratchInstallation('export {};\n'));
    for (const file of ['apps/tower/test/x.test.tsx', 'apps/tower/e2e/harness.ts', 'workers/ingest/test/fixture-config/pull.json',
      'packages/contract/test/x.test.ts', 'scripts/x.test.mjs', 'scripts/fixture-config/beads.json', 'db/fixtures/dev-seed.json',
      'workers/ingest/vitest.config.ts', 'apps/tower/test/__snapshots__/x.test.tsx.snap']) {
      assert.equal(isTestFile(file), true, file);
      assert.equal(findOffenders("{ asset: 'shop.example' }", file, names).length, 1, file);
      assert.deepEqual(findOffenders("timeZone: 'Europe/Warsaw'", file, names), [], file);
    }
    for (const file of ['apps/tower/src/x.ts', 'scripts/os-up.mjs', 'apps/tower/e2e/ux-flows-results/results.json', 'installation/pull.json']) {
      assert.equal(isTestFile(file), false, file);
    }
    // The old-name rule's own test spells the product's old slug, which the
    // historical seed also gives the OS asset; nothing else is its to spell.
    assert.deepEqual(findOffenders("asset: 'home-os'", OLD_NAME_TEST, names), []);
    assert.equal(findOffenders("asset: 'shop.example'", OLD_NAME_TEST, names).length, 1);
    assert.equal(findOffenders("asset: 'home-os'", 'scripts/x.test.mjs', names).length, 1);
  });

  test('the checkout’s test code is read and passes with generic defaults', () => {
    const files = testFiles(REPO_ROOT);
    for (const file of ['apps/tower/test/fixture-config/integrations.json', 'workers/ingest/test/fixture-config/pull.json',
      'scripts/neutral-code-gate.test.mjs', 'apps/tower/e2e/wall-fixture.ts', 'db/fixtures/dev-seed.json', 'workers/ingest/vitest.config.ts']) {
      assert.ok(files.includes(file), `the gate read ${file}`);
    }
    assert.ok(files.length > 300, 'the gate read the suites');
    const result = withFreshInstallation(() => check({ root: REPO_ROOT, files }));
    assert.deepEqual(result.offenders, [], formatReport(result));
  });

  test('a zone may be named only as a provider’s reporting zone in the catalog, and UTC is neutral', () => {
    const names = new Map();
    const line = "    reportingTimeZones: { gsc: 'America/Los_Angeles' },";
    assert.deepEqual(findOffenders(line, PROVIDER_ZONE_FILE, names), []);
    assert.equal(findOffenders(line, 'workers/ingest/src/google-signals.ts', names).length, 1);
    assert.equal(findOffenders("const zone = 'America/Los_Angeles';", PROVIDER_ZONE_FILE, names).length, 1);
    assert.equal(findOffenders('const tz = "PST8PDT";', 'apps/tower/src/x.ts', names).length, 1);
    for (const neutral of ['timeZone: "UTC"', '"Etc/UTC"', 'US/English results', 'an Area/City name']) {
      assert.deepEqual(findOffenders(neutral, 'apps/tower/src/x.ts', names), [], neutral);
    }
  });

  test('tests, e2e walks and fixtures are not product source', () => {
    assert.equal(isProductFile('apps/tower/src/routes/KitchenSinkRoute.tsx'), true);
    assert.equal(isProductFile('workers/ingest/src/db.ts'), true);
    assert.equal(isProductFile('packages/contract/src/configuration.mts'), true);
    assert.equal(isProductFile('apps/tower/test/components.test.tsx'), false);
    assert.equal(isProductFile('apps/tower/e2e/fixtures.ts'), false);
    assert.equal(isProductFile('workers/ingest/test/fixture-config/pull.json'), false);
    // The runner and host scripts ship with the product (ro-ujb9.120); their
    // tests, frozen fixture config, generated declarations and README do not.
    assert.equal(isProductFile('scripts/os-up.mjs'), true);
    assert.equal(isProductFile('scripts/installation.mts'), true);
    assert.equal(isProductFile('scripts/ux-gate.settings.json'), true);
    assert.equal(isProductFile('scripts/os-up.test.mjs'), false);
    assert.equal(isProductFile('scripts/fixture-config/pull.json'), false);
    assert.equal(isProductFile('scripts/installation.d.mts'), false);
    // The product defaults are product, and so is the prose that ships beside
    // them (ro-ujb9.149); this installation's folder is not.
    assert.equal(isProductFile('config/constants.json'), true);
    assert.equal(isProductFile('config/dolt-server.yaml'), true);
    assert.equal(isProductFile('config/constants.README.md'), true);
    assert.equal(isProductFile('config/decisions.md'), true);
    assert.equal(isProductFile('config/changesets/README.md'), true);
    assert.equal(isProductFile('installation/constants.json'), false);
    assert.equal(isProductFile('installation/decisions.md'), false);
    assert.equal(isProductFile('installation/notes.md'), false);
  });

  // The repository's first screen and the docs index are what a stranger reads
  // first (bead ro-ujb9.139), and every operator document that ships explains
  // the product with example names (bead ro-ujb9.157). Dated records keep the
  // words they were written in; the owner's context pack is its own.
  test('the READMEs and the operator docs are held to it, the dated records are not', () => {
    for (const file of ['README.md', 'docs/README.md', 'docs/09-onboarding-a-site.md', 'docs/playbooks/utm-taxonomy.md',
      'docs/runbooks/one-runtime-cutover.md', 'scripts/README.md', 'workers/ingest/README.md', 'workers/ingest/.dev.vars.example',
      'workers/ingest/.dev.secrets.example.json', 'apps/tower/README.md', 'db/README.md', 'CONTEXT.md']) {
      assert.equal(isProductFile(file), true, file);
    }
    for (const file of ['docs/reports/2026-09-14-open-source-readiness.html', 'docs/reports/x.md', 'docs/briefs/2026-09-23-first-run.md',
      'docs/artifacts/first-run-2026-09-23/README.md', 'AGENTS.md', 'installation/notes.md']) {
      assert.equal(isProductFile(file), false, file);
    }
  });
});

describe('where it stops you', () => {
  test('pnpm neutral:gate exists, and the pre-commit hook runs the gate on staged files', () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    assert.equal(manifest.scripts['neutral:gate'], 'node scripts/neutral-code-gate.mjs');
    const hook = readFileSync(path.join(REPO_ROOT, '.githooks/pre-commit'), 'utf8');
    assert.match(hook, /scripts\/neutral-code-gate\.mjs" --staged/);
  });

  test('--staged refuses a staged planted name and passes a clean one', () => {
    const root = scratchInstallation("export const os = 'home-os';\n", { git: true });
    spawnSync('git', ['add', '-A'], { cwd: root });
    const blocked = runGate(['--staged', '--root', root], root);
    assert.equal(blocked.status, 1, blocked.stdout);
    assert.match(blocked.stderr, /the OS asset's id "home-os"/);

    writeFileSync(path.join(root, 'apps/tower/src/planted.ts'), 'export const os = await readOsAsset();\n');
    spawnSync('git', ['add', '-A'], { cwd: root });
    const clean = runGate(['--staged', '--root', root], root);
    assert.equal(clean.status, 0, clean.stderr);
  });

  test('a newly staged historical name rescans unchanged product files', () => {
    const root = scratchInstallation("export const site = 'retired.example';\n", { git: true });
    assert.equal(spawnSync('git', ['add', '-A'], { cwd: root }).status, 0);
    assert.equal(spawnSync('git', ['commit', '-qm', 'Synthetic neutral gate fixture'], { cwd: root }).status, 0);
    assert.equal(runGate(['--staged', '--root', root], root).status, 0);
    const inventory = path.join(root, 'installation/neutral-names.json');
    const document = JSON.parse(readFileSync(inventory, 'utf8'));
    document.assets.push({ id: 'retired.example', domain: 'retired.example', displayName: 'Retired Site', isOs: false });
    writeFileSync(inventory, JSON.stringify(document));
    assert.equal(spawnSync('git', ['add', 'installation/neutral-names.json'], { cwd: root }).status, 0);
    const blocked = runGate(['--staged', '--root', root], root);
    assert.equal(blocked.status, 1, blocked.stderr);
    assert.match(blocked.stderr, /apps\/tower\/src\/planted\.ts:1/);
  });
});
