import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { captureStoppedDoltSource, stoppedDoltCapturePlan, verifyStoppedDoltCapture } from './dolt-migration-capture.mjs';
import { describeDoltMigrationPlan, verifyDoltMigrationCapture } from './dolt-migration.mjs';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'noticeos-cold-capture-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, 'source'); fs.mkdirSync(source, { mode: 0o700 });
  for (const database of ['active_tasks', 'retired_tasks']) {
    fs.mkdirSync(path.join(source, database, '.dolt/noms'), { recursive: true });
    fs.mkdirSync(path.join(source, database, '.dolt/empty'));
    for (const [name, body] of [['manifest', 'Opaque committed and working root references'], ['chunk', '\0Synthetic bytes Ω']]) fs.writeFileSync(path.join(source, database, '.dolt/noms', name), body);
    fs.writeFileSync(path.join(source, database, '.dolt/repo_state.json'), '{"head":"side","backups":{}}');
  }
  fs.mkdirSync(path.join(source, '.doltcfg'));
  fs.writeFileSync(path.join(source, '.doltcfg/privileges.db'), 'Synthetic protected grant file');
  const config = path.join(base, 'server.yaml'); fs.writeFileSync(config, 'Synthetic original server declaration');
  const global = path.join(base, 'global.json'); fs.writeFileSync(global, '{"metrics.disabled":"true"}');
  const calls = [];
  const run = async (binary, args, options) => {
    calls.push({ binary, args, options });
    // Homebrew/brew 86650d0b4057ed583daf0c7be5e622d80b3ee286:
    // services/formula_wrapper.rb#L335 emits these fields, #L478 maps an
    // unloaded service to :none, #L424 preserves its formula service label.
    // https://github.com/Homebrew/brew/blob/86650d0b4057ed583daf0c7be5e622d80b3ee286/Library/Homebrew/services/formula_wrapper.rb#L335
    return { code: 0, stdout: JSON.stringify([{ name: 'dolt', service_name: 'homebrew.mxcl.dolt',
      running: false, loaded: false, schedulable: false, pid: null, status: 'none' }]), stderr: '' };
  };
  const plan = { sourceDirectory: source, outputDirectory: path.join(base, 'capture'), sourceVersion: '2.2.3',
    databases: ['active_tasks', 'retired_tasks'], service: { brew: '/absolute/bin/brew', home: base, name: 'dolt', label: 'homebrew.mxcl.dolt' },
    files: [{ name: 'server-yaml', path: config, required: true }, { name: 'global-config', path: global, required: false },
      { name: 'absent-metadata', path: path.join(base, 'absent.json'), required: false }],
    approval: 'Synthetic approval only', writerFence: 'Synthetic fixture has no server or writers' };
  return { base, source, plan, calls, run };
}

function aliasFixture(t) {
  const f = fixture(t);
  const plist = path.join(f.base, 'original-service.plist');
  fs.writeFileSync(plist, '<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>homebrew.mxcl.dolt</string></dict></plist>', { mode: 0o600 });
  f.plan.files.push({ name: 'original-service-plist', path: plist, required: true });
  f.plan.service.aliasTransition = { stoppedLabel: 'sh.brew.dolt', userId: process.getuid(),
    originalPlistName: 'original-service-plist', originalPlistSha256: createHash('sha256').update(fs.readFileSync(plist)).digest('hex') };
  const run = async (binary, args, options) => {
    if (binary === f.plan.service.brew) {
      const result = await f.run(binary, args, options);
      const rows = JSON.parse(result.stdout); rows[0].service_name = 'sh.brew.dolt';
      return { ...result, stdout: JSON.stringify(rows) };
    }
    f.calls.push({ binary, args, options });
    if (binary === '/usr/bin/plutil') {
      assert.deepEqual(args, ['-extract', 'Label', 'raw', '-o', '-', plist]);
      return { code: 0, stdout: 'homebrew.mxcl.dolt\n', stderr: '' };
    }
    assert.equal(binary, '/bin/launchctl'); assert.equal(args[0], 'print');
    const [domain, uid, label] = args[1].split('/');
    assert.ok(['gui', 'user'].includes(domain)); assert.equal(uid, String(process.getuid())); assert.equal(label, 'homebrew.mxcl.dolt');
    return { code: 113, stdout: '', stderr: `Bad request.\nCould not find service "${label}" in domain for ${domain === 'gui' ? 'user gui' : 'uid'}: ${uid}\n` };
  };
  return { ...f, run, plist };
}

test('cold capture keeps every opaque byte, empty directory, absent metadata and source version without SQL or source changes', async t => {
  const f = fixture(t);
  const result = await captureStoppedDoltSource(f.plan, { run: f.run });
  assert.equal(result.format, 'noticeos-native-dolt-capture-v1');
  assert.deepEqual(result.databases, ['active_tasks', 'retired_tasks']);
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    assert.equal(call.binary, '/absolute/bin/brew');
    assert.deepEqual(call.args, ['services', 'info', 'dolt', '--json']);
    assert.equal(call.options.env.HOMEBREW_NO_AUTO_UPDATE, '1');
    assert.equal(call.options.env.BEADS_DOLT_SERVER_PORT, undefined);
  }
  const marker = verifyStoppedDoltCapture(f.plan.outputDirectory);
  assert.equal(marker.sourceVersion, '2.2.3');
  assert.equal(marker.metadataPresent['absent-metadata'], false);
  assert.equal(fs.readFileSync(path.join(f.plan.outputDirectory, 'metadata/absent-metadata.absent'), 'utf8'), '');
  for (const relative of Object.keys(marker.inventory.files).filter(file => file.startsWith('data/'))) {
    assert.deepEqual(fs.readFileSync(path.join(f.plan.outputDirectory, relative)), fs.readFileSync(path.join(f.source, relative.slice(5))));
    assert.equal(fs.statSync(path.join(f.plan.outputDirectory, relative)).mode & 0o777, 0o600);
  }
  assert.equal(fs.statSync(path.join(f.plan.outputDirectory, 'data/retired_tasks/.dolt/empty')).isDirectory(), true);
  assert.equal(fs.statSync(f.plan.outputDirectory).mode & 0o777, 0o700);
});

test('a running, loaded, schedulable, unknown or different service refuses before source contents or output writes', async t => {
  const f = fixture(t);
  for (const patch of [{ running: true }, { loaded: true }, { schedulable: true }, { pid: 123 }, { running: null }, { name: 'other' }, { service_name: 'other' }, { service_name: 'sh.brew.dolt' }, { status: 'error' }]) {
    const run = async () => ({ code: 0, stdout: JSON.stringify([{ name: 'dolt', service_name: 'homebrew.mxcl.dolt', running: false, loaded: false, schedulable: false, pid: null, status: 'none', ...patch }]) });
    const io = { ...fs, readFileSync() { assert.fail('No source content may be read before a stopped-service proof'); } };
    await assert.rejects(captureStoppedDoltSource(f.plan, { run, fs: io }), /capture refused/u);
    assert.equal(fs.existsSync(f.plan.outputDirectory), false);
  }
});

test('existing or overlapping destinations, private-parent failure and missing writer/approval declarations refuse', async t => {
  const f = fixture(t);
  for (const patch of [{ outputDirectory: f.source }, { outputDirectory: path.join(f.source, 'nested') },
    { writerFence: '' }, { approval: '' }, { databases: ['active_tasks', 'active_tasks'] }]) assert.throws(() => stoppedDoltCapturePlan({ ...f.plan, ...patch }));
  fs.mkdirSync(f.plan.outputDirectory);
  await assert.rejects(captureStoppedDoltSource(f.plan, { run: f.run }));
  assert.equal(f.calls.length, 0);
  fs.rmdirSync(f.plan.outputDirectory); fs.chmodSync(f.base, 0o755);
  await assert.rejects(captureStoppedDoltSource(f.plan, { run: f.run }));
  assert.equal(f.calls.length, 0);
});

test('symlink and hardlink source entries cannot enter a capture', async t => {
  const f = fixture(t);
  const link = path.join(f.source, 'unsafe');
  fs.symlinkSync(path.join(f.source, '.doltcfg/privileges.db'), link);
  await assert.rejects(captureStoppedDoltSource(f.plan, { run: f.run }));
  assert.equal(fs.existsSync(f.plan.outputDirectory), false);
  fs.unlinkSync(link); fs.linkSync(path.join(f.source, '.doltcfg/privileges.db'), link);
  await assert.rejects(captureStoppedDoltSource(f.plan, { run: f.run }));
  assert.equal(fs.existsSync(f.plan.outputDirectory), false);
});

test('source change or service restart during copying preserves only an incomplete private copy', async t => {
  for (const change of ['data', 'service']) {
    const f = fixture(t); let probes = 0;
    const run = async (...args) => {
      const result = await f.run(...args);
      if (++probes === 2) {
        if (change === 'data') fs.writeFileSync(path.join(f.source, 'active_tasks/.dolt/noms/new-chunk'), 'Concurrent source change');
        else result.stdout = JSON.stringify([{ name: 'dolt', service_name: 'homebrew.mxcl.dolt', running: true, loaded: true, schedulable: false, pid: 1, status: 'started' }]);
      }
      return result;
    };
    await assert.rejects(captureStoppedDoltSource(f.plan, { run }));
    assert.equal(fs.existsSync(f.plan.outputDirectory), true);
    assert.equal(fs.existsSync(path.join(f.plan.outputDirectory, 'capture.json')), false);
  }
});

test('completed capture inventory detects changed, missing or added files before any restore', async t => {
  const f = fixture(t);
  await captureStoppedDoltSource(f.plan, { run: f.run });
  const file = path.join(f.plan.outputDirectory, 'data/active_tasks/.dolt/noms/chunk');
  fs.appendFileSync(file, 'tamper');
  assert.throws(() => verifyStoppedDoltCapture(f.plan.outputDirectory));
});

test('an explicit saved Homebrew identity proves both original domains absent before and after a canonical stopped capture', async t => {
  const f = aliasFixture(t);
  const plan = { capture: stoppedDoltCapturePlan(f.plan) };
  const description = describeDoltMigrationPlan(plan);
  assert.deepEqual(description.sourceServiceRead, ['/absolute/bin/brew', 'services', 'info', 'dolt', '--json']);
  assert.deepEqual(description.sourceServiceIdentityReads, [
    ['/usr/bin/plutil', '-extract', 'Label', 'raw', '-o', '-', f.plist],
    ['/bin/launchctl', 'print', `gui/${process.getuid()}/homebrew.mxcl.dolt`],
    ['/bin/launchctl', 'print', `user/${process.getuid()}/homebrew.mxcl.dolt`],
  ]);
  await captureStoppedDoltSource(plan.capture, { run: f.run });
  const marker = verifyDoltMigrationCapture(plan);
  assert.equal(f.calls.length, 8);
  for (const proof of [marker.serviceBefore, marker.serviceAfter]) {
    assert.equal(proof.label, 'sh.brew.dolt');
    assert.equal(proof.identityEvidence.originalLabel, 'homebrew.mxcl.dolt');
    assert.deepEqual(proof.identityEvidence.savedPlist, { name: 'original-service-plist', sha256: f.plan.service.aliasTransition.originalPlistSha256 });
    assert.equal(proof.identityEvidence.originalLabelAbsent.length, 2);
    for (const result of proof.identityEvidence.originalLabelAbsent) assert.equal(result.exitCode, 113);
  }
  assert.deepEqual(fs.readFileSync(path.join(f.plan.outputDirectory, 'metadata/original-service-plist')), fs.readFileSync(f.plist));
  for (const relative of Object.keys(marker.inventory.files).filter(file => file.startsWith('data/'))) {
    assert.deepEqual(fs.readFileSync(path.join(f.plan.outputDirectory, relative)), fs.readFileSync(path.join(f.source, relative.slice(5))));
  }
  for (const call of f.calls.filter(call => call.binary !== f.plan.service.brew)) {
    assert.deepEqual(call.options.env, { HOME: f.base, PATH: '/usr/bin:/bin' });
  }
});

test('unsupported, ambiguous or incomplete alias declarations cannot cause any command or source read', async t => {
  const f = aliasFixture(t); const alias = f.plan.service.aliasTransition;
  for (const patch of [null, {}, { ...alias, stoppedLabel: 'other' }, { ...alias, userId: alias.userId + 1 },
    { ...alias, originalPlistSha256: '' }, { ...alias, originalPlistName: 'missing' }, { ...alias, extra: true }]) {
    await assert.rejects(captureStoppedDoltSource({ ...f.plan, service: { ...f.plan.service, aliasTransition: patch } }, { run: f.run }));
  }
  for (const service of [{ ...f.plan.service, label: 'other' }, { ...f.plan.service, name: 'other' }]) {
    await assert.rejects(captureStoppedDoltSource({ ...f.plan, service }, { run: f.run }));
  }
  for (const files of [f.plan.files.map(file => ({ ...file, required: false })),
    f.plan.files.map(file => file.name === alias.originalPlistName ? { ...file, path: path.join(f.source, 'saved.plist') } : file)]) {
    await assert.rejects(captureStoppedDoltSource({ ...f.plan, files }, { run: f.run }));
  }
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(f.plan.outputDirectory), false);
});

test('live original labels and unrelated launchctl errors are refused in either domain before source contents are read', async t => {
  for (const domain of ['gui', 'user']) {
    for (const change of ['live', 'wrong-exit', 'stdout', 'permission', 'wrong-label', 'wrong-user', 'wrong-domain']) {
      const f = aliasFixture(t);
      const run = async (...args) => {
        const result = await f.run(...args);
        if (args[0] !== '/bin/launchctl' || !args[1][1].startsWith(`${domain}/`)) return result;
        if (change === 'live') return { code: 0, stdout: 'Loaded service', stderr: '' };
        if (change === 'wrong-exit') return { ...result, code: 1 };
        if (change === 'stdout') return { ...result, stdout: 'unexpected' };
        if (change === 'permission') return { ...result, stderr: 'Permission denied\n' };
        if (change === 'wrong-label') return { ...result, stderr: result.stderr.replace('homebrew.mxcl.dolt', 'other') };
        if (change === 'wrong-user') return { ...result, stderr: result.stderr.replace(`: ${process.getuid()}\n`, `: ${process.getuid() + 1}\n`) };
        return { ...result, stderr: result.stderr.replace(domain === 'gui' ? 'user gui' : 'uid', domain === 'gui' ? 'uid' : 'user gui') };
      };
      let sourceReads = 0;
      const io = { ...fs, readdirSync(...args) { sourceReads++; return fs.readdirSync(...args); } };
      await assert.rejects(captureStoppedDoltSource(f.plan, { run, fs: io }), /capture refused/u);
      assert.equal(sourceReads, 0, 'Source contents cannot be read before both absence proofs');
      assert.equal(fs.existsSync(f.plan.outputDirectory), false);
    }
  }
});

test('canonical Homebrew status and saved original plist hash and Label all remain required', async t => {
  for (const change of ['canonical-live', 'canonical-unknown', 'ambiguous-service', 'brew-error', 'hash', 'label', 'parser-error']) {
    const f = aliasFixture(t);
    if (change === 'hash') fs.appendFileSync(f.plist, 'changed');
    const run = async (...args) => {
      const result = await f.run(...args);
      if (args[0] === f.plan.service.brew) {
        const rows = JSON.parse(result.stdout);
        if (change === 'canonical-live') rows[0].loaded = true;
        if (change === 'canonical-unknown') rows[0].status = 'unknown';
        if (change === 'ambiguous-service') rows.push(rows[0]);
        return { ...result, code: change === 'brew-error' ? 1 : result.code, stdout: JSON.stringify(rows) };
      }
      if (args[0] === '/usr/bin/plutil' && change === 'label') return { ...result, stdout: 'other\n' };
      if (args[0] === '/usr/bin/plutil' && change === 'parser-error') return { code: 1, stdout: '', stderr: 'Cannot parse' };
      return result;
    };
    await assert.rejects(captureStoppedDoltSource(f.plan, { run }), /capture refused/u);
    assert.equal(fs.existsSync(f.plan.outputDirectory), false);
  }
});

test('an original-label reappearance after copying retains private custody without a completion marker', async t => {
  for (const domain of ['gui', 'user']) {
    const f = aliasFixture(t); let canonicalChecks = 0;
    const run = async (...args) => {
      const result = await f.run(...args);
      if (args[0] === f.plan.service.brew) canonicalChecks++;
      if (canonicalChecks === 2 && args[0] === '/bin/launchctl' && args[1][1].startsWith(`${domain}/`)) {
        return { code: 0, stdout: 'Original service loaded again', stderr: '' };
      }
      return result;
    };
    await assert.rejects(captureStoppedDoltSource(f.plan, { run }), /capture refused/u);
    assert.equal(fs.existsSync(path.join(f.plan.outputDirectory, 'data/active_tasks/.dolt/noms/chunk')), true);
    assert.equal(fs.existsSync(path.join(f.plan.outputDirectory, 'capture.json')), false);
    assert.equal(fs.statSync(f.plan.outputDirectory).mode & 0o777, 0o700);
  }
});

test('verification refuses mutation or removal of either recorded original-label absence proof', async t => {
  const f = aliasFixture(t); const plan = { capture: stoppedDoltCapturePlan(f.plan) };
  await captureStoppedDoltSource(f.plan, { run: f.run });
  const file = path.join(f.plan.outputDirectory, 'capture.json'); const marker = verifyDoltMigrationCapture(plan);
  for (const phase of ['serviceBefore', 'serviceAfter']) {
    for (const index of [0, 1]) {
      const changed = structuredClone(marker);
      changed[phase].identityEvidence.originalLabelAbsent[index].exitCode = 0;
      fs.writeFileSync(file, JSON.stringify(changed));
      assert.throws(() => verifyDoltMigrationCapture(plan), /capture refused/u);
    }
    const changed = structuredClone(marker); delete changed[phase].identityEvidence;
    fs.writeFileSync(file, JSON.stringify(changed));
    assert.throws(() => verifyDoltMigrationCapture(plan), /capture refused/u);
  }
  fs.writeFileSync(file, JSON.stringify(marker)); assert.deepEqual(verifyDoltMigrationCapture(plan), marker);
});

test('the copied original plist stays bound to its approved identity even if a changed inventory is internally consistent', async t => {
  const f = aliasFixture(t); const plan = { capture: stoppedDoltCapturePlan(f.plan) };
  await captureStoppedDoltSource(f.plan, { run: f.run });
  const marker = verifyDoltMigrationCapture(plan);
  const relative = 'metadata/original-service-plist';
  const changed = Buffer.from('A different saved service identity');
  fs.writeFileSync(path.join(f.plan.outputDirectory, relative), changed);
  marker.inventory.files[relative] = { bytes: changed.length, sha256: createHash('sha256').update(changed).digest('hex') };
  fs.writeFileSync(path.join(f.plan.outputDirectory, 'capture.json'), JSON.stringify(marker));
  assert.deepEqual(verifyStoppedDoltCapture(f.plan.outputDirectory), marker);
  assert.throws(() => verifyDoltMigrationCapture(plan), /capture refused/u);
});
