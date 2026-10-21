import fs from 'node:fs/promises';
import path from 'node:path';

async function resolvedPath(file, io) {
  let at = path.resolve(file);
  const missing = [];
  for (;;) {
    try { return path.join(await io.realpath(at), ...missing); }
    catch (error) {
      if (error?.code !== 'ENOENT' || path.dirname(at) === at) throw error;
      // A destination may not exist yet; existing ancestors still resolve links.
      missing.unshift(path.basename(at));
      at = path.dirname(at);
    }
  }
}

/** Host paths supplied to a container can only be compared in their host namespace. */
export async function assertOffsiteOutsideInstallation(destination, installation, { fs: io = fs, resolve = true } = {}) {
  const [target, root] = resolve
    ? await Promise.all([resolvedPath(destination, io), resolvedPath(installation, io)])
    : [path.resolve(destination), path.resolve(installation)];
  const relative = path.relative(root, target);
  if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new Error(`Offsite backup destination must be outside the installation folder; handoff rejected and retention blocked. Destination: ${destination}. Installation: ${installation}.`);
  }
}
