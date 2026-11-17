import { createHash, randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import { openWorkspaceStore } from '../packages/postgres/src/store.mjs';
import { openWorkspaceServiceGrant } from '../packages/postgres/src/service-grant.mjs';
import { customerJobSubject, customerSchedules } from './customer-collection.mjs';
import { createHostedJobRunner } from './hosted-job-runner.mjs';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { scheduleTimezone } from './scheduled-jobs.mjs';
import { REPORT_EFFECT_LIMIT_MS } from './local-customer-reports.mjs';

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const privateUrl = 'https://scheduler.internal/collect';

function next(schedule, after) {
  return new Cron(schedule.cron, { timezone: scheduleTimezone(schedule), paused: true })
    .nextRun(new Date(after))?.getTime() ?? Infinity;
}

/** One clock for the deployment. The hourly discovery reads active bindings in
 * pairs. Between discovery windows only due work touches the store. */
export function customerScheduleClock({ workspaces, read, run, now = Date.now,
  warn = () => console.warn('Customer collection could not finish. See workflow history.') }) {
  const entries = workspaces.map(binding => ({ binding, jobs: [], planned: false, queued: new Map(), running: false }));
  const running = new Set();
  let discovery = -Infinity, pending, stopped = false, turn = 0;
  const inPairs = async (items, apply) => {
    for (let index = 0; index < items.length && !stopped; index += 2) {
      await Promise.all(items.slice(index, index + 2).map(async item => {
        try { await apply(item); } catch { warn(); }
      }));
    }
  };
  function launch() {
    while (!stopped && running.size < 2) {
      let entry;
      for (let tried = 0; tried < entries.length; tried++) {
        const candidate = entries[turn];
        turn = (turn + 1) % entries.length;
        if (!candidate.running && candidate.queued.size) { entry = candidate; break; }
      }
      if (!entry) return;
      const [key, call] = entry.queued.entries().next().value;
      entry.queued.delete(key);
      entry.running = true;
      const work = Promise.resolve().then(() => stopped ? undefined : run(call)).catch(warn).finally(() => {
        running.delete(work); entry.running = false; launch();
      });
      running.add(work);
    }
  }
  async function whenIdle() {
    await pending;
    while (running.size) await Promise.all(running);
  }
  async function dispatch() {
    const at = Math.floor(now() / MINUTE) * MINUTE;
    if (at >= discovery) {
      discovery = Math.floor(at / HOUR) * HOUR + HOUR;
      await inPairs(entries, async entry => {
        const previous = entry.jobs;
        entry.jobs = [];
        entry.planned = false;
        let selected;
        try { selected = await read(entry.binding); } catch (error) { entry.queued.clear(); throw error; }
        for (const [key, call] of entry.queued) {
          if (!selected.some(item => item.job === call.job && (call.archive
            ? item.archives?.some(target => customerJobSubject(target.asset, target.archive) === customerJobSubject(call.asset, call.archive))
            : item.assets.includes(call.asset)))) entry.queued.delete(key);
        }
        entry.jobs = selected.map(item => {
          const old = previous.find(j => j.job === item.job && j.schedule.cron === item.schedule.cron
            && scheduleTimezone(j.schedule) === scheduleTimezone(item.schedule));
          let due = old?.due ?? next(item.schedule, at - 1);
          if (!old && item.job === 'panel-refresh') {
            const cron = new Cron(item.schedule.cron, { timezone: scheduleTimezone(item.schedule), paused: true });
            const previous = cron.previousRuns(1, new Date(at + 1000))[0]?.getTime();
            if (previous >= at - 24 * HOUR) due = previous;
          }
          return { ...item, due };
        });
        entry.planned = true;
      });
    }
    for (const { binding, jobs, queued } of entries) {
      for (const item of jobs) {
        if (item.due > at) continue;
        // Resume at most the most recent occurrence after a delayed tick.
        const cron = new Cron(item.schedule.cron, { timezone: scheduleTimezone(item.schedule), paused: true });
        const due = cron.previousRuns(1, new Date(at + 1000))[0]?.getTime() ?? item.due;
        item.due = next(item.schedule, at);
        for (const target of item.archives ?? item.assets.map(asset => ({ asset }))) {
          // At most one waiting occurrence per scheduled subject if a tenant is behind.
          const subject = target.asset === null ? null : customerJobSubject(target.asset, target.archive);
          queued.set(JSON.stringify([item.job, subject]), { binding, job: item.job, ...target, scheduledAt: new Date(due).toISOString() });
        }
      }
    }
    launch();
  }
  return {
    status(workspaceId) {
      const entry = entries.find(item => item.binding.workspaceId === workspaceId);
      if (stopped || !entry) return null;
      return { onlyListedJobs: true, hostLanes: false, registeredJobs: entry.jobs.map(item => item.job),
        updatedAt: new Date(now()).toISOString(), error: entry.planned ? null : 'waiting', overrides: null,
        jobs: entry.jobs.map(({ job, schedule, due }) => ({ id: job, ...schedule,
          nextRun: Number.isFinite(due) ? new Date(due).toISOString() : null })) };
    },
    tick() {
      if (stopped) return Promise.resolve();
      if (!pending) pending = dispatch().finally(() => { pending = undefined; });
      return pending;
    },
    whenIdle,
    async close() { stopped = true; await whenIdle(); },
  };
}

export async function startLocalCustomerSchedules({ workspaces, connectionString, grantConnectionString, worker, reports, now = Date.now }) {
  const ids = new Set();
  for (const binding of workspaces) {
    if (!binding.workspaceId || !binding.serviceId || ids.has(binding.workspaceId)) throw new Error('Invalid customer schedule binding.');
    ids.add(binding.workspaceId);
  }
  const resources = ({ workspaceId, serviceId }) => ({
    store: openWorkspaceStore(connectionString, { workspaceId, maxConnections: 1 }),
    grant: openWorkspaceServiceGrant({ connectionString: grantConnectionString, workspaceId, principalId: serviceId }),
  });
  const active = new Set();
  const clock = customerScheduleClock({ workspaces, now,
    async read(binding) {
      const { store, grant } = resources(binding);
      try {
        const admission = createWorkspaceAdmission({ kind: 'service', profile: Symbol('customer schedule'),
          authority: () => grant.facts() });
        return await admission.withAdmission('workflows.run', { requestedWorkspaceId: binding.workspaceId, correlationId: randomUUID() },
          new Request(privateUrl, { method: 'POST' }), async () => [
            ...await customerSchedules(store), ...(await reports?.targets(store) ?? []),
          ]);
      } finally { await Promise.all([store.close(), grant.close()]); }
    },
    async run({ binding, job, asset, archive, scheduledAt }) {
      const occurrence = scheduledAt + '/' + (asset === null ? 'workspace' : createHash('sha256').update(customerJobSubject(asset, archive)).digest('hex'));
      const scoped = resources(binding);
      const reporting = job === 'panel-refresh';
      const definitions = [{ key: job, version: 'customer-v1', parseInput: value => value, diagnostics: false,
        steps: [{ key: reporting ? 'report' : 'collect', kind: 'effect', action: 'workflows.run',
          ...(reporting ? {} : { terminalReportedFailure: true }), async run({ context, signal }) {
          if (reporting) return await reports.run({ store: scoped.store, workspaceId: context.workspaceId, asset, scheduledAt, signal })
            ?? { state: 'skipped', summary: 'No eligible reports were archived.' };
          const response = await worker.fetch(new Request(privateUrl, { method: 'POST', signal,
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: binding.workspaceId, job, asset, archive, occurrence }) }));
          if (!response.ok) throw new Error('Customer collection was refused.');
          return response.json();
        } }] }];
      const runner = createHostedJobRunner({ ...binding, ...scoped, definitions, effectTimeoutMs: reporting ? REPORT_EFFECT_LIMIT_MS : 90_000 });
      active.add(runner);
      try {
        const receipt = await runner.run(job, occurrence, { asset, scheduledAt, ...(archive ? { archive } : {}) });
        if (!['busy', 'succeeded'].includes(receipt.state)) throw new Error('Customer collection did not complete.');
      } finally { active.delete(runner); await runner.close(); }
    },
  });
  await clock.tick();
  const timer = setInterval(() => { void clock.tick().catch(() => console.warn('Customer schedule unavailable.')); }, MINUTE);
  timer.unref();
  return { status: clock.status, whenIdle: clock.whenIdle, async close() {
    clearInterval(timer);
    await Promise.all([clock.close(), ...Array.from(active, runner => runner.close())]);
  } };
}
