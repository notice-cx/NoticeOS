import { PANEL_REVIEW_LABEL, INVALID_PANEL_REVIEW_LABEL, PANEL_REVIEW_ASSET_KEY, PANEL_REVIEW_DATE_KEY, PANEL_REVIEW_DUE_DAYS, PANEL_REVIEW_ACTOR, PANEL_REVIEW_LIMIT, panelReviewTitle, panelReviewDueDate, panelReviewListArgs, panelReviewPanelDate, invalidPanelReview, panelReviewAlreadyFiled, panelReviewEntry, PANEL_DATE_RE } from '../panel-review-summary.mjs';
export { PANEL_REVIEW_LABEL, INVALID_PANEL_REVIEW_LABEL, PANEL_REVIEW_ASSET_KEY, PANEL_REVIEW_DATE_KEY, PANEL_REVIEW_DUE_DAYS, PANEL_REVIEW_ACTOR, PANEL_REVIEW_LIMIT, panelReviewTitle, panelReviewDueDate, panelReviewListArgs, panelReviewPanelDate, invalidPanelReview, panelReviewAlreadyFiled, panelReviewEntry } from '../panel-review-summary.mjs';
// runner/panel-review.mjs — the panel-review convention (one review bead per
// property per collection day) and the hourly filer that writes those beads
// into each property's own tracker. The snapshot poller
// (runner/task-snapshot.mjs) reads them with the same query.

import fs from 'node:fs/promises';
import path from 'node:path';
import { checkoutRelative, installationPath } from '../installation.mjs';
import { PANEL_FRESHNESS_FILE, panelReportPath, panelReportRelativePath } from '../signal-panel-paths.mjs';
import { readTaskProjectConfig } from '../task-project-config.mjs';
import { CONFIG, HOME_ROOT, OS_CHECKOUT } from './config.mjs';
import { isShuttingDown } from './lifecycle.mjs';
import { log } from './log.mjs';
import { operatorToken } from './operator-token.mjs';
import {
  beadsCreatedId,
  beadsFailure,
  beadsInstant,
  beadsSkipDecision,
  beadsText,
  checkBeadsHub,
  parseBeadsProjects,
  runBd,
} from './task-hub.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// Panel-review filer — one of the two lanes here that WRITE a bead (the
// push-state filer below is the other; it is the only one that also closes).
//
// A weekly DataForSEO collection lands in the archive (doc 08 §S1b) and nothing
// asks anybody to read it. This closes that: once an hour the runner asks ingest
// which properties have a fresh collection, and files the review bead into that
// property's own spoke if it is not already there. The S1b panel is one family
// of that collection, not the trigger (ro-478) — a property without one buys the
// other five and owes the same review.
//
// IDEMPOTENCE COMES FROM THE DATA, NOT FROM A CURSOR. The pair that identifies
// a review is (property, collection day), and both halves are re-derivable — the
// day from the collection manifest, the "already filed?" answer from the spoke
// itself. So there is no state file to corrupt, no "last seen" to reset:
// a runner that was asleep when the collection landed files it on its next pass,
// and a runner that files it and then runs a hundred more passes creates nothing.
//
// The write is deliberately narrow: `bd create` in one repo, and only after a
// `bd list` in that same repo came back clean. Every failure path below
// continues WITHOUT creating — a duplicate review is worse than a late one, and
// the next pass is an hour away.
//
// PUBLISHED BEFORE REVIEWED (epic ro-cvl9). A landing is evidence in the
// archive, not in the panel dir the review points at; the daily refresh puts
// it there on its own schedule. So a review is filed only once the published
// panel's freshness.json holds every family of that collection day. Until then
// the landing waits, said once per collection in the runner's log.
// ─────────────────────────────────────────────────────────────────────────────

/** Where the runner asks what landed. A read; the Worker owns the store, this
 * process owns the spokes, and this URL is the seam. */
export function serpPanelLandingsUrl(config) {
  return `http://${config.ingestHost}:${config.ingestPort}/api/serp-panel-landings`;
}

/**
 * The landings this pass can act on.
 *
 * Anything without an asset and a well-formed collection day is dropped rather
 * than repaired: those two ARE the identity of a review, and a filer that
 * guesses at either would file a bead nothing can later recognize as already
 * filed.
 *
 * `panel` decides the wording and the scope of the review, never its identity.
 * An endpoint that does not send the flag at all — an ingest deployed before
 * ro-478, which this process can outlive by a restart — is read the way that
 * ingest meant it: it only ever reported panel collections, and it always sized
 * them, so a landing carrying a query count is a panel.
 */
export function parsePanelLandings(body) {
  const rows = Array.isArray(body?.landings) ? body.landings : [];
  const seen = new Set();
  const landings = [];
  for (const row of rows) {
    const asset = beadsText(row?.asset);
    const panelDate = beadsText(row?.panelDate);
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
      landedAt: beadsInstant(row?.landedAt),
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
export async function readPublishedFreshness(asset) {
  try {
    return JSON.parse(await fs.readFile(path.join(panelReportPath(asset), PANEL_FRESHNESS_FILE), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
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
    return `the published ${PANEL_FRESHNESS_FILE} is not this property's`;
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

/** What the reviewer is being asked to do, written for somebody standing in the
 * PROPERTY's repo — every path is qualified, because none of these files are
 * theirs.
 *
 * Two forms, because a property with no panel has no panel walk to do: asking
 * it to "walk every tracked query" against a file that does not exist is how a
 * reviewer learns the bead is boilerplate. What it gets instead is the whole
 * Inventory pass and one thing the panel properties do not need — the standing
 * option of earning a panel, which is the only way a property ever gets one. */
export function panelReviewDescription(landing, { osCheckout = OS_CHECKOUT, installation = { root: HOME_ROOT } } = {}) {
  const exportPath = (name) => {
    const file = checkoutRelative(installationPath(name, installation), installation);
    return path.isAbsolute(file) ? file : `${osCheckout}/${file}`;
  };
  const settings = `NoticeOS: Sites → ${landing.asset} → Settings → Tracked search terms`;
  const exports = { terms: exportPath('serp-panel.json'), roster: exportPath('signal-panels.json') };
  if (landing.panel === false) return collectionReviewDescription(landing, osCheckout, settings, exports);
  // The landing's `queries` field counts PROVIDER CALLS, and since ro-o1n the
  // panel buys one call per (tracked term, DEVICE) — so a 28-term panel reports
  // 56. Calling that "56 tracked queries" put this bead in open disagreement
  // with config/serp-panel.json, which the same bead hands the reviewer as the
  // list of terms: they count 28 there, read 56 here, and have to work out which
  // register is lying (ro-1b0.3). Neither was. The number is right about the
  // WORK — the panel CSV really does hold one row per term per device — and
  // wrong about the WORD.
  //
  // It is NOT divided back into terms here, because the device count does not
  // ride on the wire: the manifest has no device column and gets none (that is
  // what let ro-o1n land without a migration), so a filer that guessed at two
  // devices would be inventing a denominator. So the count is named for what it
  // honestly is — result pages — and the term list stays where it is authored.
  const size =
    landing.queries === null
      ? 'every result page in the panel'
      : `all ${landing.queries} collected result pages`;
  return [
    `WHAT: The ${landing.panelDate} tracked-query SERP panel for ${landing.asset} has ` +
      `landed, and the rest of that week's collection landed with it. Triage BOTH, ` +
      `through the ${osCheckout} playbook docs/playbooks/serp-opportunity-execution.md: ` +
      `(1) the panel — walk ${size} (one per tracked term per device; the terms ` +
      `themselves are saved under ${settings}) through the ` +
      `decision rules ("Panel review"); ` +
      `(2) the week's other fresh collections in the same panel dir — the ranked-keywords ` +
      `inventory, backlinks new/lost, the two LLM-mention families, and this property's ` +
      `own GSC / GA4 / Bing exports ("Inventory pass"). Every demand-vs-position gap, ` +
      `decay signal, or new-opportunity cluster becomes a bead in THIS tracker; every row ` +
      `that produces no bead gets the rule that closed it, named (institution-locked, ` +
      `AIO-cites-us-protect, too-young-to-read). A finding that maps to work already open ` +
      `is annotated on that bead, not filed again. Before any surface gets a verdict, ` +
      `read THIS property's docs/freeze-register.md and run git log over the content ` +
      `sources that produce that surface. A new bead must state the freeze state and ` +
      `last ship date/commit; a target changed inside its measurement window is ` +
      `too-recently-changed-to-verdict, so annotate the evidence on the freeze entry's ` +
      `readback bead instead of filing new copy work.`,
    `WHY: The panel is bought every week to surface demand worth building against. A ` +
      `collection nobody triages is money spent on a report nobody reads — and the gap it ` +
      `would have named goes on costing traffic for every week it stays unread. The panel ` +
      `is the metered part; the rest is already paid for and answers what the panel's ` +
      `chosen terms cannot — what this property ranks for AT ALL, who is linking to it, ` +
      `and whether the models mention it.`,
    `WHERE: the property's panel dir in ${osCheckout} ` +
      `(${panelReportRelativePath(landing.asset)}/) — read freshness.json FIRST, ` +
      `docs/20-signal-panels.md is the read contract. The panel is ` +
      `dataforseo-serp-panel.csv; the inventory is dataforseo-ranked-keywords.csv; then ` +
      `dataforseo-backlinks-*.csv, dataforseo-llm-mentions-*.csv, and the gsc-*, ga4-*, ` +
      `bing-webmaster-* exports. The dir is kept current by the daily panel refresh, so ` +
      `nothing needs pulling. Read the saved terms at ${settings}. For a current local ` +
      `export, run pnpm config:export in ${osCheckout}; the terms are exported to ${exports.terms}. ` +
      `Measurement state is in THIS property's docs/freeze-register.md; surface recency ` +
      `comes from git log in this repo, scoped to the content source paths rather than ` +
      `the repository as a whole.`,
    `Filed automatically by the OS runner (scripts/os-up.mjs) when the collection ` +
      `landed.`,
  ].join('\n\n');
}

/** The same ask for a property with no tracked-query panel (ro-478): the
 * Inventory pass IS the review, and the panel is named only as something this
 * property could earn. */
function collectionReviewDescription(landing, osCheckout, settings, exports) {
  const bought =
    landing.families === null
      ? `this week's DataForSEO report families`
      : `${landing.families} DataForSEO report families`;
  return [
    `WHAT: The ${landing.panelDate} signal collection for ${landing.asset} has landed — ` +
      `${bought} plus this property's own GSC / GA4 / Bing exports. Triage it through the ` +
      `${osCheckout} playbook docs/playbooks/serp-opportunity-execution.md §"Inventory pass": ` +
      `the ranked-keywords inventory (what do we rank for AT ALL — cluster by URL, look at ` +
      `pages ranking 11-60 with real demand), backlinks summary and new/lost (is authority ` +
      `moving?), the two LLM-mention families (do the models mention us?), and the ` +
      `property's own reported clicks and impressions (what did it actually get?). Every ` +
      `demand-vs-position gap, decay signal, or new-opportunity cluster becomes a bead in ` +
      `THIS tracker; every finding that produces no bead gets the rule that closed it, ` +
      `named (institution-locked, AIO-cites-us-protect, too-young-to-read). A finding that ` +
      `maps to work already open is annotated on that bead, not filed again. Before any ` +
      `surface gets a verdict, read THIS property's docs/freeze-register.md and run git ` +
      `log over the content sources that produce that surface. A new bead must state the ` +
      `freeze state and last ship date/commit; a target changed inside its measurement ` +
      `window is too-recently-changed-to-verdict, so annotate the evidence on the freeze ` +
      `entry's readback bead instead of filing new copy work.`,
    `WHY: This collection has no tracked-query SERP panel, and the property buys the ` +
      `rest of the collection every week anyway. Check its current saved terms at ${settings}. ` +
      `A collection nobody triages is money spent on a report nobody reads, and the gap it ` +
      `would have named goes on costing traffic for every week it stays unread. If the ` +
      `inventory surfaces head terms worth watching every week, adding them through that ` +
      `Settings section is a legitimate outcome of this review — that is how a ` +
      `property earns a panel, and the next review would then carry the panel walk too.`,
    `WHERE: the property's panel dir in ${osCheckout} ` +
      `(${panelReportRelativePath(landing.asset)}/) — read freshness.json FIRST, ` +
      `docs/20-signal-panels.md is the read contract. The inventory is ` +
      `dataforseo-ranked-keywords.csv; then dataforseo-backlinks-*.csv, ` +
      `dataforseo-llm-mentions-*.csv, and the gsc-*, ga4-*, bing-webmaster-* exports. The ` +
      `dir is kept current by the daily panel refresh, so nothing needs pulling. No ` +
      `freshness.json calls for checking Panel refresh in the same Settings section. ` +
      `Run pnpm config:export in ${osCheckout} for current local exports: tracked terms ` +
      `in ${exports.terms}, refresh roster in ${exports.roster}. A missing or failed ` +
      `refresh needs investigation; that is a bead in the OS's own tracker, not a ` +
      `reason to close this one. Measurement state is in THIS property's ` +
      `docs/freeze-register.md; surface recency comes from git log in this repo, scoped ` +
      `to the content source paths rather than the repository as a whole.`,
    `Filed automatically by the OS runner (scripts/os-up.mjs) when the collection ` +
      `landed.`,
  ].join('\n\n');
}

/** What "done" means — the same bar the playbook's reference close met. */
export const PANEL_REVIEW_ACCEPTANCE =
  'Every panel row, and every finding in the week\'s other collections, ends in either a ' +
  'bead in this tracker, an annotation on existing work, an evidence-to-readback ' +
  'annotation for an active freeze, or a no-action note naming the rule that closed it. ' +
  'Every filed bead names the target surface\'s freeze state and last content ship ' +
  'date/commit; this bead closes with a reason listing the beads filed, beads annotated, ' +
  'readback beads updated, and rows deliberately left alone.';

/** The same bar with the half this property does not have removed. A criterion
 * naming panel rows a panel-less review can never produce is a criterion that
 * gets closed by ignoring it. */
export const COLLECTION_REVIEW_ACCEPTANCE =
  'Every finding in the week\'s collection — ranked keywords, backlinks, LLM mentions, ' +
  'and the property\'s own GSC / GA4 / Bing exports — ends in either a bead in this ' +
  'tracker, an annotation on existing work, an evidence-to-readback annotation for an ' +
  'active freeze, or a no-action note naming the rule that closed it. Every filed bead ' +
  'names the target surface\'s freeze state and last content ship date/commit; this bead ' +
  'closes with a reason listing the beads filed, beads annotated, readback beads updated, ' +
  'and findings deliberately left alone.';

/** Which bar this landing is held to. */
export function panelReviewAcceptance(hasPanel) {
  return hasPanel === false ? COLLECTION_REVIEW_ACCEPTANCE : PANEL_REVIEW_ACCEPTANCE;
}

/**
 * The bead, as argv.
 *
 * Type and priority are stated rather than left to `bd`'s defaults: this argv
 * is what every property's tracker will fill up with, and a default that
 * changes upstream must not quietly re-grade a year of review beads.
 *
 * A panel day we cannot turn into a due date files WITHOUT one rather than
 * failing — a review with no deadline still beats no review — but
 * `parsePanelLandings` has already made that unreachable.
 */
export function panelReviewCreateArgs(repoDir, landing) {
  const due = panelReviewDueDate(landing.panelDate);
  return [
    '-C',
    repoDir,
    '--actor',
    PANEL_REVIEW_ACTOR,
    'create',
    panelReviewTitle(landing.asset, landing.panelDate, landing.panel !== false),
    '--type',
    'task',
    '--priority',
    '2',
    '--labels',
    PANEL_REVIEW_LABEL,
    ...(due === null ? [] : ['--due', due]),
    // The identity, and the ONLY part of this bead that is a contract: the same
    // two keys whether or not a panel landed, so the label + metadata pair a
    // reader (the poller, the Tower) matches on never depends on the wording.
    '--metadata',
    JSON.stringify({
      [PANEL_REVIEW_ASSET_KEY]: landing.asset,
      [PANEL_REVIEW_DATE_KEY]: landing.panelDate,
    }),
    '--description',
    panelReviewDescription(landing),
    '--acceptance',
    panelReviewAcceptance(landing.panel !== false),
    '--json',
  ];
}

/** The panel filer's name for the same reader, kept because this lane's
 * vocabulary block is a contract other readers navigate by name. */
export const panelReviewCreatedId = beadsCreatedId;

// One WARN per outage, like the poller's. `unmapped` is separate and per-asset:
// a property with a panel and no spoke is a config gap somebody has to close
// once, not an hourly event. `waiting` is per collection, for the same reason.
const panelFilerState = { skipping: null, unmapped: new Set(), waiting: new Set() };

/**
 * One pass: ask what landed, file what is missing.
 *
 * Every dependency that touches the world is injectable, for the same reason as
 * the poller's — what this does when something is missing IS the behavior, and
 * none of it is reachable from a test that has to spawn `bd` against a real
 * property tracker.
 *
 * Returns what it did, so a caller (and a test) can see a pass that filed
 * nothing as distinct from one that never ran.
 */
export async function runPanelReviewFiler(runtime, deps = {}) {
  const {
    probe = () => checkBeadsHub(),
    readConfig = () => readTaskProjectConfig({ repoRoot: HOME_ROOT }),
    readToken = operatorToken,
    run = runBd,
    get = fetch,
    readPublished = readPublishedFreshness,
    state = panelFilerState,
    emit = log,
    stopped = () => isShuttingDown(),
  } = deps;

  const skip = (reason) => {
    if (beadsSkipDecision(state, reason)) {
      emit('WARN', `panel review filer skipped — ${reason} (silent until it changes)`);
    }
  };

  if (stopped()) return null;
  // The tower's child hosts BOTH Workers now, so its readiness is the ingest's:
  // there is no separate ingest process left to ask.
  if (!runtime.running || !runtime.ready) {
    skip('ingest is down/restarting');
    return null;
  }
  if (!(await probe())) {
    skip('the beads task hub is unreachable');
    return null;
  }

  let raw;
  try {
    raw = await readConfig();
  } catch (err) {
    skip(`the task map is unreadable (${err.message})`);
    return null;
  }
  const projects = parseBeadsProjects(raw);
  if (projects.length === 0) {
    skip('no beads spokes are configured');
    return null;
  }

  const token = await readToken().catch(() => null);
  if (!token) {
    skip('no OPERATOR_TOKEN is configured for the ingest worker');
    return null;
  }

  let landings;
  try {
    const res = await get(serpPanelLandingsUrl(CONFIG), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      skip(`the panel landings read returned HTTP ${res.status}`);
      return null;
    }
    landings = parsePanelLandings(await res.json());
  } catch (err) {
    skip(`the panel landings read failed (${err.message})`);
    return null;
  }

  if (state.skipping !== null) {
    emit('INFO', `panel review filer resumed (was skipped: ${state.skipping})`);
    state.skipping = null;
  }

  const spokes = new Map(projects.map((project) => [project.asset, project]));
  const filed = [];
  let checked = 0;

  for (const landing of landings) {
    const project = spokes.get(landing.asset);
    if (!project) {
      // A property with a collection and no tracker cannot hold a review bead.
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
    if (project.unavailableReason) {
      emit('WARN', `panel review: ${project.unavailableReason}`);
      continue;
    }
    const repoDir = path.resolve(HOME_ROOT, project.repo);

    let existing;
    try {
      existing = await run(panelReviewListArgs(repoDir));
    } catch (err) {
      emit('ERROR', `panel review: ${landing.asset} — bd list could not run: ${err.message}`);
      continue;
    }
    if (existing.code !== 0) {
      emit('ERROR', `panel review: ${landing.asset} — ${beadsFailure('panel review list', existing)}`);
      continue;
    }
    let rows;
    try {
      rows = JSON.parse(existing.stdout);
    } catch {
      emit(
        'ERROR',
        `panel review: ${landing.asset} — bd returned unparseable JSON; filing nothing`,
      );
      continue;
    }
    checked += 1;
    if (panelReviewAlreadyFiled(rows, landing.panelDate)) continue;

    let gap;
    try {
      gap = panelPublicationGap(await readPublished(landing.asset), landing);
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

    let created;
    try {
      created = await run(panelReviewCreateArgs(repoDir, landing));
    } catch (err) {
      emit('ERROR', `panel review: ${landing.asset} — bd create could not run: ${err.message}`);
      continue;
    }
    if (created.code !== 0) {
      emit('ERROR', `panel review: ${landing.asset} — ${beadsFailure('panel review create', created)}`);
      continue;
    }
    const beadId = panelReviewCreatedId(created.stdout);
    filed.push({ asset: landing.asset, panelDate: landing.panelDate, beadId });
    emit(
      'INFO',
      `panel review filed — ${beadId ?? '(id unread)'} in ${project.repo}: ` +
        `"${panelReviewTitle(landing.asset, landing.panelDate, landing.panel !== false)}", due ` +
        `${panelReviewDueDate(landing.panelDate)}`,
    );
  }

  return { checked, filed };
}
