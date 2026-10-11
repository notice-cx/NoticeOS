import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { COMMANDS, becomeHostUser, main, naming } from './noticeos-cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = () => ({ NOTICEOS_CLI_IMAGE: 'ghcr.io/example/noticeos:main', NOTICEOS_DIR: '/srv/one installation', NOTICEOS_HOST_UID: '501', NOTICEOS_HOST_GID: '20', NOTICEOS_LAUNCHER: './noticeos' });
const sink = () => { let text = ''; return { write: (value) => { text += value; }, text: () => text }; };

test('the launcher\'s commands and the image\'s are the same list, and each names a script that has a main', async () => {
  const launcher = readFileSync(path.join(ROOT, 'deploy/compose/noticeos'), 'utf8');
  const listed = /^ {2}status\|[a-z|-]+\)$/mu.exec(launcher)[0].trim().slice(0, -1).split('|');
  assert.deepEqual([...listed, 'setup', 'update', 'migrate'].sort(), Object.keys(COMMANDS).sort());
  for (const [script] of Object.values(COMMANDS)) assert.equal(typeof (await import(script)).main, 'function', script);
});

test('each command runs its os:* twin on the installation\'s own stack.json, writing as the host user', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'nos-cli-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const [verb, [script, first]] of Object.entries(COMMANDS)) {
    let ran = null; let became = null;
    const own = env();
    const code = await main([verb, '--lines', '5'], { env: own, out: sink(), err: sink(), home: () => home, become: (value) => { became = value.NOTICEOS_HOST_UID; },
      load: async (file) => ({ main: async (argv, options) => { ran = { file, argv, options }; return 7; } }) });
    assert.equal(code, 7, verb);
    assert.equal(became, '501');
    assert.equal(ran.file, script);
    assert.deepEqual(ran.argv, [...first, '--lines', '5', '--config', '/srv/one installation/stack.json']);
    assert.equal(ran.options.env.HOME, home);
  }
});

test('outside the launcher\'s container, or with a command it does not know, nothing runs', async () => {
  const load = async () => assert.fail('a script was loaded');
  const err = sink();
  assert.equal(await main(['status'], { env: {}, out: sink(), err, load }), 1);
  assert.match(err.text(), /runs inside the container the noticeos launcher starts/u);
  assert.equal(await main(['convert-legacy'], { env: env(), out: sink(), err: sink(), load }), 2);
  assert.equal(await main([], { env: env(), out: sink(), err: sink(), load }), 2);
});

test('it drops to the host user\'s IDs and keeps the Docker socket\'s group, unless it is already them', () => {
  const calls = [];
  const proc = (uid) => ({ getuid: () => uid, setgroups: (groups) => calls.push(['groups', groups]), setgid: (gid) => calls.push(['gid', gid]), setuid: (id) => calls.push(['uid', id]) });
  const io = { statSync: () => ({ gid: 991 }) };
  becomeHostUser(env(), { proc: proc(0), io });
  assert.deepEqual(calls, [['groups', [20, 991]], ['gid', 20], ['uid', 501]]);
  calls.length = 0;
  becomeHostUser(env(), { proc: proc(501), io });
  becomeHostUser({ ...env(), NOTICEOS_HOST_UID: '0' }, { proc: proc(0), io });
  assert.deepEqual(calls, []);
  assert.throws(() => becomeHostUser({ ...env(), NOTICEOS_HOST_UID: 'me' }, { proc: proc(0), io }), /no host user/u);
});

test('a message naming a pnpm os:* command names the launcher instead', () => {
  const out = sink();
  const own = naming(out, '~/noticeos/noticeos');
  own.write('pnpm os:logs -- noticeos shows why; pnpm os:migrate -- --apply brings it up to date\n');
  own.write('settings: noticeos does not run as installation.env declares; pnpm os:apply shows the change\npnpm os:status');
  assert.equal(out.text(), '~/noticeos/noticeos logs noticeos shows why; ~/noticeos/noticeos migrate --apply brings it up to date\n'
    + 'settings: noticeos does not run as installation.env declares; ~/noticeos/noticeos apply shows the change\n~/noticeos/noticeos status');
});

test('only migrate reaches the migration command; update, restart and every other command cannot', () => {
  const reaching = Object.entries(COMMANDS).filter(([, [script]]) => /os-migrate|postgres-apply/u.test(script)).map(([verb]) => verb);
  assert.deepEqual(reaching, ['migrate']);
  for (const script of new Set(Object.values(COMMANDS).map(([file]) => file).filter((file) => !file.includes('os-migrate')))) {
    assert.doesNotMatch(readFileSync(path.join(ROOT, 'scripts', script), 'utf8'), /os-migrate|postgres-apply/u, script);
  }
});
