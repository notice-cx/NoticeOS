// Runtime child only: parent signals become an IPC request, never a workerd TERM.
import { tracingChannel } from 'node:diagnostics_channel';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const defaultStart = async file => {
  const { readHostedDemoRuntimeFile, startHostedDemoServer } = await import('./hosted-demo-server.mjs');
  const { PRODUCT_ENV } = await import('./product-env.mjs');
  // The page's analytics tag is the operator's (deploy/demo/example.env), never the private runtime's.
  return startHostedDemoServer(readHostedDemoRuntimeFile(file), undefined, { statcounter: process.env[PRODUCT_ENV.demoStatcounter.name] });
};
export async function runHostedDemoWorker(runtimeFile, start = defaultStart, { graceMs = 80000 } = {}) {
  if (!process.connected) throw new Error('Owned supervisor required.');
  if (!Number.isSafeInteger(graceMs) || graceMs < 1 || graceMs > 80000) throw new Error('Invalid shutdown deadline.');
  let stop, stopping = false, deadline, nextLease = 0;
  const detached = new WeakSet(), owned = new Map();
  const send = value => { if (process.connected) process.send(value, () => {}); };
  const killDetached = () => {
    for (const { child } of owned.values()) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') process.exitCode = 1; }
    }
  };
  // Documented Node 24 tracing events: observe only detached custody, never
  // copy command arguments, environment or private runtime facts into IPC.
  const channel = tracingChannel('child_process.spawn');
  const observer = {
    start: ({ process: child, options }) => { if (options.detached === true) detached.add(child); },
    end: ({ process: child }) => {
      if (!detached.has(child)) return;
      // Pinned Node publishes tracing end before assigning child.pid. Its
      // ordinary spawn event supplies the successful, exact owned PID.
      child.once('spawn', () => {
        if (!Number.isSafeInteger(child.pid) || child.pid < 1) return;
        const lease = ++nextLease;
        const closed = new Promise(resolve => child.once('close', () => {
          owned.delete(lease); send({ type: 'noticeos-demo-group-closed', lease, pid: child.pid }); resolve();
        }));
        owned.set(lease, { child, closed });
        send({ type: 'noticeos-demo-group-owned', lease, pid: child.pid });
      });
    },
  };
  channel.subscribe(observer);
  const stopped = new Promise(resolve => { stop = resolve; });
  const requestStop = () => {
    stopping = true; stop();
    deadline ??= setTimeout(() => {
      // The supervisor creates this runtime as its own detached group. Also
      // bound orphan cleanup when the supervisor itself can no longer await it.
      killDetached(); process.kill(-process.pid, 'SIGKILL');
    }, graceMs);
  };
  const message = value => { if (value?.type === 'noticeos-demo-stop' && Object.keys(value).length === 1) requestStop(); };
  process.on('message', message); process.once('disconnect', requestStop);
  send({ type: 'noticeos-demo-control-ready' });
  // Keep awaited cleanup alive even if the supervisor's IPC connection is lost.
  const keepalive = setInterval(() => {}, 1000);
  let server;
  try {
    server = await start(runtimeFile);
    if (!stopping) process.stdout.write('Demo preview ready.\n');
    await stopped;
  } finally {
    try {
      requestStop();
      await server?.close();
    }
    finally {
      killDetached();
      await Promise.all([...owned.values()].map(value => value.closed));
      channel.unsubscribe(observer);
      clearTimeout(deadline); clearInterval(keepalive); process.off('message', message); process.off('disconnect', requestStop);
      if (process.connected) process.disconnect();
    }
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--runtime-file') throw new Error('Explicit private runtime required.');
    await runHostedDemoWorker(args[1]);
  } catch {
    process.stderr.write('Demo preview unavailable. Check its private configuration.\n'); process.exitCode = 1;
  }
}
