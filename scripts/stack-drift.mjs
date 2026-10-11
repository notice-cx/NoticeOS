// Which of the stack's services do not run as the stack now declares them.
//
// Compose labels each container it creates with a hash of its service's
// resolved declaration (com.docker.compose.config-hash), and
// `docker compose config --hash` prints the same hash for the declaration as
// it reads today. A service whose two hashes differ is one an edit to
// installation.env, or a pull that changed the stack definition, has changed;
// `pnpm os:apply` recreates exactly those. Read-only.

import { composePrefix } from './stack-database.mjs';
import { runCommand } from './run-command.mjs';

const ownEnv = (env) => Object.fromEntries(['PATH', 'HOME', 'DOCKER_CONFIG', 'XDG_CONFIG_HOME'].filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));
const HASH = /^[a-f0-9]{64}$/u;

/** Compose could not read the stack as declared; `line` is its own first complaint. */
export class DeclarationUnreadable extends Error {}

/** Each service's hash, from `config --hash '*'` output. */
export function parseDeclaredHashes(stdout) {
  const hashes = new Map();
  for (const line of String(stdout).split('\n').map((row) => row.trim()).filter(Boolean)) {
    const [service, hash, ...rest] = line.split(/\s+/u);
    if (rest.length || !HASH.test(hash ?? '')) throw new DeclarationUnreadable('Compose printed an unexpected service hash.');
    hashes.set(service, hash);
  }
  return hashes;
}

/** Each service's container and the hash it was created from, from `ps --all --format json` output. */
export function parseRunningHashes(stdout) {
  const raw = String(stdout).trim();
  const rows = raw === '' ? [] : raw.startsWith('[') ? JSON.parse(raw) : raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const running = new Map();
  for (const row of rows) {
    if (row.OneOff === true) continue;
    const labels = Object.fromEntries(String(row.Labels ?? '').split(',').map((pair) => {
      const at = pair.indexOf('=');
      return at === -1 ? [pair, ''] : [pair.slice(0, at), pair.slice(at + 1)];
    }));
    running.set(row.Service, { id: row.ID, state: row.State, health: row.Health || null, hash: labels['com.docker.compose.config-hash'] ?? null });
  }
  return running;
}

/**
 * `{ declared, running, changed, missing }`: the declared hashes, the running
 * containers, the services whose container was created from another
 * declaration, and declared services with no container. Throws
 * DeclarationUnreadable naming Compose's own first complaint when the stack's
 * files or installation.env cannot be read.
 */
export async function serviceDrift(selector, { run = runCommand, env = process.env } = {}) {
  const prefix = composePrefix(selector);
  const declared = await run('docker', [...prefix, 'config', '--hash', '*'], { env: ownEnv(env), timeoutMs: 20_000 });
  if (declared.code !== 0) {
    const complaint = String(declared.stderr ?? '').split('\n').map((line) => line.trim()).find(Boolean);
    throw new DeclarationUnreadable(complaint ? `Compose cannot read the stack: ${complaint}` : 'Compose cannot read the stack; is Docker running?');
  }
  const listed = await run('docker', [...prefix, 'ps', '--all', '--format', 'json'], { env: ownEnv(env), timeoutMs: 20_000 });
  if (listed.code !== 0) throw new DeclarationUnreadable('Compose could not list the stack\'s containers; is Docker running?');
  const hashes = parseDeclaredHashes(declared.stdout);
  const running = parseRunningHashes(listed.stdout);
  const changed = [...hashes].filter(([service, hash]) => running.has(service) && running.get(service).hash !== hash).map(([service]) => service);
  const missing = [...hashes.keys()].filter((service) => !running.has(service));
  return { declared: hashes, running, changed, missing };
}
