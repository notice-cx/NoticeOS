// Disposable transport qualification only; never exposed as a product entry.
import pg from 'pg';
import { openStore, runInWorkspace, withHostedWorkspaceStore } from '../src/store.mjs';
import { openIdentity } from '../src/identity.mjs';
const { Pool } = pg;

export async function observeTransport(connectionString, workspaces) {
  const store = openStore(connectionString, { maxConnections: 1 });
  const clientPool = new Pool({ connectionString, max: 1 });
  let client;
  try {
    const read = workspace => store.inWorkspace(workspace, async tx =>
      (await tx.query("SELECT pg_backend_pid() AS pid, display_name FROM noticeos.assets WHERE asset_id='shared.example'"))[0], { readOnly: true });
    const first = await read(workspaces[0]), second = await read(workspaces[1]);
    const interleaved = await Promise.all([0, 1, 0, 1].map(index => read(workspaces[index])));
    let failed = false;
    try {
      await store.inWorkspace(workspaces[0], async tx => {
        await tx.execute("UPDATE noticeos.assets SET display_name='Rolled back' WHERE asset_id='shared.example'");
        await tx.query('SELECT 1/0').catch(() => undefined);
      });
    } catch (error) { failed = error.name === 'TransactionRolledBack'; }
    const afterFailure = [await read(workspaces[0]), await read(workspaces[1])];
    await store.inWorkspace(workspaces[0], tx => tx.execute("UPDATE noticeos.assets SET display_name='Fresh write' WHERE asset_id='shared.example'"));
    const afterWrite = [await read(workspaces[0]), await read(workspaces[1])];
    client = await clientPool.connect();
    const queryClient = { query: query => client.query(query) };
    const inside = await runInWorkspace(queryClient, workspaces[0], async tx =>
      (await tx.query("SELECT noticeos.current_workspace_id() AS scope"))[0].scope, { readOnly: true });
    const reset = (await client.query("SELECT nullif(current_setting('noticeos.workspace_id',true),'') AS scope, count(*)::int AS visible FROM noticeos.assets")).rows[0];
    let rawFailed = false;
    try {
      await runInWorkspace(queryClient, workspaces[0], async tx => {
        await tx.query('SELECT 1/0');
      });
    } catch (error) { rawFailed = error.code === '22012'; }
    const rollbackReset = (await client.query("SELECT nullif(current_setting('noticeos.workspace_id',true),'') AS scope, count(*)::int AS visible FROM noticeos.assets")).rows[0];
    const reusedAfterRollback = await runInWorkspace(queryClient, workspaces[1], async tx =>
      (await tx.query("SELECT display_name FROM noticeos.assets WHERE asset_id='shared.example'"))[0].display_name, { readOnly: true });
    let malformedRefused = false;
    try {
      await withHostedWorkspaceStore({ transport: { kind: 'hyperdrive', connectionString }, workspace: { workspaceId: workspaces[0] } },
        { waitUntil() { throw new Error('invalid transport must not acquire a store'); } }, async () => undefined);
    } catch (error) { malformedRefused = error.name === 'TransactionRefused'; }
    return { first, second, interleaved, failed, afterFailure, afterWrite, inside, reset, rawFailed, rollbackReset, reusedAfterRollback, malformedRefused };
  } finally { client?.release(); await clientPool.end(); await store.close(); }
}

export async function observeLock(connectionString, workspaceId, key, acquired, hashed = false) {
  const store = openStore(connectionString, { maxConnections: 1 });
  try {
    return await store.inWorkspace(workspaceId, async tx => {
      await tx.query(hashed
        ? 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))'
        : 'SELECT pg_advisory_xact_lock($1::bigint)', [key]);
      await acquired();
      return 'held';
    });
  } finally { await store.close(); }
}

export async function tryLock(connectionString, workspaceId, key, hashed = false) {
  const store = openStore(connectionString, { maxConnections: 1 });
  try {
    return await store.inWorkspace(workspaceId, async tx =>
      (await tx.query(hashed
        ? 'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired'
        : 'SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired', [key]))[0].acquired);
  } finally { await store.close(); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = url.pathname;
    const hashed = url.searchParams.get('hashed') === '1';
    if (route === '/facts') {
      const identity = await openIdentity({ connectionString: env.IDENTITY, trustedOrigin: env.ORIGIN, sessionSecret: env.SECRET });
      try {
        return Response.json({ session: await identity.session(request.headers), membership: await identity.membership(request.headers, env.WORKSPACES[0]) });
      } finally { await identity.close(); }
    }
    if (route === '/hold' || route === '/rollback') {
      try { return Response.json(await observeLock(env.DATABASE, env.WORKSPACES[0], env.LOCK,
      async () => { const response = await env.BARRIER.fetch('https://barrier.example.test/acquired'); await response.text(); if (route === '/rollback') throw new Error('fixture rollback'); }, hashed));
      } catch (error) { if (error.message !== 'fixture rollback') throw error; return Response.json({ rolledBack: true }); }
    }
    if (route === '/try') return Response.json(await tryLock(env.DATABASE, env.WORKSPACES[1], env.LOCK, hashed));
    if (route === '/probe') return Response.json(await observeTransport(env.DATABASE, env.WORKSPACES));
    return new Response(null, { status: 404 });
  },
};
