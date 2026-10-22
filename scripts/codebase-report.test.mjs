// `pnpm os:codebase-report`: its arguments, the Docker commands it assembles
// and where it reads the site's token, with Docker and the secrets file faked.
// The measurement engine's own suite, deploy/codebase-report/measure.test.mjs,
// is imported here so `pnpm test:scripts` runs it: the root suite reads only
// scripts/*.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CODEBASE_REPORT_REPOSITORY, DEFAULT_IMAGE, LOCAL_IMAGE, assetToken, buildArgs, codebaseReport, main, measureArgs, parseArgs, secretFiles,
} from './codebase-report.mjs';
import { renderInstallationEnv } from './installation-layout.mjs';
import { RELEASE_REPOSITORY } from './published-image.mjs';
import '../deploy/codebase-report/measure.test.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOCKET = 'unix:///var/run/docker.sock';
const APP_ID = 'a'.repeat(12);
const quiet = { write() {} };

test('arguments: the asset and the checkout are required; folders stay inside it; image and build exclude each other', () => {
  assert.deepEqual(parseArgs(['--', '--asset', 'example.com', '--repo', 'site', '--paths', './apps/site/, packages/ui'], { cwd: '/work' }),
    { asset: 'example.com', repo: '/work/site', paths: ['apps/site', 'packages/ui'], image: null, build: false, config: null, measures: [] });
  assert.equal(parseArgs(['--asset', 'example.com', '--repo', '/srv/site', '--build']).build, true);
  assert.throws(() => parseArgs(['--repo', '/srv/site']), /--asset/u);
  assert.throws(() => parseArgs(['--asset', 'example.com']), /--repo/u);
  assert.throws(() => parseArgs(['--asset', 'example.com', '--repo', '/srv/site', '--token', 'x']), /Usage/u);
  assert.throws(() => parseArgs(['--asset', 'example.com', '--repo', '/srv/a,b']), /comma/u);
  assert.throws(() => parseArgs(['--asset', 'example.com', '--repo', '/srv/site', '--paths', '../up']), /inside the checkout/u);
  assert.throws(() => parseArgs(['--asset', 'example.com', '--repo', '/srv/site', '--image', 'x:y', '--build']), /not both/u);
  assert.throws(() => parseArgs(['--asset', 'example.com', '--repo', '/srv/site', '--image', 'Bad Image']), /--image/u);
  assert.throws(() => parseArgs(['--asset', 'example.com', '--repo', '/srv/site', '--config', 'stack.json']), /absolute/u);
});

test('--measure passes a build, test or audit result to the image, checked by the image\'s own parser first', () => {
  const parsed = parseArgs(['--asset', 'example.com', '--repo', '/srv/site', '--measure', 'build_passed=success', '--measure', 'vulnerable_dependencies=3']);
  assert.deepEqual(parsed.measures, ['build_passed=success', 'vulnerable_dependencies=3']);
  const selector = { dockerHost: SOCKET, project: 'noticeos', files: ['/srv/stack.yaml'], envFile: '/srv/installation.env' };
  const args = measureArgs({ selector, app: APP_ID, image: DEFAULT_IMAGE, repo: '/srv/site', asset: 'example.com', paths: null, local: false, measures: parsed.measures });
  assert.deepEqual(args.slice(args.indexOf(DEFAULT_IMAGE)), [DEFAULT_IMAGE, '--asset', 'example.com', '--repo', '/repo',
    '--measure', 'build_passed=success', '--measure', 'vulnerable_dependencies=3', '--post', 'http://127.0.0.1:8791']);
  assert.throws(() => parseArgs(['--asset', 'example.com', '--repo', '/srv/site', '--measure', 'coverage=90']), /--measure takes/u);
  assert.throws(() => parseArgs(['--asset', 'example.com', '--repo', '/srv/site', '--measure', 'tests_passed=maybe']), /success or failure/u);
  assert.throws(() => parseArgs(['--asset', 'example.com', '--repo', '/srv/site', '--measure', 'tests_passed=success', '--measure', 'tests_passed=failure']), /given twice/u);
  assert.throws(() => parseArgs(['--asset', 'example.com', '--repo', '/srv/site', '--measure']), /key=value/u);
});

test('the published image is the app image\'s name with -codebase-report, the name the release workflow derives', () => {
  assert.equal(CODEBASE_REPORT_REPOSITORY, `${RELEASE_REPOSITORY}-codebase-report`);
  assert.equal(DEFAULT_IMAGE, `${CODEBASE_REPORT_REPOSITORY}:main`);
  const release = fs.readFileSync(path.join(ROOT, '.github/workflows/release-image.yml'), 'utf8');
  assert.match(release, /steps\.repository\.outputs\.name \}\}-codebase-report/u);
  assert.match(release, /docker build .*deploy\/codebase-report/u);
  const action = fs.readFileSync(path.join(ROOT, '.github/actions/codebase-report/action.yml'), 'utf8');
  assert.ok(action.includes(`IMAGE_REPOSITORY: ${CODEBASE_REPORT_REPOSITORY}`), 'the action runs the image the release publishes');
});

test('the measurement runs read-only beside the app container, and its token is named, never written, on the command line', () => {
  const selector = { dockerHost: SOCKET, project: 'noticeos', files: ['/srv/stack.yaml'], envFile: '/srv/installation.env' };
  const args = measureArgs({ selector, app: APP_ID, image: DEFAULT_IMAGE, repo: '/srv/site', asset: 'example.com', paths: ['apps/site'], local: false });
  assert.deepEqual(args, ['--host', SOCKET, 'run', '--rm', '--pull', 'missing', '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--network', `container:${APP_ID}`, '--mount', 'type=bind,source=/srv/site,target=/repo,readonly',
    '--env', 'NOTICEOS_ASSET_TOKEN', DEFAULT_IMAGE, '--asset', 'example.com', '--repo', '/repo', '--paths', 'apps/site', '--post', 'http://127.0.0.1:8791']);
  const local = measureArgs({ selector, app: APP_ID, image: LOCAL_IMAGE, repo: '/srv/site', asset: 'example.com', paths: null, local: true });
  assert.equal(local[local.indexOf('--pull') + 1], 'never');
  assert.equal(local.includes('--paths'), false);
  assert.deepEqual(buildArgs(selector, '/checkout'), ['--host', SOCKET, 'build', '--tag', LOCAL_IMAGE, '/checkout/deploy/codebase-report']);
});

test("the token is the asset's ASSET_TOKENS entry in the installation folder's bootstrap secrets", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envFile = path.join(dir, 'installation.env');
  fs.writeFileSync(envFile, renderInstallationEnv({ dir, image: 'noticeos-local:abc', uid: 1000, gid: 1000 }));
  assert.deepEqual(secretFiles({ envFile }), {
    secretsFile: path.join(dir, 'state/workers/ingest/.dev.secrets.json'), varsFile: path.join(dir, 'state/workers/ingest/.dev.vars'),
  });
  assert.deepEqual(secretFiles({ envFile: path.join(dir, 'legacy.env') }), {});
  const read = async () => ({ bindings: { ASSET_TOKENS: JSON.stringify({ 'example.com': 'site-token' }) }, sourceFile: '/s/.dev.secrets.json' });
  assert.equal(await assetToken('example.com', {}, read), 'site-token');
  await assert.rejects(assetToken('example.org', {}, read), /no "example\.org" entry/u);
  await assert.rejects(assetToken('example.com', {}, async () => ({ bindings: { ASSET_TOKENS: '{' }, sourceFile: 'f' })), /not valid JSON/u);
});

/** A stack selector and the files it declares, in a temporary folder. */
function installation(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-report-stack-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envFile = path.join(dir, 'installation.env');
  fs.writeFileSync(envFile, renderInstallationEnv({ dir, image: 'noticeos-local:abc', uid: 1000, gid: 1000 }));
  const stack = path.join(dir, 'stack.yaml');
  fs.writeFileSync(stack, 'services: {}\n');
  const config = path.join(dir, 'stack.json');
  fs.writeFileSync(config, JSON.stringify({ project: 'noticeos', files: [stack], envFile, dockerHost: SOCKET }));
  const repo = path.join(dir, 'site');
  fs.mkdirSync(repo);
  return { dir, config, repo };
}

const inventory = (state = 'running') => ['noticeos', 'postgres', 'dolt']
  .map((service, i) => JSON.stringify({ Project: 'noticeos', Service: service, ID: String(i + 1).repeat(12), State: state, Health: 'healthy' })).join('\n');

test('a run asks Docker for the app container, then runs the image with the token only in its environment', async (t) => {
  const { config, repo } = installation(t);
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, env: options.env });
    return args.includes('ps') ? { code: 0, stdout: inventory() } : { code: 0, stdout: '' };
  };
  const readSecrets = async () => ({ bindings: { ASSET_TOKENS: JSON.stringify({ 'example.com': 'site-token' }) }, sourceFile: 's' });
  await codebaseReport(parseArgs(['--asset', 'example.com', '--repo', repo, '--config', config]), { run, readSecrets, env: { PATH: '/bin' }, out: quiet });
  assert.equal(calls.length, 2);
  const measure = calls[1];
  assert.ok(measure.args.includes(`container:${'1'.repeat(12)}`));
  assert.equal(measure.env.NOTICEOS_ASSET_TOKEN, 'site-token');
  assert.ok(!calls.some((call) => call.args.join(' ').includes('site-token')));
  assert.equal(calls[0].env.NOTICEOS_ASSET_TOKEN, undefined);
});

test('a stopped app, a missing token or a failed measurement stops with a sentence, not a stack trace', async (t) => {
  const { config, repo } = installation(t);
  const readSecrets = async () => ({ bindings: { ASSET_TOKENS: JSON.stringify({ 'example.com': 'site-token' }) }, sourceFile: 's' });
  const stopped = async (command, args) => ({ code: 0, stdout: args.includes('ps') ? inventory('exited') : '' });
  await assert.rejects(codebaseReport(parseArgs(['--asset', 'example.com', '--repo', repo, '--config', config]), { run: stopped, readSecrets, out: quiet }), /pnpm os:start/u);
  const failing = async (command, args) => ({ code: args.includes('ps') ? 0 : 1, stdout: args.includes('ps') ? inventory() : '' });
  await assert.rejects(codebaseReport(parseArgs(['--asset', 'example.com', '--repo', repo, '--config', config]), { run: failing, readSecrets, out: quiet }), /not stored/u);
  await assert.rejects(codebaseReport(parseArgs(['--asset', 'example.org', '--repo', repo, '--config', config]), { run: failing, readSecrets, out: quiet }), /no "example\.org" entry/u);
  let said = '';
  assert.equal(await main(['--asset', 'example.com', '--repo', path.join(repo, 'missing'), '--config', config], { err: { write: (text) => { said += text; } } }), 1);
  assert.match(said, /is not a folder/u);
});
