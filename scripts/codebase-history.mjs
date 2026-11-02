#!/usr/bin/env node
// Preview Git-history snapshots and release records offline; measure a pinned image, or explicitly import a prepared bundle.
//
//   pnpm os:codebase-history -- --asset example.com --repo /path/to/repo --image <image@sha256:digest> --out /tmp/history
//     [--from YYYY-MM-DD --to YYYY-MM-DD --step-days 7 --ref main --revision <sha> --paths src,tests]
//     [--releases _releases/releases.jsonl --gate-policy /path/to/reviewed-policy.json] [--measure]
//   pnpm os:codebase-history -- --asset <id> --repo <path> --image <pinned-image> --out <existing-folder> --resume --measure
//   pnpm os:codebase-history -- --import /tmp/history/bundle.json --config /absolute/stack.json [--apply]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { boundEnvelope, normalizeRemote, readRepoConfig, safeRelativePath } from '../deploy/codebase-report/measure.mjs';
import { assetToken, secretFiles } from './codebase-report.mjs';
import { readSelector, parseServices } from './stack-control.mjs';
import { MANAGED_DOOR } from './ingest-door.mjs';
import { runCommand } from './run-command.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROGRAM = path.join(ROOT, 'deploy/codebase-report/measure.mjs');
const DAY = 86_400_000;
const PIN = /^[a-z0-9][a-z0-9._/:-]*@sha256:[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const ownGitEnv = () => ({ PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' });
const git = (repo, args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'init.templateDir=', '-C', repo, ...args],
  { env: ownGitEnv(), encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const day = time => new Date(time).toISOString().slice(0, 10);
const cutoff = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || day(`${value}T00:00:00Z`) !== value) throw new Error('Dates must be valid YYYY-MM-DD values.');
  return `${value}T23:59:59Z`;
};
function boundedFile(file, limit = 8 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > limit) throw new Error(`${file} must be a regular file under ${limit} bytes.`);
  return fs.readFileSync(file, 'utf8');
}

export function parseHistoryArgs(argv, now = new Date()) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--') continue;
    if (['--measure', '--apply', '--resume'].includes(flag)) { if (values[flag]) throw new Error(`Duplicate ${flag}`); values[flag] = true; continue; }
    if (!['--asset', '--repo', '--image', '--out', '--from', '--to', '--step-days', '--ref', '--revision', '--paths', '--releases', '--gate-policy', '--import', '--config'].includes(flag)
      || values[flag] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Invalid argument ${flag}`);
    values[flag] = argv[++i];
  }
  if (values['--import']) {
    if (Object.keys(values).some(key => !['--import', '--config', '--apply'].includes(key)) || !path.isAbsolute(values['--config'] ?? '')) throw new Error('--import requires --config /absolute/stack.json; --apply writes, omission previews against the store.');
    return { importFile: path.resolve(values['--import']), config: values['--config'], apply: Boolean(values['--apply']) };
  }
  if (values['--apply'] || values['--config']) throw new Error('--apply and --config belong only to --import.');
  if (values['--resume'] && ['--from', '--to', '--step-days', '--ref', '--revision', '--paths', '--releases', '--gate-policy'].some(flag => values[flag] !== undefined)) {
    throw new Error('--resume uses the saved plan; omit date, revision, path, release and gate-policy options.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$/u.test(values['--asset'] ?? '') || !values['--repo'] || !values['--out'] || !PIN.test(values['--image'] ?? '')) throw new Error('Provide --asset, --repo, --out and a digest-pinned --image.');
  const to = values['--to'] ?? day(now.getTime() - DAY);
  const from = values['--from'] ?? day(Date.parse(cutoff(to)) - 89 * DAY);
  const start = Date.parse(cutoff(from)), end = Date.parse(cutoff(to));
  const step = Number(values['--step-days'] ?? 7);
  if (start > end || end > now.getTime() || end - start > 365 * DAY || !Number.isInteger(step) || step < 1 || step > 90) throw new Error('Choose a past range of at most 366 days and a step of 1–90 days.');
  const dates = new Set([to]);
  for (let at = start; at <= end; at += step * DAY) dates.add(day(at));
  const baseline = day(end - 30 * DAY);
  if (baseline >= from) dates.add(baseline);
  if (dates.size > 100) throw new Error('At most 100 snapshots per plan; increase --step-days.');
  const ref = values['--ref'] ?? 'HEAD';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/^-]{0,254}$/u.test(ref) || (values['--revision'] && !SHA.test(values['--revision']))) throw new Error('Use a plain Git ref or a full --revision SHA.');
  const paths = values['--paths']?.split(',').map(safeRelativePath) ?? null;
  const releases = values['--releases'] ?? null;
  if (paths && (paths.length > 20 || paths.some(value => !value))) throw new Error('--paths must name 1–20 repository-relative folders.');
  if (releases && !safeRelativePath(releases)) throw new Error('--releases is a repository-relative JSONL path.');
  return { asset: values['--asset'], repo: path.resolve(values['--repo']), out: path.resolve(values['--out']), image: values['--image'],
    ref, revision: values['--revision'] ?? null, paths, dates: [...dates].sort(), releases,
    gatePolicy: values['--gate-policy'] ? path.resolve(values['--gate-policy']) : null, measure: Boolean(values['--measure']), resume: Boolean(values['--resume']) };
}

/** Registry order is retained for supersession. Invalid records are reported,
 * never silently turned into deployment timestamps or passing checks. */
export function parseReleaseHistory(text, source) {
  const releases = [], issues = [];
  const lines = text.split('\n');
  if (lines.length > 10_000) throw new Error('Release registry exceeds 10,000 lines.');
  for (const [sequence, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      const timestamp = name => {
        if (typeof value[name] !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/u.test(value[name]) || !Number.isFinite(Date.parse(value[name]))) throw new Error(`invalid ${name}`);
        cutoff(value[name].slice(0, 10));
        return new Date(value[name]).toISOString();
      };
      if (!SHA.test(value.commit)) throw new Error('invalid commit');
      const release = { source, sequence, commit: value.commit, recordedAt: timestamp('recordedAt'),
        ...(value.deployedAt === undefined ? {} : { deployedAt: timestamp('deployedAt') }),
        ...(typeof value.branch === 'string' && value.branch.length <= 255 ? { branch: value.branch } : {}),
        supersedes: value.supersedes ?? [] };
      if (!Array.isArray(release.supersedes) || release.supersedes.length > 100 || !release.supersedes.every(sha => SHA.test(sha))) throw new Error('invalid supersedes');
      if (value.counts && ['added', 'changed', 'removed', 'total'].every(key => Number.isSafeInteger(value.counts[key]) && value.counts[key] >= 0)) {
        release.counts = Object.fromEntries(['added', 'changed', 'removed', 'total'].map(key => [key, value.counts[key]]));
      }
      release.id = digest(release);
      releases.push(release);
    } catch (error) { issues.push({ line: sequence + 1, reason: error.message }); }
  }
  if (releases.length > 500) throw new Error('Release registry exceeds 500 records; split it into bounded source files while preserving supersession.');
  return { releases, issues };
}

/** Policies are reviewed source fingerprints, not executable checks. Every
 * named file must match at the exact release revision before its pass applies. */
export function verificationFor(repo, commit, releases, policies) {
  const release = releases.filter(row => row.commit === commit).sort((a, b) => b.sequence - a.sequence)[0];
  if (!release) return [];
  for (const policy of policies) {
    if (policy.branch && release.branch && policy.branch !== release.branch) continue;
    const files = Object.entries(policy.files ?? {});
    if (!files.length || files.length > 10 || !files.every(([file, blob]) => safeRelativePath(file) && SHA.test(blob))
      || typeof policy.command !== 'string' || !policy.command || policy.command.length > 200
      || !Array.isArray(policy.measures) || !policy.measures.length || policy.measures.some(key => !['build_passed', 'tests_passed'].includes(key))) throw new Error('Invalid gate policy: provide reviewed files (Git blob hashes), command, and build/test measures.');
    if (!files.every(([file, blob]) => {
      try { return git(repo, ['rev-parse', `${commit}:${file}`]) === blob; } catch { return false; }
    })) continue;
    return [...new Set(policy.measures)].map(measure => ({ measure, commit, recordedAt: release.recordedAt, source: release.source,
      sourceId: release.id, policy: digest(policy), command: policy.command, files: policy.files }));
  }
  return [];
}

/** Recognize the existing detached-worktree pre-push convention by reading
 * versioned source only. This is recorded gate evidence, not a fresh test run.
 * Unknown hook shapes remain unmeasured and are listed in the preview. */
export function discoverGatePolicy(repo, commit, source, explain = () => {}) {
  const files = {};
  const unknown = reason => { explain(reason); return null; };
  let reading = '';
  const read = file => {
    reading = file;
    const text = git(repo, ['show', `${commit}:${file}`]);
    files[file] = git(repo, ['rev-parse', `${commit}:${file}`]);
    return text;
  };
  const shell = text => text.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
  try {
    const delegate = shell(read('.husky/pre-push'));
    if (!/exec "\$\(git rev-parse --show-toplevel\)\/scripts\/git-hooks\/pre-push" "\$@"/u.test(delegate)) return unknown('Unrecognized pre-push entrypoint');
    const hook = shell(read('scripts/git-hooks/pre-push'));
    const worktree = hook.indexOf('worktree add --detach "$WT" "$sha"');
    const enter = hook.indexOf('cd "$WT"', worktree);
    const verify = /^\s*npm run (verify(?::release)?)\s*$/mu.exec(hook.slice(enter));
    const record = hook.indexOf('node "$WT/scripts/release-registry.mjs" record', enter);
    if (!/^set -[a-z]*e[a-z]*$/mu.test(hook) || worktree < 0 || enter < 0 || !verify || record < enter + verify.index
      || !hook.includes('for sha in $SHAS; do') || !hook.includes('--commit "$sha"')
      || !hook.includes(`--out "$MAIN_ROOT/${source}"`) || !hook.includes('[ "$sha" = "$MAIN_SHA" ]')) return unknown('Versioned hook does not establish this registry write after exact-revision verification');
    const pkg = JSON.parse(read('package.json'));
    const command = verify[1];
    let checks = pkg.scripts?.[command] ?? '';
    if (command === 'verify:release' && checks === 'node scripts/verify-release.mjs') {
      const entry = read('scripts/verify-release.mjs');
      const stages = read('scripts/lib/verify-release.mjs');
      if (!entry.includes('runStages(RELEASE_STAGES') || !entry.includes('process.exitCode =')
        || !/args:\s*\["verify"\]/u.test(stages)
        || !(stages.includes('if (failed !== undefined) return failed') || stages.includes('if (code !== 0) return code ?? 1'))) return unknown('Unrecognized release-stage failure handling');
      checks = pkg.scripts?.verify ?? '';
    } else if (/^npm run verify && /u.test(checks) && !/[;\n]|\|\|/u.test(checks)) {
      checks = pkg.scripts?.verify ?? '';
    }
    // The convention's verify graph names both kinds of check. Never infer
    // coverage from a generic command called "verify" alone.
    if (/[;\n]|\|\|/u.test(checks)) return unknown('Verification command is not a recognized fail-fast chain');
    const turbo = /(?:^|\s)turbo run ([\w:\s-]+)$/u.exec(checks);
    const direct = checks.split('&&').map(part => part.trim());
    const tasks = turbo ? turbo[1].trim().split(/\s+/u) : direct.flatMap(part => /^npm (?:run )?([\w:-]+)$/u.exec(part)?.[1] ?? []);
    const build = tasks.some(task => /^build(?::[\w-]+)?$/u.test(task));
    const tests = tasks.some(task => /^test(?::[\w-]+)?$/u.test(task));
    if (!build || !tests) return unknown('Versioned verification does not establish both build and test coverage');
    read('scripts/release-registry.mjs');
    return { adapter: 'detached-pre-push-v1', branch: 'main', command: `npm run ${command}`, files, measures: ['build_passed', 'tests_passed'] };
  } catch { return unknown(`Versioned source unavailable: ${reading}`); }
}

function planFingerprint(plan) {
  const { asset, selectionRef, head, remote, settings, snapshots, releases } = plan;
  return digest({ asset, selectionRef, head, remote, settings, snapshots, releases });
}

export function planHistory(options) {
  if (git(options.repo, ['rev-parse', '--is-shallow-repository']) !== 'false') throw new Error('History reconstruction requires a complete local Git history; no fetch is run automatically.');
  const head = git(options.repo, ['rev-parse', '--verify', `${options.ref}^{commit}`]);
  let remote = null;
  try { remote = normalizeRemote(git(options.repo, ['config', '--get', 'remote.origin.url'])); } catch { /* A local-only repository has no remote. */ }
  const commits = git(options.repo, ['log', '--format=%H %ct', head]).split('\n').map(line => {
    const [commit, seconds] = line.split(' '); return { commit, at: Number(seconds) * 1000 };
  }).sort((a, b) => b.at - a.at || a.commit.localeCompare(b.commit));
  if (options.revision && !commits.some(row => row.commit === options.revision)) throw new Error('--revision must be reachable from --ref.');
  const policies = options.gatePolicy ? JSON.parse(boundedFile(options.gatePolicy, 65_536)) : [];
  if (!Array.isArray(policies) || policies.length > 50) throw new Error('Gate policies must be an array of at most 50 reviewed source versions.');
  const registry = options.releases ? parseReleaseHistory(boundedFile(path.join(options.repo, options.releases)), options.releases) : { releases: [], issues: [] };
  const gateSources = registry.releases.map(release => {
    let reason = null;
    const policy = release.branch && release.branch !== 'main' ? null
      : discoverGatePolicy(options.repo, release.commit, release.source, why => { reason = why; });
    return { commit: release.commit, branch: release.branch ?? null,
      superseded: registry.releases.some(later => later.sequence > release.sequence && later.supersedes.includes(release.commit)),
      policy, reason: release.branch && release.branch !== 'main' ? 'Registry branch is not covered by the main-branch gate' : reason };
  });
  const discovered = gateSources.flatMap(row => row.policy ? [row.policy] : []);
  const acceptedPolicies = [...policies, ...discovered];
  let config = { exclude: [], tests: [] };
  try { config = readRepoConfig(git(options.repo, ['show', `${head}:.noticeos-codebase.json`])); }
  catch (error) { if (!String(error.stderr).includes('does not exist') && !String(error.stderr).includes('exists on disk, but not in')) throw error; }
  const program = digest(fs.readFileSync(PROGRAM, 'utf8'));
  const settings = { paths: options.paths, config, image: options.image, program };
  const snapshots = options.dates.map(date => {
    const at = cutoff(date);
    const selected = options.revision ? commits.find(row => row.commit === options.revision && row.at <= Date.parse(at)) : commits.find(row => row.at <= Date.parse(at));
    return selected ? { effectiveAt: at, commit: selected.commit, committedAt: new Date(selected.at).toISOString(), verification: verificationFor(options.repo, selected.commit, registry.releases, acceptedPolicies) }
      : { effectiveAt: at, missing: 'No reachable commit at or before this cutoff' };
  });
  if (!options.revision) {
    const reachable = new Map(commits.map(row => [row.commit, row]));
    const days = new Set(options.dates);
    const effective = registry.releases.filter(release => !registry.releases.some(later => later.sequence > release.sequence && later.supersedes.includes(release.commit)));
    const releaseDays = new Map();
    for (const release of effective) {
      const date = day(release.recordedAt);
      const commit = reachable.get(release.commit);
      if (date < options.dates[0] || date > options.dates.at(-1) || days.has(date) || !commit || commit.at > Date.parse(release.recordedAt)) continue;
      const previous = releaseDays.get(date);
      if (!previous || previous.sequence < release.sequence) releaseDays.set(date, release);
    }
    for (const release of releaseDays.values()) snapshots.push({ effectiveAt: release.recordedAt, commit: release.commit,
      committedAt: new Date(reachable.get(release.commit).at).toISOString(), verification: verificationFor(options.repo, release.commit, registry.releases, acceptedPolicies) });
    snapshots.sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt));
    if (snapshots.length > 100) throw new Error('Sampling plus release days exceeds 100 snapshots; narrow the date range.');
  }
  const plan = { version: 1, asset: options.asset, selectionRef: options.ref, head, remote, settings, snapshots, gateSources, ...registry };
  return { ...plan, fingerprint: planFingerprint(plan) };
}

/** A separate immutable index avoids inconsistent mmap reads observed when a
 * host-shared checkout replaces its index between containers. */
export function snapshotIndex(checkout, directory, date) {
  const file = path.join(directory, `${date}.index`);
  fs.copyFileSync(path.join(checkout, '.git', 'index'), file, fs.constants.COPYFILE_EXCL);
  return file;
}

export function historyMeasureArgs(options, snapshot, checkout, settings, container = null, index = null) {
  return ['run', '--rm', ...(container ? ['--name', container] : []), '--pull', 'never', '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--network', 'none',
    '--mount', `type=bind,source=${checkout},target=/repo,readonly`, '--mount', `type=bind,source=${PROGRAM},target=/measure.mjs,readonly`,
    ...(index ? ['--mount', `type=bind,source=${index},target=/repo/.git/index,readonly`] : []),
    '--mount', `type=bind,source=${settings},target=/settings.json,readonly`, '--env', `NOTICEOS_CODEBASE_IMAGE=${options.image}`, '--entrypoint', 'node',
    options.image, '/measure.mjs', '--asset', options.asset, '--repo', '/repo', '--ref', options.ref, '--as-of', snapshot.effectiveAt, '--settings', '/settings.json',
    ...(options.paths ? ['--paths', options.paths.join(',')] : [])];
}

export async function prepareHistory(options, { run = runCommand, out = process.stdout } = {}) {
  const planFile = path.join(options.out, 'plan.json');
  const plan = options.resume ? JSON.parse(boundedFile(planFile)) : planHistory(options);
  if (options.resume && (!plan || plan.version !== 1 || plan.asset !== options.asset || plan.settings?.image !== options.image
    || plan.settings?.program !== digest(fs.readFileSync(PROGRAM, 'utf8')) || plan.fingerprint !== planFingerprint(plan)
    || !SHA.test(plan.head) || typeof plan.selectionRef !== 'string' || !Array.isArray(plan.snapshots) || plan.snapshots.length > 100
    || !plan.snapshots.every(row => (row.commit === undefined || SHA.test(row.commit)) && Number.isFinite(Date.parse(row.effectiveAt)))
    || !Array.isArray(plan.releases) || plan.releases.length > 500)) throw new Error('Saved plan is invalid or uses a different asset, image or measuring program; choose a new output folder.');
  const measurement = { ...options, paths: plan.settings.paths, ref: plan.selectionRef };
  fs.mkdirSync(options.out, { recursive: true });
  if (fs.existsSync(planFile) && JSON.parse(boundedFile(planFile)).fingerprint !== plan.fingerprint) throw new Error('This output folder holds a different plan; choose a new --out folder.');
  if (!fs.existsSync(planFile)) fs.writeFileSync(planFile, JSON.stringify(plan, null, 2) + '\n');
  out.write(`Preview: ${plan.snapshots.filter(row => row.commit).length} snapshots, ${plan.releases.length} release records, ${plan.issues.length} invalid registry lines. ${planFile}\n`);
  if (!options.measure) return plan;
  const free = fs.statfsSync(options.out);
  const objectSizes = Object.fromEntries(git(options.repo, ['count-objects', '-v']).split('\n').map(line => line.split(': ')));
  const objectBytes = (Number(objectSizes.size) + Number(objectSizes['size-pack'])) * 1024;
  let treeBytes = 0;
  let indexBytes = 0;
  for (const commit of new Set(plan.snapshots.flatMap(row => row.commit ? [row.commit] : []))) {
    const listing = git(options.repo, ['ls-tree', '-rl', commit]);
    const entries = listing.split('\n');
    const bytes = entries.reduce((sum, line) => sum + Number(/^\d+ blob [a-f0-9]+\s+(\d+)\t/u.exec(line)?.[1] ?? 0), 0);
    treeBytes = Math.max(treeBytes, bytes);
    indexBytes = Math.max(indexBytes, Buffer.byteLength(listing) + entries.length * 80);
  }
  if (free.bavail * free.bsize - objectBytes - 3 * treeBytes - indexBytes * plan.snapshots.length < 8 * 1024 ** 3) throw new Error('Reconstruction must leave at least 8 GiB free after the source copy and measurement workspace.');
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-history-'));
  let inactive = true;
  try {
    const checkout = path.join(own, 'source');
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir=', 'clone', '--local', '--no-hardlinks', '--no-checkout', options.repo, checkout],
      { env: ownGitEnv(), timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
    if (plan.remote) git(checkout, ['config', 'remote.origin.url', `https://${plan.remote}.git`]);
    const settings = path.join(own, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify(plan.settings.config));
    const indexes = path.join(own, 'indexes');
    fs.mkdirSync(indexes);
    const reports = [];
    for (const snapshot of plan.snapshots.filter(row => row.commit)) {
      const file = path.join(options.out, `${snapshot.effectiveAt.slice(0, 10)}.json`);
      let report;
      if (fs.existsSync(file)) {
        report = JSON.parse(boundedFile(file, 256 * 1024));
        if (report.asset !== options.asset || report.repository.commit !== snapshot.commit || report.history?.effectiveAt !== snapshot.effectiveAt || report.tools.image !== options.image) throw new Error('Cached snapshot differs from its plan.');
      } else {
        git(checkout, ['checkout', '--detach', '--force', snapshot.commit]);
        const index = snapshotIndex(checkout, indexes, snapshot.effectiveAt.slice(0, 10));
        const container = `noticeos-history-${randomUUID()}`;
        let measured;
        try { measured = await run('docker', historyMeasureArgs(measurement, snapshot, checkout, settings, container, index), { timeoutMs: 1_800_000 }); }
        finally {
          const removed = await run('docker', ['rm', '--force', container], { timeoutMs: 30_000 });
          if (removed.code !== 0 && !/No such container/iu.test(removed.stderr ?? '')) {
            inactive = false;
            throw new Error(`Cannot confirm measurement container ${container} stopped; retained its source at ${own}.`);
          }
        }
        if (measured.code !== 0) throw new Error(`Measurement failed for ${snapshot.commit}: ${measured.stderr}`);
        report = JSON.parse(measured.stdout);
        if (report.repository.commit !== snapshot.commit) throw new Error('Measurement returned a different commit.');
        report.history = { effectiveAt: snapshot.effectiveAt, selectionRef: plan.selectionRef };
        report.verification = snapshot.verification;
        for (const evidence of snapshot.verification) { report.measures[evidence.measure] = 1; delete report.unmeasured?.[evidence.measure]; }
        report = boundEnvelope(report);
        fs.writeFileSync(file, JSON.stringify(report) + '\n');
      }
      reports.push(report);
      out.write(`Prepared ${snapshot.effectiveAt.slice(0, 10)} ${snapshot.commit.slice(0, 12)}\n`);
    }
    const bundle = { version: 1, asset: options.asset, reports, releases: plan.releases };
    fs.writeFileSync(path.join(options.out, 'bundle.json'), JSON.stringify(bundle) + '\n');
    return bundle;
  } finally { if (inactive) fs.rmSync(own, { recursive: true, force: true }); }
}

export function importBatches(bundle) {
  if (bundle.version !== 1 || !Array.isArray(bundle.reports) || bundle.reports.length > 100 || !Array.isArray(bundle.releases) || bundle.releases.length > 500) throw new Error('Invalid or oversized history bundle.');
  const empty = () => ({ version: 1, asset: bundle.asset, reports: [], releases: [] });
  const batches = []; let batch = empty();
  for (const [key, rows] of [['reports', bundle.reports], ['releases', bundle.releases]]) for (const row of rows) {
    batch[key].push(row);
    if (Buffer.byteLength(JSON.stringify(batch)) > 1024 * 1024) {
      batch[key].pop(); batches.push(batch); batch = empty(); batch[key].push(row);
      if (Buffer.byteLength(JSON.stringify(batch)) > 1024 * 1024) throw new Error('One history record exceeds the batch size.');
    }
  }
  if (batch.reports.length || batch.releases.length) batches.push(batch);
  return batches;
}

/** The only installation access in this command. Default is a store preview;
 * --apply sends the same batches with the explicit write query parameter. */
export async function sendHistory(options, { run = runCommand, out = process.stdout } = {}) {
  const bundle = JSON.parse(boundedFile(options.importFile, 32 * 1024 * 1024));
  const batches = importBatches(bundle);
  const selector = readSelector(options.config);
  const token = await assetToken(bundle.asset, secretFiles(selector));
  const inventory = await run('docker', ['--host', selector.dockerHost, 'compose', '--project-name', selector.project,
    ...selector.files.flatMap(file => ['-f', file]), '--env-file', selector.envFile, 'ps', '--all', '--format', 'json']);
  if (inventory.code !== 0) throw new Error('Cannot read the selected stack.');
  const app = parseServices(inventory.stdout, selector.project).get('noticeos');
  if (app.state !== 'running') throw new Error('The selected app is not running.');
  const code = `let s='';for await(const c of process.stdin)s+=c;const r=await fetch(${JSON.stringify(MANAGED_DOOR + '/api/codebase-history' + (options.apply ? '?apply=true' : ''))},{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env.NOTICEOS_ASSET_TOKEN},body:s});console.log(await r.text());if(!r.ok)process.exitCode=1;`;
  for (const batch of batches) {
    const sent = await run('docker', ['--host', selector.dockerHost, 'exec', '-i', '--env', 'NOTICEOS_ASSET_TOKEN', app.id, 'node', '--input-type=module', '-e', code],
      { env: { ...process.env, NOTICEOS_ASSET_TOKEN: token }, stdin: JSON.stringify(batch), timeoutMs: 120_000 });
    if (sent.code !== 0) throw new Error(`History batch refused: ${sent.stdout || sent.stderr}`);
    out.write(sent.stdout);
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    process.stdout.write('Preview: pnpm os:codebase-history -- --asset <id> --repo <path> --image <image@sha256:digest> --out <folder> [--from YYYY-MM-DD --to YYYY-MM-DD --step-days 7 --releases _releases/releases.jsonl] [--measure]\nResume: use --asset, --repo, --image and --out with --resume --measure; the existing plan fixes all selections and settings.\nStore preview: pnpm os:codebase-history -- --import <folder>/bundle.json --config /absolute/stack.json\nApply: add --apply to the store preview after approval.\n'); return 0;
  }
  try {
    const options = parseHistoryArgs(argv);
    if (options.importFile) await sendHistory(options); else await prepareHistory(options);
    return 0;
  } catch (error) { process.stderr.write(`${error.message}\n`); return 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
