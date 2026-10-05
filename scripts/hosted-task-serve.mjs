// Explicit local hosted entry. No standalone setup, installation discovery or
// remote provisioning; the two server Worker configs and private composition
// must already have been prepared by the operator.
import { startHostedTaskServer, readHostedTaskRuntimeFile } from './hosted-task-server.mjs';
const usage = 'node scripts/hosted-task-serve.mjs --runtime-file ABSOLUTE_FILE --worker-config-root ABSOLUTE_DIRECTORY';
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--runtime-file' || args[2] !== '--worker-config-root') throw new Error(usage);
  const runtime = readHostedTaskRuntimeFile(args[1]);
  const server = await startHostedTaskServer({ runtime, workerConfigRoot: args[3] });
  let release;
  const stopped = new Promise(resolve => { release = resolve; });
  const stop = () => release();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    process.stdout.write(server.runtime.origin + '\n');
    await stopped;
  } finally {
    // Keep signal handlers installed while cleanup is pending, so repeated
    // interruption cannot bypass awaited request/Worker/pool retirement.
    try { await server.close(); } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  }
}
try { await main(); } catch {
  process.stderr.write('Hosted Tasks server failed. Check its reviewed server configuration.\n');
  process.exitCode = 1;
}
