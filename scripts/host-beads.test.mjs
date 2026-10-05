import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { main, readHostBeadsPlan, hostBeadsArguments, runHostBeads, prepareHostBeads, selectHostBeadsSpoke, hostBeadsInput } from './host-beads.mjs';
import { startDoltPlan } from './dolt-profile.mjs';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'noticeos-host-beads-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'client-home'); fs.mkdirSync(home, { mode: 0o700 });
  const credentials = path.join(base, 'credentials'); const password = 'a'.repeat(64);
  fs.writeFileSync(credentials, `[dolt:3306]\npassword=${password}\n`, { mode: 0o600 });
  const clientProfile = path.join(base, 'client.json');
  fs.writeFileSync(clientProfile, JSON.stringify({ host: 'dolt', port: 3306, user: 'noticeos', credentialsFile: credentials, clientHome: home }), { mode: 0o600 });
  const cwd = path.join(base, 'spoke'); fs.mkdirSync(path.join(cwd, '.beads'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.beads.gate.lock'), '', { mode: 0o600 });
  fs.writeFileSync(path.join(cwd, '.beads/metadata.json'), '{"dolt_server_host":"127.0.0.1","dolt_server_port":3308}');
  const input = { format: 'noticeos-host-beads-v1', image: `sha256:${'f'.repeat(64)}`, network: `noticeos-start-${'a'.repeat(16)}_default`, clientProfile, spokes: [cwd], fallbackActor: 'synthetic-host-operator' };
  const file = path.join(base, 'wrapper.json'); fs.writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
  const calls = [];
  const run = async (binary, args, options) => {
    calls.push({ binary, args, options });
    if (args[0] === 'context') return { code: 0, stdout: 'unix:///owned/docker.sock\n' };
    if (args[0] === 'network') return { code: 0, stdout: input.network + '\n' };
    return { code: 0, stdout: 'Synthetic task result', stderr: '' };
  };
  return { base, cwd, home, credentials, clientProfile, input, file, password, calls, run };
}

test('host agents use only exact bundled image, target network and selected .beads without application startup or host bd', async t => {
  const f = fixture(t);
  const result = await runHostBeads(f.file, ['show', 'no-example', '--json'], { cwd: f.cwd, run: f.run,
    env: { HOME: f.base, PATH: '/synthetic/bin', BEADS_DOLT_SERVER_PORT: '3308', BEADS_DOLT_PASSWORD: 'synthetic-poison' } });
  assert.equal(result.code, 0); assert.equal(f.calls.length, 3);
  const call = f.calls[2]; assert.equal(call.binary, 'docker'); assert.equal(call.args[0], 'run');
  assert.equal(call.args.includes('--pull=never'), true);
  assert.equal(call.args.includes(f.input.image), true);
  assert.deepEqual(call.args.slice(-3), ['show', 'no-example', '--json']);
  assert.ok(call.args.includes(`type=bind,source=${path.join(f.cwd, '.beads')},target=/spoke/.beads`));
  assert.ok(call.args.includes(`type=bind,source=${path.join(f.cwd, '.beads.gate.lock')},target=/spoke/.beads.gate.lock`));
  assert.equal(call.args.some(value => value.includes('source=' + f.cwd + ',target=')), false);
  assert.ok(call.args.includes('BEADS_DOLT_SERVER_HOST=dolt')); assert.ok(call.args.includes('BEADS_DOLT_SERVER_PORT=3306'));
  assert.ok(call.args.includes('BEADS_CREDENTIALS_FILE=/client/credentials'));
  assert.ok(call.args.includes('DOLT_DISABLE_EVENT_FLUSH=1'));
  assert.ok(call.args.includes('BEADS_ACTOR=synthetic-host-operator'));
  assert.equal(JSON.stringify(f.calls).includes(f.password), false);
  assert.equal(JSON.stringify(f.calls).includes('synthetic-poison'), false);
  assert.equal(call.options.env.DOCKER_HOST, 'unix:///owned/docker.sock');
  assert.equal(call.options.env.DOCKER_CONTEXT, undefined);
  assert.equal(f.calls.some(item => item.args.includes('up') || item.args.includes('compose')), false);
});

test('caller actor and explicit CLI actor survive without inventing a container identity', async t => {
  const f = fixture(t);
  await runHostBeads(f.file, ['update', 'no-example', '--claim', '--actor', 'synthetic-explicit-agent'],
    { cwd: f.cwd, run: f.run, env: { BEADS_ACTOR: 'synthetic-caller-agent' } });
  const args = f.calls.at(-1).args;
  assert.ok(args.includes('BEADS_ACTOR=synthetic-caller-agent'));
  assert.deepEqual(args.slice(-5), ['update', 'no-example', '--claim', '--actor', 'synthetic-explicit-agent']);
  assert.equal(args.includes('BEADS_ACTOR=synthetic-host-operator'), false);
});

test('lint JSON refuses without contacting Docker, with flags before or after the command', async t => {
  const f = fixture(t);
  for (const args of [
    ['lint', 'no-valid', '--json'], ['--json', '--sandbox', 'lint', 'no-valid'],
    ['--actor', 'synthetic-agent', '--json=true', 'lint', 'no-valid', '--status', 'all'],
    ['lint', '--type', 'task', '-s', 'all', 'no-valid', 'no-missing', '--json'],
  ]) {
    const result = await runHostBeads(f.file, args, { cwd: f.cwd, run: f.run, env: {} });
    assert.equal(result.code, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /does not report checked tasks.*without --json/u);
  }
  assert.deepEqual(f.calls, []);
  let stdout = '', stderr = '';
  assert.equal(await main(['--plan', f.file, '--', '--json', 'lint', 'no-valid'], {
    cwd: f.cwd, run: f.run, env: {}, stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } },
  }), 1);
  assert.equal(stdout, ''); assert.match(stderr, /without --json/u);
});

test('text lint preserves checked count and native warnings; failed lookups cannot pass', async t => {
  const f = fixture(t);
  const runWith = output => async (binary, args, options) => args[0] === 'run' ? output : f.run(binary, args, options);
  const valid = { code: 0, stdout: '✓ No template warnings found (1 issues checked)\n', stderr: '' };
  assert.deepEqual(await runHostBeads(f.file, ['lint', 'no-valid'], { cwd: f.cwd, env: {}, run: runWith(valid) }), valid);
  const warning = { code: 1, stdout: 'Template warnings (1 issues, 1 warnings):\n', stderr: '' };
  assert.deepEqual(await runHostBeads(f.file, ['lint', 'no-incomplete'], { cwd: f.cwd, env: {}, run: runWith(warning) }), warning);
  for (const stderr of ['Error getting no-missing: not found: issue no-missing\n', 'Issue not found: no-missing\n']) {
    const result = await runHostBeads(f.file, ['--actor', 'synthetic-agent', 'lint', 'no-valid', 'no-missing', '--status=all'],
      { cwd: f.cwd, env: {}, run: runWith({ ...valid, stderr }) });
    assert.equal(result.code, 1); assert.equal(result.stdout, valid.stdout);
    assert.ok(result.stderr.startsWith(stderr)); assert.match(result.stderr, /did not check every requested task/u);
  }
});

test('lint guard distinguishes global values, literal IDs, help and unrelated output', async t => {
  const f = fixture(t);
  for (const args of [
    ['--actor', 'lint', 'show', 'no-valid', '--json'], ['show', 'no-valid', '--json'],
    ['create', 'lint', '--description', '--json', '--json'], ['lint', 'no-valid', '--json=false'],
    ['lint', '--json', '--help'], ['lint', '--', '--json'],
  ]) assert.equal((await runHostBeads(f.file, args, { cwd: f.cwd, env: {}, run: f.run })).code, 0);
  const fake = { code: 0, stdout: 'Error getting no-missing: quoted issue content\n',
    stderr: 'A note contains Error getting no-missing: quoted text\n' };
  const run = async (binary, args, options) => args[0] === 'run' ? fake : f.run(binary, args, options);
  assert.deepEqual(await runHostBeads(f.file, ['lint', 'no-valid'], { cwd: f.cwd, env: {}, run }), fake);
  assert.deepEqual(await runHostBeads(f.file, ['show', 'no-valid'], { cwd: f.cwd, env: {}, run: async (binary, args, options) =>
    args[0] === 'run' ? { ...fake, stderr: 'Error getting no-missing: not found\n' } : f.run(binary, args, options) }),
  { ...fake, stderr: 'Error getting no-missing: not found\n' });
});

test('one explicit directory selects only an allowed spoke, strips inner selectors and supports existing -C callers', async t => {
  const f = fixture(t); const plan = readHostBeadsPlan(f.file);
  for (const selector of [['-C', f.cwd], ['--directory', f.cwd], [`--directory=${f.cwd}`], [`-C${f.cwd}`], ['-C', 'spoke']]) {
    assert.deepEqual(selectHostBeadsSpoke(plan, f.base, [...selector, 'list', '--json']), { cwd: f.cwd, args: ['list', '--json'] });
    const result = await runHostBeads(f.file, [...selector, 'list', '--json'], { cwd: f.base, run: f.run, env: {} });
    assert.equal(result.code, 0); const call = f.calls.at(-1);
    assert.equal(call.options.cwd, f.cwd); assert.deepEqual(call.args.slice(-2), ['list', '--json']);
    assert.ok(call.args.includes(`type=bind,source=${path.join(f.cwd, '.beads')},target=/spoke/.beads`));
  }
  for (const args of [['-C', f.cwd, '--directory', f.cwd, 'list'], ['-C', '/unlisted', 'list'], ['-C'], ['--directory=', 'list']]) {
    assert.throws(() => selectHostBeadsSpoke(plan, f.base, args));
  }
});

test('preparation creates only a new private wrapper scope and keeps host CLI/profile credentials unchanged', t => {
  const f = fixture(t); const doltHome = path.join(f.base, 'dolt-home'); fs.mkdirSync(doltHome, { mode: 0o700 });
  const profile = startDoltPlan({ root: path.resolve('.'), home: doltHome, port: 63305 });
  fs.mkdirSync(profile.secretsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(profile.secretsDir, 'root'), 'b'.repeat(64) + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(profile.secretsDir, 'noticeos'), f.password + '\n', { mode: 0o600 });
  fs.writeFileSync(profile.credentialsFile, `[127.0.0.1:63308]\npassword=${f.password}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(doltHome, 'dolt/profile.json'), JSON.stringify(profile), { mode: 0o600 });
  const directory = path.join(f.base, "optional agent's wrapper"); const declaration = path.join(f.base, 'prepare.json');
  fs.writeFileSync(declaration, JSON.stringify({ format: 'noticeos-host-beads-prepare-v1', doltHome, directory,
    image: f.input.image, spokes: [f.cwd], fallbackActor: f.input.fallbackActor }), { mode: 0o600 });
  const before = fs.readFileSync(profile.credentialsFile);
  const result = prepareHostBeads(declaration);
  assert.equal(result.hostEntrypointChanged, false);
  assert.equal(readHostBeadsPlan(result.plan).fallbackActor, f.input.fallbackActor);
  assert.equal(fs.statSync(result.wrapper).mode & 0o777, 0o700);
  const script = fs.readFileSync(result.wrapper, 'utf8');
  assert.ok(script.includes("agent'\\''s")); assert.ok(script.includes('"$@"'));
  assert.equal(script.includes(f.password), false);
  assert.deepEqual(fs.readFileSync(profile.credentialsFile), before);
  assert.throws(() => prepareHostBeads(declaration), 'An existing wrapper directory cannot be adopted');
});

test('undeclared/linked spokes and alternate CLI selectors fail before Docker contact', async t => {
  const f = fixture(t); const plan = readHostBeadsPlan(f.file);
  for (const args of [['--directory=/source', 'list'], ['-C/source', 'list'], ['--db', '/source', 'list'], ['--global', 'list'], []]) {
    assert.throws(() => hostBeadsArguments(plan, f.cwd, args));
  }
  await assert.rejects(runHostBeads(f.file, ['list'], { cwd: f.base, run: f.run }));
  assert.equal(f.calls.length, 0);
  const gate = path.join(f.cwd, '.beads.gate.lock'); fs.unlinkSync(gate);
  await assert.rejects(runHostBeads(f.file, ['list'], { cwd: f.cwd, run: f.run })); assert.equal(f.calls.length, 0);
  fs.writeFileSync(gate, '', { mode: 0o600 });
  const beads = path.join(f.cwd, '.beads'); fs.renameSync(beads, beads + '-held'); fs.symlinkSync(beads + '-held', beads);
  await assert.rejects(runHostBeads(f.file, ['list'], { cwd: f.cwd, run: f.run })); assert.equal(f.calls.length, 0);
});

test('unprotected declarations, floating images, old root selectors and remote Docker endpoints are refused', async t => {
  const f = fixture(t);
  fs.chmodSync(f.file, 0o644); assert.throws(() => readHostBeadsPlan(f.file)); fs.chmodSync(f.file, 0o600);
  fs.writeFileSync(f.file, JSON.stringify({ ...f.input, image: 'noticeos:latest' })); assert.throws(() => readHostBeadsPlan(f.file));
  fs.writeFileSync(f.file, JSON.stringify(f.input));
  const client = JSON.parse(fs.readFileSync(f.clientProfile));
  fs.writeFileSync(f.clientProfile, JSON.stringify({ ...client, user: 'root' })); assert.throws(() => readHostBeadsPlan(f.file));
  fs.writeFileSync(f.clientProfile, JSON.stringify(client));
  await assert.rejects(runHostBeads(f.file, ['list'], { cwd: f.cwd, run: async () => ({ code: 0, stdout: 'tcp://remote.example:2375' }), env: {} }));
});

test('compatibility CLI preserves task output/exit status while redacting protected credentials in both streams', async t => {
  const f = fixture(t); let stdout = ''; let stderr = '';
  const run = async (...args) => args[1][0] === 'run' ? { code: 2, stdout: `Task ${f.password}`, stderr: `Failure ${f.password}` } : f.run(...args);
  const code = await main(['--plan', f.file, '--', 'list'], { cwd: f.cwd, run, env: {}, stdout: { write(value) { stdout += value; } }, stderr: { write(value) { stderr += value; } } });
  assert.equal(code, 2); assert.equal(stdout, 'Task [redacted]'); assert.equal(stderr, 'Failure [redacted]');
});


test('a protected shared-project declaration selects only its exact default network', async t => {
  const f = fixture(t);
  for (const network of ['noticeos_default', 'noticeos-shared-example_default']) {
    f.input.network = network;
    fs.writeFileSync(f.file, JSON.stringify(f.input), { mode: 0o600 });
    const result = await runHostBeads(f.file, ['list', '--json'], { cwd: f.cwd, run: f.run, env: {} });
    assert.equal(result.code, 0);
    const command = f.calls.at(-1).args;
    assert.equal(command[command.indexOf('--network') + 1], network);
  }
  for (const network of ['default', '_default', 'noticeos_other', 'UPPER_default', 'bad name_default', '../other_default']) {
    fs.writeFileSync(f.file, JSON.stringify({ ...f.input, network }), { mode: 0o600 });
    assert.throws(() => readHostBeadsPlan(f.file));
  }
});

test('one explicit file is forwarded as exact bytes without content in argv, environment or additional mounts', async t => {
  const f = fixture(t); const name = "Unicode Ω, 'quote' $(literal) `text`\n.txt";
  const file = path.join(f.cwd, name); const bytes = Buffer.from('First Ω 🧭\r\nSecond line\n\n');
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  const commands = [
    ['--sandbox', '--actor', 'create', 'comments', 'add', 'no-example', '--file', name],
    ['comments', 'add', 'no-example', `--file=${file}`],
    ['comments', 'add', 'no-example', '-f', name],
    ['comments', 'add', 'no-example', `-f${file}`],
    ['comments', 'add', 'no-example', `-f=${file}`],
    ['comment', 'no-example', '--file', name],
    ['create', 'Synthetic title', '--body-file', name, '--json'],
    ['create', 'Synthetic title', '--stdin=false', '--body-file', name],
    ['create', '-s', 'open', 'Synthetic title', '--body-file', name],
    ['new', '-s', 'open', 'Synthetic title', '--body-file', name],
    ['update', 'no-example', '-s', 'open', '--body-file', name],
    ['comments', 'add', 'no-example', '-a', 'Synthetic author', '-f', name],
    ['new', '--title=Literal title', `--description-file=${file}`],
    ['update', 'no-example', '--design-file', file],
  ];
  for (const args of commands) {
    f.calls.length = 0;
    const input = await hostBeadsInput(args, { cwd: f.cwd, stdin: { get isTTY() { assert.fail('File input must not read stdin'); } } });
    assert.deepEqual(input.stdin, bytes); assert.equal(input.args.includes(file), false); assert.equal(input.args.includes(name), false);
    const result = await runHostBeads(f.file, args, { cwd: f.cwd, run: f.run, env: {} });
    assert.equal(result.code, 0);
    const call = f.calls.at(-1); assert.deepEqual(call.options.stdin, bytes); assert.deepEqual(call.args.slice(0, 2), ['run', '-i']);
    assert.deepEqual(call.args.filter(arg => arg.startsWith('type=bind,')), [
      `type=bind,source=${path.join(f.cwd, '.beads')},target=/spoke/.beads`,
      `type=bind,source=${path.join(f.cwd, '.beads.gate.lock')},target=/spoke/.beads.gate.lock`,
      `type=bind,source=${f.credentials},target=/client/credentials,readonly`,
    ]);
    assert.equal(JSON.stringify(call.args).includes('First Ω'), false); assert.equal(JSON.stringify(call.options.env).includes('First Ω'), false);
    assert.deepEqual(fs.readFileSync(file), bytes);
  }
});

test('supported explicit stdin is forwarded unchanged and only the final client command receives it', async t => {
  const f = fixture(t); const bytes = Buffer.from('Unicode Ω\r\nKeep these trailing newlines\n\n');
  for (const args of [['create', 'Synthetic', '--body-file', '-'], ['new', 'Synthetic', '--stdin'],
    ['update', 'no-example', '--description-file=-'], ['update', 'no-example', '--stdin=true'],
    ['update', 'no-example', '--design-file', '-'], ['comments', 'add', 'no-example', '--file', '-'],
    ['comment', 'no-example', '--stdin']]) {
    f.calls.length = 0;
    await runHostBeads(f.file, args, { cwd: f.cwd, run: f.run, env: {}, stdin: Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]) });
    assert.deepEqual(f.calls.at(-1).options.stdin, bytes);
    assert.equal(f.calls.slice(0, -1).some(call => call.options.stdin !== undefined), false);
    assert.deepEqual(f.calls.at(-1).args.slice(-args.length), args);
  }
});

test('ordinary commands, false stdin, help, consumed values and arguments after -- never read or rewrite input', async t => {
  const f = fixture(t); const never = { get isTTY() { assert.fail('No implicit stdin read'); } };
  for (const args of [['list', '--json'], ['create', 'Synthetic', '--stdin=false'],
    ['create', '--description', '--body-file=/missing'], ['create', '--title', 'comment', '--description=--stdin'],
    ['create', '--description', '-Coutside'], ['create', '--description', '--server-host=remote.example'],
    ['create', '-s', '-Coutside'], ['update', 'no-example', '-s', '--server-host=remote.example'],
    ['create', '--description', '--', '--json'],
    ['comments', 'add', 'no-example', '--', '--file', '/missing'],
    ['comment', 'no-example', '--', '--stdin'], ['create', '--help', '--body-file', '/missing'],
    ['comments', 'add', 'no-example', '-h', '-f', '/missing']]) {
    assert.deepEqual(await hostBeadsInput(args, { cwd: f.cwd, stdin: never }), { args, stdin: null });
    f.calls.length = 0;
    await runHostBeads(f.file, args, { cwd: f.cwd, run: f.run, env: {}, stdin: never });
    assert.equal(f.calls.at(-1).options.stdin, undefined); assert.equal(f.calls.at(-1).args.includes('-i'), false);
    assert.deepEqual(f.calls.at(-1).args.slice(-args.length), args);
  }
});

test('literal file values cannot become directory or endpoint selectors and relative files follow the selected spoke', async t => {
  const f = fixture(t); const plan = readHostBeadsPlan(f.file);
  for (const name of ['-Coutside', '--directory=outside', '--global', '--']) {
    fs.writeFileSync(path.join(f.cwd, name), name, { mode: 0o600 });
    const args = ['-C', 'spoke', 'comments', 'add', 'no-example', '--file', name];
    const selected = selectHostBeadsSpoke(plan, f.base, args);
    assert.equal(selected.cwd, f.cwd);
    await runHostBeads(f.file, args, { cwd: f.base, run: f.run, env: {} });
    assert.deepEqual(f.calls.at(-1).options.stdin, Buffer.from(name));
  }
  const literal = ['comments', 'add', 'no-example', '--', '--directory=/literal', '-Cliteral', '--global'];
  assert.deepEqual(selectHostBeadsSpoke(plan, f.cwd, literal), { cwd: f.cwd, args: literal });
  assert.doesNotThrow(() => hostBeadsArguments(plan, f.cwd, literal));
  for (const args of [['--db', 'other', 'comments', 'add', 'no-example', '--file', '/missing'],
    ['comments', 'add', 'no-example', '--file', '/missing', '--server-host=remote.example'],
    ['comments', 'add', 'no-example', '--file', '--', '--server-host=remote.example'],
    ['create', '--description', '--', '--server-host=remote.example']]) {
    f.calls.length = 0; await assert.rejects(runHostBeads(f.file, args, { cwd: f.cwd, run: f.run, env: {} })); assert.equal(f.calls.length, 0);
  }
});

test('delete and unknown commands cannot hide actual target selectors behind guessed short or long option values', async t => {
  const f = fixture(t); const plan = readHostBeadsPlan(f.file);
  for (const command of ['delete', 'unrecognized-command']) {
    for (const guessed of ['-f', '--status', '--file', '--title']) {
      for (const selector of [['--database', 'other'], ['--db', 'other'], ['-C', '/outside'], ['--server-host', 'remote.example']]) {
        const args = [command, 'no-example', guessed, ...selector];
        f.calls.length = 0;
        await assert.rejects(runHostBeads(f.file, args, { cwd: f.cwd, run: f.run, env: {} }));
        assert.equal(f.calls.length, 0, `${command} ${guessed} must not conceal ${selector[0]}`);
        assert.throws(() => hostBeadsArguments(plan, f.cwd, args));
      }
    }
  }
  for (const args of [['delete', 'no-example', '-f', '--', '--database', 'other'],
    ['unrecognized-command', '--file', '--', '--db', 'other'],
    ['create', 'Synthetic', '--event-payload', '--', '--database', 'other'],
    ['update', 'no-example', '--unproven-option', '--', '--server-host=remote.example']]) {
    f.calls.length = 0;
    await assert.rejects(runHostBeads(f.file, args, { cwd: f.cwd, run: f.run, env: {} }));
    assert.equal(f.calls.length, 0);
  }
});

test('missing, oversized, unreadable, nonregular and linked input files refuse before Docker contact', async t => {
  const f = fixture(t); const good = path.join(f.base, 'input'); fs.writeFileSync(good, 'Synthetic', { mode: 0o600 });
  const large = path.join(f.base, 'large'); fs.writeFileSync(large, Buffer.alloc(1024 * 1024 + 1));
  const unreadable = path.join(f.base, 'unreadable'); fs.writeFileSync(unreadable, 'Synthetic', { mode: 0o000 });
  const link = path.join(f.base, 'symlink'); fs.symlinkSync(good, link);
  const hardlink = path.join(f.base, 'hardlink'); fs.linkSync(good, hardlink);
  for (const file of [path.join(f.base, 'missing'), large, unreadable, f.base, link, hardlink]) {
    f.calls.length = 0;
    await assert.rejects(runHostBeads(f.file, ['comments', 'add', 'no-example', '--file', file], { cwd: f.cwd, run: f.run, env: {} }));
    assert.equal(f.calls.length, 0);
  }
});

test('explicit file bytes work through parent aliases including macOS /tmp while leaf links still refuse', async t => {
  const f = fixture(t); const parent = path.join(f.base, 'input-folder'); fs.mkdirSync(parent);
  const file = path.join(parent, 'input.txt'); const bytes = Buffer.from('Exact Ω bytes\r\n\n');
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  const alias = path.join(f.base, 'parent-alias'); fs.symlinkSync(parent, alias);
  const paths = [path.join(alias, 'input.txt')];
  for (const systemAlias of ['/tmp', '/var']) {
    const canonical = fs.realpathSync(systemAlias);
    if (file.startsWith(`${canonical}${path.sep}`)) paths.push(path.join(systemAlias, path.relative(canonical, file)));
  }
  if (process.platform === 'darwin' && file.startsWith('/private/tmp/')) assert.ok(paths.some(value => value.startsWith('/tmp/')));
  for (const selected of paths) {
    await runHostBeads(f.file, ['comments', 'add', 'no-example', '--file', selected], { cwd: f.cwd, run: f.run, env: {} });
    assert.deepEqual(f.calls.at(-1).options.stdin, bytes);
  }
  const leaf = path.join(parent, 'leaf-link'); fs.symlinkSync(file, leaf);
  f.calls.length = 0;
  await assert.rejects(runHostBeads(f.file, ['comments', 'add', 'no-example', '--file', path.join(alias, 'leaf-link')], { cwd: f.cwd, run: f.run, env: {} }));
  assert.equal(f.calls.length, 0);
});

test('ambiguous inputs, unsupported bare options and failed or oversized stdin refuse without transport', async t => {
  const f = fixture(t);
  for (const args of [['create', 'Synthetic', '--body-file', '-', '--design-file', '-'],
    ['comment', 'no-example', '--stdin', '--file', '/missing'],
    ['create', 'Synthetic', '--body-file', '-','--unknown-option'],
    ['create', 'Synthetic', '--body-file', '-', '--file', '/missing'],
    ['create', 'Synthetic', '--body-file', '-', '--description', 'Conflicting inline text'],
    ['update', 'no-example', '--design-file', '-', '--design=Conflicting inline text'],
    ['comment', 'no-example', 'Conflicting positional text', '--stdin'],
    ['comments', 'add', 'no-example', '--file', '-', '--', 'Conflicting positional text'],
    ['create', 'Synthetic', '--body-file', '-', '-f', '/missing'],
    ['new', '--body-file', '-', '-f=/missing'], ['create', '--body-file', '-', '-f/missing'],
    ['comment', 'no-example', '--file', '/missing', '-s', 'open'],
    ['comments', 'add', 'no-example', '-d', 'unsupported', '--file', '/missing'],
    ['update', 'no-example', '--body-file'], ['comments', 'add', 'no-example', '--file=']]) {
    await assert.rejects(runHostBeads(f.file, args, { cwd: f.cwd, run: f.run, env: {}, stdin: Buffer.from('Synthetic') }));
    assert.equal(f.calls.length, 0);
  }
  for (const source of [Buffer.alloc(1024 * 1024 + 1), Readable.from([Buffer.alloc(1024 * 1024 + 1)]),
    Readable.from([{ unsupported: 'non-byte chunk' }]),
    new Readable({ read() { this.destroy(new Error('Synthetic input failure')); } }), { isTTY: true }]) {
    await assert.rejects(runHostBeads(f.file, ['create', 'Synthetic', '--stdin'], { cwd: f.cwd, run: f.run, env: {}, stdin: source }));
    assert.equal(f.calls.length, 0);
  }
  const closed = new Readable({ read() {} }); closed.destroy();
  await assert.rejects(runHostBeads(f.file, ['create', 'Synthetic', '--stdin'], { cwd: f.cwd, run: f.run, env: {}, stdin: closed }));
  assert.equal(f.calls.length, 0);
});

test('forwarded input keeps empty and exact-limit bytes, and a client refusal keeps its exit status and streams', async t => {
  const f = fixture(t);
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(1024 * 1024, 0x61)]) {
    const file = path.join(f.base, 'bounded-input'); fs.writeFileSync(file, bytes, { mode: 0o600 });
    await runHostBeads(f.file, ['update', 'no-example', '--body-file', file, '--allow-empty-description'], { cwd: f.cwd, run: f.run, env: {} });
    assert.deepEqual(f.calls.at(-1).options.stdin, bytes);
  }
  let stdout = ''; let stderr = '';
  const run = async (...args) => args[1][0] === 'run' ? { code: 2, stdout: 'Original task output', stderr: 'Original client refusal\n' } : f.run(...args);
  const code = await main(['--plan', f.file, '--', 'comment', 'no-example', '--stdin'], {
    cwd: f.cwd, run, env: {}, stdin: Buffer.from('Synthetic Unicode Ω\n\n'),
    stdout: { write(value) { stdout += value; } }, stderr: { write(value) { stderr += value; } },
  });
  assert.equal(code, 2); assert.equal(stdout, 'Original task output'); assert.equal(stderr, 'Original client refusal\n');
});
