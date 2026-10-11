// What differs when an installation's commands run from its image
// (deploy/compose/noticeos starts them in a short-lived container, through
// scripts/noticeos-cli.mjs) rather than from a checkout on the host: the
// host's ports and loopback are not the container's own, so a port is tested
// by asking Docker to publish it, and Postgres is reached on the
// installation's network.

import path from 'node:path';

/** The image installation these commands run for, or null when they run from a checkout. */
export function imageInstallation(env = process.env) {
  const image = env.NOTICEOS_CLI_IMAGE;
  const dir = env.NOTICEOS_DIR;
  if (!image || !dir) return null;
  if (!path.isAbsolute(dir) || /[\r\n\0]/u.test(dir) || /[\s\0]/u.test(image)) throw new Error('The launcher named an invalid installation folder or image.');
  return { image, dir, launcher: env.NOTICEOS_LAUNCHER || path.join(dir, 'noticeos') };
}

const BUSY = /already allocated|already in use|ports are not available/iu;

/**
 * Whether Docker can publish `address`:`port` on this host: a throwaway
 * container from `image` tries, and fails exactly when the stack's would.
 * Throws when Docker fails for another reason.
 */
export async function dockerPortFree(port, { run, dockerHost, image, env, address = '127.0.0.1' }) {
  const result = await run('docker', ['--host', dockerHost, 'run', '--rm', '--pull', 'never', '--network', 'bridge',
    '--publish', `${address}:${port}:9`, '--entrypoint', 'true', image], { env, timeoutMs: 60_000 });
  if (result.code === 0) return true;
  if (BUSY.test(String(result.stderr ?? ''))) return false;
  throw new Error(`Docker could not test whether port ${port} is free.`);
}

/** A Postgres address from the secrets folder, as the installation's network reaches it. */
export function onInstallationNetwork(address) {
  const url = new URL(address.url);
  url.hostname = 'postgres';
  url.port = '5432';
  return { ...address, url: url.href };
}
