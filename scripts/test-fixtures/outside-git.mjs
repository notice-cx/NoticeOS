import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';

/** A tool that discovers Git above its working directory may commit files
 * there. Every fixture tree must be outside all checkouts. */
export function assertOutsideGit(directory) {
  for (let current = fs.realpathSync(directory); ; current = path.dirname(current)) {
    assert.equal(fs.existsSync(path.join(current, '.git')), false, 'Test fixtures must be outside Git checkouts');
    if (current === path.dirname(current)) break;
  }
}
