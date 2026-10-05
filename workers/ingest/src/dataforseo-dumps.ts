import { beginCollection, collectionMonitoring, type CollectionMonitoring } from './collection-attempt.js';
import { signalObjectScope, type SignalObjectScope } from './signal-objects.js';
import { observeIntegration, tryHealthConnection, type HealthConnection } from './integration-health-context.js';
// Operator-directed DataForSEO search-intelligence collector.
//
// The provider datasets used here update weekly or are most useful as weekly
// executive evidence. Every bounded response is archived through the same
// immutable R2 + append-only manifest boundary as GA4/GSC/BWT, so later
// analysis compares stored snapshots and never needs to repay for old data.
//
// ONE COLLECTOR, TWO WAYS IN. The Monday cron calls `runDataForSeoDumps(env)`;
// `POST /api/signal-collect` calls the same function with a `scope` naming one
// property and optionally a subset of its families (ro-282.1). There is no
// second collector and no on-demand branch inside this one — the scope narrows
// the SWEEP PLAN and nothing else, so an on-demand landing writes the same
// manifest row, the same archive and the same cost the Monday lane would have
// written for that property. That is the load-bearing property: the panel-review
// filer, the daily refresh, the lane evidence and the review loop all read
// the report runs (`noticeos.archive_runs`), and not one of them may need to
// know which door a run came through.

import {
  archiveCollectedDump,
  archiveDumpFailure,
  unmeasuredDumpOutcome,
  type DumpPage,
  type DumpTarget,
  type SignalDumpOutcome,
} from './signal-dumps.js';
import {
  EGRESS_DOWN_CODE,
  EgressGate,
  type EgressLaneRecord,
  type EgressRunOutcome,
  type TransportWatch,
  egressExplains,
  openEgressLaneRecord,
  watchTransport,
} from './egress.js';
import {
  normalizeSignalError,
  SignalError,
} from './signal-store.js';
import {
  DATAFORSEO_MONTHLY_CADENCE_DAYS,
  DATAFORSEO_WEEKLY_CADENCE_DAYS,
  MAX_REPORT_COST_USD,
  SERP_PANEL_CALL_USD,
  SERP_PANEL_DEVICES,
  SERP_PANEL_QUERY_LIMIT,
  dataForSeoReportsFor,
  loadMeteredDataSpend,
  type DataForSeoReport,
} from '@noticeos/contract';
import type { CredentialSource } from '@noticeos/contract';
import {
  credentialConnected,
  recordCredentialOutcome,
  resolveCredential,
  sourcedCredentialRef,
} from './credentials.js';
import { readDataForSeoAccount, recordDataForSeoBalance } from './dataforseo-balance.js';
import {
  type LaneMappingSource,
  type LaneRegister,
  laneDeclined,
  mappingSourceTally,
  resolveDataForSeoScope,
} from './lane-mapping.js';
import { type ConfigSourceMap, configSourceLine } from './config-store.js';
import type { WorkspaceStore } from '@noticeos/postgres';
import { SITE_ORDER } from './asset-registry.js';
import constants from '../../../config/constants.json';
import serpPanelConfigJson from '../../../config/serp-panel.json';

const API_BASE = 'https://api.dataforseo.com/v3';
const CREDENTIAL_REF = 'DATAFORSEO_LOGIN+DATAFORSEO_PASSWORD';
const RESPONSE_BYTE_LIMIT = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 130_000;
/**
 * The free account read's own patience, deliberately not `REQUEST_TIMEOUT_MS`
 * (bead `ro-vu8d.26`). Two minutes is what a paid live SERP page is worth
 * waiting for; a one-line courtesy read that nothing depends on must never hold
 * a finished sweep open that long.
 */
const ACCOUNT_TIMEOUT_MS = 10_000;
const RANKED_KEYWORD_LIMIT = 200;
const HISTORY_DAYS = 90;
/**
 * Rows the two named-backlink families ask for (ro-cda6.1) — a COST decision
 * before it is a coverage one.
 *
 * The Backlinks API bills $0.024 per request plus $0.000036 per row, so 100 rows
 * is $0.024 + $0.0036 = ~$0.0276 a call, against the $0.0218 measured for
 * `backlinks-summary`. Two families, six properties, 4.33 weeks ≈ $1.45/month
 * marginal — comfortably inside the $0.25 per-family reserve, and it has to be:
 * August 2026 spent $12.41 of the $25 portfolio cap, so roughly half the budget
 * was already committed before this family existed.
 *
 * 100 is also where the reading stops being a distribution and starts being an
 * inventory. These families answer "what shape is the link profile" and "which
 * domains are worth reclaiming", and both questions are answered by the head.
 * A property whose profile genuinely needs a thousand rows to characterise is
 * not one this portfolio has.
 */
const BACKLINK_ROW_LIMIT = 100;
/**
 * Ideas kept per property per collection (ro-cda6.2), ordered by search volume
 * so the cap holds the demand rather than the tail.
 *
 * A discovery list is read by a person deciding what to build next, and 100
 * rows is already more candidates than a single operator will action in a
 * month. Past that the family stops being a shortlist and becomes a dataset,
 * which is the failure that gets a surface opened once and never again.
 */
const KEYWORD_IDEAS_LIMIT = 100;
/**
 * Competitors kept per property. Twenty is a market, not a census: ordered by
 * keyword INTERSECTION, the domains past the first handful share almost nothing
 * with us and are competitors only in the sense that they exist.
 */
const SERP_COMPETITORS_LIMIT = 20;
/**
 * The monthly-search ceiling on a keyword idea (`ro-kukv.2`, measured).
 *
 * `keyword_ideas` expands by CATEGORY rather than by string, so a broad seed
 * set returns the internet's biggest queries. Half a million monthly searches
 * is already far outside anything a property this size competes for, so the
 * ceiling discards nothing real — and it discards it before we pay for the row.
 */
const KEYWORD_IDEAS_VOLUME_CEILING = 500_000;
// The panel's money facts — the per-family reserve, the two devices, the call
// price and the query ceiling derived from them — now live in
// `packages/contract/src/dataforseo.ts` and are re-exported here (bead
// `ro-x5gu.4`). The Tower's Growth tab edits the panel and has to state what a
// new term costs, so the numbers had to be readable from both workspaces; the
// collector still OWNS them, in the sense that it is the only thing that
// enforces the ceiling and the only place raising the reserve is argued
// (config/serp-panel.README.md). Re-exported rather than moved out of sight:
// every reader that already imported them from here still does.
export {
  MAX_REPORT_COST_USD,
  SERP_PANEL_CALL_USD,
  SERP_PANEL_DEVICES,
  SERP_PANEL_QUERY_LIMIT,
};
const DATA_MONTHLY_CAP_USD = constants.monthly_caps.data_usd;
/** Two pages of results: enough for the SERP neighborhood the panel exists to
 * read, without paying for a depth nobody looks at. A property below it records
 * no rank — "not inside the tracked depth", never "not ranking". */
const SERP_PANEL_DEPTH = 20;
/** A cluster label is a GROUP NAME — it becomes a CSV column value and a heading
 * in a readout, and twenty terms collapse into a handful of them. The cap is not
 * a storage limit (the label is never transmitted, so no provider limit applies)
 * but a shape one: past this, the field is being used to explain the bet rather
 * than to name it, and the explanation belongs where the decision lives. */
const SERP_PANEL_LABEL_LIMIT = 60;
/**
 * The waits before each retry, in order — and its LENGTH is the retry budget.
 *
 * On 2026-08-03 both of one asset's backlinks families came back HTTP 500,
 * provider_rows 0, provider_cost_usd 0.0. The same two families had returned 480
 * backlinks and 10 timeseries rows three days earlier, so it was a blip on the
 * provider's side; the cron runs `45 12 * * 1`, so the blip cost the property a
 * full WEEK of backlinks evidence and left a hole in the weekly series that
 * nothing fills. The failed calls were not billed, and neither would the retries
 * have been.
 *
 * Two short waits, four seconds in total. The budget is per FAMILY rather than
 * per request, so the tracked panel's 56 calls (28 terms on two devices) cannot
 * multiply it by 56 and turn a provider outage into minutes of sleeping inside a
 * sweep that already has a runtime to fit into.
 */
const RETRY_BACKOFF_MS = [1_000, 3_000];
/**
 * The longest wait a `Retry-After` may buy before the family fails instead.
 *
 * A 429 is the one 4xx a second call can answer, and the provider states when:
 * DataForSEO meters 2000 requests per minute, so an honest throttle clears when
 * the window rolls. But the header is the PROVIDER's number, and an unbounded
 * one would hold the sweep open for as long as it likes — a provider asking for
 * ten minutes is not throttling us for a moment, it is telling us to come back
 * later, and later is what the Monday cadence is for.
 *
 * Ten seconds is what the collector can spend without changing its own shape.
 * The sweep is ~28 (property, family) pairs and each carries its own two-retry
 * budget, so a WHOLLY rate-limited portfolio waits at most 28 x 2 x 10s ≈ 9
 * minutes — inside `LANE_LEASE_MS`, so the run still finishes before the lane it
 * holds can be taken from under it. Past the cap the family fails with an honest
 * `dataforseo_http_429`, and next Monday (or `pnpm signals:collect`) collects it.
 */
const RETRY_AFTER_CAP_MS = 10_000;
/**
 * How long one run may hold the collector lane without returning.
 *
 * The longest sweep this collector has actually run is one asset's ~112-second
 * tracked panel plus seconds apiece for everything else. The panel's second device
 * (`ro-o1n`) doubles that leg to ~224 seconds, so fifteen minutes is about four
 * times the real thing rather than eight — still far enough clear that a live run
 * is never mistaken for an orphan, and the margin to watch if a third dimension is
 * ever added. Read the other way it is the longest a run that died without
 * releasing can lock the operator out — an afternoon's inconvenience, never a
 * missed Monday.
 */
const LANE_LEASE_MS = 15 * 60_000;

type LlmPlatform = 'google' | 'chat_gpt';

interface DataForSeoTarget extends DumpTarget {
  integration: 'dataforseo';
  /**
   * THE MARKET EVERY FAMILY FOR THIS PROPERTY IS ASKED IN (bead `ro-vu8d.16`).
   *
   * Resolved once per property, from its own `config/integrations.json` entry
   * with the US/English portfolio baseline behind it, and carried on the target
   * so all five request builders below ask the same question. They used to
   * carry `location_code: 2840, language_code: 'en'` five times over, which is
   * one fact written down five times and a portfolio-wide assumption a
   * self-hoster outside the US could only change by editing TypeScript.
   */
  locationCode: number;
  languageCode: string;
  /** Whether that scope came from the asset's own entry or the baseline. */
  mappingSource: LaneMappingSource;
}

interface PortfolioCandidate {
  asset: string;
  domain: string;
}

/**
 * One provider call, as the collector will both MAKE and STORE it.
 *
 * `body` is posted verbatim (`JSON.stringify([body])`), so it may carry only
 * fields the provider's own documentation names. Everything else that is true of
 * the call belongs BESIDE the body in the archived page envelope — which is
 * where `path` and `attempts` already live — never inside it.
 */
interface PlannedRequest {
  body: Record<string, unknown>;
  /**
   * The cluster this tracked query measures — the bet, not the term — archived
   * with the observation and never transmitted (`ro-282.2`).
   *
   * WHY IT IS ARCHIVED RATHER THAN LOOKED UP. The flattened
   * `dataforseo-serp-panel.csv` derives only from the immutable archive. A label
   * read out of today's config over yesterday's collection would silently
   * relabel history the day a cluster is renamed or a term moves between bets:
   * the same rows, retitled, with nothing recording that the question changed.
   * Stored with the observation, a rename applies from the next collection
   * forward and every earlier row keeps the bet it was actually placed on.
   *
   * WHY NOT THE `tag` FIELD. `tag` is the provider's sanctioned free-text slot
   * (255 characters, echoed back in the response) and already carries
   * `<asset>:<report>` — the join key an archive reader matches on. Appending
   * the label would overload one field with two meanings and make every reader
   * parse a delimiter out of operator-written prose ("GLP-1", "Comparisons
   * (/vs)"), in exchange for sending our internal taxonomy to a third party that
   * has no use for it. A field the provider never sees cannot be rejected by the
   * provider either, which is the whole risk the tag was being considered to
   * avoid.
   */
  label?: string;
}

/** One paid independent request, durable before the next one starts. These
 * objects are resumable working evidence, not complete family manifests; every
 * read model continues to trust only signal_dump_runs. */
interface DataForSeoRequestCheckpoint {
  schemaVersion: 1;
  asset: string;
  report: DataForSeoReport;
  reportDate: string;
  requestHash: string;
  page: DumpPage;
  providerRows: number;
  costUsd: number;
  taskError: { code: string; message: string } | null;
}

export const DATAFORSEO_CHECKPOINT_PREFIX = 'checkpoints/dataforseo';

interface ReportSpec {
  name: DataForSeoReport;
  path: string;
  /** Minimum whole UTC days between successful/unchanged provider snapshots. */
  cadenceDays: number;
  /**
   * One provider POST per entry. Every family but the tracked SERP panel is a
   * single call; the panel is one call per (tracked query, device), because the
   * live/advanced SERP endpoint accepts exactly one task per request and a
   * device is a property of the task. All of a family's responses land in ONE
   * archive with ONE manifest row, so a run is still one durable observation per
   * (property, report).
   */
  requests(
    target: DataForSeoTarget,
    reportDate: string,
    panel: SerpPanelConfig,
  ): PlannedRequest[];
  /**
   * Whether this family applies to a property at all, answered WITHOUT reading
   * the config deeply enough to fail. A family no property config covers is
   * skipped before the budget gate, so it never consumes a reserve and never
   * writes an attempt row: absence of config is not a failed collection.
   * Malformed config is a different thing entirely and is raised from
   * `requests`, where it becomes a visible `config_invalid` attempt.
   *
   * Takes the asset id rather than the target, because the on-demand route has
   * to answer the same question BEFORE a target exists — asking for a panel a
   * property has no config for is a 422 there, not a silently empty run.
   */
  appliesTo?(asset: string, panel: SerpPanelConfig): boolean;
  /**
   * One provider call per configured item rather than one for the property, so
   * this family runs for MINUTES where the others run for seconds. The sweep
   * therefore collects every property's single-call families before it starts
   * any long one: on 2026-08-03 a mid-panel restart took the four properties
   * queued behind it too (ro-q18). Each paid independent response is now
   * checkpointed before the next call, so ordering protects the portfolio and
   * the checkpoints protect the long family itself. Only the final coherent
   * archive becomes a manifest/read-model landing.
   */
  longRunning?: boolean;
  /**
   * Retain a provider-level task failure alongside the family's other responses
   * instead of discarding the run. Only meaningful for multi-request families:
   * one tracked query the provider cannot answer must not throw away the
   * seventeen it did. Transport failures still fail the whole family, and a
   * family whose every request failed is still an error, not an empty success.
   */
  independentRequests?: boolean;
}

export interface DataForSeoDumpOutcome extends SignalDumpOutcome {
  costUsd: number;
  /** Provider calls this family had to repeat before it landed — 0 on a clean
   * collection. Carried on the outcome and into the run's completion log so
   * "succeeded on retry 2" is something the run RECORDED, not something a reader
   * infers from a gap. */
  retries: number;
}

export interface DataForSeoDumpsResult {
  monitoringAvailable?: boolean;
  attempted: number;
  succeeded: number;
  unchanged: number;
  failed: number;
  costUsd: number;
  outcomes: DataForSeoDumpOutcome[];
  /**
   * What the run's egress gate concluded (bead `ro-aed0.3`) — see
   * {@link EgressRunOutcome}. Absent on a run that asked DataForSEO nothing: a
   * refused trigger, or a sweep with no credential to call it with.
   */
  egress?: EgressRunOutcome;
  /**
   * Set INSTEAD of a collection: another run held the lane, so this trigger asked
   * the provider for nothing, archived nothing and wrote no manifest row. Every
   * tally above is therefore 0 — read this field before reading them, because a
   * run that never started and a run that found nothing due look alike otherwise.
   */
  refused?: DataForSeoRunInFlight;
}

// THE COLLECTOR LANE — one DataForSEO run at a time (ro-xx9).
//
// Every provider call is metered, and the cap gate reads month-to-date spend ONCE
// at the top of a run (`loadMeteredDataSpend`). So two runs started together see
// the pre-run total and neither knows about the other's reservations: the archive
// survives it (`archiveCollectedDump` stores identical content as `unchanged`),
// but the SPEND does not — every call is made twice and both manifest rows carry
// `provider_cost_usd`. The way it happens is honest rather than careless: a
// full-property on-demand run holds the HTTP request open for minutes, the
// operator's client times out, the run keeps going server-side invisibly, and the
// obvious next move is to fire it again.
//
// WHY A MODULE-SCOPE MARKER IS THE LOCK. The ingest Worker runs as an auxiliary
// worker inside the Tower's single workerd runtime — one isolate over one
// D1DatabaseObject (ro-mad) — so the platform cron, the runner's `runScheduled`
// RPC and `POST /api/signal-collect` all execute in THIS module. A variable here
// is the same variable for all three, needs no table, no Durable Object and no
// migration, and is claimed before the first `await`, so two triggers arriving in
// one tick still see each other. What it is not is a distributed lock: were the
// ingest ever deployed to Cloudflare proper, `scheduled()` and `fetch()` could
// land in different isolates and this would stop serializing them (ro-axo).
//
// WHY IT CANNOT WEDGE THE LANE SHUT. Three independent releases, because a lock
// over money must fail open on a schedule rather than never: the holder's
// `finally`; the module scope itself, which a restarted runtime starts empty (the
// 2026-08-03 mid-panel restart would have freed it); and the lease, for a run
// whose context was torn down mid-await and whose `finally` therefore never ran.
// Next Monday's cron runs no matter what happened to the run before it.

/** The run that already holds the lane, as the trigger it refused reports it. */
export interface DataForSeoRunInFlight {
  /** When the holding run started — the clock its `dataforseo_dumps_start` line
   * was written on, so the log and this refusal name the same run. */
  startedAt: string;
  /** How long it has been running, whole seconds. The number the operator
   * actually wants: "started 94 seconds ago" is a run to wait for. */
  runningSeconds: number;
  /** The holder's scope, or null when the weekly portfolio sweep holds the lane. */
  scope: DataForSeoCollectScope | null;
  /** When the lane frees itself even if the holder never returns. */
  leaseExpiresAt: string;
}

interface CollectorLane {
  /** Rising within this isolate, and the release token: a run whose lease expired
   * and was taken over must not free the lane its successor now holds. */
  readonly token: number;
  readonly startedAtMs: number;
  readonly scope: DataForSeoCollectScope | null;
}

let lane: CollectorLane | null = null;
let laneTokens = 0;

type LaneClaim =
  | { token: number; blockedBy: null }
  | { token: null; blockedBy: DataForSeoRunInFlight };

/** Take the lane, or report who has it. Synchronous on purpose — see above. */
function claimLane(nowMs: number, scope: DataForSeoCollectScope | null): LaneClaim {
  const held = lane;
  if (held !== null && nowMs < held.startedAtMs + LANE_LEASE_MS) {
    return { token: null, blockedBy: laneHolder(held, nowMs) };
  }
  const token = (laneTokens += 1);
  lane = { token, startedAtMs: nowMs, scope };
  return { token, blockedBy: null };
}

function releaseLane(token: number): void {
  if (lane?.token === token) lane = null;
}

function laneHolder(held: CollectorLane, nowMs: number): DataForSeoRunInFlight {
  return {
    startedAt: new Date(held.startedAtMs).toISOString(),
    runningSeconds: Math.max(0, Math.round((nowMs - held.startedAtMs) / 1000)),
    scope: held.scope,
    leaseExpiresAt: new Date(held.startedAtMs + LANE_LEASE_MS).toISOString(),
  };
}

/**
 * Narrow a run to one property, and optionally to some of its families.
 *
 * The weekly cron passes no scope and sweeps the portfolio. `POST
 * /api/signal-collect` passes one, so a bet that launched on a Tuesday gets its
 * baseline on Tuesday instead of six days later — for the price of that one
 * property's families rather than the ~$1.60 of re-firing the whole Monday lane
 * to buy ~$0.07 of new data (ro-282.1).
 *
 * The route validates both fields before it gets here; the scope is applied
 * anyway as the narrowing itself, so nothing downstream needs to trust it.
 */
export interface DataForSeoCollectScope {
  /** Exactly one property id, matched against the collector's OWN membership
   * query — a scope can only reach a property the weekly lane would collect. */
  asset: string;
  /** A subset of `DATAFORSEO_REPORTS`. Omitted means every applicable family
   * for this property. A scope is an explicit baseline/repair, so it deliberately
   * bypasses the automated freshness filter. */
  families?: readonly string[];
}

export interface DataForSeoDumpsOptions {
  nowMs?: number;
  fetchImpl?: typeof fetch;
  login?: string;
  password?: string;
  monthlyCapUsd?: number;
  /** Override the built-in config/serp-panel.json (tests inject their own). */
  serpPanelConfig?: SerpPanelConfig;
  /** Override the retry waits (tests use zeroes, or `[]` for no retry at all). */
  retryBackoffMs?: number[];
  /** Override the compiled-in config/integrations.json mapping (tests state
   * their own register instead of editing the operator's file). */
  laneRegister?: LaneRegister;
  /** Where this run's config came from, per file — resolved once per cron fire
   * in dispatch.ts and reported on the completion line (`ro-syok.7`). */
  configSources?: ConfigSourceMap;
  /** One property instead of the portfolio — see `DataForSeoCollectScope`. */
  scope?: DataForSeoCollectScope | null;
  /** Override the run's egress gate (tests control the verdict TTL); every other
   * caller gets a real one over the same fetcher. */
  egress?: EgressGate;
}

/** The run's egress question, carried to every call that might owe it. */
interface EgressLane {
  gate: EgressGate;
  transport: TransportWatch;
}

const REPORTS: ReportSpec[] = [
  {
    name: 'ranked-keywords',
    path: '/dataforseo_labs/google/ranked_keywords/live',
    cadenceDays: DATAFORSEO_WEEKLY_CADENCE_DAYS,
    requests: (target) => [
      {
        body: {
          target: target.propertyRef,
          location_code: target.locationCode,
          language_code: target.languageCode,
          item_types: ['organic', 'featured_snippet', 'ai_overview_reference'],
          historical_serp_mode: 'live',
          include_clickstream_data: false,
          limit: RANKED_KEYWORD_LIMIT,
          filters: [
            ['keyword_data.keyword_info.search_volume', '>', 0],
            'and',
            ['ranked_serp_element.serp_item.rank_group', '<=', 100],
          ],
          order_by: ['keyword_data.keyword_info.search_volume,desc'],
          tag: `${target.asset}:ranked-keywords`,
        },
      },
    ],
  },
  {
    name: 'backlinks-summary',
    path: '/backlinks/summary/live',
    cadenceDays: DATAFORSEO_WEEKLY_CADENCE_DAYS,
    requests: (target) => [
      {
        body: {
          target: target.propertyRef,
          include_subdomains: true,
          backlinks_status_type: 'live',
          internal_list_limit: 10,
          tag: `${target.asset}:backlinks-summary`,
        },
      },
    ],
  },
  {
    name: 'backlinks-new-lost',
    path: '/backlinks/timeseries_new_lost_summary/live',
    cadenceDays: DATAFORSEO_WEEKLY_CADENCE_DAYS,
    requests: (target, reportDate) => {
      // This endpoint accepts COMPLETED days only. `reportDate` is the day the
      // OS collected the snapshot and remains the manifest grain; using it as
      // `date_to` made a midnight startup catch-up ask DataForSEO for "today",
      // which the provider rejects for every property. Keep those two clocks
      // separate: the archive says when we observed, the request ends yesterday.
      const completedThrough = isoDateOffset(reportDate, -1);
      return [
        {
          body: {
            target: target.propertyRef,
            date_from: isoDateOffset(completedThrough, -(HISTORY_DAYS - 1)),
            date_to: completedThrough,
            group_range: 'week',
            tag: `${target.asset}:backlinks-new-lost`,
          },
        },
      ];
    },
  },
  {
    // ro-cda6.1. `backlinks-summary` reports a referring-domain COUNT and
    // `backlinks-new-lost` reports the weekly delta; neither names a single
    // domain. "We lost 12 referring domains this week" was therefore
    // unactionable — no way to learn which, whether they mattered, or whether
    // to try reclaiming them. This family is the names behind the number, and
    // it is what `reclamation_targets` needs to be pointed at anything.
    name: 'backlinks-referring-domains',
    path: '/backlinks/referring_domains/live',
    cadenceDays: DATAFORSEO_WEEKLY_CADENCE_DAYS,
    requests: (target) => [
      {
        body: {
          target: target.propertyRef,
          include_subdomains: true,
          backlinks_status_type: 'live',
          limit: BACKLINK_ROW_LIMIT,
          // Rank first, so a truncated response keeps the domains whose link is
          // worth having. Ordered by count, the cap would fill with whichever
          // scraper farm happened to link most times.
          order_by: ['rank,desc'],
          tag: `${target.asset}:backlinks-referring-domains`,
        },
      },
    ],
  },
  {
    // ro-cda6.1. The anchor profile as a DISTRIBUTION rather than a list: an
    // inbound profile that is mostly exact-match commercial anchors is a risk
    // signal, and one that is mostly brand is the input docs/08 says
    // out-predicts raw link counts ~3x for AI visibility. Neither is knowable
    // from a referring-domain count.
    name: 'backlinks-anchors',
    path: '/backlinks/anchors/live',
    cadenceDays: DATAFORSEO_WEEKLY_CADENCE_DAYS,
    requests: (target) => [
      {
        body: {
          target: target.propertyRef,
          include_subdomains: true,
          backlinks_status_type: 'live',
          limit: BACKLINK_ROW_LIMIT,
          // Anchors are read as a distribution, so the head is the part that
          // carries the shape: the anchors used by the most distinct domains.
          order_by: ['referring_domains,desc'],
          tag: `${target.asset}:backlinks-anchors`,
        },
      },
    ],
  },
  {
    // ro-cda6.2. Every other search family in this collector is REFLEXIVE:
    // `ranked-keywords` reads what the property already ranks for, `serp-panel`
    // reads terms somebody already chose, GSC reads queries that already earned
    // an impression. Nothing could propose a term the portfolio has never
    // touched, so Decide could rank existing opportunities and never generate
    // one — the difference between optimizing a page and choosing what to build
    // (docs/13, the outer loop).
    //
    // SEEDS COME FROM THE PANEL, not from a new config file and not from the
    // stored `ranked-keywords` archive. The panel is the operator's own
    // statement of which head terms matter for a property, it is already loaded
    // here, and expanding exactly those is the discovery question. Reading the
    // archive instead would put an R2 fetch and a gzip parse inside a paid
    // lane — a new failure mode between the budget gate and the provider — to
    // reach a seed set nobody curated.
    //
    // A property with no panel therefore has no declared head terms, and gets
    // no ideas rather than ideas grown from a guess.
    name: 'keyword-ideas',
    path: '/dataforseo_labs/google/keyword_ideas/live',
    cadenceDays: DATAFORSEO_MONTHLY_CADENCE_DAYS,
    appliesTo: (asset, panel) => serpPanelEntry(panel, asset) !== undefined,
    requests: (target, _reportDate, panel) => [
      {
        body: {
          keywords: trackedQueries(panel, target.asset).map((q) => q.keyword),
          location_code: target.locationCode,
          language_code: target.languageCode,
          limit: KEYWORD_IDEAS_LIMIT,
          order_by: ['keyword_info.search_volume,desc'],
          // THE UPPER BOUND IS THE LOAD-BEARING FILTER, added 2026-08-31 after
          // the first real collection. `keyword_ideas` expands a seed set by
          // CATEGORY, not by string, so myplate's head terms returned "free
          // porn" (20.4M), "fubo free trial" and "porn video free" as its three
          // biggest ideas — 75% of the hundred rows shared no token with any
          // seed. Ordered by volume, the internet's largest queries win every
          // time and the family reads as noise.
          //
          // A term with millions of monthly searches is definitionally not a
          // niche opportunity for a property this size, so the ceiling costs
          // nothing real and removes the whole failure mode at request time
          // rather than paying for rows a reader then has to ignore. The
          // remaining 25% was the good part all along: "high protein foods"
          // 246k at difficulty 9, "chipotle nutrition calculator" 201k at 17.
          filters: [
            ['keyword_info.search_volume', '>', 0],
            'and',
            ['keyword_info.search_volume', '<', KEYWORD_IDEAS_VOLUME_CEILING],
          ],
          tag: `${target.asset}:keyword-ideas`,
        },
      },
    ],
  },
  {
    // ro-cda6.2. Who else holds the SERPs this property competes on. Today the
    // competitive set is discovered only incidentally, from the `top3` of
    // whichever panel queries happen to be tracked — which means it is a
    // property of the panel rather than of the market, and a competitor that
    // owns terms nobody tracks is invisible by construction.
    name: 'serp-competitors',
    path: '/dataforseo_labs/google/competitors_domain/live',
    cadenceDays: DATAFORSEO_MONTHLY_CADENCE_DAYS,
    requests: (target) => [
      {
        body: {
          target: target.propertyRef,
          location_code: target.locationCode,
          language_code: target.languageCode,
          limit: SERP_COMPETITORS_LIMIT,
          // Ordered by the overlap that matters — how many of OUR keywords they
          // also rank for — rather than by their size. A bigger domain that
          // intersects us on nothing is not a competitor.
          order_by: ['intersections,desc'],
          // The property itself comes back as its own top "competitor" — it
          // intersects itself on every keyword — so it is excluded at request
          // time. Leaving it in wastes a row of the cap and puts a meaningless
          // 100% self-overlap at the head of the list (observed 2026-08-31:
          // the asset itself ranked first with 3,737 intersections against itself).
          filters: [
            ['intersections', '>', 0],
            'and',
            ['domain', '<>', target.propertyRef],
          ],
          tag: `${target.asset}:serp-competitors`,
        },
      },
    ],
  },
  llmReport('google'),
  llmReport('chat_gpt'),
  {
    // S1b (doc 08): the hand-picked panel, alongside the broad `ranked-keywords`
    // inventory rather than instead of it. The inventory answers "what do we
    // rank for"; this answers "who else is on the page for the terms we chose,
    // and does the AI Overview cite us" — the two facts the query-decision lanes
    // need before recommending copy work on a term whose click is consumed.
    //
    // Since ro-o1n it asks that of BOTH devices: one call per (query, device),
    // still one family, one archive and one manifest row per property per run.
    // The device dimension therefore costs provider calls and nothing else — no
    // second family for the on-demand route to know about, no second landing for
    // the review filer to file against, no manifest column, no migration. Two
    // devices for one query can never dedupe against each other either: they are
    // two pages of the same archive, and the content hash that decides
    // `success` vs `unchanged` covers every page's request body, `device`
    // included.
    name: 'serp-panel',
    path: '/serp/google/organic/live/advanced',
    cadenceDays: DATAFORSEO_WEEKLY_CADENCE_DAYS,
    appliesTo: (asset, panel) => serpPanelEntry(panel, asset) !== undefined,
    longRunning: true,
    independentRequests: true,
    requests: (target, _reportDate, panel) =>
      // Device-inner rather than device-outer: a query's two result pages sit
      // side by side in the archive, and the desktop call is the LAST word on
      // every query (see SERP_PANEL_DEVICES).
      //
      // The two dimensions sit on opposite sides of the body/envelope line and
      // for the same reason: `device` is a documented provider field, so it goes
      // in the BODY and is transmitted; `label` is our own taxonomy, so it rides
      // BESIDE the body and is not. Both end up archived with the observation,
      // which is all either one needed. A query's cluster is a property of the
      // term, not of the surface it was read on, so both device pages carry the
      // same label.
      panelWithinCostCeiling(
        trackedQueries(panel, target.asset),
        target.asset,
      ).flatMap(({ keyword, label }) =>
        SERP_PANEL_DEVICES.map((device) => ({
          body: {
            keyword,
            location_code: target.locationCode,
            language_code: target.languageCode,
            device,
            depth: SERP_PANEL_DEPTH,
            // Without this the AI Overview is frequently absent from the
            // response even when Google served one, which would read as "no
            // overview" — exactly the false negative this panel exists to
            // prevent.
            load_async_ai_overview: true,
            tag: `${target.asset}:serp-panel`,
          },
          // Omitted, not empty, when the panel labels nothing: an unlabelled
          // collection archives byte-for-byte what it always did.
          ...(label === null ? {} : { label }),
        })),
      ),
  },
];

function llmReport(platform: LlmPlatform): ReportSpec {
  const name =
    platform === 'chat_gpt'
      ? 'llm-mentions-chatgpt'
      : 'llm-mentions-google';
  return {
    name,
    path: '/ai_optimization/llm_mentions/target_metrics/live',
    cadenceDays: DATAFORSEO_WEEKLY_CADENCE_DAYS,
    requests: (target) => [
      {
        body: {
          location_code: target.locationCode,
          language_code: target.languageCode,
          platform,
          target: [
            {
              domain: target.propertyRef,
              search_filter: 'include',
              search_scope: ['sources', 'search_results'],
              include_subdomains: true,
            },
          ],
          internal_list_limit: 10,
          tag: `${target.asset}:${name}`,
        },
      },
    ],
  };
}

/**
 * One entry of a property's tracked panel.
 *
 * The bare string is the query and nothing else — the shape every panel had
 * before labels existed, and still fully valid. The object form adds the
 * optional cluster `label`: which bet this query measures, so a readout can
 * group twenty terms into the six or seven questions they were chosen to answer.
 */
export type SerpPanelQuery = string | { query: string; label?: string };

export interface SerpPanelAssetConfig {
  queries: SerpPanelQuery[];
}

export interface SerpPanelConfig {
  assets: Record<string, SerpPanelAssetConfig>;
}

const SERP_PANEL_CONFIG = serpPanelConfigJson as SerpPanelConfig;

/** Lenient lookup: answers "is there a panel for this property" and nothing
 * more, so an unconfigured property is skipped without a malformed one being
 * able to abort the sweep here. */
function serpPanelEntry(panel: SerpPanelConfig, asset: string): unknown {
  const assets = panel?.assets;
  return assets && typeof assets === 'object'
    ? (assets as Record<string, unknown>)[asset]
    : undefined;
}

/** A tracked query as the collector will ask it and store it: the keyword the
 * provider is sent, and the cluster the archive keeps beside the answer. */
interface TrackedQuery {
  keyword: string;
  label: string | null;
}

/**
 * This property's tracked panel, validated for SHAPE. Every rule below is a
 * config error rather than a silent repair: a trimmed, deduplicated, or emptied
 * panel would bill for one question and answer another. The failure is scoped
 * to the one property — `config/serp-panel.README.md` documents each rule.
 *
 * The panel's COST CEILING is deliberately not enforced here (ro-cda6.2). It is
 * derived from the panel's own per-call economics — one metered call per
 * (query, device) — and `keyword-ideas` reads the same config to seed ONE call,
 * where that arithmetic means nothing. Applying it to both would let a panel
 * one term over its cap take discovery down with it for an unrelated reason.
 * `panelWithinCostCeiling` holds the rule, and the panel family applies it.
 */
/**
 * The panel's cost ceiling — its own rule, because it is the only family whose
 * bill is a function of config: one metered call per (query, device), so the
 * biggest legal panel must fit the $0.25 the budget gate reserves before it
 * calls. A panel that quietly outspends its own reserve is how a portfolio cap
 * gets crossed by calls nobody reserved for.
 */
function panelWithinCostCeiling(
  queries: readonly TrackedQuery[],
  asset: string,
): readonly TrackedQuery[] {
  // The cap is what the per-report reserve (MAX_REPORT_COST_USD) buys at one
  // metered call per term and device (SERP_PANEL_DEVICES x SERP_PANEL_CALL_USD);
  // raising it means raising that reserve. The line on the site's Data sources
  // is the count against the cap, and the fix is the site's tracked terms
  // (bead `ro-ujb9.96.6.27`).
  if (queries.length > SERP_PANEL_QUERY_LIMIT) {
    throw new SignalError(
      'config_invalid',
      `${queries.length} tracked terms for ${asset} · the panel cap is ${SERP_PANEL_QUERY_LIMIT}`,
    );
  }
  return queries;
}

function trackedQueries(panel: SerpPanelConfig, asset: string): TrackedQuery[] {
  const entry = serpPanelEntry(panel, asset);
  const queries = (entry as SerpPanelAssetConfig | undefined)?.queries;
  if (!Array.isArray(queries) || queries.length === 0) {
    throw new SignalError(
      'config_invalid',
      `config/serp-panel.json entry for ${asset} has no tracked queries.`,
    );
  }
  const seen = new Set<string>();
  /** Normalized cluster label -> the spelling that claimed it first. */
  const claimedLabels = new Map<string, string>();
  const tracked: TrackedQuery[] = [];
  for (const item of queries) {
    if (typeof item !== 'string' && asRecord(item) === null) {
      throw new SignalError(
        'config_invalid',
        `config/serp-panel.json lists a tracked query for ${asset} that is neither a string nor a { query, label } object.`,
      );
    }
    const source: Record<string, unknown> =
      typeof item === 'string' ? { query: item } : asRecord(item)!;
    const raw = source.query;
    const keyword = typeof raw === 'string' ? raw.trim() : '';
    if (keyword.length === 0) {
      throw new SignalError(
        'config_invalid',
        `config/serp-panel.json lists a blank tracked query for ${asset}.`,
      );
    }
    const key = keyword.toLowerCase();
    if (seen.has(key)) {
      throw new SignalError(
        'config_invalid',
        `config/serp-panel.json repeats the tracked query "${keyword}" for ${asset}.`,
      );
    }
    seen.add(key);
    tracked.push({
      keyword,
      label: trackedLabel(source.label, keyword, asset, claimedLabels),
    });
  }
  return tracked;
}

/**
 * The cluster this query measures, validated — or null, which is a complete
 * answer: labelling is optional per query and per property, and an unlabelled
 * panel must stay exactly as valid as it was before labels existed.
 *
 * The case rule is the duplicate-query rule wearing a different hat. Grouping is
 * an exact-string match on the stored label, so "Item head" and "Item Head" are
 * two bets in the readout and one bet in the operator's head — the same class of
 * mistake as two spellings of one term, and just as invisible once archived.
 */
function trackedLabel(
  value: unknown,
  keyword: string,
  asset: string,
  claimed: Map<string, string>,
): string | null {
  if (value === undefined) return null;
  const label = typeof value === 'string' ? value.trim() : '';
  if (label.length === 0) {
    throw new SignalError(
      'config_invalid',
      `config/serp-panel.json gives the tracked query "${keyword}" a blank label for ${asset}; omit the field instead.`,
    );
  }
  if (label.length > SERP_PANEL_LABEL_LIMIT) {
    throw new SignalError(
      'config_invalid',
      `config/serp-panel.json labels the tracked query "${keyword}" with ${label.length} characters for ${asset}; the cluster-label cap is ${SERP_PANEL_LABEL_LIMIT}.`,
    );
  }
  const first = claimed.get(label.toLowerCase());
  if (first !== undefined && first !== label) {
    throw new SignalError(
      'config_invalid',
      `config/serp-panel.json spells one cluster two ways for ${asset}: "${first}" and "${label}".`,
    );
  }
  claimed.set(label.toLowerCase(), label);
  return label;
}

/**
 * One collection, whichever door it came through — and never two at once.
 *
 * The lane is claimed here rather than in either caller, so the weekly cron, the
 * runner's `runScheduled` RPC and `POST /api/signal-collect` are serialized by
 * CONSTRUCTION: a future trigger cannot forget to ask. A refused trigger returns
 * a zeroed result carrying `refused` instead of throwing — the cron must not
 * record a platform failure for behaving correctly, and the route turns the same
 * field into its 409.
 */
export async function runDataForSeoDumps(
  env: IngestEnv,
  options: DataForSeoDumpsOptions = {},
): Promise<DataForSeoDumpsResult> {
  return await runCollector(env, options, null);
}

/**
 * The daily re-collection of what an offline run skipped (bead `ro-aed0.6`).
 *
 * THE GAP IT CLOSES. The sweep runs once a week (`45 12 * * 1`). Since
 * `ro-aed0.3` a family the dead uplink swallowed is left due rather than
 * written off — but nothing collected it until the next Monday, so one bad
 * morning cost every property a week of ranking and backlink evidence.
 *
 * WHAT IT RE-RUNS, AND ONLY THAT. The families this collector's entry on the
 * open `os-egress-down` flag names (src/egress.ts): the exact (property, family)
 * pairs a run gave up on because the OS could not get out. A family that failed
 * AT THE PROVIDER is never on that list — it has a manifest row and is the
 * provider's story, and retrying a paid error every day is exactly what this
 * pass must not do — and neither is one the monthly cap stopped. Everything else
 * is the ordinary sweep: the same due check against durable manifests (a family
 * collected since is skipped), the same monthly cap gate, the same lane lock.
 *
 * FREE WHEN NOTHING IS OWED. The flag is read before anything else — before the
 * lane is claimed, a credential is resolved or a line is logged — and a pass
 * with no entry returns a zeroed result having touched nothing but that read.
 * Once the pass has run with the connection back, the entry is gone, so the
 * following days cost nothing again.
 */
export async function runDataForSeoRecovery(
  env: IngestEnv,
  options: Omit<DataForSeoDumpsOptions, 'scope'> = {},
): Promise<DataForSeoDumpsResult> {
  const owed = await openEgressLaneRecord(env, 'dataforseo');
  if (owed === null) {
    return { attempted: 0, succeeded: 0, unchanged: 0, failed: 0, costUsd: 0, outcomes: [] };
  }
  return await runCollector(env, { ...options, scope: null }, owed);
}

async function runCollector(
  env: IngestEnv,
  options: DataForSeoDumpsOptions,
  owed: EgressLaneRecord | null,
): Promise<DataForSeoDumpsResult> {
  const nowMs = options.nowMs ?? Date.now();
  const claim = claimLane(nowMs, options.scope ?? null);
  if (claim.blockedBy) {
    // Neither a start nor a complete line: nothing started. "One start, no
    // complete" keeps meaning an INTERRUPTED run, which is the read ro-q18 built.
    console.log(
      JSON.stringify({
        event: 'dataforseo_dumps_refused',
        reason: 'run_in_flight',
        ...(options.scope
          ? {
              scope: {
                asset: options.scope.asset,
                families: options.scope.families ?? null,
              },
            }
          : {}),
        inFlight: claim.blockedBy,
      }),
    );
    return {
      attempted: 0,
      succeeded: 0,
      unchanged: 0,
      failed: 0,
      costUsd: 0,
      outcomes: [],
      refused: claim.blockedBy,
    };
  }
  try {
    return await collectDueReports(env, options, nowMs, owed);
  } finally {
    releaseLane(claim.token);
  }
}

/** Is this (property, family) on the outage entry? A property named with no
 * family list went unmeasured whole, so every family of it is owed. */
function owedFamily(owed: EgressLaneRecord, asset: string, family: string): boolean {
  if (!owed.unmeasuredAssets.includes(asset)) return false;
  const families = owed.parts?.[asset];
  return families === undefined || families.includes(family);
}

async function collectDueReports(
  env: IngestEnv,
  options: DataForSeoDumpsOptions,
  nowMs: number,
  owed: EgressLaneRecord | null,
): Promise<DataForSeoDumpsResult> {
  const recovery = owed !== null;
  const requestedAt = new Date(nowMs).toISOString();
  const reportDate = requestedAt.slice(0, 10);
  const fetchImpl = options.fetchImpl ?? fetch;
  // Store first, legacy env bindings second (bead `ro-vu8d.1`). A caller that
  // handed us a login is a test, so nothing was resolved and the source is
  // `env` by definition.
  const resolved = await resolveCredential(env, 'dataforseo');
  const health = await tryHealthConnection(env, 'dataforseo', resolved);
  const monitoring = beginCollection(env.STORE, health);
  const login = options.login ?? resolved.fields.DATAFORSEO_LOGIN;
  const password = options.password ?? resolved.fields.DATAFORSEO_PASSWORD;
  const credentialSource: CredentialSource =
    options.login === undefined && options.password === undefined
      ? resolved.source
      : 'env';
  // DATAFORSEO NOT CONNECTED AT ALL IS NO WORK, NOT A FAILURE (bead
  // `ro-ujb9.176`). A new installation's first site used to archive a
  // `config_missing` failure per planned (site, family), for a source nobody
  // set up. Nothing is planned, reserved or logged as a sweep; a stored login
  // this Worker cannot open is still connected, and still fails below.
  if (
    (!login || !password) &&
    options.login === undefined &&
    options.password === undefined &&
    !(await credentialConnected(env, 'dataforseo', resolved))
  ) {
    console.log(JSON.stringify({ event: 'dataforseo_dumps_not_connected', ...(recovery ? { recovery: true } : {}) }));
    return { attempted: 0, succeeded: 0, unchanged: 0, failed: 0, costUsd: 0, outcomes: [] };
  }
  const monthlyCapUsd = options.monthlyCapUsd ?? DATA_MONTHLY_CAP_USD;
  const panel = options.serpPanelConfig ?? SERP_PANEL_CONFIG;
  const retryBackoffMs = options.retryBackoffMs ?? RETRY_BACKOFF_MS;
  const scope = options.scope ?? null;
  // A property its Data sources row declines (Not using) is neither asked for
  // nor billed — the sweep, a named collection and the outage re-collection
  // alike (bead `ro-ujb9.96.7.18`). Filtered before the plan, so it reserves
  // nothing against the monthly cap and writes no attempt row.
  const candidates = (await dataForSeoCandidates(env.STORE, scope?.asset ?? null))
    .filter((candidate) => !laneDeclined(candidate.asset, 'dataforseo', options.laneRegister));
  const targets = candidates.map((candidate) =>
    dataForSeoTarget(
      candidate,
      sourcedCredentialRef(CREDENTIAL_REF, credentialSource),
      options.laneRegister,
    ),
  );
  const sweep = sweepPlan(targets, panel, scope?.families);
  // The daily re-collection narrows the sweep to what the outage skipped; the
  // due check below still applies, so a family collected since is not re-bought.
  const fullPlan =
    owed === null
      ? sweep
      : sweep.filter(({ target, report }) => owedFamily(owed, target.asset, report.name));
  // A named operator collection is an intentional baseline/repair and may force
  // exactly the requested families. Cron and startup catch-up are automation:
  // they must prove each family due from durable manifests before paying.
  const { due: plan, skippedFresh } =
    scope === null
      ? await dueDataForSeoPlan(env.STORE, fullPlan, reportDate)
      : { due: fullPlan, skippedFresh: [] };
  // Announce the sweep before it can be interrupted. The coherent family
  // manifest still lands only after the last request, while independent paid
  // pages checkpoint after every response. A start without a completion line is
  // therefore readable interruption evidence, and the next repair resumes its
  // checkpoints instead of paying for the successful calls again.
  console.log(
    JSON.stringify({
      event: 'dataforseo_dumps_start',
      properties: targets.length,
      reports: plan.length,
      skippedFresh,
      reportDate,
      // Which mapping named each property's market (bead `ro-vu8d.16`), on the
      // START line because a scope is what this run is about to SPEND on:
      // `{register: 1, baseline: 5}` is one property asking in the market its
      // Sources tab states and five in the US/English baseline.
      mappingSources: mappingSourceTally(
        targets.map((target) => target.mappingSource),
      ),
      // Present only on an on-demand run, so a weekly line reads exactly as it
      // always has — and a $0.07 line in os-up.log is never mistaken for the
      // $1.60 one.
      ...(scope ? { scope: { asset: scope.asset, families: scope.families ?? null } } : {}),
      // Present only on the daily outage re-collection (`ro-aed0.6`), so a
      // Tuesday line is never mistaken for a second weekly sweep.
      ...(recovery ? { recovery: true } : {}),
    }),
  );

  // CAN THE OS GET OUT (bead `ro-aed0.3`)? Asked before a status-less failure
  // is granted a retry, because the ladder exists for a PROVIDER blip: on a dead
  // uplink it used to spend every family's full budget against a wall and then
  // store "Gave up after 3 attempts" — a first-person claim of a DataForSEO
  // outage the OS never reached. Only the report calls are watched; the gate's
  // beacons and the free account read use the raw fetcher.
  const egress: EgressLane = {
    gate: options.egress ?? new EgressGate(env, { lane: 'dataforseo', fetchImpl, at: requestedAt }),
    transport: watchTransport(fetchImpl),
  };
  // Which of this collector's outage entries the run answers for (`ro-aed0.5`).
  // A scoped run answers only for the families it was asked for: the rest of
  // what an outage skipped stays owed. Every family the plan attempted leaves
  // the entry whatever became of it — collected, or failed for a reason that is
  // not the uplink's (a missing login, the monthly cap, the provider itself) —
  // so the daily re-collection never retries a failure it cannot fix.
  const egressCoverage =
    scope === null
      ? {}
      : {
          covers: (asset: string, family: string | null) =>
            asset === scope.asset &&
            (scope.families === undefined || (family !== null && scope.families.includes(family))),
        };

  if (!login || !password) {
    const error = new SignalError(
      'config_missing',
      'DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD are not configured.',
    );
    const outcomes: DataForSeoDumpOutcome[] = [];
    for (const { target, report } of plan) {
      const outcome = await archiveDumpFailure(env.STORE, {
        monitoring,
        target,
        report: report.name,
        reportDate,
        requestedAt,
        dataState: 'provider-snapshot',
        error,
        knownZeroCost: true,
      });
      outcomes.push({ ...outcome, costUsd: 0, retries: 0 });
    }
    const egressOutcome = await egress.gate.finalize(egressCoverage);
    return { ...finish(outcomes, scope, skippedFresh, options.configSources, false, egressOutcome, recovery), ...collectionMonitoring(monitoring) };
  }

  if (!Number.isFinite(monthlyCapUsd) || monthlyCapUsd <= 0) {
    throw new SignalError(
      'config_invalid',
      'DataForSEO monthly data cap must be greater than zero.',
    );
  }
  const authorization = basicAuthorization(login, password);
  const outcomes: DataForSeoDumpOutcome[] = [];
  // BOTH PLACES THE PORTFOLIO SPENDS THIS ACCOUNT, through the one sum the
  // desk's meters read (`loadMeteredDataSpend`, bead `ro-ukus`); the
  // arithmetic is the Tower's, unchanged.
  const { spentUsd } = await loadMeteredDataSpend(env.STORE, requestedAt, 'month');
  let monthSpendUsd = spentUsd;
  for (const { target, report } of plan) {
    if (monthSpendUsd + MAX_REPORT_COST_USD > monthlyCapUsd) {
      const outcome = await archiveDumpFailure(env.STORE, {
        monitoring,
        target,
        report: report.name,
        reportDate,
        requestedAt,
        dataState: 'provider-snapshot',
        error: new SignalError(
          'budget_exhausted',
          `DataForSEO paused before the portfolio ${monthlyCapUsd.toFixed(2)} USD monthly data cap.`,
        ),
        knownZeroCost: true,
      });
      outcomes.push({ ...outcome, costUsd: 0, retries: 0 });
      continue;
    }
    const outcome = await collectReport(
      env,
      target,
      report,
      reportDate,
      requestedAt,
      authorization,
      egress,
      panel,
      { backoffMs: retryBackoffMs, monthSpendUsd, monthlyCapUsd, used: 0 },
      monitoring,
    );
    outcomes.push(outcome);
    monthSpendUsd += outcome.costUsd;
  }
  // One `os-egress-down` fact for the sweep — or the retraction of one an
  // earlier run left open.
  const egressOutcome = await egress.gate.finalize(egressCoverage);
  // One stamp per sweep on the CREDENTIAL (db/0028). A single paid report that
  // came back proves the login works; a sweep where nothing did is what an
  // operator needs to see on the Integrations page. A family the dead uplink
  // swallowed says nothing about the login either way, so a sweep made only of
  // those stamps nothing: no measurement is not a verdict.
  const sweepWorked = outcomes.some((outcome) => outcome.status !== 'error');
  const measured = outcomes.filter((outcome) => !outcome.egressDown);
  if (credentialSource === 'store' && measured.length > 0) {
    await recordCredentialOutcome(env, 'dataforseo', {
      ok: sweepWorked,
      error: sweepWorked ? null : 'Every DataForSEO report in this sweep failed.',
    });
  }
  // And ONE free read of the account, on a sweep that worked (bead
  // `ro-vu8d.26`). `ro-qpas` recorded the credit wherever the OS saw it, but the
  // report endpoints never volunteer it, so the figure that decides whether next
  // Monday's sweep can run moved only when a human pressed Test connection. The
  // run that already talks to DataForSEO asks the free endpoint once, at the
  // end, and stamps what it says through the same writer the probe uses.
  //
  // ONLY on a sweep that worked, and only where there is a stored credential to
  // stamp: a run that failed outright has just proved it cannot reach this
  // provider, so one more call would be one more failure, and a run with nothing
  // due did not go near DataForSEO at all. Neither has anything to refresh.
  const creditRefreshed =
    credentialSource === 'store' && sweepWorked
      ? await refreshAccountCredit(env, authorization, fetchImpl, requestedAt, health, new Date(options.nowMs ?? Date.now()).toISOString())
      : { refreshed: false, monitoringAvailable: true };
  return { ...finish(outcomes, scope, skippedFresh, options.configSources, creditRefreshed.refreshed, egressOutcome, recovery), ...collectionMonitoring(monitoring), ...(!creditRefreshed.monitoringAvailable ? { monitoringAvailable: false } : {}) };
}

/**
 * The sweep's one free account read, and the credit it stamps (bead
 * `ro-vu8d.26`).
 *
 * FREE, AND TREATED AS FREE THROUGHOUT. `appendix/user_data` costs no money and
 * no metered quota, so this call is deliberately outside everything that governs
 * a paid one: it is not weighed against the monthly data cap, its zero cost is
 * never added to the run's spend, and it is NEVER RETRIED. A retry ladder exists
 * so a family the OS already paid to plan is not lost to a blip; a courtesy read
 * has nothing to lose, and asking twice for a figure nobody is waiting on is how
 * a free call becomes a habit.
 *
 * NEVER THE SWEEP'S FAILURE. A refusal at the egress gate, a timeout, a rejected
 * login, a body that states no figure — all of it answers false and the run
 * stays exactly as green as the reports made it. The card then keeps its last
 * sighting WITH its age, which is the honest reading: the OS did not look
 * successfully today, and the operator can see how long it has been.
 *
 * Stamped with `requestedAt` — the run's own instant, the one every manifest row
 * from this sweep carries — rather than the wall clock at the end of it, so a
 * sweep's evidence is dated one way.
 */
async function refreshAccountCredit(
  env: IngestEnv, authorization: string, fetchImpl: typeof fetch, requestedAt: string,
  health: HealthConnection | null, observedAt: string,
): Promise<{ refreshed: boolean; monitoringAvailable: boolean }> {
  let read: Awaited<ReturnType<typeof readDataForSeoAccount>>;
  try { read = await readDataForSeoAccount(authorization, fetchImpl, ACCOUNT_TIMEOUT_MS); }
  catch {
    const monitoringAvailable = await observeIntegration(env, health, { capability: 'dataforseo-credit', observedAt, ok: false, code: 'network' });
    return { refreshed: false, monitoringAvailable };
  }
  const usable = read.ok && read.usd !== null;
  const monitoringAvailable = await observeIntegration(env, health, { capability: 'dataforseo-credit', observedAt, ok: usable, code: read.ok ? 'incomplete-report' : 'provider' });
  if (!read.ok || read.usd === null) return { refreshed: false, monitoringAvailable };
  try { await recordDataForSeoBalance(env, read.usd, requestedAt); }
  catch { return { refreshed: false, monitoringAvailable: false }; }
  return { refreshed: true, monitoringAvailable };
}

/**
 * Every report family this collector knows, in sweep order.
 *
 * `POST /api/signal-collect` validates a requested `families` list against THIS
 * array rather than a copy of it, so a family added above is requestable on
 * demand the same day and one removed stops being requestable immediately. A
 * hand-kept second list is precisely how a route comes to accept a name the
 * sweep no longer has.
 */
export const DATAFORSEO_REPORTS: readonly string[] = REPORTS.map(
  (report) => report.name,
);

/** Public, machine-readable cadence policy for routes, tests and operators. */
export const DATAFORSEO_REPORT_CADENCE_DAYS: Readonly<Record<string, number>> =
  Object.freeze(
    Object.fromEntries(
      REPORTS.map((report) => [report.name, report.cadenceDays]),
    ),
  );

/**
 * The families applicable to this property — the ones the weekly lane considers
 * before its freshness check, and exactly what an unfiltered scoped run forces.
 *
 * The route asks this before it runs anything, so `families: ['serp-panel']` for
 * a property with no `config/serp-panel.json` entry is a 422 naming the file,
 * not a run that quietly attempts nothing and reports a $0.00 success.
 */
export function dataForSeoFamiliesFor(
  asset: string,
  panel: SerpPanelConfig = SERP_PANEL_CONFIG,
): string[] {
  // Derived from the REPORTS registry and its per-family `appliesTo` — the only
  // authority on what this property can be asked for. It used to delegate to
  // the contract's `dataForSeoReportsFor`, which was the same answer only while
  // every family was weekly and part of the collection identity. Since
  // ro-cda6.2 those are two different questions: the contract says what a WEEK
  // OWES (and so must exclude the 28-day families, which are legitimately
  // absent from three report_dates in four), while this says what may be
  // REQUESTED. A periodic family that could not be named here would be
  // reachable only by waiting up to 28 days for its own cadence — no use to a
  // bet that launched on a Tuesday, which is why the scoped route exists.
  return REPORTS.filter(
    (report) => report.appliesTo?.(asset, panel) ?? true,
  ).map((report) => report.name);
}

interface PlannedReport {
  target: DataForSeoTarget;
  report: ReportSpec;
}

interface SkippedFreshReport {
  asset: string;
  report: string;
  latestReportDate: string;
  nextDueDate: string;
}

interface DueDataForSeoPlan {
  due: PlannedReport[];
  skippedFresh: SkippedFreshReport[];
}

/**
 * Every (property, family) this run owes, breadth first: all the single-call
 * families for every property, then the long ones.
 *
 * The old order was property-major, which put one asset's ~112-second
 * tracked panel between the first property and every other one. When the runtime
 * was restarted 92 seconds into that panel on 2026-08-03, the portfolio lost the
 * panel and four untouched properties with it — twenty families that cost
 * nothing and would have taken seconds (ro-q18). Cheap evidence should never
 * queue behind expensive evidence.
 *
 * ONE list, used by both the credential-missing path and the collecting path, so
 * "what this run owes" is decided in exactly one place — and, since ro-282.1, by
 * the weekly sweep and the on-demand route alike. `families` is the ONLY thing an
 * on-demand run changes about it, and the breadth-first ordering survives
 * narrowing: a single property still collects its cheap families before its
 * ~112-second panel.
 */
function sweepPlan(
  targets: DataForSeoTarget[],
  panel: SerpPanelConfig,
  families?: readonly string[],
): PlannedReport[] {
  const plan: PlannedReport[] = [];
  for (const long of [false, true]) {
    for (const target of targets) {
      for (const report of reportsFor(target.asset, panel, families)) {
        if ((report.longRunning === true) === long) plan.push({ target, report });
      }
    }
  }
  return plan;
}

/**
 * Filter an automated plan against durable collection evidence.
 *
 * The job-run ledger records whether a cron invocation returned; it does not
 * own provider freshness. A later manual or replayed collection can satisfy the
 * same weekly obligation, so startup catch-up consults the manifest that stores
 * the observation itself. Only `success` and `unchanged` count. Errors remain
 * due, never-archived families are due immediately, and a skip writes no fake
 * attempt row. Explicit scoped runs bypass this function by design.
 */
async function dueDataForSeoPlan(
  store: WorkspaceStore,
  fullPlan: PlannedReport[],
  reportDate: string,
): Promise<DueDataForSeoPlan> {
  if (fullPlan.length === 0) return { due: [], skippedFresh: [] };

  const rows = await store.read((tx) =>
    tx.query<{ asset: string; report: string; latestReportDate: string | null }>(
      `SELECT asset_id AS asset, report, max(report_date) AS "latestReportDate"
         FROM noticeos.archive_runs
        WHERE integration = 'dataforseo'
          AND status IN ('success','unchanged')
        GROUP BY asset_id, report`,
    ),
  );
  const latestByFamily = new Map(
    rows
      .filter(
        (row): row is typeof row & { latestReportDate: string } =>
          row.latestReportDate !== null,
      )
      .map((row) => [planKey(row.asset, row.report), row.latestReportDate]),
  );
  const due: PlannedReport[] = [];
  const skippedFresh: SkippedFreshReport[] = [];

  for (const item of fullPlan) {
    const latest = latestByFamily.get(
      planKey(item.target.asset, item.report.name),
    );
    if (
      latest === undefined ||
      wholeDaysBetween(latest, reportDate) >= item.report.cadenceDays
    ) {
      due.push(item);
      continue;
    }
    skippedFresh.push({
      asset: item.target.asset,
      report: item.report.name,
      latestReportDate: latest,
      nextDueDate: isoDateOffset(latest, item.report.cadenceDays),
    });
  }
  return { due, skippedFresh };
}

function planKey(asset: string, report: string): string {
  return `${asset}\u0000${report}`;
}

/** Whole UTC days from `from` to `to`. Unreadable stored evidence is treated as
 * infinitely old: collect visibly instead of letting a malformed date suppress
 * a paid lane forever. */
function wholeDaysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.round((end - start) / 86_400_000);
}

/** The families this property actually owns, in declaration order. A family
 * whose config does not cover the property is not "skipped with a reason" — it
 * is not one of its reports at all, so it never reaches the budget gate. This is
 * the ONLY path on which a family writes no attempt row, and it means the file
 * never named the property: every other outcome — missing credentials, the cap
 * gate, a provider failure, malformed panel config — is archived.
 *
 * `families`, when a scope carries one, narrows that set further. It can only
 * ever REMOVE families: a name outside this list selects nothing, and a name the
 * property's config does not cover is still filtered by `appliesTo` — so no
 * request can talk the collector into billing a family it does not own. */
function reportsFor(
  asset: string,
  panel: SerpPanelConfig,
  families?: readonly string[],
): ReportSpec[] {
  return REPORTS.filter(
    (report) =>
      (families === undefined || families.includes(report.name)) &&
      (report.appliesTo?.(asset, panel) ?? true),
  );
}

/**
 * The collector's membership rule, written once and asked two ways.
 *
 * There is no roster: a launched, non-OS property with a domain is collected the
 * moment it is seeded (ro-540.1). A scoped run asks the SAME question about one
 * property — the id is bound, never interpolated — so an on-demand request can
 * only reach a property the Monday lane would already collect, and can never
 * reach a second one. A property the store does not have, or that is pre-launch,
 * retired, OS or domainless, comes back empty here and the route turns that into
 * a 422 rather than an empty run. Asked of the site list on Postgres (bead
 * ro-ujb9.76.4.2).
 */
const CANDIDATE_WHERE = `SELECT asset_id AS asset, domain
     FROM noticeos.assets
    WHERE NOT is_os
      AND status NOT IN ('pre-launch','retired')
      AND domain IS NOT NULL`;
const CANDIDATES_ALL = `${CANDIDATE_WHERE} ORDER BY ${SITE_ORDER}`;
const CANDIDATE_ONE = `${CANDIDATE_WHERE} AND asset_id = $1`;

export async function dataForSeoCandidates(
  store: WorkspaceStore,
  asset: string | null = null,
): Promise<PortfolioCandidate[]> {
  return store.read((tx) =>
    asset === null ? tx.query<{ asset: string; domain: string }>(CANDIDATES_ALL) : tx.query<{ asset: string; domain: string }>(CANDIDATE_ONE, [asset]),
  );
}

export function dataForSeoTarget(
  candidate: PortfolioCandidate,
  credentialRef: string = CREDENTIAL_REF,
  laneRegister?: LaneRegister,
): DataForSeoTarget {
  const scope = resolveDataForSeoScope(candidate.asset, laneRegister);
  return {
    asset: candidate.asset,
    integration: 'dataforseo',
    credentialRef,
    propertyRef: normalizeDomain(candidate.domain),
    locationCode: scope.locationCode,
    languageCode: scope.languageCode,
    mappingSource: scope.source,
  };
}

async function collectReport(
  env: IngestEnv,
  target: DataForSeoTarget,
  spec: ReportSpec,
  reportDate: string,
  requestedAt: string,
  authorization: string,
  egress: EgressLane,
  panel: SerpPanelConfig,
  budget: RetryBudget,
  monitoring?: CollectionMonitoring,
): Promise<DataForSeoDumpOutcome> {
  const pages: DumpPage[] = [];
  let providerRows = 0;
  let costUsd = 0;
  let failedRequests = 0;
  let failedAttempts = 0;
  let resumedRequests = 0;
  let lastTaskError: SignalError | null = null;
  try {
    const objects = await signalObjectScope(env);
    // Built inside the boundary so a malformed panel is archived as this
    // property's `config_invalid` attempt rather than aborting the sweep.
    const requests = spec.requests(target, reportDate, panel);
    const priorAttempt = spec.independentRequests
      ? await latestDataForSeoAttempt(env.STORE, target.asset, spec.name, reportDate)
      : null;
    // One report date has one coherent panel. Re-firing it is always a repair,
    // never permission to rebuy its successful query/device pages. A new report
    // date naturally has different keys and starts fresh.
    const resumeCheckpoints = spec.independentRequests === true;
    // With no manifest, a killed request's spend has nowhere else to be counted;
    // a prior error manifest already recorded what that attempt paid.
    const checkpointCostsUnaccounted = priorAttempt === null;
    for (const { body, label } of requests) {
      const checkpointKey = resumeCheckpoints
        ? await dataForSeoCheckpointKey(env, target, spec, reportDate, body, label)
        : null;
      const checkpoint = checkpointKey
        ? await readDataForSeoCheckpoint(env.RAW_SIGNALS, checkpointKey, {
            asset: target.asset,
            report: spec.name,
            reportDate,
          }, objects)
        : null;
      if (checkpoint && checkpoint.taskError === null) {
        pages.push(checkpoint.page);
        providerRows += checkpoint.providerRows;
        if (checkpointCostsUnaccounted) costUsd += checkpoint.costUsd;
        resumedRequests += 1;
        continue;
      }

      const call = await callProvider(
        spec,
        body,
        authorization,
        egress,
        budget,
      );
      const parsed = parseProviderResponse(
        call.status,
        call.body,
        spec.name,
        spec.independentRequests === true,
      );
      const page: DumpPage = {
        request: {
          path: spec.path,
          body,
          attempts: call.attempts,
          ...(label === undefined ? {} : { label }),
        },
        response: call.body,
      };
      // Count the provider's bill before the checkpoint write: if durable
      // persistence itself fails, the error manifest still records what we paid.
      costUsd += parsed.costUsd;
      providerRows += parsed.providerRows;
      if (spec.independentRequests === true) {
        const key =
          checkpointKey ??
          (await dataForSeoCheckpointKey(env, target, spec, reportDate, body, label));
        await writeDataForSeoCheckpoint(env.RAW_SIGNALS, key, {
          schemaVersion: 1,
          asset: target.asset,
          report: spec.name,
          reportDate,
          requestHash: key.slice(key.lastIndexOf('/') + 1, -5),
          page,
          providerRows: parsed.providerRows,
          costUsd: parsed.costUsd,
          taskError: parsed.taskError
            ? { code: parsed.taskError.code, message: parsed.taskError.message }
            : null,
        }, objects);
      }
      // The response is archived verbatim either way: a task the provider could
      // not answer is evidence too, and it was billed. `attempts` rides with the
      // request so the archive says how hard this page was to get, and `label`
      // — present only where the panel named a cluster — so the observation
      // carries the bet it was placed on rather than borrowing today's answer
      // from config the next time anyone flattens it.
      pages.push(page);
      if (parsed.taskError) {
        failedRequests += 1;
        // The retry allowance belongs to the FAMILY, not one query. A panel
        // can therefore exhaust the three-attempt ladder as two unanswered
        // calls carrying 2 + 1 attempts. Count the failures the operator
        // actually endured across the partial panel; taking only the largest
        // per-call value would leave that settled provider fault orange.
        failedAttempts += call.attempts;
        lastTaskError = parsed.taskError;
      }
    }
    if (resumedRequests > 0) {
      console.log(
        JSON.stringify({
          event: 'dataforseo_checkpoint_resumed',
          asset: target.asset,
          report: spec.name,
          reportDate,
          resumedRequests,
          expectedRequests: requests.length,
        }),
      );
    }
    if (lastTaskError && failedRequests === pages.length) {
      // A panel with no answered page is not review evidence. Its checkpoints
      // still retain every paid response, but no archive is promoted.
      Object.assign(lastTaskError, { costUsd });
      throw lastTaskError;
    }
    const outcome = await archiveCollectedDump(env, {
      monitoring,
      provider: 'dataforseo',
      target,
      report: spec.name,
      reportDate,
      requestedAt,
      dataState: 'provider-snapshot',
      collected: {
        pages,
        providerRows,
        providerTruncated: providerTruncated(spec, providerRows),
      },
      providerCostUsd: costUsd,
    });
    if (lastTaskError && failedRequests > 0) {
      // Partial panels are useful and reviewable, but never silently healthy.
      // The success row keeps the archive/read path intact; a zero-cost error
      // marker written immediately after it keeps integration health degraded.
      // Spend belongs to the archive row only, so the marker cannot double it.
      const observed = pages.length - failedRequests;
      const exhausted = failedAttempts >= 3;
      const taskCode = lastTaskError.code.replace(/^dataforseo_task_/, '');
      // Counted values and the provider's own words (bead `ro-ujb9.96.6.27`):
      // the answered calls stay reviewable, which the lane's evidence shows.
      const partial = new SignalError(
        `dataforseo_partial_${taskCode}`,
        `${failedRequests} of ${pages.length} calls unanswered${exhausted ? ' after 3 attempts' : ''} · ` +
          `${observed} answered · DataForSEO: ${lastTaskError.message}`,
      );
      await archiveDumpFailure(env.STORE, {
        monitoring,
        target,
        report: spec.name,
        reportDate,
        requestedAt,
        dataState: 'provider-snapshot',
        error: partial,
        providerCostUsd: 0,
        knownZeroCost: true,
      });
      console.warn(
        JSON.stringify({
          event: 'dataforseo_partial_panel',
          asset: target.asset,
          reportDate,
          observedRequests: observed,
          failedRequests,
          failedAttempts,
          reviewable: true,
        }),
      );
    }
    return { ...outcome, costUsd, retries: budget.used };
  } catch (error) {
    // Requests already billed before the failure still count against the cap.
    const spent = Math.max(costUsd, providerCost(error));
    // THE UPLINK, NOT DATAFORSEO (bead `ro-aed0.3`). `callProvider` asked the
    // gate before granting any retry, so this is the cached verdict, not a new
    // probe. The family is unmeasured: named on the run's one `os-egress-down`
    // flag, still due, and — when nothing was paid — without a manifest at all.
    if (await egressExplains(egress.gate, egress.transport, error)) {
      if (spent <= 0) {
        return {
          ...unmeasuredDumpOutcome(egress.gate, target, spec.name, reportDate),
          costUsd: 0,
          retries: budget.used,
        };
      }
      // A panel whose first pages were paid for before the uplink went. That
      // money has to reach the monthly meter, which sums manifests, so the
      // attempt is written — in the OS's own words, and with no monitoring
      // context, so no Health observation blames the provider for it. An error
      // row never satisfies a cadence, so the family stays due, and a repair of
      // the same report date resumes the paid checkpoints instead of rebuying.
      const outcome = await archiveDumpFailure(env.STORE, {
        target,
        report: spec.name,
        reportDate,
        requestedAt,
        dataState: 'provider-snapshot',
        // The OS's own words, as values (bead `ro-ujb9.96.6.27`): offline, not
        // the provider, and the paid calls this row carries to the cap.
        error: new SignalError(
          EGRESS_DOWN_CODE,
          `Offline, not DataForSEO · ${pages.length} paid call${pages.length === 1 ? '' : 's'} kept · ${spent.toFixed(4)} USD counted`,
        ),
        providerCostUsd: spent,
      });
      egress.gate.recordUnmeasured(target.asset, spec.name);
      return { ...outcome, egressDown: true, costUsd: spent, retries: budget.used };
    }
    const normalized = normalizeSignalError(
      error,
      `DataForSEO ${spec.name} request failed.`,
    );
    const outcome = await archiveDumpFailure(env.STORE, {
      monitoring,
      target,
      report: spec.name,
      reportDate,
      requestedAt,
      dataState: 'provider-snapshot',
      error: retriedFailure(normalized, budget.used),
      providerCostUsd: spent,
    });
    return { ...outcome, costUsd: spent, retries: budget.used };
  }
}

type DataForSeoAttemptStatus = 'success' | 'unchanged' | 'error';

async function latestDataForSeoAttempt(
  store: WorkspaceStore,
  asset: string,
  report: DataForSeoReport,
  reportDate: string,
): Promise<DataForSeoAttemptStatus | null> {
  const [row] = await store.read((tx) =>
    tx.query<{ status: DataForSeoAttemptStatus }>(
      `SELECT status
         FROM noticeos.archive_runs
        WHERE asset_id = $1 AND integration = 'dataforseo'
          AND report = $2 AND report_date = $3::date
        ORDER BY finished_at DESC, run_id COLLATE "C" DESC
        LIMIT 1`,
      [asset, report, reportDate],
    ),
  );
  return row?.status ?? null;
}

/** Stable per request body, so a changed term/device config fetches only its new
 * members while identical paid pages from an interrupted run remain reusable. */
export async function dataForSeoCheckpointKey(
  env: IngestEnv,
  target: DataForSeoTarget,
  spec: Pick<ReportSpec, 'name' | 'path'>,
  reportDate: string,
  body: Record<string, unknown>,
  label?: string,
): Promise<string> {
  const objects = await signalObjectScope(env);
  const identity = JSON.stringify({ path: spec.path, body, label: label ?? null });
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity)),
  );
  const hash = [...digest]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return objects.key([
    DATAFORSEO_CHECKPOINT_PREFIX,
    encodeURIComponent(target.asset),
    reportDate,
    spec.name,
    `${hash}.json`,
  ].join('/'));
}

async function writeDataForSeoCheckpoint(
  bucket: R2Bucket,
  key: string,
  checkpoint: DataForSeoRequestCheckpoint,
  objects: SignalObjectScope,
): Promise<void> {
  if (!objects.owns(key)) throw new Error('Checkpoint owner is unavailable.');
  await bucket.put(key, JSON.stringify(checkpoint), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: {
      asset: checkpoint.asset,
      report: checkpoint.report,
      reportDate: checkpoint.reportDate,
      requestHash: checkpoint.requestHash,
      schemaVersion: String(checkpoint.schemaVersion),
      workspaceId: objects.workspaceId,
    },
  });
}

async function readDataForSeoCheckpoint(
  bucket: R2Bucket,
  key: string,
  expected: Pick<DataForSeoRequestCheckpoint, 'asset' | 'report' | 'reportDate'>,
  objects: SignalObjectScope,
): Promise<DataForSeoRequestCheckpoint | null> {
  if (!objects.owns(key)) throw new Error('Checkpoint owner is unavailable.');
  let object = await bucket.get(key);
  if (!object) {
    const legacy = await objects.legacyCheckpoint(key);
    if (legacy !== null) object = await bucket.get(legacy);
  }
  if (!object) return null;
  try {
    const value = JSON.parse(await object.text()) as Partial<DataForSeoRequestCheckpoint>;
    if (
      value.schemaVersion !== 1 ||
      value.asset !== expected.asset ||
      value.report !== expected.report ||
      value.reportDate !== expected.reportDate ||
      !value.page ||
      typeof value.page !== 'object' ||
      !Number.isFinite(value.providerRows) ||
      !Number.isFinite(value.costUsd) ||
      value.taskError === undefined
    ) {
      throw new Error('checkpoint shape does not match its key');
    }
    return value as DataForSeoRequestCheckpoint;
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'dataforseo_checkpoint_ignored',
        key,
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}

/** The stored reason, plus what the run already did about it. A row that says
 * only "HTTP 500" invites the operator to try again by hand; one that says the
 * OS tried twice more says the provider was down, not flaky. Silent when nothing
 * was retried — a failure that was never repeatable should not imply it was. */
function retriedFailure(error: SignalError, retries: number): SignalError {
  if (retries < 1) return error;
  const disclosed = new SignalError(
    error.code,
    `${error.message} Gave up after ${retries + 1} attempts.`,
  );
  Object.assign(disclosed, { costUsd: providerCost(error) });
  return disclosed;
}

/**
 * One provider call, repeated while the failure is about the CALL rather than
 * what we asked for.
 *
 * `budget` is shared by every request in the family and mutated as retries are
 * spent, so the ceiling is per family: a panel whose 28th query starts failing
 * cannot buy a fresh allowance because its first 27 succeeded.
 *
 * A transient response is returned rather than thrown once the budget is gone —
 * `parseProviderResponse` still owns turning a status into the right error, with
 * the message taken from whichever nesting level actually failed.
 */
async function callProvider(
  spec: ReportSpec,
  /** The planned request's `body` and only its body — the archive's page
   * envelope carries the rest, and none of it is the provider's business. */
  requestBody: Record<string, unknown>,
  authorization: string,
  egress: EgressLane,
  budget: RetryBudget,
): Promise<{ status: number; body: unknown; attempts: number }> {
  for (let attempts = 1; ; attempts += 1) {
    let delayMs: number | null = null;
    try {
      const response = await egress.transport.fetch(`${API_BASE}${spec.path}`, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
        },
        body: JSON.stringify([requestBody]),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // Read before the body, because a 429 that is about to be dropped for
      // being too far away still has to say how far away it was.
      const askedForMs = retryAfterWaitMs(
        response.status === 429 ? response.headers.get('retry-after') : null,
        Date.now(),
      );
      const body = await boundedResponseJson(response);
      if (!isTransientResponse(response.status, body)) {
        return { status: response.status, body, attempts };
      }
      delayMs = nextRetryDelay(budget, askedForMs);
      if (delayMs === null) return { status: response.status, body, attempts };
    } catch (error) {
      // ASK BEFORE SPENDING A RETRY (bead `ro-aed0.3`). A call that never came
      // back is transient only if the far side is what broke; when the OS's
      // own uplink is down, a second call hits the same wall, and the family
      // must be left due for the next run rather than burn its ladder here.
      delayMs =
        isTransientTransport(error) && !(await egressExplains(egress.gate, egress.transport, error))
          ? nextRetryDelay(budget)
          : null;
      if (delayMs === null) {
        Object.assign(error as object, { attempts });
        throw error;
      }
    }
    budget.used += 1;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

/** The retry allowance for ONE report family, spent across all its requests. */
interface RetryBudget {
  /** The wait before each retry, in order; its length is the ceiling. */
  readonly backoffMs: number[];
  /** Month-to-date metered spend as the family's budget gate saw it. */
  readonly monthSpendUsd: number;
  readonly monthlyCapUsd: number;
  /** Retries already spent by this family. */
  used: number;
}

/**
 * The wait before the next retry, or null when there must not be one.
 *
 * The gate before this family reserved ONE report's worth of the monthly cap.
 * A retry is another call the provider may charge for, so it reserves its own:
 * a retry may never be the call that crosses the cap, even though the attempt it
 * repeats was not billed. Fail closed — when the reserve does not fit, the family
 * fails with what it already knows rather than betting on the provider being
 * cheap this time.
 *
 * `askedForMs` is the provider's own answer to "when", read off a 429's
 * `Retry-After` (`ro-mr3`). It OUTRANKS the ladder, because the ladder is a guess
 * about a broken server and this is a fact about a rate window — but only up to
 * `RETRY_AFTER_CAP_MS`, past which there is no retry at all: waiting longer than
 * the cap is the sweep standing still, and a family that fails is collected
 * again by the next run. The ladder stays the FLOOR, so `Retry-After: 0` cannot
 * turn the repair into a hot loop against a provider that just said slow down.
 */
function nextRetryDelay(
  budget: RetryBudget,
  askedForMs: number | null = null,
): number | null {
  if (budget.used >= budget.backoffMs.length) return null;
  const reserved = (budget.used + 2) * MAX_REPORT_COST_USD;
  if (budget.monthSpendUsd + reserved > budget.monthlyCapUsd) return null;
  const ladderMs = budget.backoffMs[budget.used]!;
  if (askedForMs === null) return ladderMs;
  if (askedForMs > RETRY_AFTER_CAP_MS) return null;
  return Math.max(ladderMs, askedForMs);
}

/**
 * How long the provider asked us to wait, in milliseconds, or null when it did
 * not ask (or asked in something this cannot read).
 *
 * RFC 9110 allows both spellings and DataForSEO's own gateway has used the plain
 * one; a date already in the past is a wait of zero rather than a negative
 * number, which is the same "ask again now" the ladder's floor then bounds.
 * Anything unparseable is treated as no header at all — an unreadable hint must
 * not be able to cancel a retry the ladder would have made.
 */
export function retryAfterWaitMs(
  header: string | null,
  nowMs: number,
): number | null {
  if (header === null) return null;
  const text = header.trim();
  if (text === '') return null;
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - nowMs);
}

/**
 * A failure about the CALL, which a second call may not have. HTTP 5xx,
 * DataForSEO's own 5xxxx status codes, and its task-level 40101/40103 codes are
 * the provider reporting that its side broke — the 2026-08-03 backlinks blip
 * was exactly this, and the same two families had answered three days earlier.
 * The official appendix defines 40101 as an internal search-engine server error
 * and 40103 as a task that should be resubmitted, so neither is treated like a
 * malformed request merely because its numeric prefix is 4.
 *
 * 429 is the one 4xx that joins them (`ro-mr3`). Every other 4xx is about what we
 * ASKED FOR — a bad target, a malformed field, an expired credential — and would
 * fail identically on every attempt, so it still fails immediately. A rate limit
 * is about WHEN we asked: DataForSEO meters 2000 requests a minute, and the same
 * call a moment later is the call that works. It is retried on the provider's own
 * `Retry-After` rather than the collector's ladder, and only inside
 * `RETRY_AFTER_CAP_MS` — see `nextRetryDelay`.
 */
function isTransientResponse(status: number, body: unknown): boolean {
  if (status >= 500 || status === 429) return true;
  if (status < 200 || status >= 300) return false;
  const root = asRecord(body);
  const envelope = finiteNumber(root?.status_code);
  if (envelope !== null && envelope >= 50000 && envelope < 60000) return true;
  const taskStatus = finiteNumber(asRecord(arrayField(root, 'tasks')[0])?.status_code);
  return taskStatus === 40101 || taskStatus === 40103;
}

/** A call that produced no response at all: a dropped connection or our own
 * 130-second timeout. A SignalError here is `response_too_large` or
 * `response_invalid_json` — facts about what DID come back, which repeating
 * cannot change. */
function isTransientTransport(error: unknown): boolean {
  return !(error instanceof SignalError) && error instanceof Error;
}

/** An explicit "there is more than what is stored here". Both families that can
 * say it are bounded by our own cap, not the provider's. */
function providerTruncated(spec: ReportSpec, providerRows: number): boolean {
  if (spec.name === 'ranked-keywords') {
    return providerRows >= RANKED_KEYWORD_LIMIT;
  }
  // The panel reads two pages of a result set that always continues past them.
  return spec.name === 'serp-panel';
}

interface ParsedProviderResponse {
  providerRows: number;
  costUsd: number;
  /** Set instead of thrown when the caller retains independent requests. */
  taskError: SignalError | null;
}

/**
 * Transport and root-status problems always throw — the call itself is broken.
 * A task the provider accepted but could not answer is a fact about one request:
 * `retainTaskFailure` returns it so a multi-request family keeps the responses
 * it did get, and the caller decides whether losing all of them is an error.
 */
function parseProviderResponse(
  httpStatus: number,
  body: unknown,
  report: string,
  retainTaskFailure = false,
): ParsedProviderResponse {
  const root = asRecord(body);
  if (httpStatus < 200 || httpStatus >= 300) {
    throw new SignalError(
      `dataforseo_http_${httpStatus}`,
      providerFailureMessage(
        root,
        `DataForSEO ${report} returned HTTP ${httpStatus}.`,
      ),
    );
  }
  const statusCode = finiteNumber(root?.status_code);
  if (statusCode !== 20000) {
    throw new SignalError(
      `dataforseo_${statusCode ?? 'invalid_response'}`,
      providerFailureMessage(
        root,
        `DataForSEO ${report} returned an unsuccessful response.`,
      ),
    );
  }
  const rootCost = finiteNumber(root?.cost);
  const costUsd = rootCost ?? 0;
  const task = asRecord(arrayField(root, 'tasks')[0]);
  const taskStatus = finiteNumber(task?.status_code);
  const failed = (error: SignalError): ParsedProviderResponse => {
    Object.assign(error, { costUsd });
    if (!retainTaskFailure) throw error;
    return { providerRows: 0, costUsd, taskError: error };
  };
  if (taskStatus !== 20000) {
    return failed(
      new SignalError(
        `dataforseo_task_${taskStatus ?? 'invalid_response'}`,
        failureText(stringField(task, 'status_message')) ??
          `DataForSEO ${report} returned no successful task.`,
      ),
    );
  }
  const results = arrayField(task, 'result');
  const result = asRecord(results[0]);
  if (!result) {
    // The provider accepted the task, billed it, and positively reported that
    // it holds nothing for this target (`ro-qgn`). That is an ANSWER, not a
    // broken response: an asset registered 2026-08-02 and not yet
    // serving — failed one of 26 reports on the 2026-08-03 sweep with
    // `dataforseo_invalid_response` "returned no result", while every other
    // property's backlinks-summary succeeded. A domain the provider has never
    // crawled has no backlink summary row, and a lane that wears red for a
    // week over that is reporting our own reading, not the provider's.
    //
    // It archives as a zero-row collection so the verbatim body is STORED —
    // which is the other half of what this bead cost: a failure writes a
    // manifest row and no R2 object, so there was no body to inspect and the
    // shape had to be read back out of a 500-character error message.
    if (providerAnsweredEmpty(task, results)) {
      return {
        providerRows: 0,
        costUsd: rootCost ?? finiteNumber(task?.cost) ?? 0,
        taskError: null,
      };
    }
    // Anything else is a response we could not read — and now it says what it
    // actually carried, because the row is all a later reader will have.
    return failed(
      new SignalError(
        'dataforseo_invalid_response',
        `DataForSEO ${report} returned a task with no readable result ` +
          `(result_count ${finiteNumber(task?.result_count) ?? 'absent'}, ` +
          `result items ${results.length}).`,
      ),
    );
  }
  const declaredItems = finiteNumber(result.items_count);
  const nestedItems = arrayField(result, 'items').length;
  return {
    providerRows: Math.max(1, declaredItems ?? nestedItems),
    costUsd: rootCost ?? finiteNumber(task?.cost) ?? 0,
    taskError: null,
  };
}

/**
 * Did the provider say "nothing", or did it say something we cannot read?
 *
 * Empty means the `result` ARRAY is empty and the task's own `result_count`
 * either agrees or is absent — the provider counting its rows and reaching zero.
 * Everything else stays a failure: a `result` carrying a non-object (`[null]`),
 * or an empty array under a `result_count` that claims rows, is a response that
 * contradicts itself, and storing that as an empty success would turn "we could
 * not read the answer" into "the answer was nothing" — the exact absent-is-zero
 * reading doc 02 forbids.
 *
 * This is a claim about ONE task, so a multi-request family is unaffected: a
 * tracked query the provider answers with nothing is one zero-row page beside
 * the others, exactly as it already was.
 */
function providerAnsweredEmpty(
  task: Record<string, unknown> | null,
  results: unknown[],
): boolean {
  if (results.length !== 0) return false;
  const declared = finiteNumber(task?.result_count);
  return declared === null || declared === 0;
}

/** The provider's own words for a part that WORKED. DataForSEO says "Ok." at
 * every nesting level that succeeded, so none of these can ever be the reason
 * something failed — and a failed attempt that repeats one is worse than one
 * with no message at all, because it reads as a contradiction the operator has
 * to resolve. Compared without trailing punctuation or case. */
const PROVIDER_SUCCESS_PHRASES = new Set([
  'ok',
  'success',
  'successful',
  'task created',
  'task handed',
]);

/** A provider message only if it can be a failure's reason; otherwise null so
 * the caller states the failure in its own words. */
function failureText(message: string | null): string | null {
  if (message === null) return null;
  const normalized = message.trim().replace(/[.!]+$/, '').toLowerCase();
  return PROVIDER_SUCCESS_PHRASES.has(normalized) ? null : message;
}

/**
 * The message from the part that actually failed.
 *
 * DataForSEO nests statuses: the envelope reports whether the API accepted the
 * call, each task reports whether it could be answered. A 20000 "Ok." envelope
 * routinely wraps a task the provider could not answer — and it arrives that way
 * even when the transport itself returned 5xx. Reading `status_message` off the
 * envelope regardless is how one asset's backlinks families came to be
 * stored as `dataforseo_http_500` with the message "Ok.", which the Tower then
 * showed as the whole reason the lane was red.
 *
 * So: take the envelope's message only when the envelope is the thing that
 * failed, then the first failing task's, and otherwise say it plainly ourselves.
 */
function providerFailureMessage(
  root: Record<string, unknown> | null,
  fallback: string,
): string {
  if (finiteNumber(root?.status_code) !== 20000) {
    const envelope = failureText(stringField(root, 'status_message'));
    if (envelope) return envelope;
  }
  for (const entry of arrayField(root, 'tasks')) {
    const task = asRecord(entry);
    if (finiteNumber(task?.status_code) === 20000) continue;
    const message = failureText(stringField(task, 'status_message'));
    if (message) return message;
  }
  return fallback;
}

async function boundedResponseJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > RESPONSE_BYTE_LIMIT) {
    await response.body?.cancel();
    throw new SignalError(
      'response_too_large',
      `DataForSEO response exceeded ${RESPONSE_BYTE_LIMIT} bytes.`,
    );
  }
  if (!response.body) return {};

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > RESPONSE_BYTE_LIMIT) {
        await reader.cancel();
        throw new SignalError(
          'response_too_large',
          `DataForSEO response exceeded ${RESPONSE_BYTE_LIMIT} bytes.`,
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new SignalError(
      'response_invalid_json',
      'DataForSEO returned invalid JSON.',
    );
  }
}

function basicAuthorization(login: string, password: string): string {
  const bytes = new TextEncoder().encode(`${login}:${password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function normalizeDomain(value: string): string {
  try {
    const parsed = new URL(
      value.includes('://') ? value : `https://${value}`,
    );
    return parsed.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return value
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('/')[0]!;
  }
}

function isoDateOffset(date: string, days: number): string {
  const time = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(time)) {
    throw new SignalError('config_invalid', `Invalid report date "${date}".`);
  }
  return new Date(time + days * 86_400_000).toISOString().slice(0, 10);
}

function providerCost(error: unknown): number {
  if (!error || typeof error !== 'object') return 0;
  const value = (error as { costUsd?: unknown }).costUsd;
  return finiteNumber(value) ?? 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayField(
  record: Record<string, unknown> | null,
  field: string,
): unknown[] {
  const value = record?.[field];
  return Array.isArray(value) ? value : [];
}

function stringField(
  record: Record<string, unknown> | null,
  field: string,
): string | null {
  const value = record?.[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function finish(
  outcomes: DataForSeoDumpOutcome[],
  scope: DataForSeoCollectScope | null = null,
  skippedFresh: SkippedFreshReport[] = [],
  configSources?: ConfigSourceMap,
  creditRefreshed = false,
  egress?: EgressRunOutcome,
  recovery = false,
): DataForSeoDumpsResult {
  const result = {
    attempted: outcomes.length,
    succeeded: outcomes.filter((outcome) => outcome.status === 'success').length,
    unchanged: outcomes.filter((outcome) => outcome.status === 'unchanged').length,
    failed: outcomes.filter((outcome) => outcome.status === 'error').length,
    costUsd: outcomes.reduce((sum, outcome) => sum + outcome.costUsd, 0),
    outcomes,
    ...(egress ? { egress } : {}),
  };
  const measured = outcomes.filter((outcome) => !outcome.egressDown);
  console.log(
    JSON.stringify({
      event: 'dataforseo_dumps_complete',
      attempted: result.attempted,
      succeeded: result.succeeded,
      unchanged: result.unchanged,
      failed: result.failed,
      costUsd: Number(result.costUsd.toFixed(6)),
      // WHERE THIS RUN'S CONFIG CAME FROM (bead `ro-syok.7`) — the per-asset
      // scope and the tracked-query panel this sweep paid for, each `store`
      // when the run read the document an operator saved and `file` when it
      // read the copy compiled into this Worker. Never a tracked query itself.
      ...configSourceLine(configSources, [
        'config/integrations.json',
        'config/serp-panel.json',
      ]),
      skippedFresh,
      // WHETHER THE ACCOUNT CREDIT MOVED THIS RUN (bead `ro-vu8d.26`) — the word
      // and never the figure. What the operator needs from a log is whether the
      // number on the card is this week's or an older one; the amount itself is
      // on the card with its age, and a balance printed into a rotated,
      // shipped-around log file is a fact about somebody's account that no
      // reader of this line asked for.
      accountCredit: creditRefreshed ? 'refreshed' : 'not refreshed',
      // DataForSEO's failures only: a family the dead uplink swallowed is
      // counted in `failed` and `unmeasured`, never listed as the provider's.
      errors: measured
        .filter((outcome) => outcome.status === 'error')
        .map(({ asset, report, errorCode }) => ({ asset, report, errorCode })),
      unmeasured: outcomes.length - measured.length,
      // A family that only landed because the OS asked twice is not the same
      // fact as one that landed first time, and the difference is invisible in
      // the manifest row a success writes.
      retried: outcomes
        .filter((outcome) => outcome.retries > 0)
        .map(({ asset, report, status, retries }) => ({
          asset,
          report,
          status,
          retries,
        })),
      // Same tallies, same key order, same everything a weekly line carries —
      // plus, on an on-demand run only, what it was scoped to. The operator
      // reads this line to see what was billed, and "one property's panel" and
      // "the whole portfolio" must not look alike at $0.07 versus $1.60.
      ...(scope ? { scope: { asset: scope.asset, families: scope.families ?? null } } : {}),
      ...(recovery ? { recovery: true } : {}),
    }),
  );
  return result;
}
