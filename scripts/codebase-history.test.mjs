import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverGatePolicy, historyMeasureArgs, importBatches, parseHistoryArgs, parseReleaseHistory, planHistory, prepareHistory, verificationFor } from './codebase-history.mjs';
import { measure } from '../deploy/codebase-report/measure.mjs';

const PIN = `example.com/measure@sha256:${'a'.repeat(64)}`;
const quiet = { write() {} };
const NOW = new Date('2026-11-02T12:00:00Z');
const git = (repo, args, env = {}) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args],
  { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-history-test-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  git(repo, ['init', '--initial-branch=main']);
  git(repo, ['config', 'user.name', 'Fixture']); git(repo, ['config', 'user.email', 'fixture@example.com']);
  git(repo, ['config', 'remote.origin.url', 'ssh://git@code.example/owner/site.git']);
  const write = (name, text) => { fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true }); fs.writeFileSync(path.join(repo, name), text); };
  write('.husky/pre-push', '#!/bin/sh\nexec "$(git rev-parse --show-toplevel)/scripts/git-hooks/pre-push" "$@"\n');
  write('scripts/git-hooks/pre-push', `#!/bin/sh
set -eu
for sha in $SHAS; do
git worktree add --detach "$WT" "$sha"
cd "$WT"
npm run verify:release
if [ "$sha" = "$MAIN_SHA" ]; then
node "$WT/scripts/release-registry.mjs" record --out "$MAIN_ROOT/_releases/releases.jsonl" --commit "$sha"
fi
done
`);
  write('scripts/release-registry.mjs', 'throw new Error("never execute registry");');
  write('package.json', JSON.stringify({ scripts: { 'verify:release': 'npm run build && npm test' } }));
  write('.noticeos-codebase.json', JSON.stringify({ exclude: ['old/**'] }));
  const commit = (at, content) => {
    write('src/app.js', content);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'fixture'], { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at });
    return git(repo, ['rev-parse', 'HEAD']);
  };
  const first = commit('2026-08-01T12:00:00Z', 'export const value = 1;');
  const released = commit('2026-10-01T12:00:00Z', 'export const value = 2;');
  const middle = commit('2026-10-03T12:00:00Z', 'export const value = 3;');
  const latest = commit('2026-11-01T12:00:00Z', 'export const value = 4;');
  write('_releases/releases.jsonl', JSON.stringify({ commit: released, recordedAt: '2026-10-01T13:00:00Z', branch: 'main', counts: { added: 1, changed: 2, removed: 0, total: 3 } }) + '\n');
  const options = parseHistoryArgs(['--asset', 'example.com', '--repo', repo, '--out', path.join(dir, 'out'), '--image', PIN,
    '--from', '2026-10-01', '--to', '2026-11-01', '--step-days', '7', '--releases', '_releases/releases.jsonl'], NOW);
  return { dir, repo, options, first, released, middle, latest, write, commit };
}

test('bounded, offline preview selects deterministic cutoffs, includes a 30-day point and distinguishes missing history', t => {
  const f = fixture(t);
  const plan = planHistory(f.options);
  assert.equal(plan.snapshots[0].commit, f.released);
  assert.equal(plan.snapshots.at(-1).commit, f.latest);
  assert.equal(plan.remote, 'code.example/owner/site');
  assert.ok(plan.snapshots.some(row => row.effectiveAt.startsWith('2026-10-02')));
  assert.deepEqual(plan, planHistory(f.options));
  const missing = planHistory({ ...f.options, dates: ['2026-07-01', '2026-08-01'] });
  assert.match(missing.snapshots[0].missing, /No reachable commit/);
  assert.equal(missing.snapshots[1].commit, f.first);
  assert.throws(() => parseHistoryArgs(['--asset', 'example.com', '--repo', f.repo, '--out', f.dir, '--image', 'example.com/measure:main'], NOW), /digest-pinned/);
  assert.throws(() => parseHistoryArgs(['--asset', 'example.com', '--repo', f.repo, '--out', f.dir, '--image', PIN, '--from', '2026-01-01', '--to', '2026-11-01', '--step-days', '1'], NOW), /100 snapshots/);
  fs.writeFileSync(path.join(f.repo, '.git', 'shallow'), f.latest + '\n');
  assert.throws(() => planHistory(f.options), /complete local Git history/);
});

test('existing hook plus JSONL recovers exact-revision passes without an authored policy or executing historical code', t => {
  const f = fixture(t);
  const plan = planHistory(f.options);
  const evidence = plan.snapshots[0].verification;
  assert.deepEqual(evidence.map(row => row.measure), ['build_passed', 'tests_passed']);
  assert.ok(evidence.every(row => row.commit === f.released && row.source === '_releases/releases.jsonl'));
  assert.equal(evidence[0].files['scripts/git-hooks/pre-push'], git(f.repo, ['rev-parse', `${f.released}:scripts/git-hooks/pre-push`]));
  assert.deepEqual(verificationFor(f.repo, f.middle, plan.releases, plan.gateSources.flatMap(row => row.policy ? [row.policy] : [])), []);
  assert.deepEqual(plan.snapshots.at(-1).verification, []);
  assert.equal(discoverGatePolicy(f.repo, f.released, 'other.jsonl'), null);
  assert.equal(git(f.repo, ['status', '--porcelain']), '?? _releases/');
});

test('registry adapter preserves supersession and timing; malformed timestamps stay rejected', () => {
  const a = { commit: 'a'.repeat(40), recordedAt: '2026-10-01T10:00:00Z' };
  const b = { commit: 'b'.repeat(40), recordedAt: '2026-10-01T11:00:00Z', supersedes: [a.commit], deployedAt: '2026-10-01T11:05:00Z' };
  const result = parseReleaseHistory([a, b, { commit: a.commit }, { ...a, recordedAt: 'bad' }].map(row => JSON.stringify(row)).join('\n'), 'releases.jsonl');
  assert.equal(result.releases.length, 2); assert.equal(result.issues.length, 2);
  assert.equal(result.releases[0].deployedAt, undefined);
  assert.deepEqual(result.releases[1].supersedes, [a.commit]);
  assert.deepEqual(parseReleaseHistory(JSON.stringify(a), 'releases.jsonl').releases[0], result.releases[0]);
});

test('measurement uses isolated snapshots, frozen settings, no network or repo code, and resumes without remeasuring', async t => {
  const f = fixture(t); const before = git(f.repo, ['status', '--porcelain']);
  let calls = 0; let measuredCheckout;
  const run = async (command, args) => {
    if (args[0] === 'rm') return { code: 0, stdout: '' };
    calls++; assert.equal(command, 'docker'); assert.equal(args[args.indexOf('--network') + 1], 'none');
    assert.ok(args.includes('--read-only')); assert.ok(!args.includes('--post'));
    measuredCheckout = args.find(arg => arg.startsWith('type=bind,source=') && arg.includes('target=/repo')).split('source=')[1].split(',')[0];
    assert.notEqual(measuredCheckout, f.repo);
    const commit = git(measuredCheckout, ['rev-parse', 'HEAD']);
    assert.equal(git(measuredCheckout, ['config', '--get', 'remote.origin.url']), 'https://code.example/owner/site.git');
    return { code: 0, stdout: JSON.stringify({ asset: 'example.com', generatedAt: NOW.toISOString(), repository: { commit, ref: 'main', committedAt: git(measuredCheckout, ['show', '-s', '--format=%cI', 'HEAD']) },
      tools: { image: PIN, profile: 'b'.repeat(64), scc: '3', jscpd: '5', lizard: '1' }, measures: { code_lines: 100 }, unmeasured: { tests_passed: 'No run', vulnerable_dependencies: 'No audit' } }) };
  };
  const bundle = await prepareHistory({ ...f.options, measure: true }, { run, out: quiet });
  assert.equal(bundle.reports[0].measures.tests_passed, 1);
  assert.equal(bundle.reports[0].measures.vulnerable_dependencies, undefined);
  assert.equal(bundle.reports[0].generatedAt, NOW.toISOString());
  assert.equal(bundle.reports[0].history.effectiveAt, '2026-10-01T23:59:59Z');
  assert.ok(!fs.existsSync(measuredCheckout));
  const measuredCalls = calls;
  assert.deepEqual(await prepareHistory({ ...f.options, measure: true }, { run, out: quiet }), bundle);
  assert.equal(calls, measuredCalls); assert.equal(git(f.repo, ['status', '--porcelain']), before);
  await assert.rejects(prepareHistory({ ...f.options, image: `example.com/other@sha256:${'a'.repeat(64)}` }, { run, out: quiet }), /different plan/);
  await assert.rejects(prepareHistory({ ...f.options, asset: 'other.example' }, { run, out: quiet }), /different plan/);
  const args = historyMeasureArgs(f.options, bundle.reports[0].history, '/tmp/source', '/tmp/settings');
  assert.ok(args.includes('--as-of'));
});

test('historical churn uses the snapshot cutoff while actual measurement time stays current', async t => {
  const f = fixture(t);
  const snapshot = path.join(f.dir, 'snapshot');
  git(f.dir, ['clone', '--no-hardlinks', f.repo, snapshot]);
  git(snapshot, ['checkout', '--detach', f.released]);
  const report = await measure({ asset: 'example.com', repo: snapshot, now: NOW, asOf: new Date('2026-10-02T23:59:59Z'), log() {} });
  assert.equal(report.measures.commits_30d, 1);
  assert.equal(report.generatedAt, '2026-11-02T12:00:00Z');
  assert.equal(report.measures.build_passed, undefined);
  assert.equal(report.history.effectiveAt, '2026-10-02T23:59:59Z');
  await assert.rejects(measure({ asset: 'example.com', repo: f.repo, now: NOW, asOf: new Date('2026-10-02T23:59:59Z'), log() {} }), /commit follows/);
});

test('source preview explains unrecognized, unavailable and non-main evidence without treating it as a failed check', t => {
  const f = fixture(t);
  f.write('_releases/releases.jsonl', JSON.stringify({ commit: f.released, recordedAt: '2026-10-01T13:00:00Z', branch: 'feature' }) + '\n');
  let plan = planHistory(f.options);
  assert.match(plan.gateSources[0].reason, /branch is not covered/);
  assert.deepEqual(plan.snapshots[0].verification, []);
  f.write('_releases/releases.jsonl', JSON.stringify({ commit: 'f'.repeat(40), recordedAt: '2026-10-01T13:00:00Z', branch: 'main' }) + '\n');
  plan = planHistory(f.options);
  assert.match(plan.gateSources[0].reason, /source unavailable/);
  f.write('scripts/git-hooks/pre-push', '#!/bin/sh\nset -eu\nnpm run verify\n');
  const changed = f.commit('2026-11-02T01:00:00Z', 'export const value = 5;');
  let reason;
  assert.equal(discoverGatePolicy(f.repo, changed, '_releases/releases.jsonl', why => { reason = why; }), null);
  assert.match(reason, /does not establish/);
});

test('large prepared files split into bounded resumable batches', () => {
  const reports = Array.from({ length: 10 }, () => ({ data: 'a'.repeat(250_000) }));
  const batches = importBatches({ version: 1, asset: 'example.com', reports, releases: [] });
  assert.equal(batches.flatMap(batch => batch.reports).length, 10);
  assert.ok(batches.every(batch => Buffer.byteLength(JSON.stringify(batch)) <= 1024 * 1024));
});

test('failed measurement retires its own container before removing its temporary source', async t => {
  const f = fixture(t); const calls = []; let checkout;
  const run = async (_command, args) => {
    calls.push(args);
    if (args[0] === 'rm') { assert.ok(fs.existsSync(checkout)); return { code: 0 }; }
    checkout = args.find(arg => arg.startsWith('type=bind,source=') && arg.includes('target=/repo')).split('source=')[1].split(',')[0];
    return { code: 124, stderr: 'fixture timeout' };
  };
  await assert.rejects(prepareHistory({ ...f.options, measure: true }, { run, out: quiet }), /fixture timeout/);
  assert.equal(calls[1][2], calls[0][calls[0].indexOf('--name') + 1]);
  assert.ok(!fs.existsSync(checkout));
});
