// Entrypoint for the opt-in disposable Compose proof. Starts a pinned Ntasks
// Worker on the container's own loopback, with no public port or egress.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = '/state/ntasks-fixture';
const app = '/opt/noticeos';
const require = createRequire(path.join(app, 'workers/ingest/package.json'));
const { v4Miniflare } = await import(`${app}/scripts/miniflare-v4.mjs`);
const { demoNtasksWorker } = await import(`${app}/scripts/demo-ntasks.mjs`);
const { Miniflare } = v4Miniflare(createRequire(require.resolve('wrangler/package.json')));
const settings = JSON.parse(readFileSync(path.join(root, 'settings.json'), 'utf8'));
const origin = 'http://127.0.0.1:17971';
const worker = demoNtasksWorker({ bundleRoot: path.join(root, 'bundle'), ...settings });
const { PUBLIC_WORKSPACE_ID: _public, ...bindings } = worker.bindings;
const runtime = new Miniflare({ ...worker, bindings: { ...bindings, NTASKS_ORIGIN: origin }, host: '127.0.0.1', port: 17971,
  cf: false, telemetry: { enabled: false }, resourcePersistencePath: path.join(root, 'state') });
try {
  await runtime.ready;
  const child = spawn(process.execPath, [path.join(app, 'deploy/compose/entrypoint.mjs')], { stdio: 'inherit' });
  const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try { process.exitCode = await new Promise(resolve => {
    child.once('exit', code => resolve(code ?? 1));
    child.once('error', () => resolve(1));
  }); } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
} finally { await runtime.dispose(); }
