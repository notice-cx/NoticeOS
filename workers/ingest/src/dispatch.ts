// The cron dispatch table: which lanes one expression runs, and what config
// each runs on. Both the real `scheduled()` handler and the `runScheduled()`
// RPC the local runner reaches converge on one function, so the local
// rehearsal rehearses the deployed behaviour. The expressions it answers are
// the dispatch keys of the scheduled jobs (scripts/scheduled-jobs.mts); any
// other expression is refused as `unknown_cron`. One `readCollectorConfigs`
// per fire resolves every document the lanes need, store-first, and hands each
// lane its own; nothing below reads a file.

import { runBingSignals } from './bing-signals.js';
import { runClarityDumps } from './clarity-dumps.js';
import { runPosthogDumps } from './posthog-dumps.js';
import { runMediavine, syncMediavine } from './mediavine.js';
import type {
  CollectNowInput,
  CollectNowResult,
  CollectNowSite,
  IntegrationProviderId,
  ScheduledRunResult,
} from '@noticeos/contract';
import { OS_TIME_ZONE, savedOsTimeZone } from '@noticeos/contract';
import { type CountersConfig, runCountersScrape } from './counters.js';
import {
  type CollectorConfigs,
  type ConfigSourceMap,
  readCollectorConfigs,
} from './config-store.js';
import {
  type DataForSeoCollectScope,
  type SerpPanelConfig,
  dataForSeoCandidates,
  runDataForSeoDumps,
  runDataForSeoRecovery,
} from './dataforseo-dumps.js';
import { resolveCredential } from './credentials.js';
import { runAssetZeroPulse, runFreshnessCheck } from './db.js';
import { runGoogleSignals } from './google-signals.js';
import { runHygieneChecks, runUptimeChecks } from './hygiene.js';
import { type LaneRegister, laneDeclined } from './lane-mapping.js';
import { runNotifier } from './notifier.js';
import { type PullAssetConfig, runPullAdapter } from './pull.js';
import { type Ga4CustomDimensionConfig, runSignalDumps } from './signal-dumps.js';
import { runWatchWindows } from './watch-windows.js';
import { createWorkflowRecorder, settleWorkflowSteps, type WorkflowRecorder } from '../../../scripts/workflow-trace.mjs';
import { redactLogText } from '../../../scripts/os-log.mjs';
import { collectNowStep, ingestJobForCron, jobRunName } from '../../../scripts/scheduled-jobs.mjs';
import { recordManualRun, type JobRunOutcome } from './job-runs.js';

/**
 * One fire's config. Every field is `undefined` when the store holds nothing
 * usable for that file, which means keep the compiled copy. `sources` is the
 * word per file, and the only thing about config that reaches a log line.
 */
interface RunConfig {
  pullEntries: PullAssetConfig[] | undefined;
  counters: CountersConfig | undefined;
  laneRegister: LaneRegister | undefined;
  ga4CustomDimensions: Ga4CustomDimensionConfig | undefined;
  serpPanelConfig: SerpPanelConfig | undefined;
  /** The operator's saved clock: the stored `os_time_zone` when usable, else
   * the compiled copy, the same resolution the Tower runs. */
  osTimeZone: string;
  /** The operator paused the DataForSEO job. The daily outage re-collection
   * rides another job's tick, so it has to honour that pause itself. */
  dataForSeoPaused: boolean;
  /** The stored settings document, for the saved schedules a collect-now
   * press honours (`jobPaused`). */
  constants: unknown;
  configSources: ConfigSourceMap;
}

/** Is `job` saved as paused in the stored schedules? Anything unreadable is not
 * paused: the runner applies the same saved document, so an absent entry runs. */
function schedulePaused(constants: unknown, job: string): boolean {
  if (typeof constants !== 'object' || constants === null) return false;
  const schedules = (constants as { schedules?: unknown }).schedules;
  if (typeof schedules !== 'object' || schedules === null) return false;
  const entry = (schedules as Record<string, unknown>)[job];
  return typeof entry === 'object' && entry !== null && (entry as { enabled?: unknown }).enabled === false;
}

/** The cast happens once, against documents `readCollectorConfigs` has already
 * shape-checked. */
function runConfig({ documents, sources }: CollectorConfigs): RunConfig {
  return {
    pullEntries: documents['config/pull.json'] as PullAssetConfig[] | undefined,
    counters: documents['config/counters.json'] as CountersConfig | undefined,
    laneRegister: documents['config/integrations.json'] as LaneRegister | undefined,
    ga4CustomDimensions: documents['config/ga4-custom-dimensions.json'] as
      | Ga4CustomDimensionConfig
      | undefined,
    serpPanelConfig: documents['config/serp-panel.json'] as SerpPanelConfig | undefined,
    osTimeZone: savedOsTimeZone(documents['config/constants.json'], OS_TIME_ZONE),
    dataForSeoPaused: schedulePaused(documents['config/constants.json'], 'dataforseo'),
    constants: documents['config/constants.json'],
    configSources: sources,
  };
}

/**
 * The Bing and DataForSEO lanes as a job step runs them, one call each, used
 * by the cron and by `runCollectNow` so a collect-now press cannot drift from
 * the scheduled run. A collect-now only narrows it.
 */
export interface LaneNarrowing {
  fetchImpl?: typeof fetch;
  nowMs?: number;
}
function bingLane(env: IngestEnv, cfg: RunConfig, narrow: LaneNarrowing & { assets?: readonly string[] } = {}) {
  return runBingSignals(env, { laneRegister: cfg.laneRegister, configSources: cfg.configSources, ...narrow });
}
function searchLane(env: IngestEnv, cfg: RunConfig, narrow: LaneNarrowing & { scope?: DataForSeoCollectScope } = {}) {
  return runDataForSeoDumps(env, {
    laneRegister: cfg.laneRegister,
    serpPanelConfig: cfg.serpPanelConfig,
    configSources: cfg.configSources,
    ...narrow,
  });
}

/** One step of a scheduled job: a lane, on this fire's config. */
type Lane = (env: IngestEnv, cfg: RunConfig) => Promise<unknown>;

/** What one scheduled job runs. */
export interface JobLanes {
  /** Its steps, by the ids its workflow definition names. Steps of one job run
   * side by side, each isolated. */
  steps: Readonly<Record<string, Lane>>;
  /** The step whose own answer is the run's. */
  answeredBy?: string;
}

/**
 * What each scheduled job runs, keyed by its id in SCHEDULED_JOBS. The list of
 * jobs is that file's; test/crons.test.ts keeps the two naming the same jobs.
 */
export const JOB_LANES: Readonly<Record<string, JobLanes>> = {
  mediavine: { steps: { revenue: (env) => runMediavine(env) }, answeredBy: 'revenue' },
  // The hourly tick also asks whether each site is up. A site that hangs its
  // request must not stop the report-freshness alerts.
  freshness: { steps: { freshness: (env) => runFreshnessCheck(env), uptime: (env) => runUptimeChecks(env) } },
  notifications: { steps: { notify: (env) => runNotifier(env) } },
  pull: {
    steps: {
      pull: (env, cfg) => runPullAdapter(env, { entries: cfg.pullEntries, configSources: cfg.configSources }),
      bing: (env, cfg) => bingLane(env, cfg),
    },
  },
  'asset-zero': { steps: { report: (env) => runAssetZeroPulse(env) } },
  'watch-windows': { steps: { outcomes: (env) => runWatchWindows(env) } },
  hygiene: { steps: { hygiene: (env) => runHygieneChecks(env) } },
  clarity: { steps: { clarity: (env, cfg) => runClarityDumps(env, { laneRegister: cfg.laneRegister }) } },
  // The daily tick also re-collects the DataForSEO families an offline weekly
  // sweep skipped, 30 minutes clear of the sweep it shares a lane lock with.
  // A skipped step (null) when the operator paused DataForSEO.
  'signal-dumps': {
    steps: {
      archives: (env, cfg) =>
        runSignalDumps(env, {
          laneRegister: cfg.laneRegister,
          ga4CustomDimensions: cfg.ga4CustomDimensions,
          osTimeZone: cfg.osTimeZone,
          configSources: cfg.configSources,
        }),
      'search-recovery': (env, cfg) =>
        cfg.dataForSeoPaused
          ? Promise.resolve(null)
          : runDataForSeoRecovery(env, {
              laneRegister: cfg.laneRegister,
              serpPanelConfig: cfg.serpPanelConfig,
              configSources: cfg.configSources,
            }),
    },
  },
  posthog: {
    steps: { product: (env, cfg) => runPosthogDumps(env, { laneRegister: cfg.laneRegister, configSources: cfg.configSources }) },
  },
  dataforseo: { steps: { search: (env, cfg) => searchLane(env, cfg) } },
  counters: {
    steps: {
      counters: (env, cfg) => runCountersScrape(env, { config: cfg.counters, configSources: cfg.configSources }),
      google: (env, cfg) =>
        runGoogleSignals(env, {
          laneRegister: cfg.laneRegister,
          osTimeZone: cfg.osTimeZone,
          configSources: cfg.configSources,
        }),
    },
  },
};

/** The refusal of an expression no scheduled job runs on. */
export class UnknownCronError extends Error {
  readonly code = 'unknown_cron' as const;
  constructor(readonly cron: string) {
    super(`No scheduled job runs on "${cron}".`);
    this.name = 'UnknownCronError';
  }
}

/**
 * Run the job `cron` names, every lane as a traced step. An expression no
 * scheduled job runs on is refused before anything runs, config included: a
 * mistyped `pnpm os:cron`, or a trigger added without a job, fails by name
 * instead of running every collector and the notifier at an unplanned time.
 */
export async function runCron(cron: string, env: IngestEnv, trace?: WorkflowRecorder): Promise<void | ScheduledRunResult> {
  const job = ingestJobForCron(cron);
  const lanes = job ? JOB_LANES[job.id] : undefined;
  if (!lanes) throw new UnknownCronError(cron);
  const step = <T>(id: string, fn: () => Promise<T>): Promise<T> => trace ? trace.run(id, fn) : fn();
  const cfg = runConfig(await step('config', () => readCollectorConfigs(env)));
  const answers: Record<string, unknown> = {};
  await settleWorkflowSteps(Object.entries(lanes.steps).map(([id, lane]) =>
    step(id, async () => (answers[id] = await lane(env, cfg)))));
  return lanes.answeredBy ? answers[lanes.answeredBy] as ScheduledRunResult : undefined;
}

// --- a scheduled fire, as the runners see it ---------------------------------

/** The one line a failed scheduled step writes to the service log. */
export interface ScheduledStepFailure {
  event: 'scheduled_step_failed';
  cron: string;
  /** The Workflows step that failed; null when the fire failed outside one. */
  step: string | null;
  code: string;
  message: string;
}

/**
 * The line a failed step leaves in the service log: the cron, the step, the
 * error's code and its message, redacted and bounded.
 */
export function scheduledStepFailure(cron: string, step: string | null, error: unknown): ScheduledStepFailure {
  const code = (error as { code?: unknown } | null)?.code;
  return {
    event: 'scheduled_step_failed',
    cron,
    step,
    code: typeof code === 'string' && code !== '' ? code : error instanceof Error ? error.name : 'unknown',
    message: redactLogText(error instanceof Error ? error.message : String(error)).slice(0, 500),
  };
}

/**
 * One scheduled fire from the runner (`runScheduled`, the local runner's RPC):
 * the dispatch above, traced step by step. A failed step's error goes to the
 * log once, from the step that failed; the answer the runner records carries
 * the steps and never the error itself. An expression no job runs on answers
 * `refused: 'unknown_cron'`, with no step, and the runner door turns it away.
 */
export async function runScheduledCron(cron: string, env: IngestEnv): Promise<ScheduledRunResult> {
  const logged = new Set<unknown>();
  const log = (step: string | null, error: unknown) => {
    logged.add(error);
    console.error(JSON.stringify(scheduledStepFailure(cron, step, error)));
  };
  const trace = createWorkflowRecorder({ failed: log });
  try {
    const result = await runCron(cron, env, trace);
    return { ...(result ?? { outcome: 'ran' as const, detail: 'Execution completed' }), steps: trace.steps };
  } catch (error) {
    if (!logged.has(error)) log(null, error);
    if (error instanceof UnknownCronError) {
      return { outcome: 'failed', detail: error.message, refused: error.code, steps: trace.steps };
    }
    return { outcome: 'failed', detail: 'A workflow step failed. Check service logs for details.', steps: trace.steps };
  }
}

// --- collect now -------------------------------------------------------------
//
// The connect panel's Start collecting: one job step, run now, for the sites
// the operator just confirmed, through the same seam every cron fire goes
// through, so it gets exactly what a scheduled run gets: the stored config,
// the job's saved schedule (a paused job is not run early), and the lane's own
// function with its egress gate, lease, budget gate and retry budget. Narrower
// than the job, never wider.

/** Is `job` saved as paused? The same reading the runner makes. */
function jobPaused(cfg: RunConfig, job: string): boolean {
  return schedulePaused(cfg.constants, job);
}

/** Run `input.provider`'s collect-now step for `input.assets`. Never throws for
 * a refusal: every reason nothing ran is an answer the panel draws. */
export async function runCollectNow(
  env: IngestEnv,
  input: CollectNowInput,
  options: LaneNarrowing = {},
): Promise<CollectNowResult> {
  const provider = String(input.provider);
  const plan = collectNowStep(provider);
  if (plan === null) return { ok: false, provider, error: 'not-supported' };
  const job = plan.job.id;
  const assets = [...new Set((Array.isArray(input.assets) ? input.assets : []).filter(
    (asset): asset is string => typeof asset === 'string' && asset !== '',
  ))];
  if (assets.length === 0) return { ok: false, provider, error: 'no-sites', job };
  const cfg = runConfig(await readCollectorConfigs(env));
  if (jobPaused(cfg, job)) return { ok: false, provider, error: 'paused', job };
  if ((await resolveCredential(env, provider as IntegrationProviderId)).source === 'none') {
    return { ok: false, provider, error: 'not-connected', job };
  }
  const startedAt = new Date(options.nowMs ?? Date.now()).toISOString();
  // The run's own length, measured on the wall clock whatever `nowMs` says, so
  // the recorded firing's end never precedes its start.
  const clockAtStart = Date.now();
  const narrow: LaneNarrowing = {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
  };
  let sites: CollectNowSite[];
  if (plan.step.step === 'bing') {
    const run = await bingLane(env, cfg, { ...narrow, assets });
    sites = run.outcomes.map((outcome) => ({
      asset: outcome.asset,
      outcome: outcome.egressDown ? 'unmeasured' : outcome.status === 'success' ? 'collected' : 'failed',
      code: outcome.errorCode,
    }));
  } else if (plan.step.step === 'search') {
    sites = [];
    for (const asset of assets) {
      // The collector's own membership rule, asked per asset as
      // `POST /api/signal-collect` asks it; a declined site is skipped as the
      // sweep skips it.
      const [candidate] = await dataForSeoCandidates(env.STORE, asset);
      if (!candidate || laneDeclined(asset, 'dataforseo', cfg.laneRegister)) continue;
      const run = await searchLane(env, cfg, { ...narrow, scope: { asset } });
      if (run.refused) {
        // Another run holds the lane: nothing was bought yet, so say so rather
        // than queue a second paid run behind it.
        if (sites.length === 0) return { ok: false, provider, error: 'in-flight', job };
        sites.push({ asset, outcome: 'skipped', code: 'in-flight' });
        continue;
      }
      const unmeasured = run.outcomes.length > 0 && run.outcomes.every((outcome) => outcome.egressDown === true);
      const stored = run.succeeded + run.unchanged;
      sites.push({
        asset,
        outcome: unmeasured ? 'unmeasured' : run.failed > 0 && stored === 0 ? 'failed' : stored > 0 ? 'collected' : 'skipped',
        code: run.outcomes.find((outcome) => outcome.errorCode !== null)?.errorCode ?? null,
        reports: stored,
        costUsd: run.costUsd,
      });
    }
  } else if (plan.step.step === 'clarity') {
    // Clarity: each site's export spends one of its ten daily calls, which is
    // why the panel asks for it with an explicit Run now.
    const run = await runClarityDumps(env, { laneRegister: cfg.laneRegister, assets, ...narrow });
    sites = run.outcomes.map((outcome) => ({
      asset: outcome.asset,
      outcome: outcome.egressDown ? 'unmeasured' : outcome.status === 'error' ? 'failed' : 'collected',
      code: outcome.errorCode,
    }));
  } else if (plan.step.step === 'product') {
    // PostHog: scoped to one site at a time; its own lease turns a press away
    // while a run holds the site.
    sites = [];
    for (const asset of assets) {
      if (laneDeclined(asset, 'posthog', cfg.laneRegister)) continue;
      const run = await runPosthogDumps(env, { laneRegister: cfg.laneRegister, configSources: cfg.configSources, scope: { asset }, ...narrow });
      const busy = run.skipped.find((skip) => skip.asset === asset && skip.reason === 'in-flight');
      if (busy) {
        if (sites.length === 0 && assets.length === 1) return { ok: false, provider, error: 'in-flight', job };
        sites.push({ asset, outcome: 'skipped', code: 'in-flight' });
        continue;
      }
      const measured = run.outcomes.filter((outcome) => outcome.asset === asset);
      const unmeasured = measured.length > 0 && measured.every((outcome) => outcome.egressDown === true);
      const stored = measured.filter((outcome) => outcome.status !== 'error').length;
      const skip = run.skipped.find((entry) => entry.asset === asset && entry.family === null);
      sites.push({
        asset,
        outcome: unmeasured ? 'unmeasured' : stored > 0 ? 'collected' : measured.length > 0 ? 'failed' : 'skipped',
        code: measured.find((outcome) => outcome.errorCode !== null)?.errorCode ?? skip?.reason ?? null,
      });
    }
  } else if (plan.step.step === 'google') {
    // Google: the same call the cron makes, narrowed to the named sites. A site
    // is collected when any of its lanes stored a result.
    const run = await runGoogleSignals(env, {
      laneRegister: cfg.laneRegister, osTimeZone: cfg.osTimeZone, configSources: cfg.configSources, assets, ...narrow,
    });
    sites = [];
    for (const asset of assets) {
      const outcomes = run.outcomes.filter((outcome) => outcome.asset === asset);
      if (outcomes.length === 0) continue;
      const unmeasured = outcomes.every((outcome) => outcome.egressDown === true);
      const failed = outcomes.find((outcome) => outcome.status === 'error');
      sites.push({
        asset,
        outcome: unmeasured ? 'unmeasured' : outcomes.some((outcome) => outcome.status === 'success') ? 'collected' : 'failed',
        code: failed?.errorCode ?? null,
      });
    }
  } else if (plan.step.step === 'revenue') {
    // Mediavine: run now for each named site through the one Mediavine lease.
    // A site whose row says Not using is not synced; the sync refuses it too.
    sites = [];
    for (const asset of assets) {
      if (laneDeclined(asset, 'ad-network', cfg.laneRegister)) continue;
      const run = await syncMediavine(env, { asset }, narrow);
      if (!run.ok && run.outcome === 'skipped') {
        if (sites.length === 0 && assets.length === 1) return { ok: false, provider, error: 'in-flight', job };
        sites.push({ asset, outcome: 'skipped', code: 'in-flight' });
        continue;
      }
      sites.push({
        asset,
        outcome: run.ok ? (run.outcome === 'ran' ? 'collected' : 'skipped') : 'failed',
        code: run.ok ? null : 'provider',
      });
    }
  } else {
    // A step declared in scheduled-jobs.mts that this dispatch cannot run is a
    // catalog change nobody finished.
    return { ok: false, provider, error: 'not-supported', job };
  }
  if (sites.length === 0) return { ok: false, provider, error: 'no-sites', job };
  // In its job's run history, marked Manual. A refusal above ran nothing and
  // records nothing.
  await recordManualRun(env, {
    job: jobRunName(plan.job),
    startedAt,
    finishedAt: new Date(Date.parse(startedAt) + (Date.now() - clockAtStart)).toISOString(),
    outcome: manualRunOutcome(sites),
  }, options.nowMs);
  return { ok: true, provider, job, startedAt, finishedAt: new Date().toISOString(), sites };
}

/** A press's sites as one firing's outcome, in the runner's vocabulary: it ran
 * when any site was collected, failed when none was and one failed, and was
 * skipped when nothing could be measured or asked. */
export function manualRunOutcome(sites: readonly CollectNowSite[]): JobRunOutcome {
  if (sites.some((site) => site.outcome === 'collected')) return 'ran';
  if (sites.some((site) => site.outcome === 'failed')) return 'failed';
  return 'skipped';
}
