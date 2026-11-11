import { PANEL_REVIEW_LABEL, PANEL_REVIEW_ASSET_KEY, PANEL_REVIEW_DATE_KEY, PANEL_REVIEW_VERSION_KEY, PANEL_REVIEW_ACTOR, panelReviewTitle, panelReviewDueDate, panelReviewPanelDate, invalidPanelReview, panelReviewAlreadyFiled, PANEL_DATE_RE } from '../panel-review-summary.mjs';
export { PANEL_REVIEW_LABEL, INVALID_PANEL_REVIEW_LABEL, PANEL_REVIEW_ASSET_KEY, PANEL_REVIEW_DATE_KEY, PANEL_REVIEW_DUE_DAYS, PANEL_REVIEW_ACTOR, PANEL_REVIEW_LIMIT, panelReviewTitle, panelReviewDueDate, panelReviewPanelDate, invalidPanelReview, panelReviewAlreadyFiled, panelReviewEntry } from '../panel-review-summary.mjs';
// runner/panel-review.mjs — the panel-review convention (one review task per
// property per collection day) and the hourly filer that files those tasks in
// Ntasks, in each property's own project. The snapshot poller
// (runner/task-snapshot.mjs) reads them by the same label.

import fs from 'node:fs/promises';
import path from 'node:path';
import { PANEL_FRESHNESS_FILE, PANEL_REPORTS_ROOT, panelReportPath, panelReportRelativePath } from '../signal-panel-paths.mjs';
import { isPanelVersion } from '../panel-versions.mjs';
import { readTaskProjectConfig } from '../task-project-config.mjs';
import { createHash } from 'node:crypto';
import { CONFIG, HOME_ROOT, OS_CHECKOUT } from './config.mjs';
import { isShuttingDown } from './lifecycle.mjs';
import { laneSkips, log } from './log.mjs';
import { taskBackend, taskLaneSkip } from './task-service-poll.mjs';
import { ntasksRegister } from './task-service-register.mjs';
import { operatorToken } from './operator-token.mjs';
import { readTaskProjectList } from './task-hub.mjs';
import { taskInstant, taskText } from '../task-snapshot-values.mjs';

// Panel-review filer — once an hour the runner asks ingest which
// properties have a fresh weekly DataForSEO collection, and files the review
// task into that property's Ntasks project if it is not already there. The
// tracked-query panel is one family of that collection, not the trigger: a
// property without one buys the other families and owes the same review.
//
// Idempotence comes from the data, not from a cursor. The pair that identifies
// a review is (property, collection day), and both halves are re-derivable —
// the day from the collection manifest, the "already filed?" answer from the
// project's own labelled tasks. A review is filed only after that read came
// back clean, under a retry key for the pair. Every failure path below
// continues without creating — a duplicate review is worse than a late one.
//
// Published before reviewed. A landing is evidence in the archive, not in the
// panel dir the review points at; the daily refresh puts it there on its own
// schedule. So a review is filed only once the published panel's
// freshness.json holds every family of that collection day. Until then the
// landing waits, said once per collection in the runner's log.

/** Where the runner asks what landed. A read; the Worker owns the store, this
 * process owns the spokes, and this URL is the seam. */
export function serpPanelLandingsUrl(config) {
  return `http://${config.ingestHost}:${config.ingestPort}/api/serp-panel-landings`;
}

/**
 * The landings this pass can act on. Anything without an asset and a
 * well-formed collection day is dropped rather than repaired: those two are
 * the identity of a review. `panel` decides the wording and the scope of the
 * review, never its identity; an endpoint that does not send the flag at all
 * only ever reported panel collections and always sized them, so a landing
 * carrying a query count is a panel.
 */
export function parsePanelLandings(body) {
  const rows = Array.isArray(body?.landings) ? body.landings : [];
  const seen = new Set();
  const landings = [];
  for (const row of rows) {
    const asset = taskText(row?.asset);
    const panelDate = taskText(row?.panelDate);
    if (asset === '' || !PANEL_DATE_RE.test(panelDate)) continue;
    // One landing per property — the newest. A second row for the same asset is
    // the endpoint misbehaving, and filing two reviews would be the loud way to
    // find that out.
    if (seen.has(asset)) continue;
    seen.add(asset);
    const queries = Number.isInteger(row?.queries) && row.queries >= 0 ? row.queries : null;
    const reports = Array.isArray(row?.reports) && row.reports.length > 0
      && row.reports.every((report) => typeof report === 'string' && report !== '')
      ? [...row.reports]
      : null;
    landings.push({
      asset,
      panelDate,
      landedAt: taskInstant(row?.landedAt),
      panel: typeof row?.panel === 'boolean' ? row.panel : queries !== null,
      queries,
      families: Number.isInteger(row?.families) && row.families > 0 ? row.families : null,
      reports,
    });
  }
  return landings;
}

/** The published panel's freshness.json for a property, or null when no
 * refresh has published one. */
export async function readPublishedFreshness(asset, version = null, root = PANEL_REPORTS_ROOT) {
  if (version !== null && !isPanelVersion(version)) throw new Error('Invalid published panel version.');
  try {
    return JSON.parse(await fs.readFile(path.join(version ? path.join(`${panelReportPath(asset, root)}.reports`, version) : panelReportPath(asset, root), PANEL_FRESHNESS_FILE), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** The published panel version the property's link names now, or null. A
 * review records it, so its reader opens the evidence it was filed on. */
export async function readPublishedVersion(asset, root = PANEL_REPORTS_ROOT) {
  try {
    const version = path.basename(await fs.readlink(panelReportPath(asset, root)));
    return isPanelVersion(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * Why the published panel does not yet hold this landing, or null when it does.
 *
 * The DataForSEO source must reach the collection day, and when both sides name
 * their families (a landing's `reports`, the source's `reports[]`), each family
 * of that day must too: a refresh that ran while the collection was still
 * landing published part of it. Either side written before the names existed
 * falls back to the source's newest day.
 */
export function panelPublicationGap(freshness, landing) {
  if (freshness === null || freshness === undefined) return 'no panel has been published';
  if (freshness.asset !== landing.asset || !Array.isArray(freshness.sources)) {
    return `the published ${PANEL_FRESHNESS_FILE} is not this asset's`;
  }
  const source = freshness.sources.find((row) => row?.key === 'dataforseo' && row.collected !== false);
  const newest = typeof source?.newestReportDate === 'string' ? source.newestReportDate : null;
  if (newest === null || newest < landing.panelDate) {
    return `the published panel's DataForSEO reaches ${newest ?? 'no day'}`;
  }
  if (landing.reports === null || !Array.isArray(source.reports)) return null;
  const published = new Map(
    source.reports
      .filter((row) => typeof row?.report === 'string' && typeof row.newestReportDate === 'string')
      .map((row) => [row.report, row.newestReportDate]),
  );
  const missing = landing.reports.filter((report) => !(published.get(report) >= landing.panelDate));
  return missing.length === 0 ? null : `the published panel lacks ${missing.join(', ')}`;
}

/** Where the reviewer reads the evidence: the version this review covers,
 * through NoticeOS's panel tools, and the same files on the OS's own machine. */
function panelSource(landing, osCheckout) {
  const version = landing.version ? ` version=${landing.version}` : '';
  return `In NoticeOS MCP, open get_panel asset=${landing.asset}${version} and read its attention list first. ` +
    `Use get_search_review if available and query_panel for detail on the same version. On the OS's own machine the files are in ${osCheckout} ` +
    `(${panelReportRelativePath(landing.asset)}/), and docs/20-signal-panels.md there is the read contract.`;
}

/** Tie the task to its published evidence and include roster checks only for a tracked panel. */
export function panelReviewDescription(landing, { osCheckout = OS_CHECKOUT } = {}) {
  const hasPanel = landing.panel !== false;
  // The manifest counts one request per term and device, not distinct terms.
  const size = Number.isInteger(landing.queries) ? ` (${landing.queries} result-page requests)` : '';
  const scope = hasPanel
    ? `tracked-query SERP panel${size} and weekly search inventory`
    : 'weekly search inventory';
  const table = hasPanel ? 'dataforseo_serp_panel, ' : '';
  const roster = hasPanel
    ? ' Compare observed term/device pairs with the roster saved for that collection. If it is unavailable, report observed coverage and leave expected pairs unknown. Keep organic ranks and AI Overview citations separate by device. Set aside rank and competitor conclusions when organic results are suspect.'
    : '';
  const settings = `Portfolio → ${landing.asset} → Settings → Tracked search terms`;
  const termDecision = hasPanel
    ? `Periodically use ${settings} to assess which paid terms still change a decision.`
    : `If an opportunity would benefit from recurring tracking, propose the term, decision and weekly cost for owner approval. The roster is under ${settings}.`;
  return [
    `WHAT: Review the ${landing.panelDate} ${scope} for ${landing.asset}. Check evidence and due readbacks, then recommend up to three material actions grouped by page or search intent. Zero actions is a valid outcome.`,
    'WHY: Use measured demand and user outcomes to decide where a small test could pay off and where to protect existing gains.',
    `WHERE: ${panelSource(landing, osCheckout)} Start with signal_trend_daily and the gsc_*, ga4_* and bing_webmaster_* tables. Use ${table}dataforseo_ranked_keywords, dataforseo_backlinks_* and dataforseo_llm_mentions_* as context. Work from stored evidence.`,
    [
      'FIX: Follow the weekly search review workflow in the panel read contract.',
      `1. Check freshness and coverage for each source. Compare equal, complete measured periods at the same level of detail. Record provisional, stale, capped and suspect evidence and omit it from conclusions it cannot support.${roster} Route material collection defects to the NoticeOS tracker and continue with independent evidence.`,
      '2. Check due readback tasks and standing protections. For each candidate surface, use git log on its content sources and record its measurement state and last content ship date and commit. Add evidence to the existing readback when an active window or recent change makes a verdict premature.',
      '3. Rank candidates by observed lost or attainable clicks, relevant outcomes, confidence and effort. Use modeled demand as a lead. For each selected action state the upside range, smallest test, success measure and stop rule. Include dollars only where supported. Annotate existing work before filing anything new.',
      `4. Record coverage and reasons for leaving groups alone, plus material exceptions. Read backlink and AI mention detail only when it changes a decision. ${termDecision}`,
    ].join('\n'),
    'Filed automatically by the OS runner (scripts/os-up.mjs) after publication.',
  ].join('\n\n');
}

const REVIEW_DECISIONS =
  'Summarize usable sources and comparison dates, grouped reasons for no action, and material exceptions. ' +
  'Record due readbacks and up to three prioritized actions or a reason to take zero. ' +
  'Link existing or new tasks for the actions and include evidence, upside, confidence, effort, a success measure and a stop rule. ' +
  'New work names the target measurement state and last content ship date and commit.';

export const COLLECTION_REVIEW_ACCEPTANCE = `Cite the pinned panel version. ${REVIEW_DECISIONS}`;
export const PANEL_REVIEW_ACCEPTANCE =
  'Cite the pinned panel version and summarize expected and observed term/device coverage or its limits. ' +
  REVIEW_DECISIONS;

/** Which bar this landing is held to. */
export function panelReviewAcceptance(hasPanel) {
  return hasPanel === false ? COLLECTION_REVIEW_ACCEPTANCE : PANEL_REVIEW_ACCEPTANCE;
}

/** The review filed in Ntasks (runner/task-service-register.mjs), due date
 * included, once per collection under a key for the project's prefix. */
export async function fileNtasksPanelReview(register, project, landing) {
  const key = 'panel-review:' + createHash('sha256').update(JSON.stringify(
    ['ntasks', project.prefix, landing.asset, landing.panelDate, [...new Set(landing.invalidated ?? [])].sort()])).digest('hex');
  const dueAt = panelReviewDueDate(landing.panelDate);
  return register.create(project, {
    title: panelReviewTitle(landing.asset, landing.panelDate, landing.panel !== false), type: 'task', priority: 2,
    labels: [PANEL_REVIEW_LABEL], ...(dueAt ? { dueAt } : {}),
    metadata: { [PANEL_REVIEW_ASSET_KEY]: landing.asset, [PANEL_REVIEW_DATE_KEY]: landing.panelDate,
      ...(landing.version ? { [PANEL_REVIEW_VERSION_KEY]: landing.version } : {}) },
    description: panelReviewDescription(landing), acceptance: panelReviewAcceptance(landing.panel !== false),
  }, key);
}

// `unmapped` is per-asset: a property with a panel and no spoke is a config
// gap somebody has to close once, not an hourly event. `waiting` is per
// collection, for the same reason.
const panelFilerState = { skipping: null, unmapped: new Set(), waiting: new Set() };

/**
 * One pass: ask what landed, file what is missing. Every dependency that
 * touches the world is injectable. Returns what it did, so a caller can see a
 * pass that filed nothing as distinct from one that never ran.
 */
export async function runPanelReviewFiler(runtime, deps = {}) {
  const {
    readConfig = () => readTaskProjectConfig({ repoRoot: HOME_ROOT }),
    readToken = operatorToken,
    get = fetch,
    readPublished = readPublishedFreshness,
    readVersion = readPublishedVersion,
    state = panelFilerState,
    emit = log,
    stopped = () => isShuttingDown(),
    taskService = null,
  } = deps;

  const { skip, resume } = laneSkips('panel review filer', state, emit);

  if (stopped()) return null;
  // The tower's child hosts both Workers, so its readiness is the ingest's.
  if (!runtime.running || !runtime.ready) return skip('ingest is down/restarting');
  const standDown = taskLaneSkip(await taskBackend(taskService), 'file reviews');
  if (standDown) return skip(standDown);
  const register = ntasksRegister(taskService, PANEL_REVIEW_ACTOR);
  const { projects, unreadable } = await readTaskProjectList(readConfig);
  if (unreadable) return skip(unreadable);
  if (projects.length === 0) return skip('no task projects are configured');

  const token = await readToken().catch(() => null);
  if (!token) return skip('no OPERATOR_TOKEN is configured for the ingest worker');

  let landings;
  try {
    const res = await get(serpPanelLandingsUrl(CONFIG), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return skip(`the panel landings read returned HTTP ${res.status}`);
    landings = parsePanelLandings(await res.json());
  } catch (err) {
    return skip(`the panel landings read failed (${err.message})`);
  }
  resume();

  const spokes = new Map(projects.map((project) => [project.asset, project]));
  const filed = [];
  let checked = 0;

  for (const landing of landings) {
    const project = spokes.get(landing.asset);
    if (!project) {
      // A property with a collection and no tracker cannot hold a review task.
      // One line, once: it is a config gap somebody closes by hand.
      if (!state.unmapped.has(landing.asset)) {
        state.unmapped.add(landing.asset);
        emit(
          'WARN',
          `panel review: ${landing.asset} has a ${landing.panelDate} collection but no spoke ` +
            `in config/beads.json — no review filed (silent until that changes)`,
        );
      }
      continue;
    }
    state.unmapped.delete(landing.asset);

    let rows;
    try { rows = await register.labelled(project, PANEL_REVIEW_LABEL); }
    catch (err) {
      emit('ERROR', `panel review: ${landing.asset} — the Ntasks review list could not be read: ${err.message}`);
      continue;
    }
    checked += 1;
    if (panelReviewAlreadyFiled(rows, landing.panelDate)) continue;

    const version = await readVersion(landing.asset).catch(() => null);
    let gap;
    try {
      gap = isPanelVersion(version)
        ? panelPublicationGap(await readPublished(landing.asset, version), landing)
        : 'the published panel has no immutable version';
    } catch (err) {
      emit('ERROR', `panel review: ${landing.asset} — the published panel is unreadable: ${err.message}`);
      continue;
    }
    const waiting = (state.waiting ??= new Set());
    const collection = `${landing.asset}\0${landing.panelDate}`;
    if (gap !== null) {
      if (!waiting.has(collection)) {
        waiting.add(collection);
        emit(
          'WARN',
          `panel review: ${landing.asset}'s ${landing.panelDate} collection waits for the ` +
            `panel refresh — ${gap} (silent until it is published)`,
        );
      }
      continue;
    }
    waiting.delete(collection);

    let beadId;
    try { beadId = await fileNtasksPanelReview(register, project, { ...landing, version,
      invalidated: rows.filter(row => invalidPanelReview(row) && panelReviewPanelDate(row) === landing.panelDate)
        .map(row => taskText(row.id)).filter(Boolean),
    }); }
    catch (error) {
      emit('ERROR', `panel review: ${landing.asset} — review create failed: ${error.message}`);
      continue;
    }
    filed.push({ asset: landing.asset, panelDate: landing.panelDate, beadId });
    emit(
      'INFO',
      `panel review filed — ${beadId} in Ntasks: ` +
        `"${panelReviewTitle(landing.asset, landing.panelDate, landing.panel !== false)}", due ${panelReviewDueDate(landing.panelDate)}`,
    );
  }

  return { checked, filed };
}
