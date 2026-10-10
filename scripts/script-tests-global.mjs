// What the whole root script suite shares for one run.
//
// `pnpm test:scripts` runs every scripts/*.test.mjs in a process of its own.
// node --test loads this once, before any of them (--test-global-setup), and
// it makes one folder for the run's Worker bundles: several files bundle the
// same Tower and ingest Workers, and each wrangler dry run costs seconds. The
// folder's path reaches every test process through the environment, and the
// folder is removed when the run ends. A file run on its own (CONTRIBUTING.md)
// has no folder and bundles as it always did.

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The variable naming the run's Worker bundle folder. */
export const WORKER_BUNDLES = 'NOTICEOS_TEST_WORKER_BUNDLES';

let bundles = null;

export async function globalSetup() {
  bundles = mkdtempSync(path.join(os.tmpdir(), 'noticeos-worker-bundles-'));
  process.env[WORKER_BUNDLES] = bundles;
}

export async function globalTeardown() {
  if (bundles) rmSync(bundles, { recursive: true, force: true });
  bundles = null;
}
