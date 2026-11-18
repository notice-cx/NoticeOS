import { createHash, randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import { openWorkspaceStore } from '../packages/postgres/src/store.mjs';
import { openWorkspaceServiceGrant } from '../packages/postgres/src/service-grant.mjs';
import { CUSTOMER_GOOGLE_ARCHIVE_PLAN_URL, customerJobStep, customerJobSubject, customerSchedules } from './customer-collection.mjs';
import { createHostedJobRunner } from './hosted-job-runner.mjs';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { scheduleFor, scheduleTimezone, schedulesRefusal, manualScheduledJob } from './scheduled-jobs.mjs';
import { REPORT_EFFECT_LIMIT_MS } from './local-customer-reports.mjs';
import { CUSTOMER_BACKUP_EFFECT_MS } from './customer-backup.mjs';

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const privateUrl = 'https://scheduler.internal/collect';
const POSTHOG_LIMIT_MS = 4 * MINUTE;
const GOOGLE_ARCHIVE_LIMIT_MS = 10 * MINUTE;
const BING_ARCHIVE_LIMIT_MS = 3 * MINUTE;

export async function readCustomerGoogleArchiveScope(worker, workspaceId) {
  const response = await worker.fetch(new Request(CUSTOMER_GOOGLE_ARCHIVE_PLAN_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId }),
    signal: AbortSignal.timeout(10_000),
  }));
  if (!response.ok) throw new Error('Google archive targets unavailable.');
  const targets = await response.json();
  if (!Array.isArray(targets) || !targets.every(target => target && typeof target.asset === 'string'
    && (target.provider === 'ga4' || target.provider === 'gsc'))) throw new Error('Google archive targets unavailable.');
  return targets;
}

function next(schedule, after) {
  return new Cron(schedule.cron, { timezone: scheduleTimezone(schedule), paused: true })
    .nextRun(new Date(after))?.getTime() ?? Infinity;
}

/** One clock for the deployment. The hourly discovery reads active bindings in
 * pairs. Between discovery windows only due work touches the store. */
export function customerScheduleClock({ workspaces, read, run, now = Date.now, resumeSince, backupResumeSince,
  warn = () => console.warn('Customer collection could not finish. See workflow history.') }) {
  const entries = workspaces.map(binding => ({ binding, jobs: [], planned: false, queued: new Map(),
    running: false, discovery: -Infinity, retryDelay: MINUTE, initial: true }));
  const running = new Set();
  let pending, stopped = false, turn = 0;
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
        if (candidate.planned && !candidate.running && candidate.queued.size) { entry = candidate; break; }
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
    const dueDiscovery = entries.filter(entry => at >= entry.discovery);
    if (dueDiscovery.length) {
      // Pause admissions until each enabled target and service grant has been checked again.
      for (const entry of dueDiscovery) entry.planned = false;
      await inPairs(dueDiscovery, async entry => {
        const previous = entry.jobs;
        entry.discovery = at + entry.retryDelay;
        entry.retryDelay = Math.min(15 * MINUTE, entry.retryDelay * 2);
        const result = await read(entry.binding);
        const { jobs: selected, googleScopePending = false } = Array.isArray(result) ? { jobs: result } : result;
        const recoveringGoogleSince = googleScopePending ? undefined : entry.googleScopeUnavailableSince;
        if (googleScopePending) {
          entry.googleScopeUnavailableSince ??= entry.initial && Number.isFinite(resumeSince) ? Math.min(at, resumeSince) : at;
        } else entry.googleScopeUnavailableSince = undefined;
        for (const [key, call] of entry.queued) {
          if (!selected.some(item => item.schedule.enabled && item.job === call.job && (call.archive
            ? item.archives?.some(target => customerJobSubject(target.asset, target.archive) === customerJobSubject(call.asset, call.archive))
            : item.assets.includes(call.asset)))) entry.queued.delete(key);
        }
        entry.jobs = selected.map(item => {
          if (!item.schedule.enabled) return { ...item, due: Infinity };
          const old = previous.find(j => j.job === item.job);
          const matching = old?.schedule.enabled && old.schedule.cron === item.schedule.cron
            && scheduleTimezone(old.schedule) === scheduleTimezone(item.schedule);
          let due = matching ? old.due : next(item.schedule, at - 1);
          const recoverGoogle = item.job === 'signal-dumps' && (!old || matching) ? recoveringGoogleSince : undefined;
          const restartSince = item.job === 'backup' ? backupResumeSince : ['counters', 'signal-dumps'].includes(item.job) ? resumeSince : undefined;
          const since = recoverGoogle ?? (entry.initial ? restartSince : undefined);
          const resuming = Number.isFinite(since);
          if (resuming || entry.initial && item.job === 'panel-refresh') {
            const cron = new Cron(item.schedule.cron, { timezone: scheduleTimezone(item.schedule), paused: true });
            const previous = cron.previousRuns(1, new Date(at + 1000))[0]?.getTime();
            const earliest = resuming ? Math.max(since, at - 24 * HOUR) : at - 24 * HOUR;
            if (previous >= earliest) due = previous;
          }
          return { ...item, due };
        });
        entry.planned = true;
        entry.initial = false;
        if (!googleScopePending) {
          entry.retryDelay = MINUTE;
          entry.discovery = Math.floor(at / HOUR) * HOUR + HOUR;
        }
      });
    }
    for (const { binding, jobs, queued, planned } of entries) {
      if (!planned) continue;
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

async function readBackupSchedule(store) {
  const rows = await store.read(tx => tx.query(`SELECT COALESCE(body->'schedules','{}'::json)::text AS overrides
    FROM noticeos.config_documents WHERE document_key='constants'`));
  const overrides = JSON.parse(rows[0]?.overrides ?? '{}');
  if (schedulesRefusal(overrides)) throw new Error('Invalid saved backup schedule.');
  return scheduleFor(manualScheduledJob('backup'), overrides);
}

export async function startLocalCustomerSchedules({ workspaces, connectionString, grantConnectionString, worker, reports, now = Date.now,
  resumeSince, backupResumeSince, collection, backup }) {
  const ids = new Set();
  for (const binding of workspaces) {
    if (!binding.workspaceId || !binding.serviceId || ids.has(binding.workspaceId)) throw new Error('Invalid customer schedule binding.');
    ids.add(binding.workspaceId);
  }
  const resources = ({ workspaceId, serviceId }) => ({
    store: openWorkspaceStore(connectionString, { workspaceId, maxConnections: 1 }),
    grant: openWorkspaceServiceGrant({ connectionString: grantConnectionString, workspaceId, principalId: serviceId }),
  });
  const googleScopes = new Map();
  const active = new Set();
  const clock = customerScheduleClock({ workspaces, now, resumeSince, backupResumeSince,
    async read(binding) {
      const { store, grant } = resources(binding);
      try {
        const admission = createWorkspaceAdmission({ kind: 'service', profile: Symbol('customer schedule'),
          authority: () => grant.facts() });
        return await admission.withAdmission('workflows.run', { requestedWorkspaceId: binding.workspaceId, correlationId: randomUUID() },
          new Request(privateUrl, { method: 'POST' }), async () => {
            let googleScope, googleScopePending = false;
            if (collection?.extendedArchives && collection.googleDaily) {
              try {
                googleScope = await readCustomerGoogleArchiveScope(worker, binding.workspaceId);
                googleScopes.set(binding.workspaceId, googleScope);
              } catch {
                console.warn('Saved Google archive targets could not be read.');
                googleScope = googleScopes.get(binding.workspaceId) ?? [];
                googleScopePending = true;
              }
            }
            const scheduled = await customerSchedules(store, null, collection, googleScope);
            if (backup) {
              scheduled.push({ job: 'backup', schedule: await readBackupSchedule(store), assets: [null] });
            }
            if (reports) {
              try { scheduled.push(...await reports.targets(store)); }
              catch { console.warn('Customer report settings could not be read. Check the report configuration.'); }
            }
            return { jobs: scheduled, googleScopePending };
          });
      } finally { await Promise.all([store.close(), grant.close()]); }
    },
    run,
  });
  async function run({ binding, job, asset, archive, scheduledAt, manual }) {
    const occurrence = manual ? `manual/${randomUUID()}`
      : scheduledAt + '/' + (asset === null ? 'workspace' : createHash('sha256').update(customerJobSubject(asset, archive)).digest('hex'));
    const scoped = resources(binding);
    const reporting = job === 'panel-refresh';
    const snapshot = job === 'backup';
    let backupResult;
    const definitions = [{ key: job, version: 'customer-v1', parseInput: value => value, diagnostics: false,
      steps: [{ key: snapshot ? 'backup' : reporting ? 'report' : customerJobStep(job), kind: 'effect', action: 'workflows.run',
        ...(reporting ? {} : { terminalReportedFailure: true }), async run({ context, signal }) {
        if (snapshot) {
          if (!manual && !(await readBackupSchedule(scoped.store)).enabled) return { outcome: 'skipped' };
          backupResult = await backup.run(signal);
          if (backupResult.unconfirmed) throw new Error('The backup worker did not confirm completion.');
          return backupResult;
        }
        if (reporting) return await reports.run({ store: scoped.store, workspaceId: context.workspaceId, asset, scheduledAt, signal })
          ?? { state: 'skipped', summary: 'No eligible reports were archived.' };
        const response = await worker.fetch(new Request(privateUrl, { method: 'POST', signal,
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: binding.workspaceId, job, asset, archive, occurrence }) }));
        if (!response.ok) throw new Error('Customer collection was refused.');
        return response.json();
      } }] }];
    const runner = createHostedJobRunner({ ...binding, ...scoped, definitions,
      effectTimeoutMs: snapshot ? CUSTOMER_BACKUP_EFFECT_MS : reporting ? REPORT_EFFECT_LIMIT_MS
        : job === 'posthog' ? POSTHOG_LIMIT_MS
        : archive?.provider === 'bing-webmaster' ? BING_ARCHIVE_LIMIT_MS
        : collection?.extendedArchives && archive ? GOOGLE_ARCHIVE_LIMIT_MS : 90_000 });
    active.add(runner);
    try {
      const receipt = await runner.run(job, occurrence, { asset, scheduledAt, ...(archive ? { archive } : {}) });
      if (manual) {
        if (receipt.state === 'succeeded' && backupResult?.ok || receipt.state === 'exhausted' && backupResult?.ok === false) return backupResult;
        if (receipt.state === 'uncertain' && backupResult?.unconfirmed) return { ok: false, stage: backupResult.stage, cause: backupResult.cause };
        return { ok: false, stage: 'preparation', cause: 'stage_failed' };
      }
      if (!['busy', 'succeeded'].includes(receipt.state)) throw new Error('Customer scheduled job did not complete.');
    } finally { active.delete(runner); await runner.close(); }
  }
  await clock.tick();
  const timer = setInterval(() => { void clock.tick().catch(() => console.warn('Customer schedule unavailable.')); }, MINUTE);
  timer.unref();
  return { status: clock.status, whenIdle: clock.whenIdle,
    manualBackup: backup && workspaces.length === 1 ? () => run({ binding: workspaces[0], job: 'backup',
      asset: null, scheduledAt: new Date(now()).toISOString(), manual: true }) : undefined,
    async close() {
      clearInterval(timer);
      await Promise.all([clock.close(), ...Array.from(active, runner => runner.close())]);
    } };
}
