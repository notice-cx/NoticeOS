#!/usr/bin/env node
// Measure one site's codebase with the codebase report image and send the report to this installation's ingest.
//
//   pnpm os:codebase-report -- --asset <id> --repo <path> [--paths a,b] [--image <ref> | --build] [--config /absolute/stack.json]
//                              [--measure build_passed=success] [--measure tests_passed=failure] [--measure vulnerable_dependencies=3]
//
// The image runs through the installation's own Docker (the stack
// `.local/stack.json` selects) with the repository mounted read-only. It
// joins the app container's network namespace, because the ingest answers
// only on that container's loopback (MANAGED_DOOR), and posts there with
// the site's token from ASSET_TOKENS in the installation's bootstrap secrets,
// the entry pulse-relay.mjs reads. The token reaches the image as an
// environment variable named on the command line without its value, so it is
// never in a process list. `--build` builds the image from this checkout's
// deploy/codebase-report instead of pulling the published one. The image
// never builds or tests the code, so `--measure` passes the results of a
// build, a test run or a package audit run on this computer to it, each
// checked here by the image's own parser before Docker is asked anything.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSentMeasure } from '../deploy/codebase-report/measure.mjs';
import { readDevSecretBindings } from './dev-secrets.mjs';
import { MANAGED_DOOR } from './ingest-door.mjs';
import { ENV_FILE, readInstallationEnv } from './installation-layout.mjs';
import { RELEASE_REPOSITORY } from './published-image.mjs';
import { runCommand } from './run-command.mjs';
import { parseServices, readSelector } from './stack-control.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The published measurement image: the app image's name with this suffix, as the release workflow publishes it. */
export const CODEBASE_REPORT_REPOSITORY = `${RELEASE_REPOSITORY}-codebase-report`;
export const DEFAULT_IMAGE = `${CODEBASE_REPORT_REPOSITORY}:main`;
/** The tag `--build` gives the image built from this checkout. */
export const LOCAL_IMAGE = 'noticeos-codebase-report:local';
const MEASURE_TIMEOUT_MS = 1_800_000;
const HELP = 'Usage: pnpm os:codebase-report -- --asset <id> --repo <path> [--paths a,b] [--image <ref> | --build] [--config /absolute/stack.json]'
  + ' [--measure build_passed|tests_passed|vulnerable_dependencies=<value>]...';

const ASSET = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$/u;
const IMAGE = /^[a-z0-9][a-z0-9._/-]{0,200}(?::[A-Za-z0-9_.-]{1,128})?(?:@sha256:[a-f0-9]{64})?$/u;
// A mount source is one field of --mount, so it may hold no comma, quote or line break.
const MOUNTABLE = /^\/[^,"'\r\n\0]*$/u;

function refuse(message) { throw new Error(message); }

/** The command's arguments, checked before Docker is asked anything. */
export function parseArgs(argv, { cwd = process.cwd() } = {}) {
  const parsed = { asset: null, repo: null, paths: null, image: null, build: false, config: null, measures: [] };
  const args = argv.filter((word) => word !== '--');
  const sent = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--build') {
      if (parsed.build) refuse(HELP);
      parsed.build = true;
      continue;
    }
    if (flag === '--measure') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) refuse(`--measure needs key=value.\n${HELP}`);
      const { key } = parseSentMeasure(value);
      if (sent.has(key)) refuse(`--measure ${key} is given twice.`);
      sent.add(key);
      parsed.measures.push(value);
      i += 1;
      continue;
    }
    const key = { '--asset': 'asset', '--repo': 'repo', '--paths': 'paths', '--image': 'image', '--config': 'config' }[flag];
    const value = args[i + 1];
    if (!key || parsed[key] !== null || value === undefined || value.startsWith('--')) refuse(HELP);
    parsed[key] = value;
    i += 1;
  }
  if (!parsed.asset || !ASSET.test(parsed.asset)) refuse(`Name the site with --asset, such as --asset example.com.\n${HELP}`);
  if (!parsed.repo) refuse(`Name the site's checkout with --repo.\n${HELP}`);
  parsed.repo = path.resolve(cwd, parsed.repo);
  if (!MOUNTABLE.test(parsed.repo)) refuse('The checkout\'s path may not hold a comma, a quote or a line break; move or link it to a plain path.');
  if (parsed.paths !== null) {
    const list = parsed.paths.split(',').map((part) => part.trim().replace(/^\.\//u, '').replace(/\/+$/u, '')).filter(Boolean);
    if (!list.length || list.length > 20 || list.some((part) => part.startsWith('/') || part.split('/').includes('..') || /[\0\r\n]/u.test(part))) {
      refuse('--paths takes 1 to 20 folders inside the checkout, separated by commas, such as apps/site.');
    }
    parsed.paths = list;
  }
  if (parsed.image !== null && parsed.build) refuse('Choose --image or --build, not both.');
  if (parsed.image !== null && !IMAGE.test(parsed.image)) refuse('--image takes an image reference, such as ghcr.io/example/image:tag.');
  if (parsed.config !== null && !path.isAbsolute(parsed.config)) refuse('--config takes an absolute path.');
  return parsed;
}

/**
 * Where the site's token is: the installation folder's bootstrap secrets,
 * which the app container reads as /state/workers/ingest; a legacy stack's
 * settings live elsewhere, so it keeps the checkout's own file.
 */
export function secretFiles(selector, io = fs) {
  if (path.basename(selector.envFile) !== ENV_FILE) return {};
  const values = readInstallationEnv(selector.envFile, io);
  const dir = path.join(values.NOTICEOS_STATE_DIR, 'workers', 'ingest');
  return { secretsFile: path.join(dir, '.dev.secrets.json'), varsFile: path.join(dir, '.dev.vars') };
}

/** The site's token from ASSET_TOKENS, or a refusal naming the file to edit. */
export async function assetToken(asset, files, read = readDevSecretBindings) {
  const { bindings, sourceFile } = await read(files);
  let tokens = {};
  try { tokens = JSON.parse(bindings.ASSET_TOKENS || '{}'); } catch { refuse(`ASSET_TOKENS in ${sourceFile} is not valid JSON.`); }
  const token = tokens?.[asset];
  if (typeof token !== 'string' || !token) refuse(`ASSET_TOKENS in ${sourceFile} has no "${asset}" entry; add the site's token there, then pnpm os:restart.`);
  return token;
}

/** `docker build` of this checkout's measurement image. */
export function buildArgs(selector, root = ROOT) {
  return ['--host', selector.dockerHost, 'build', '--tag', LOCAL_IMAGE, path.join(root, 'deploy', 'codebase-report')];
}

/** `docker run` of the measurement image beside the app container, with the checkout read-only. */
export function measureArgs({ selector, app, image, repo, asset, paths, local, measures = [] }) {
  return ['--host', selector.dockerHost, 'run', '--rm', '--pull', local ? 'never' : 'missing',
    '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--network', `container:${app}`,
    '--mount', `type=bind,source=${repo},target=/repo,readonly`,
    '--env', 'NOTICEOS_ASSET_TOKEN',
    image, '--asset', asset, '--repo', '/repo', ...(paths ? ['--paths', paths.join(',')] : []),
    ...measures.flatMap((measure) => ['--measure', measure]), '--post', MANAGED_DOOR];
}

export async function codebaseReport(options, { run = runCommand, env = process.env, io = fs, root = ROOT, readSecrets = readDevSecretBindings,
  out = process.stdout } = {}) {
  const stat = io.statSync(options.repo, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) refuse(`${options.repo} is not a folder.`);
  const selectorFile = options.config ?? path.join(root, '.local', 'stack.json');
  const selector = readSelector(selectorFile, io);
  const token = await assetToken(options.asset, secretFiles(selector, io), readSecrets);
  const ownEnv = Object.fromEntries(['PATH', 'HOME', 'DOCKER_CONFIG', 'XDG_CONFIG_HOME'].filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));
  const inventory = await run('docker', ['--host', selector.dockerHost, 'compose', '--project-name', selector.project,
    ...selector.files.flatMap((file) => ['-f', file]), '--env-file', selector.envFile, 'ps', '--all', '--format', 'json'], { env: ownEnv, timeoutMs: 20_000 });
  if (inventory.code !== 0) refuse('Reading the stack failed; pnpm os:status shows why.');
  const app = parseServices(inventory.stdout, selector.project).get('noticeos');
  if (app.state !== 'running') refuse('The app is not running; start it first: pnpm os:start');
  let image = options.image ?? DEFAULT_IMAGE;
  if (options.build) {
    out.write(`Building ${LOCAL_IMAGE} from deploy/codebase-report\n`);
    const built = await run('docker', buildArgs(selector, root), { env: ownEnv, timeoutMs: 1_800_000, inherit: true });
    if (built.code !== 0) refuse(`Building the measurement image failed (exit ${built.code}).`);
    image = LOCAL_IMAGE;
  }
  out.write(`Measuring ${options.repo} for ${options.asset} with ${image}\n`);
  const measured = await run('docker', measureArgs({ selector, app: app.id, image, repo: options.repo, asset: options.asset, paths: options.paths, local: options.build, measures: options.measures ?? [] }),
    { env: { ...ownEnv, NOTICEOS_ASSET_TOKEN: token }, timeoutMs: MEASURE_TIMEOUT_MS, inherit: true });
  if (measured.code !== 0) refuse(`The codebase report was not stored (exit ${measured.code}); the lines above say why.`);
}

export async function main(argv = process.argv.slice(2), { out = process.stdout, err = process.stderr, ...options } = {}) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) { out.write(`${HELP}\n`); return 0; }
  try {
    await codebaseReport(parseArgs(argv), { out, ...options });
    return 0;
  } catch (error) {
    err.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
