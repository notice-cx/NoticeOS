#!/usr/bin/env node
// Inputs for the opt-in real task store suites (`pnpm test:task-store`, the CI
// task-store job; epic ro-cvl9) on a Linux host with Docker: the task client and
// Dolt client the application image pins, read from deploy/compose/Dockerfile
// rather than copied, each verified against its pinned digest; the Dolt server
// image scripts/dolt-host.mjs pins; and a new empty evidence folder.
//
//   node scripts/task-store-test-tools.mjs --out <new folder> >> "$GITHUB_ENV"
//
// Prints only KEY=VALUE lines on stdout; progress goes to stderr. It downloads
// and pulls; it contacts no installed task hub and needs no credential.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOLT_IMAGE } from './dolt-host.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DOCKERFILE = path.join(ROOT, 'deploy', 'compose', 'Dockerfile');

/** The pinned release download of each tool, for one architecture, as the
 * application image's own RUN instructions state it. */
export function pinnedTaskTools(dockerfile, arch) {
  if (!['amd64', 'arm64'].includes(arch)) throw new Error(`no pinned task tools for ${arch}`);
  const instructions = dockerfile.replace(/\\\n/gu, ' ').split('\n').filter(line => /^RUN\s/u.test(line));
  const tool = (name, marker) => {
    const found = instructions.filter(line => line.includes(marker));
    if (found.length !== 1) throw new Error(`deploy/compose/Dockerfile pins ${name} ${found.length} times, not once`);
    const digest = new RegExp(`\\b${arch}\\) digest=([0-9a-f]{64}) ;;`, 'u').exec(found[0])?.[1];
    const url = /"(https:\/\/github\.com\/[^"]+\$\{TARGETARCH\}[^"]*)"/u.exec(found[0])?.[1];
    if (!digest || !url) throw new Error(`deploy/compose/Dockerfile has no ${arch} download for ${name}`);
    return { url: url.replaceAll('${TARGETARCH}', arch), sha256: digest };
  };
  return { beads: tool('beads', '/gastownhall/beads/releases/download/'), dolt: tool('dolt', '/dolthub/dolt/releases/download/') };
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
async function download(pin, destination) {
  const reply = await fetch(pin.url, { redirect: 'follow' });
  if (!reply.ok) throw new Error(`${pin.url} answered HTTP ${reply.status}`);
  fs.writeFileSync(destination, Buffer.from(await reply.arrayBuffer()), { mode: 0o600 });
  const actual = sha256(destination);
  if (actual !== pin.sha256) throw new Error(`${pin.url} has SHA-256 ${actual}, not the pinned ${pin.sha256}`);
}

async function main(argv) {
  const at = argv.indexOf('--out');
  const out = at === -1 ? undefined : argv[at + 1];
  if (!out || !path.isAbsolute(out) || fs.existsSync(out)) throw new Error('usage: --out <absolute path of a new folder>');
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  if (process.platform !== 'linux' || !arch) throw new Error('the pinned task tools are Linux builds');
  const pins = pinnedTaskTools(fs.readFileSync(DOCKERFILE, 'utf8'), arch);
  for (const folder of ['downloads', 'bin', 'evidence']) fs.mkdirSync(path.join(out, folder), { recursive: true, mode: 0o700 });
  const beadsArchive = path.join(out, 'downloads', 'beads.tar.gz'), doltArchive = path.join(out, 'downloads', 'dolt.tar.gz');
  process.stderr.write(`task client ${pins.beads.url}\n`); await download(pins.beads, beadsArchive);
  process.stderr.write(`dolt client ${pins.dolt.url}\n`); await download(pins.dolt, doltArchive);
  execFileSync('tar', ['--no-same-owner', '-xzf', beadsArchive, '-C', path.join(out, 'bin'), 'bd'], { stdio: ['ignore', 'ignore', 'inherit'] });
  execFileSync('tar', ['--no-same-owner', '-xzf', doltArchive, '-C', path.join(out, 'downloads'), `dolt-linux-${arch}/bin/dolt`], { stdio: ['ignore', 'ignore', 'inherit'] });
  fs.copyFileSync(path.join(out, 'downloads', `dolt-linux-${arch}`, 'bin', 'dolt'), path.join(out, 'bin', 'dolt'));
  for (const name of ['bd', 'dolt']) fs.chmodSync(path.join(out, 'bin', name), 0o700);
  process.stderr.write(`dolt server ${DOLT_IMAGE}\n`);
  execFileSync('docker', ['pull', '--quiet', DOLT_IMAGE], { stdio: ['ignore', 'ignore', 'inherit'] });
  const imageId = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', DOLT_IMAGE], { encoding: 'utf8' }).trim();
  const bd = path.join(out, 'bin', 'bd'), dolt = path.join(out, 'bin', 'dolt');
  // The fixture gives each command its own HOME, so the Docker client's own
  // configuration is named explicitly: this host's, never a new one.
  const dockerConfig = process.env.DOCKER_CONFIG ?? path.join(os.homedir(), '.docker');
  fs.mkdirSync(dockerConfig, { recursive: true, mode: 0o700 });
  const lines = {
    DOCKER_CONFIG: dockerConfig,
    NOTICEOS_TEST_HOSTED_TASK_EXECUTOR: '1',
    NOTICEOS_TEST_HOSTED_TASK_EVIDENCE: path.join(out, 'evidence'),
    NOTICEOS_TEST_BEADS_NEW_BIN: bd, NOTICEOS_TEST_BEADS_SHA256: sha256(bd),
    NOTICEOS_TEST_DOLT_CLIENT_BIN: dolt, NOTICEOS_TEST_DOLT_CLIENT_SHA256: sha256(dolt),
    NOTICEOS_TEST_DOLT_IMAGE_ID: imageId,
  };
  if (!/^sha256:[0-9a-f]{64}$/u.test(imageId)) throw new Error(`unexpected image id ${imageId}`);
  process.stdout.write(Object.entries(lines).map(([key, value]) => `${key}=${value}\n`).join(''));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exit(1); });
}
