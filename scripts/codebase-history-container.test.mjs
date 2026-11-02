// Opt-in cross-Git proof using an already-present pinned measurement image.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { historyMeasureArgs, parseHistoryArgs, prepareHistory, snapshotIndex } from './codebase-history.mjs';
import { runCommand } from './run-command.mjs';

const image = process.env.NOTICEOS_TEST_CODEBASE_IMAGE;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (repo, args, dates = {}) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'init.templateDir=', '-C', repo, ...args], {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', ...dates },
});

test('the pinned image reads immutable host indexes and resumes real measurements after source HEAD moves', { skip: !image, timeout: 180_000 }, async () => {
  assert.match(image, /@sha256:[a-f0-9]{64}$/u, 'provide an existing digest-pinned measurement image');
  const free = fs.statfsSync(os.tmpdir());
  assert.ok(free.bavail * free.bsize > 8 * 1024 ** 3 + 100 * 1024 ** 2, 'retain the 8 GiB margin');
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-history-container-'));
  const live = new Set();
  async function remove(name) {
    const result = await runCommand('docker', ['rm', '--force', name]);
    if (result.code !== 0 && !/No such container/iu.test(result.stderr)) throw new Error(`Owned fixture container ${name} could not be retired`);
    live.delete(name);
  }
  try {
    const repo = path.join(own, 'repo'); fs.mkdirSync(repo);
    git(repo, ['init', '--initial-branch=main']);
    git(repo, ['config', 'user.name', 'Fixture']); git(repo, ['config', 'user.email', 'fixture@example.com']);
    fs.mkdirSync(path.join(repo, 'src')); fs.mkdirSync(path.join(repo, 'records'));
    fs.writeFileSync(path.join(repo, 'src/app.js'), 'export const count = 1;\n');
    for (let i = 0; i < 6800; i++) fs.writeFileSync(path.join(repo, 'records', `${String(i).padStart(5, '0')}-record.txt`), 'fixture\n');
    const commit = date => {
      git(repo, ['add', '.']); git(repo, ['commit', '-m', 'fixture'], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
      return git(repo, ['rev-parse', 'HEAD']).trim();
    };
    const first = commit('2026-09-01T12:00:00Z');
    const firstFiles = git(repo, ['ls-files', '-z', '--cached']);
    const indexes = path.join(own, 'indexes'); fs.mkdirSync(indexes);
    const immutable = snapshotIndex(repo, indexes, '2026-09-01');
    const bytes = fs.readFileSync(immutable);
    fs.writeFileSync(path.join(repo, 'src/app.js'), 'export const count = 2;\nexport const added = 3;\n');
    for (let i = 6800; i < 7100; i++) fs.writeFileSync(path.join(repo, 'records', `${String(i).padStart(5, '0')}-record.txt`), 'next\n');
    commit('2026-09-08T12:00:00Z');
    assert.notEqual(hash(git(repo, ['ls-files', '-z', '--cached'])), hash(firstFiles));
    assert.deepEqual(fs.readFileSync(immutable), bytes);
    const settings = path.join(own, 'settings.json'); fs.writeFileSync(settings, '{}');
    const name = `noticeos-history-index-${randomUUID()}`;
    const args = historyMeasureArgs({ asset: 'example.com', image, ref: 'main', paths: ['src'] }, { effectiveAt: '2026-09-01T23:59:59Z' }, repo, settings, name, immutable);
    const probe = `const cp=require('node:child_process'),crypto=require('node:crypto');const files=cp.execFileSync('git',['-c','safe.directory=*','-C','/repo','ls-files','-z','--cached']);console.log(JSON.stringify({git:cp.execFileSync('git',['--version'],{encoding:'utf8'}).trim(),hash:crypto.createHash('sha256').update(files).digest('hex')}));`;
    args.splice(args.indexOf(image) + 1, args.length, '-e', probe);
    live.add(name);
    try {
      const result = await runCommand('docker', args, { timeoutMs: 30_000 });
      assert.equal(result.code, 0, result.stderr);
      const read = JSON.parse(result.stdout);
      assert.equal(read.hash, hash(firstFiles), 'the container reads the captured index, independently of the host checkout now at the second revision');
      process.stdout.write(`Cross-Git proof: ${git(repo, ['--version']).trim()} -> ${read.git}\n`);
    } finally { await remove(name); }
    const options = parseHistoryArgs(['--asset', 'example.com', '--repo', repo, '--image', image, '--out', path.join(own, 'output'), '--paths', 'src', '--from', '2026-09-01', '--to', '2026-09-08', '--step-days', '7', '--measure'], new Date('2026-10-01T00:00:00Z'));
    let runs = 0;
    const run = async (command, args, options) => {
      if (args[0] === 'run') { runs++; live.add(args[args.indexOf('--name') + 1]); }
      const result = await runCommand(command, args, options);
      if (args[0] === 'rm' && (result.code === 0 || /No such container/iu.test(result.stderr))) live.delete(args.at(-1));
      return result;
    };
    const quiet = { write() {} };
    const bundle = await prepareHistory(options, { run, out: quiet });
    assert.equal(runs, 2);
    assert.equal(bundle.reports[0].repository.commit, first);
    assert.equal(bundle.reports[0].measures.files, 1);
    assert.ok(bundle.reports[1].measures.code_lines > bundle.reports[0].measures.code_lines);
    assert.deepEqual(bundle.reports.map(report => report.measures.commits_30d), [1, 2]);
    assert.equal(bundle.reports[0].tools.profile, bundle.reports[1].tools.profile);
    const cached = path.join(options.out, '2026-09-01.json');
    const plan = path.join(options.out, 'plan.json');
    const preserved = { cached: fs.readFileSync(cached), plan: fs.readFileSync(plan), modified: fs.statSync(cached).mtimeMs };
    fs.unlinkSync(path.join(options.out, '2026-09-08.json'));
    fs.writeFileSync(path.join(repo, 'src/later.js'), 'throw new Error("historical code must never execute");\n');
    commit('2026-09-09T12:00:00Z');
    const sourceIndex = fs.readFileSync(path.join(repo, '.git', 'index'));
    await assert.rejects(prepareHistory(options, { run, out: quiet }), /different plan/);
    const resumed = await prepareHistory({ ...options, resume: true }, { run, out: quiet });
    assert.equal(runs, 3, 'resume measures only the missing report');
    assert.deepEqual(resumed.reports[0], bundle.reports[0]);
    assert.equal(resumed.reports[1].repository.commit, bundle.reports[1].repository.commit);
    assert.equal(resumed.reports[1].tools.profile, bundle.reports[1].tools.profile);
    assert.deepEqual(fs.readFileSync(cached), preserved.cached);
    assert.equal(fs.statSync(cached).mtimeMs, preserved.modified);
    assert.deepEqual(fs.readFileSync(plan), preserved.plan);
    assert.deepEqual(fs.readFileSync(path.join(repo, '.git', 'index')), sourceIndex);
  } finally {
    await Promise.all([...live].map(remove));
    fs.rmSync(own, { recursive: true, force: true });
  }
});
