// The demo's own Ntasks: the Worker the image built from deploy/demo/ntasks.json,
// run in Miniflare on the namespace's loopback, its D1 database and task store
// kept under /ntasks. The first start runs the provision preparation wrote
// (Ntasks's provision command) on the empty database; a later start finds its
// marker and changes nothing.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { applyDemoNtasksProvision, demoNtasksWorker, DEMO_NTASKS_PORT } from '../../scripts/demo-ntasks.mjs';
import { v4Miniflare } from '../../scripts/miniflare-v4.mjs';

const root = '/ntasks', marker = path.join(root, 'provisioned.json');
const BUNDLE = '/opt/ntasks/dist';

function privateJson(file) {
  if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile() || (fs.statSync(file).mode & 0o077) || fs.statSync(file).size > 4 * 1024 * 1024) throw new Error();
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

try {
  if (process.argv.length !== 2 || fs.realpathSync(root) !== root) throw new Error();
  const settings = privateJson('/setup/ntasks.json');
  if (settings.version !== 1 || typeof settings.authSecret !== 'string' || typeof settings.workspaceId !== 'string') throw new Error();
  const require = createRequire(new URL('../../workers/ingest/package.json', import.meta.url));
  const wrangler = createRequire(require.resolve('wrangler/package.json'));
  const { Miniflare, Log } = v4Miniflare(wrangler);
  const provisioned = fs.existsSync(marker);
  if (!provisioned && fs.readdirSync(root).length) throw new Error();
  const miniflare = new Miniflare({ ...demoNtasksWorker({ bundleRoot: BUNDLE, authSecret: settings.authSecret, workspaceId: settings.workspaceId }),
    host: '127.0.0.1', port: DEMO_NTASKS_PORT, cf: false, inspectorPort: undefined, resourcePersistencePath: path.join(root, 'state'),
    logRequests: false, telemetry: { enabled: false }, log: new Log(0), handleStructuredLogs: () => undefined });
  await miniflare.ready;
  if (!provisioned) {
    const provision = privateJson('/setup/ntasks-provision.json');
    if (provision.workspaceId !== settings.workspaceId) throw new Error();
    await applyDemoNtasksProvision(await miniflare.getD1Database('DB'), provision);
    fs.writeFileSync(marker, `${JSON.stringify({ version: 1, workspaceId: settings.workspaceId })}\n`, { flag: 'wx', mode: 0o600 });
  } else if (privateJson(marker).workspaceId !== settings.workspaceId) throw new Error();
  const stopped = new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
  await stopped;
  await miniflare.dispose();
} catch { process.stderr.write('Demo task service unavailable; preserve its volume for recovery.\n'); process.exitCode = 1; }
