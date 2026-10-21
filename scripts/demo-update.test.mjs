// deploy/demo/update.sh against stubbed docker, curl and df: the compatible
// swap, the fresh generation on an incompatible release, its rollback, the
// script replacing its own installed copy, and the disk it keeps free. No
// container, image or network is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'deploy/demo/update.sh');
const OLD = 'a'.repeat(40), NEW = 'b'.repeat(40);
const GIB = 1024 * 1024; // df -k counts KiB

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
  const log = path.join(dir, 'docker.log'), dockerRoot = path.join(dir, 'docker-root');
  fs.mkdirSync(dockerRoot);
  // Images and the containers that use them come from the environment; an
  // image a container uses refuses removal, as Docker's does. A STUB_USED
  // entry image@project stops being used once that project is taken down.
  fs.writeFileSync(path.join(stubs, 'docker'), `#!/bin/sh
echo "$*" >> "$STUB_DOCKER_LOG"
used() { for u in $STUB_USED; do p=\${u#*@}; [ "$p" != "$u" ] && grep -qxF "$p" "$STUB_DOCKER_LOG.down" 2>/dev/null && continue; echo "\${u%@*}"; done; }
case "$*" in
  "info") exit 0 ;;
  "info --format {{.DockerRootDir}}") echo "$STUB_DOCKER_ROOT" ;;
  "image ls noticeos-demo --format {{.Repository}}:{{.Tag}}") for i in $STUB_IMAGES; do grep -qxF "$i" "$STUB_DOCKER_LOG.removed" 2>/dev/null || echo "$i"; done ;;
  "ps -a --format {{.Image}}") used ;;
  "image rm "*) used | grep -qxF "$3" && exit 1; echo "$3" >> "$STUB_DOCKER_LOG.removed" ;;
  *"up -d --wait app"*) case "$*" in *"-p $STUB_FAIL_PROJECT "*) exit 1 ;; esac ;;
  *" down --volumes")
    p=$(echo "$*" | sed -n 's/.* -p \\([^ ]*\\) .*/\\1/p')
    case " $STUB_DOWN_FAIL " in *" $p "*) echo "cannot remove $p" >&2; exit 1 ;; esac
    echo "$p" >> "$STUB_DOCKER_LOG.down" ;;
esac
exit 0
`, { mode: 0o755 });
  // Free space: STUB_DF_KB, or STUB_DF_KB_<n> for the n-th reading.
  fs.writeFileSync(path.join(stubs, 'df'), `#!/bin/sh
n=0; [ -f "$STUB_DF_COUNT" ] && n=$(cat "$STUB_DF_COUNT"); n=$((n + 1)); echo "$n" > "$STUB_DF_COUNT"
eval "kb=\\\${STUB_DF_KB_$n:-\\$STUB_DF_KB}"
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/sda1 39845888 31457280 %s 78%% /\\n' "$kb"
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
        STUB_HEALTH_COUNT: path.join(dir, 'health.count'), STUB_HEALTH_FAIL_FIRST: '0',
        STUB_DOCKER_ROOT: dockerRoot, STUB_DF_COUNT: path.join(dir, 'df.count'), STUB_DF_KB: String(50 * GIB), STUB_IMAGES: '', STUB_USED: '',
        STUB_DOWN_FAIL: '', ...env },
    });
    return { ...result, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [] };
  };
  const envFile = path.join(operator, 'demo.env');
  return { dir, operator, source, installed, run, env: () => fs.readFileSync(envFile, 'utf8'),
    setEnv: text => fs.writeFileSync(envFile, text) };
}
/** Housekeeping reads and removals, which the deploy steps below leave out. */
const housekeeping = line => line === 'info' || /^(info --format|image ls|ps -a|image rm|builder prune|system df)/u.test(line);
const compose = result => result.log.filter(line => !housekeeping(line) && !line.startsWith('build ')).map(line => line.replace(/--env-file \S+ /u, '').replace(/-f \S+ /u, ''));

test('a compatible release swaps the app in place: build, image tag only, dolt before app, data kept', t => {
  const f = fixture(t);
  const result = f.run(['--commit', NEW]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /compatible release/u); assert.match(result.stdout, new RegExp(`demo now runs ${NEW}$`, 'mu'));
  const steps = result.log.filter(line => !housekeeping(line));
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
  const steps = compose(result);
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
  const steps = compose(result);
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

const C = 'c'.repeat(40), D = 'd'.repeat(40), E = 'e'.repeat(40);
const images = (...releases) => releases.map(release => `noticeos-demo:${release}`).join(' ');
const removed = result => result.log.filter(line => line.startsWith('image rm ')).map(line => line.slice('image rm noticeos-demo:'.length));
/** A generation an earlier fresh deploy left stopped, as update.sh writes it under generations/. */
function stoppedGeneration(f, name) {
  const dir = path.join(f.operator, 'generations', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'demo.env'), `NOTICEOS_DEMO_IMAGE=noticeos-demo:${C}\nNOTICEOS_DEMO_PROJECT=${name}\n`);
  fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services: {}\n');
  return dir;
}
const downs = result => result.log.filter(line => / down --volumes$/u.test(line)).map(line => line.match(/ -p (\S+) /u)[1]);
/** The env file of a running generation named `name`, seeded from OLD. */
const running = (f, name) => f.setEnv(`NOTICEOS_DEMO_IMAGE=noticeos-demo:${OLD}\nNOTICEOS_DEMO_CONFIG=${f.operator}/demo.json\nNOTICEOS_DEMO_HTTP_PORT=16448\nNOTICEOS_DEMO_PROJECT=${name}\n`);

test('after a healthy deploy the images no container uses go, except the new release and the one it replaced', t => {
  for (const options of [{}, { scenarioVersion: 5 }]) {
    const f = fixture(t, options);
    // C is unused; D is the image of a stopped generation's containers; E is unused too.
    const result = f.run(['--commit', NEW], { STUB_IMAGES: images(OLD, NEW, C, D, E), STUB_USED: `noticeos-demo:${D}` });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(removed(result), [C, E]);
    assert.ok(result.log.includes('builder prune --all --force'), 'all unused build cache goes too');
    assert.match(result.stdout, /removed unused image noticeos-demo:c+$/mu);
    assert.match(result.stdout, /^50\.0 GiB free for Docker$/mu);
    assert.ok(!result.log.some(line => /\bvolume\b|\bdown\b|^(rm|container rm|system prune)/u.test(line)), 'no volume or container is removed');
  }
});

test('short of space, the update frees unused images before it builds', t => {
  const f = fixture(t);
  const result = f.run(['--commit', NEW], { STUB_IMAGES: images(OLD, C, D), STUB_USED: '', STUB_DF_KB_1: String(8 * GIB), STUB_DF_KB_2: String(16 * GIB) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^8\.0 GiB free for Docker and a build needs 12\.0: removing demo images/mu);
  assert.match(result.stdout, /^16\.0 GiB free now$/mu);
  const build = result.log.findIndex(line => line.startsWith('build '));
  const firstRemoval = result.log.findIndex(line => line.startsWith('image rm '));
  assert.ok(firstRemoval >= 0 && firstRemoval < build, 'images are removed before the build');
  assert.deepEqual(removed(result), [C, D], 'the running release stays, and nothing is removed twice');
});

test('still short after removing images and stopped generations, the update stops before building and shows what Docker holds', t => {
  const f = fixture(t);
  const stopped = stoppedGeneration(f, 'demo-g1');
  const result = f.run(['--commit', NEW], { STUB_IMAGES: images(OLD, C), STUB_USED: `noticeos-demo:${C}@demo-g1`, STUB_DF_KB: String(8 * GIB) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /still only 8\.0 GiB free for Docker; a build needs 12\.0\. Nothing was built and the running demo is unchanged\./u);
  assert.ok(result.log.includes('system df'), 'what Docker holds is shown');
  assert.deepEqual(downs(result), ['demo-g1']); assert.ok(!fs.existsSync(stopped));
  assert.deepEqual(removed(result), [C], 'the stopped generation\'s image goes; the running release never does');
  assert.ok(!result.log.some(line => line.startsWith('build ') || /^compose .* (up|stop) /u.test(line)), 'nothing was built, started or stopped');
  assert.ok(fs.existsSync(path.join(f.operator, 'generations/demo-preview/compose.yaml')), 'the running generation stays');
  assert.match(f.env(), new RegExp(`^NOTICEOS_DEMO_IMAGE=noticeos-demo:${OLD}$`, 'mu'));
});

test('a healthy fresh generation removes every stopped generation but the one it replaced, then their images', t => {
  const f = fixture(t, { scenarioVersion: 5 });
  running(f, 'demo-g3');
  const g2 = stoppedGeneration(f, 'demo-g2'), preview = stoppedGeneration(f, 'demo-preview');
  const result = f.run(['--commit', NEW], {
    STUB_IMAGES: images(OLD, NEW, D, E), STUB_USED: `noticeos-demo:${OLD}@demo-g3 noticeos-demo:${D}@demo-g2 noticeos-demo:${E}@demo-preview`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`demo now runs ${NEW} as generation demo-g4$`, 'mu'));
  assert.deepEqual(downs(result).sort(), ['demo-g2', 'demo-preview']);
  assert.ok(!fs.existsSync(g2) && !fs.existsSync(preview), 'their folders go after Docker removed them');
  assert.ok(fs.existsSync(path.join(f.operator, 'generations/demo-g3/demo.env')), 'the replaced generation stays for a rollback');
  assert.ok(fs.existsSync(path.join(f.operator, 'generations/demo-g4/demo.json')), 'the new generation stays');
  assert.match(result.stdout, /previous generation demo-g3 stays stopped with its volumes until the next update/u);
  assert.match(result.stdout, /-p demo-g3 -f \S+ down --volumes$/mu, 'the command that removes it sooner is printed');
  assert.deepEqual(removed(result).sort(), [D, E].sort(), 'freed images go; the replaced release stays');
  const purge = result.log.findIndex(line => / down --volumes$/u.test(line));
  const app = result.log.findIndex(line => /-p demo-g4 .*up -d --wait app/u.test(line));
  assert.ok(app >= 0 && purge > app, 'nothing is removed before the new generation is up');
});

test('a healthy compatible swap removes every stopped generation, never the running one', t => {
  const f = fixture(t);
  running(f, 'demo-g2');
  const preview = stoppedGeneration(f, 'demo-preview');
  const result = f.run(['--commit', NEW], { STUB_IMAGES: images(OLD, NEW, D), STUB_USED: `noticeos-demo:${D}@demo-preview` });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /compatible release/u);
  assert.deepEqual(downs(result), ['demo-preview']); assert.ok(!fs.existsSync(preview));
  assert.match(result.stdout, /^removed stopped generation demo-preview with its volumes$/mu);
  assert.ok(fs.existsSync(path.join(f.operator, 'generations/demo-g2/compose.yaml')), 'the running generation stays');
  assert.deepEqual(removed(result), [D]);
});

test('short of space, stopped generations go before the build when removing images is not enough', t => {
  const f = fixture(t);
  running(f, 'demo-g2');
  const g1 = stoppedGeneration(f, 'demo-g1');
  const result = f.run(['--commit', NEW], {
    STUB_IMAGES: images(OLD, D), STUB_USED: `noticeos-demo:${D}@demo-g1`,
    STUB_DF_KB_1: String(8 * GIB), STUB_DF_KB_2: String(9 * GIB), STUB_DF_KB_3: String(16 * GIB),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^9\.0 GiB free for Docker: removing stopped generations$/mu);
  assert.match(result.stdout, /^16\.0 GiB free now$/mu);
  const purge = result.log.findIndex(line => / down --volumes$/u.test(line));
  const build = result.log.findIndex(line => line.startsWith('build '));
  assert.ok(purge >= 0 && purge < build, 'the stopped generation goes before the build');
  assert.ok(!fs.existsSync(g1)); assert.deepEqual(removed(result), [D]);
  assert.ok(fs.existsSync(path.join(f.operator, 'generations/demo-g2/compose.yaml')), 'the running generation stays');
});

test('a stopped generation Docker cannot remove keeps its folder and names the command to remove it', t => {
  const f = fixture(t);
  running(f, 'demo-g3');
  const g1 = stoppedGeneration(f, 'demo-g1'), g2 = stoppedGeneration(f, 'demo-g2');
  const result = f.run(['--commit', NEW], { STUB_DOWN_FAIL: 'demo-g1' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(g1, 'demo.env')) && !fs.existsSync(g2));
  assert.match(result.stderr, /cannot remove demo-g1\ncould not remove stopped generation demo-g1; to remove it by hand:\n.*-p demo-g1 -f \S+ down --volumes$/mu);
});

test('a fresh generation that fails health removes no stopped generation', t => {
  const f = fixture(t, { scenarioVersion: 5 });
  running(f, 'demo-g3');
  const g2 = stoppedGeneration(f, 'demo-g2');
  const result = f.run(['--commit', NEW], { STUB_FAIL_PROJECT: 'demo-g4' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the volumes of demo-g4 are kept for diagnosis until the next update/u);
  assert.deepEqual(downs(result), []);
  assert.ok(fs.existsSync(g2) && fs.existsSync(path.join(f.operator, 'generations/demo-g4/demo.env')));
});
