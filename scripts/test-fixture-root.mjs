// Owned fixtures use canonical paths even when the platform's temp directory
// is an alias. Untrusted inputs passed to production validators stay unchanged.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function testFixtureRoot(prefix, parent = tmpdir()) {
  return realpathSync(mkdtempSync(path.join(parent, prefix)));
}
