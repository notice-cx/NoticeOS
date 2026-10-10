// Stable job identities are separate from their editable local run times.
//
// Authored TypeScript: `pnpm config:generate` writes the
// `.mjs` the Tower, the Workers' config pipeline and the local runner import,
// and the `.d.mts` beside it.

// A job is named by its label; its row's state, last run and next run say the
// rest. `source` names the provider only where the label
// does not: a chip beside the label, never a sentence. `keywords` are extra
// search terms and are never shown.
export interface ScheduledJob {
  id: string; surface: 'workflow' | 'system'; label: string; group: string; cron: string;
  source?: string; keywords?: string[]; local?: boolean;
  /** How System health's operations footer names this job's work, for a local
   * job an installation runs only once it is set up. */
  footer?: string;
  /** Steps of this job an operator can run now for chosen sites. */
  collectNow?: CollectNowStep[];
  /**
   * The integration connections whose Manage panel changes this collection's
   * schedule. A job several connections feed lists each, and its one schedule
   * shows in each panel under the job's own label. A collection with none
   * (nightly reports, live counters, local research) is changed in Settings →
   * Data collection.
   */
  connections?: string[];
}
/**
 * One step of a scheduled job, run now for chosen sites.
 *
 * The connect panel's Start collecting runs a provider's first collection at
 * once instead of at the job's next tick. It is not a second collector: the
 * ingest's dispatch (workers/ingest/src/dispatch.ts `runCollectNow`) runs this
 * same job step, on the same stored config, through the lane's own egress
 * gate, lease and budget gate, and refuses while the job is paused. `step` is
 * the dispatch's own step id for that lane (its workflow trace names it), and
 * `metered` marks a step that spends money, which the panel previews first.
 * A provider appears on at most one job.
 */
export interface CollectNowStep { provider: string; step: string; metered?: boolean }
export interface JobSchedule { enabled: boolean; cron: string; timezone?: string }
export type ScheduleOverrides = Record<string, JobSchedule>;
/**
 * Why the runner's last read of the saved schedules failed, as a state the
 * Tower renders rather than a sentence it would have to print: `held` — the
 * schedules armed before stay in effect and new changes
 * wait; `waiting` — nothing was ever armed, so every job waits for the settings
 * service. A status file written before the codes carries a sentence here; a
 * reader treats any other non-null value as `held`, which is what it meant.
 */
export type ScheduleReadFailure = 'held' | 'waiting';
export const SCHEDULES_HELD: ScheduleReadFailure = 'held';
export const SCHEDULES_WAITING: ScheduleReadFailure = 'waiting';
export interface ScheduleStatus {
  updatedAt: string; sessionId?: string; error: ScheduleReadFailure | string | null;
  jobs: { id: string; enabled: boolean; cron: string; timezone?: string; nextRun: string | null }[];
  /**
   * Whether this installation runs the host's own lanes (the jobs marked
   * `local`). An installation `pnpm start` runs does not: it runs only the
   * `local` jobs it lists in `jobs`, each once set up, and the Tower lists
   * those beside the ingest's. Absent: it runs them all.
   */
  hostLanes?: boolean;
  /** Hosted composition executes only the jobs its deployment registered. */
  onlyListedJobs?: boolean;
  /** Deployment registry, available even before the first settings read. */
  registeredJobs?: readonly string[];
}
export const SCHEDULES_FILE = 'config/constants.json';
export const SCHEDULES_POINTER = '/schedules';
export const SCHEDULE_STATUS_FILE: string = '.local/scheduled-jobs.json';

export const WORKFLOW_GROUPS: { label: string }[] = [
  { label: 'Business signals' },
  { label: 'Site health' },
  { label: 'Notifications' },
  { label: 'Outcomes' },
  { label: 'Tasks' },
  { label: 'System maintenance' },
];

export const SCHEDULED_JOBS: ScheduledJob[] = [
  { id: 'mediavine', surface: 'system', label: 'Ad revenue', group: 'Business signals', cron: '10,30,50 * * * *', source: 'Mediavine',
    collectNow: [{ provider: 'mediavine', step: 'revenue' }], connections: ['mediavine'] },
  { id: 'freshness', surface: 'system', label: 'Data freshness checks', group: 'Site health', cron: '0 * * * *', keywords: ['missing reports', 'late reports', 'uptime', 'site down', 'connection counts', 'source history'] },
  { id: 'notifications', surface: 'workflow', label: 'Operator notifications', group: 'Notifications', cron: '5 * * * *' },
  { id: 'pull', surface: 'system', label: 'Nightly reports', group: 'Business signals', cron: '30 2 * * *',
    collectNow: [{ provider: 'bing-webmaster', step: 'bing' }] },
  { id: 'asset-zero', surface: 'system', label: 'NoticeOS report', group: 'System maintenance', cron: '0 3 * * *' },
  { id: 'watch-windows', surface: 'workflow', label: 'Outcome checks', group: 'Outcomes', cron: '30 3 * * *' },
  { id: 'hygiene', surface: 'system', label: 'Search accessibility checks', group: 'Site health', cron: '0 4 * * *', keywords: ['robots', 'sitemap', 'indexing', 'page structure'] },
  { id: 'clarity', surface: 'system', label: 'Clarity recordings summary', group: 'Business signals', cron: '30 4 * * *',
    collectNow: [{ provider: 'clarity', step: 'clarity' }], connections: ['clarity'] },
  { id: 'signal-dumps', surface: 'system', label: 'Traffic and search archives', group: 'Business signals', cron: '15 12 * * *', source: 'Google Analytics · Search Console · Bing',
    connections: ['google', 'bing-webmaster'] },
  { id: 'posthog', surface: 'system', label: 'Product analytics archives', group: 'Business signals', cron: '30 12 * * *', source: 'PostHog',
    collectNow: [{ provider: 'posthog', step: 'product' }], connections: ['posthog'] },
  { id: 'dataforseo', surface: 'system', label: 'Search rankings and backlinks', group: 'Business signals', cron: '45 12 * * 1', source: 'DataForSEO',
    collectNow: [{ provider: 'dataforseo', step: 'search', metered: true }], connections: ['dataforseo'] },
  { id: 'counters', surface: 'system', label: 'Live traffic and counters', group: 'Business signals', cron: '*/15 * * * *',
    collectNow: [{ provider: 'google', step: 'google' }] },
  { id: 'beads-hub', surface: 'system', label: 'Task service health', group: 'System maintenance', cron: '*/15 * * * *', local: true },
  { id: 'beads-snapshot', surface: 'system', label: 'Task board refresh', group: 'System maintenance', cron: '* * * * *', local: true, footer: 'task-board refreshes' },
  { id: 'panel-review', surface: 'workflow', label: 'Search review tasks', group: 'Tasks', cron: '25 * * * *', local: true },
  { id: 'push-state', surface: 'workflow', label: 'Unpublished commit checks', group: 'Tasks', cron: '40 * * * *', keywords: ['task gates'], local: true },
  { id: 'watch-readbacks', surface: 'workflow', label: 'Outcome task updates', group: 'Outcomes', cron: '50 * * * *', local: true },
  { id: 'task-map', surface: 'system', label: 'Task project checks', group: 'System maintenance', cron: '5 * * * *', local: true },
  { id: 'panel-refresh', surface: 'system', label: 'Local research summaries', group: 'Business signals', cron: '10 13 * * *', local: true },
  { id: 'backup', surface: 'system', label: 'Backups', group: 'System maintenance', cron: '0 4 * * *', keywords: ['central store', 'task hub'], local: true, footer: 'backups' },
];

/**
 * The job one scheduled fire names. A job the ingest runs
 * (not `local`) is fired by its `cron`, the dispatch key: the runner fires that
 * key whatever time the operator saved, and the deployed Worker's triggers are
 * these keys (workers/ingest/wrangler.jsonc, pinned by
 * workers/ingest/test/crons.test.ts). Null for any other expression, which the
 * dispatch refuses as `unknown_cron` rather than guess at.
 */
export function ingestJobForCron(cron: string): ScheduledJob | null {
  return SCHEDULED_JOBS.find((job) => !job.local && job.cron === cron) ?? null;
}

/** The job step that collects `provider` now, or null when none does. */
export function collectNowStep(provider: string): { job: ScheduledJob; step: CollectNowStep } | null {
  for (const job of SCHEDULED_JOBS) {
    const step = job.collectNow?.find((entry) => entry.provider === provider);
    if (step) return { job, step };
  }
  return null;
}

export function scheduleFor(job: ScheduledJob, overrides: ScheduleOverrides = {}): JobSchedule {
  return overrides[job.id] ?? { enabled: true, cron: job.cron };
}

export function scheduleTimezone(schedule: Pick<JobSchedule, 'timezone'>): string { return schedule.timezone ?? 'UTC'; }

// Support the minute/hour/weekday schedules the editor offers, including the
// existing comma-separated retry tick. No seconds, calendar dates or commands.
export function scheduleCronRefusal(cron: unknown): string | null {
  if (typeof cron !== 'string' || cron.length > 100) return 'Choose a valid schedule.';
  const fields = cron.split(' ');
  if (fields.length !== 5 || fields[2] !== '*' || fields[3] !== '*') return 'Use a recurring minute, hourly, daily or weekly schedule.';
  for (const [index, max] of [[0, 59], [1, 23], [4, 6]] as const) {
    const field = fields[index]!;
    if (field === '*') continue;
    if (index === 0 && /^\*\/(1|2|3|4|5|6|10|12|15|20|30)$/.test(field)) continue;
    if (!/^\d{1,2}(,\d{1,2})*$/.test(field) || field.split(',').some((n) => Number(n) > max)) {
      return 'Choose a valid minute, time and weekday.';
    }
  }
  return null;
}

/**
 * The longest wait between two runs of a schedule the editor offers, in
 * minutes: what a surface ages a job's newest reading against. Every
 * minute of one week is tried, so a list reads as its widest gap —
 * `10,30,50 * * * *` waits 20 minutes, a daily run 1440, a weekly one 10080.
 * Null for an expression the editor does not offer.
 */
export function cronIntervalMinutes(cron: string): number | null {
  if (scheduleCronRefusal(cron) !== null) return null;
  const [minute, hour, , , weekday] = cron.split(' ') as [string, string, string, string, string];
  const matches = (field: string, value: number) =>
    field === '*' || (field.startsWith('*/') ? value % Number(field.slice(2)) === 0 : field.split(',').map(Number).includes(value));
  const week = 7 * 24 * 60;
  const runs: number[] = [];
  for (let at = 0; at < week; at += 1) {
    if (matches(minute, at % 60) && matches(hour, Math.floor(at / 60) % 24) && matches(weekday, Math.floor(at / 1440))) runs.push(at);
  }
  if (runs.length === 0) return null;
  let longest = runs[0]! + week - runs.at(-1)!;
  for (let i = 1; i < runs.length; i += 1) longest = Math.max(longest, runs[i]! - runs[i - 1]!);
  return longest;
}

export function schedulesRefusal(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'Schedules must be a job configuration.';
  for (const [id, schedule] of Object.entries(value)) {
    if (!SCHEDULED_JOBS.some((job) => job.id === id)) return `Unknown scheduled job: ${id}`;
    if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule) ||
      Object.keys(schedule).some((key) => !['enabled', 'cron', 'timezone'].includes(key)) ||
      typeof schedule.enabled !== 'boolean') return `Invalid schedule for ${id}.`;
    if (schedule.timezone !== undefined) {
      if (typeof schedule.timezone !== 'string' || schedule.timezone.length > 100) return 'Choose a valid timezone.';
      try { new Intl.DateTimeFormat('en', { timeZone: schedule.timezone }).format(); } catch { return 'Choose a valid timezone.'; }
    }
    const refusal = scheduleCronRefusal(schedule.cron);
    if (refusal) return refusal;
  }
  return null;
}

export function schedulesOpRefusal(op: { file?: string; pointer?: string; kind: string; value?: unknown }): string | null {
  if (op.file !== SCHEDULES_FILE) return null;
  if (op.pointer === '') return 'The settings document must be edited by field.';
  if (op.pointer !== SCHEDULES_POINTER && !op.pointer?.startsWith(`${SCHEDULES_POINTER}/`)) return null;
  if (op.pointer !== SCHEDULES_POINTER) return 'Save scheduled jobs together to validate their complete configuration.';
  return op.kind === 'file-json-delete' ? null : schedulesRefusal(op.value);
}

export function jobRunName(job: ScheduledJob): string {
  return job.local ? job.id : `cron ${job.cron}`;
}
