// The cron expressions this Worker answers to, each READ from the one list of
// scheduled jobs (scripts/scheduled-jobs.mts, bead ro-ujb9.217) rather than
// written a second time: a job's `cron` is its dispatch key. They live OUTSIDE
// the entry module deliberately: workerd requires every named export of the
// entry to be a handler, so exporting a plain string from index.ts fails the
// runtime at boot ("Incorrect type for map entry ... not of type 'function or
// ExportedHandler'"). test/crons.test.ts pins wrangler.jsonc's `triggers.crons`
// to the same jobs; any other expression is refused as `unknown_cron`
// (dispatch.ts) and runs nothing.

import { SCHEDULED_JOBS } from '../../../scripts/scheduled-jobs.mjs';

/** The dispatch key of the ingest job `id`. */
function dispatchKey(id: string): string {
  const job = SCHEDULED_JOBS.find((entry) => entry.id === id && !entry.local);
  if (!job) throw new Error(`scripts/scheduled-jobs.mts has no ingest job "${id}".`);
  return job.cron;
}

export const FRESHNESS_CRON = dispatchKey('freshness');
// Local 06:10 is checked by the collector. Later ticks only service bounded retries/catch-up.
export const MEDIAVINE_CRON = dispatchKey('mediavine');
// 02:30 UTC: pull pull-mode assets BEFORE the 03:00 asset-#0 self-pulse, so the
// OS's own pulse counts the rows the pull just wrote.
export const PULL_CRON = dispatchKey('pull');
export const ASSET_ZERO_CRON = dispatchKey('asset-zero');
// 03:30 UTC: evaluate due watch windows AFTER the 02:30 signal pulls have
// landed the day's observations, so a check that comes due today reads today's
// data instead of yesterday's.
export const WATCH_WINDOWS_CRON = dispatchKey('watch-windows');
// 04:00 UTC: nightly tech/GEO hygiene guards (docs/08 §S5). Last in the nightly
// chain because it depends on nothing the earlier slots write — it fetches the
// properties' own served bytes — and because three plain HTTPS requests per
// property should wait behind the lanes that carry provider quota.
export const HYGIENE_CRON = dispatchKey('hygiene');
// 04:30 UTC: one Microsoft Clarity export per configured project. Last in the
// nightly chain because it depends on nothing the others write, and DELIBERATELY
// once a day: the provider allows 10 calls per project per day total, so the
// archive — not a repeat call — is what every later read consumes.
export const CLARITY_CRON = dispatchKey('clarity');
// 12:15 UTC: the previous UTC date is also complete in every continental-US
// property timezone. Archive revision-aware Google dates plus one current BWT
// provider snapshot without mixing this deeper lane into the live charts.
export const SIGNAL_DUMPS_CRON = dispatchKey('signal-dumps');
// 12:30 UTC: the PostHog product analytics archive (bead `ro-ghis.1`). After the
// 12:15 Google/Bing archives so the two never compete for the same minute, and
// before the local 13:10 summary rebuild that reads both. The run computes its
// windows in each project's own timezone, ending on the last complete day there.
export const POSTHOG_DUMPS_CRON = dispatchKey('posthog');
// 12:45 UTC each Monday. The ranking database updates weekly; backlink and
// LLM snapshots are retained at the same decision-facing cadence so historical
// comparisons come from our archive instead of paid repulls.
export const DATAFORSEO_DUMPS_CRON = dispatchKey('dataforseo');
// Its schedule is also what the Tower ages the counter cards against
// (`countersCadenceHours`, bead ro-ujb9.222). This tick refreshes both
// the fast counter cards and GA4/GSC signal snapshots; the two jobs are isolated
// in the handler so one provider cannot prevent the other lane from running.
export const COUNTERS_CRON = dispatchKey('counters');
// :05 past every hour — the operator's notification lane (bead `ro-vu8d.23`).
// Its own expression rather than a tail on the freshness tick, for two reasons
// that both matter: it must run AFTER the lane that raises freshness alerts on
// the same hour rather than racing it, and a lane that interrupts a person
// deserves its own row in the run ledger, so "did the OS notify" is provable
// rather than inferred from another lane's success.
export const NOTIFY_CRON = dispatchKey('notifications');
