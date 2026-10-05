// Public-preview supervisor. Only the owned runtime child imports Miniflare.
import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export async function superviseHostedDemo(runtimeFile, {
  worker = new URL('./hosted-demo-worker.mjs', import.meta.url),
  graceMs = 80000,
} = {}) {
  if (typeof runtimeFile !== 'string' || !path.isAbsolute(runtimeFile)) throw new Error('Explicit private runtime required.');
  if (!Number.isSafeInteger(graceMs) || graceMs < 1 || graceMs > 80000) throw new Error('Invalid shutdown deadline.');
  let child, stopping = false, deadline, forced = false, controlReady = false;
  const groups = new Map();
  const killDetached = () => {
    for (const pid of groups.values()) {
      try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') forced = true; }
    }
    groups.clear();
  };
  const killOwnedGroup = () => {
    if (!Number.isSafeInteger(child?.pid) || child.pid < 1) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') forced = true; }
  };
  const stop = () => {
    stopping = true;
    if (!child || child.exitCode !== null || child.signalCode !== null || deadline) return;
    if (child.connected && controlReady) child.send({ type: 'noticeos-demo-stop' }, () => {});
    deadline = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      forced = true;
      killDetached();
      // This fork has its own process group; never signal an inherited group.
      killOwnedGroup();
    }, graceMs);
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    child = fork(fileURLToPath(worker), ['--runtime-file', runtimeFile], {
      detached: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const closed = new Promise(resolve => {
      let failed = false;
      child.once('error', () => { failed = true; });
      child.on('message', value => {
        if (['noticeos-demo-group-owned', 'noticeos-demo-group-closed'].includes(value?.type)
          && Object.keys(value).length === 3 && Number.isSafeInteger(value.lease) && value.lease > 0
          && Number.isSafeInteger(value.pid) && value.pid > 0 && value.pid !== child.pid) {
          if (value.type === 'noticeos-demo-group-owned') groups.set(value.lease, value.pid);
          else if (groups.get(value.lease) === value.pid) groups.delete(value.lease);
          return;
        }
        if (value?.type !== 'noticeos-demo-control-ready' || Object.keys(value).length !== 1) return;
        controlReady = true;
        if (stopping && child.connected) child.send({ type: 'noticeos-demo-stop' }, () => {});
      });
      child.once('disconnect', stop);
      child.once('close', (code, signal) => {
        const unsuccessful = forced || failed || signal || code !== 0;
        // The group's lease ends here; remove surviving owned descendants now,
        // never from a delayed callback after a PID could have been reused.
        if (unsuccessful) { killDetached(); killOwnedGroup(); }
        groups.clear();
        resolve(unsuccessful ? 1 : 0);
      });
    });
    if (stopping) stop();
    return await closed;
  } finally {
    clearTimeout(deadline);
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--runtime-file') throw new Error('Explicit private runtime required.');
    process.exitCode = await superviseHostedDemo(args[1]);
  } catch {
    process.stderr.write('Demo preview unavailable. Check its private configuration.\n'); process.exitCode = 1;
  }
}
