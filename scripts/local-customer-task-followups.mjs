import path from 'node:path';
import { Cron } from 'croner';
import { scheduleTimezone } from './scheduled-jobs.mjs';
import { loadCustomerWorkflowModule } from './local-customer-workflow-module.mjs';
import { customerSchedules } from './customer-collection.mjs';
import { runPanelReviewFiler, readPublishedFreshness, readPublishedVersion, panelPublicationGap } from './runner/panel-review.mjs';
import { runWatchReadbackFiler } from './runner/watch-readbacks.mjs';

export const isCustomerTaskFiler = job => job === 'panel-review' || job === 'watch-readbacks';

function scopedTaskService(connection, callNtasks, fetchImpl, authorize) {
  const projectFor = id => {
    const project = connection.catalog.find(entry => entry.projectId === id);
    if (!project || !connection.selectedIds.has(id)) throw new Error('Task project unavailable.');
    return project;
  };
  async function call({ method, path, body, idempotencyKey, onBehalfOf }) {
    const url = new URL(path, connection.origin);
    const project = projectFor(method === 'GET' ? url.searchParams.get('project') : body?.projectId);
    const task = /^\/api\/tasks\/([a-z0-9]+-[a-z0-9]+(?:\.[0-9]+)*)(\/comments)?$/u.exec(url.pathname);
    const read = method === 'GET' && !task?.[2] && (url.pathname === '/api/tasks' || task);
    const write = method === 'POST' && (url.pathname === '/api/tasks' || task?.[2] === '/comments');
    if ((!read && !write) || url.origin !== connection.origin || task && !task[1].startsWith(project.prefix + '-')
      || write && (!connection.writableProjectIds.has(project.projectId) || !idempotencyKey)) throw new Error('Task operation unavailable.');
    await authorize();
    if (!await connection.stillCurrent()) throw new Error('Task connection changed.');
    return callNtasks(connection.credential.fields, { method, path, workspaceId: connection.workspaceId,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), idempotencyKey, onBehalfOf }, fetchImpl);
  }
  return { backend: () => 'ntasks', projects: () => connection.catalog, call,
    async tool(name, args, actor) {
      const project = projectFor(args.project);
      if (name !== 'link_tasks' || !connection.writableProjectIds.has(project.projectId)
        || ![args.task, args.to].every(id => typeof id === 'string' && id.startsWith(project.prefix + '-'))
        || args.type !== 'related' || args.remove) throw new Error('Task relation unavailable.');
      await authorize();
      if (!await connection.stillCurrent()) throw new Error('Task connection changed.');
      const reply = await callNtasks(connection.credential.fields, { method: 'POST', path: '/api/mcp',
        workspaceId: connection.workspaceId, onBehalfOf: actor, body: JSON.stringify({ jsonrpc: '2.0', id: 1,
          method: 'tools/call', params: { name, arguments: { workspace: connection.workspaceId, project: project.projectId,
            task: args.task, to: args.to, type: 'related' } } }) }, fetchImpl);
      if (reply.status !== 200 || !reply.body?.result || reply.body.result.isError) throw new Error('Task relation unavailable.');
    },
  };
}

export function localCustomerTaskFollowups({ sourceRoot, root, credentialsKey, ntasksOrigin, transport = fetch }) {
  let tools;
  return async ({ job, binding, store, signal, grant, collection, scheduledAt }) => {
    const { workspaceId, serviceId } = binding;
    if (!isCustomerTaskFiler(job) || !collection?.taskFollowups?.some(item => item.workspaceId === workspaceId && item.serviceId === serviceId)
      || await store.workspaceId() !== workspaceId || !ntasksOrigin) throw new Error('Task follow-up unavailable.');
    async function authorize() {
      signal.throwIfAborted();
      const facts = await grant.facts();
      if (facts?.workspaceId !== workspaceId || facts.principalId !== serviceId || facts.workspaceStatus !== 'active'
        || !(Date.parse(facts.expiresAt) > Date.now()) || !facts.actions.includes('tasks.write') || !facts.actions.includes('workflows.run')) {
        throw new Error('Task follow-up grant unavailable.');
      }
    }
    await authorize();
    const selected = (await customerSchedules(store, null, collection)).find(item => item.job === job);
    if (!selected?.schedule.enabled) return { outcome: 'skipped' };
    const cron = new Cron(selected.schedule.cron, { timezone: scheduleTimezone(selected.schedule), paused: true });
    if (!cron.match(new Date(scheduledAt))) return { outcome: 'skipped' };
    const api = await (tools ??= loadCustomerWorkflowModule(sourceRoot, root, `
      export { readHostedTaskConnection } from './routes/hosted-task-service.ts';
      export { callNtasks } from './ntasks.ts';
      export { readSerpPanelLandings } from './serp-panel-landings.ts';
      export { workspaceWatchReadbacks } from './routes/watch-readbacks.ts';
    `).catch(error => { tools = undefined; throw error; }));
    const env = { STORE: store, CREDENTIALS_KEY: credentialsKey, NOTICEOS_WORKSPACE_PROFILE: 'hosted', NOTICEOS_NTASKS_ORIGIN: ntasksOrigin };
    const nowMs = Date.parse(scheduledAt);
    const landings = job === 'panel-review' ? await api.readSerpPanelLandings(env, nowMs) : null;
    const publications = new Map();
    if (landings) {
      const reports = path.join(root, workspaceId, 'reports');
      for (const landing of landings.landings) {
        const version = await readPublishedVersion(landing.asset, reports);
        if (!version) continue;
        const freshness = await readPublishedFreshness(landing.asset, version, reports);
        if (!panelPublicationGap(freshness, landing)) publications.set(landing.asset, { version, freshness });
      }
      if (!publications.size) return { outcome: 'skipped' };
    }
    let connection, taskService;
    const fetchImpl = (input, init) => {
      if (new URL(input).origin !== ntasksOrigin) throw new Error('Task service address unavailable.');
      return transport(input, { ...init, redirect: 'manual', signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal });
    };
    async function connected() {
      if (connection) return taskService;
      await authorize();
      connection = await api.readHostedTaskConnection(env, fetchImpl);
      if (!connection?.writable) throw new Error('Task write access unavailable.');
      return taskService = scopedTaskService(connection, api.callNtasks, fetchImpl, authorize);
    }
    // Both filers check backend before reading the map. An empty readback queue needs no Ntasks call.
    const service = { backend: async () => (await connected()).backend(), projects: async () => (await connected()).projects(),
      call: async request => (await connected()).call(request), tool: async (...args) => (await connected()).tool(...args) };
    let failed = false;
    const deps = { taskService: service, emit: level => { if (level === 'ERROR' || job === 'watch-readbacks' && level === 'WARN') failed = true; },
      readConfig: async () => { await connected(); return JSON.stringify({ spokes: connection.projects.map(({ asset, prefix }) => ({ asset, prefix })) }); } };
    let result;
    if (landings) {
      result = await runPanelReviewFiler({ running: true, ready: true }, { ...deps,
        readLandings: () => ({ ...landings, landings: landings.landings.filter(row => publications.has(row.asset)) }),
        stopped: () => signal.aborted, osCheckout: null, state: { skipping: null, unmapped: new Set(), waiting: new Set() },
        readPublished: async asset => publications.get(asset).freshness, readVersion: async asset => publications.get(asset).version });
    } else {
      result = await runWatchReadbackFiler({ ...deps, queueRequest: async request => {
        await authorize();
        return api.workspaceWatchReadbacks(request, env, Date.now());
      } });
    }
    if (failed || result?.failed?.length) throw new Error('Task follow-up could not finish.');
    return { outcome: 'ran', filed: result?.filed?.length ?? 0, posted: result?.posted?.length ?? 0 };
  };
}
