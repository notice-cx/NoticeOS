// deploy/demo/update.sh against stubbed docker and curl: the compatible swap,
// the fresh generation on an incompatible release, its rollback, and the
// script replacing its own installed copy. No container or network is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'deploy/demo/update.sh');
const OLD = 'a'.repeat(40), NEW = 'b'.repeat(40);

/** A disposable operator directory, a target source archive and the two stubs. */
function fixture(t, { scenarioVersion = 4, migrations = 'digest-one', installedDiffers = false } = {}) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'demo-update-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const operator = path.join(dir, 'operator'), source = path.join(operator, 'src'), stubs = path.join(dir, 'bin');
  fs.mkdirSync(stubs, { recursive: true });
  fs.mkdirSync(path.join(source, 'deploy/demo'), { recursive: true });
  fs.writeFileSync(path.join(source, 'deploy/demo/compose.yaml'), 'services: {}\n');
  fs.writeFileSync(path.join(operator, 'demo.json'), JSON.stringify({ version: 1, publicOrigin: 'https://demo.example.com', seed: 'public-preview',
    cutoff: '2026-10-05T12:00:00.000Z', release: OLD, serviceExpiresAt: '2027-04-03T00:00:00.000Z' }, null, 2) + '\n');
  fs.writeFileSync(path.join(operator, 'demo.env'), `NOTICEOS_DEMO_IMAGE=noticeos-demo:${OLD}\nNOTICEOS_DEMO_CONFIG=${operator}/demo.json\nNOTICEOS_DEMO_HTTP_PORT=16448\n`);
  // The target archive: the real script, a compose file, the two compatibility markers.
  const archive = path.join(dir, 'archive'), tree = path.join(archive, `NoticeOS-${NEW}`);
  for (const sub of ['deploy/demo', 'scripts', 'db/postgres']) fs.mkdirSync(path.join(tree, sub), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(tree, 'deploy/demo/update.sh'));
  fs.writeFileSync(path.join(tree, 'deploy/demo/compose.yaml'), 'services: {}\n');
  fs.writeFileSync(path.join(tree, 'deploy/demo/Dockerfile'), 'FROM scratch\n');
  fs.writeFileSync(path.join(tree, 'scripts/demo-scenario.mts'), `export const SCENARIO_VERSION = ${scenarioVersion};\n`);
  fs.writeFileSync(path.join(tree, 'db/postgres/frozen-migrations.sha256'), `${migrations}  migrations/0001_baseline.sql\n`);
  execFileSync('tar', ['-czf', path.join(dir, 'source.tar.gz'), '-C', archive, `NoticeOS-${NEW}`]);
  // The installed copy the operator runs: the real script, optionally one comment behind.
  const installed = path.join(operator, 'update.sh');
  fs.writeFileSync(installed, fs.readFileSync(SCRIPT, 'utf8') + (installedDiffers ? '# older installed copy\n' : ''), { mode: 0o755 });
  const log = path.join(dir, 'docker.log');
  fs.writeFileSync(path.join(stubs, 'docker'), `#!/bin/sh
echo "$*" >> "$STUB_DOCKER_LOG"
case "$*" in
  "info") exit 0 ;;
  *"up -d --wait app"*) case "$*" in *"-p $STUB_FAIL_PROJECT "*) exit 1 ;; esac ;;
esac
exit 0
`, { mode: 0o755 });
  // The running release (OLD) answers with the fixture's "ours" markers; the archive is the target.
  fs.writeFileSync(path.join(stubs, 'curl'), `#!/bin/sh
for last; do :; done
case "$last" in
  *api.github.com/*) printf '%s' "$STUB_MAIN_SHA" ;;
  *archive/*.tar.gz) cat "$STUB_ARCHIVE" ;;
  */scripts/demo-scenario.mts) printf 'export const SCENARIO_VERSION = %s;\\n' "$STUB_OURS_VERSION" ;;
  */frozen-migrations.sha256) printf '%s  migrations/0001_baseline.sql\\n' "$STUB_OURS_MIGRATIONS" ;;
  *__noticeos_health)
    n=0; [ -f "$STUB_HEALTH_COUNT" ] && n=$(cat "$STUB_HEALTH_COUNT"); n=$((n + 1)); echo "$n" > "$STUB_HEALTH_COUNT"
    if [ "$n" -le "$STUB_HEALTH_FAIL_FIRST" ]; then exit 22; fi
    printf '{ "ok": true }' ;;
  *) echo "unexpected curl: $*" >&2; exit 22 ;;
esac
`, { mode: 0o755 });
  const run = (args, env = {}) => {
    const result = spawnSync('sh', [installed, '--env', path.join(operator, 'demo.env'), '--source', source, ...args], {
      encoding: 'utf8', env: { PATH: `${stubs}:${process.env.PATH}`, HOME: dir, STUB_DOCKER_LOG: log, STUB_MAIN_SHA: NEW,
        STUB_ARCHIVE: path.join(dir, 'source.tar.gz'), STUB_OURS_VERSION: '4', STUB_OURS_MIGRATIONS: 'digest-one', STUB_FAIL_PROJECT: 'none',
        STUB_HEALTH_COUNT: path.join(dir, 'health.count'), STUB_HEALTH_FAIL_FIRST: '0', ...env },
    });
    return { ...result, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [] };
  };
  const envFile = path.join(operator, 'demo.env');
  return { dir, operator, source, installed, run, env: () => fs.readFileSync(envFile, 'utf8'),
    setEnv: text => fs.writeFileSync(envFile, text) };
}
const compose = result => result.log.filter(line => line !== 'info' && !line.startsWith('build ')).map(line => line.replace(/--env-file \S+ /u, '').replace(/-f \S+ /u, ''));

test('a compatible release swaps the app in place: build, image tag only, dolt before app, data kept', t => {
  const f = fixture(t);
  const result = f.run(['--commit', NEW]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /compatible release/u); assert.match(result.stdout, new RegExp(`demo now runs ${NEW}$`, 'mu'));
  const steps = result.log.filter(line => line !== 'info');
  assert.match(steps[0], new RegExp(`^build --build-arg NOTICEOS_SOURCE_COMMIT=${NEW} `, 'u'));
  assert.deepEqual(steps.slice(1).map(line => line.replace(/--env-file \S+ /u, '').replace(/-f \S+ /u, '')),
    ['compose -p demo-preview up -d --wait --force-recreate dolt', 'compose -p demo-preview up -d --wait --force-recreate app']);
  assert.match(f.env(), new RegExp(`^NOTICEOS_DEMO_IMAGE=noticeos-demo:${NEW}$`, 'mu'));
  assert.match(f.env(), /^NOTICEOS_DEMO_PROJECT=demo-preview$/mu);
  assert.ok(!fs.existsSync(path.join(f.operator, 'generations/demo-g2')), 'no generation is created');
  assert.equal(fs.readFileSync(path.join(f.operator, 'generations/demo-preview/demo.env'), 'utf8').includes(OLD), true, 'the running generation keeps its env for a rollback');
});

test('an incompatible release brings up a fresh generation on the same port and switches the env file to it', t => {
  const f = fixture(t, { scenarioVersion: 5 });
  const before = Date.now();
  const result = f.run(['--commit', NEW]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /incompatible release: preparing fresh generation demo-g2/u);
  assert.match(result.stdout, new RegExp(`demo now runs ${NEW} as generation demo-g2$`, 'mu'));
  const steps = result.log.filter(line => line !== 'info' && !line.startsWith('build ')).map(line => line.replace(/--env-file \S+ /u, '').replace(/-f \S+ /u, ''));
  assert.deepEqual(steps, [
    'compose -p demo-g2 config --quiet',
    'compose -p demo-g2 run --rm --no-deps prepare',
    'compose -p demo-preview stop app dolt postgres',
    'compose -p demo-g2 up -d --wait postgres dolt',
    'compose -p demo-g2 run --rm setup',
    'compose -p demo-g2 up -d --wait app',
  ]);
  const config = JSON.parse(fs.readFileSync(path.join(f.operator, 'generations/demo-g2/demo.json'), 'utf8'));
  assert.equal(config.release, NEW); assert.equal(config.publicOrigin, 'https://demo.example.com'); assert.equal(config.seed, 'public-preview');
  assert.equal(config.serviceExpiresAt, '2027-04-03T00:00:00.000Z');
  assert.ok(Date.parse(config.cutoff) <= Date.now() && Date.parse(config.cutoff) >= before - 1000, 'cutoff is now, never the future');
  assert.equal(f.env(), `NOTICEOS_DEMO_IMAGE=noticeos-demo:${NEW}\nNOTICEOS_DEMO_CONFIG=${f.operator}/generations/demo-g2/demo.json\nNOTICEOS_DEMO_HTTP_PORT=16448\nNOTICEOS_DEMO_PROJECT=demo-g2\n`);
  assert.match(result.stdout, /down --volumes/u, 'the purge command is printed');
  assert.ok(!result.log.some(line => /\bdown\b/u.test(line)), 'and never run');
});

test('a fresh generation that fails health is stopped and the previous generation comes back, env untouched', t => {
  const f = fixture(t, { migrations: 'digest-two' });
  const result = f.run(['--commit', NEW], { STUB_FAIL_PROJECT: 'demo-g2' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fresh generation demo-g2 failed[\s\S]*bringing demo-preview back/u);
  assert.match(result.stderr, new RegExp(`deploy of ${NEW} failed; demo-preview at ${OLD} is back`, 'u'));
  const steps = result.log.filter(line => line !== 'info' && !line.startsWith('build ')).map(line => line.replace(/--env-file \S+ /u, '').replace(/-f \S+ /u, ''));
  assert.deepEqual(steps.slice(-4), [
    'compose -p demo-g2 up -d --wait app',
    'compose -p demo-g2 stop app dolt postgres',
    'compose -p demo-preview up -d --wait postgres dolt',
    'compose -p demo-preview up -d --wait app',
  ]);
  assert.match(f.env(), new RegExp(`^NOTICEOS_DEMO_IMAGE=noticeos-demo:${OLD}$`, 'mu'));
  assert.ok(!f.env().includes('demo-g2'), 'the env file still names the running generation');
});

test('an installed copy that fell behind hands over to the target commit\'s script and is replaced by it', t => {
  const f = fixture(t, { installedDiffers: true });
  const result = f.run(['--commit', NEW]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /continuing with the target commit's own update script/u);
  assert.match(result.stdout, /installed this release's update script/u);
  assert.equal(fs.readFileSync(f.installed, 'utf8'), fs.readFileSync(SCRIPT, 'utf8'));
  assert.equal(f.run(['--commit', NEW]).stdout.trim(), `already on ${NEW} and healthy`);
});

test('a demo left unhealthy by an older script on the target commit is deployed again: the seeded release decides, a fresh generation repairs it', t => {
  const f = fixture(t, { scenarioVersion: 5 });
  // An older update.sh swapped the image tag to the target; the generation is still the one seeded from OLD, and it is down.
  f.setEnv(`NOTICEOS_DEMO_IMAGE=noticeos-demo:${NEW}\nNOTICEOS_DEMO_CONFIG=${f.operator}/demo.json\nNOTICEOS_DEMO_HTTP_PORT=16448\n`);
  const result = f.run(['--commit', NEW], { STUB_HEALTH_FAIL_FIRST: '2' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /already on/u);
  assert.match(result.stdout, /incompatible release: preparing fresh generation demo-g2/u);
  assert.match(f.env(), /^NOTICEOS_DEMO_PROJECT=demo-g2$/mu);
  // The same situation with a failing new generation: nothing unhealthy is brought back.
  const g = fixture(t, { scenarioVersion: 5 });
  g.setEnv(`NOTICEOS_DEMO_IMAGE=noticeos-demo:${NEW}\nNOTICEOS_DEMO_CONFIG=${g.operator}/demo.json\nNOTICEOS_DEMO_HTTP_PORT=16448\n`);
  const failed = g.run(['--commit', NEW], { STUB_HEALTH_FAIL_FIRST: '2', STUB_FAIL_PROJECT: 'demo-g2' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /demo-preview was not healthy before and stays stopped/u);
  assert.ok(!compose(failed).some(line => line.startsWith('compose -p demo-preview up')), 'no attempt to revive the broken generation');
  assert.ok(g.env().includes(`noticeos-demo:${NEW}`) && !g.env().includes('demo-g2'), 'env file untouched');
});

test('a missing env file, a relative source dir and an expired grant stop before anything runs', t => {
  const f = fixture(t, { scenarioVersion: 5 });
  assert.equal(spawnSync('sh', [SCRIPT, '--env', '/nope/demo.env', '--source', f.source], { encoding: 'utf8' }).status, 1);
  assert.equal(spawnSync('sh', [SCRIPT, '--env', path.join(f.operator, 'demo.env'), '--source', 'relative'], { encoding: 'utf8' }).status, 1);
  const config = path.join(f.operator, 'demo.json');
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('2027-04-03T00:00:00.000Z', '2020-01-01T00:00:00.000Z'));
  const result = f.run(['--commit', NEW]);
  assert.equal(result.status, 1); assert.match(result.stderr, /serviceExpiresAt .* is not in the future/u);
  assert.ok(!result.log.some(line => line.startsWith('compose')), 'no container was touched');
});

test("the operator's Statcounter line survives an in-place swap and a fresh generation", t => {
  const line = 'NOTICEOS_DEMO_STATCOUNTER=12345678:0123abcd';
  for (const options of [{}, { scenarioVersion: 5 }]) {
    const f = fixture(t, options);
    f.setEnv(f.env() + line + '\n');
    const result = f.run(['--commit', NEW]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(f.env(), new RegExp(`^${line}$`, 'mu'));
    assert.match(f.env(), new RegExp(`^NOTICEOS_DEMO_IMAGE=noticeos-demo:${NEW}$`, 'mu'));
  }
});
