// Whether a module is the script node was started with, compared through realpath.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** True when `argv1` (process.argv[1]) is the file `moduleUrl` names. */
export function invokedDirectly(argv1, moduleUrl) {
  if (!argv1) return false;
  try {
    return realpathSync(path.resolve(argv1)) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
