#!/usr/bin/env node
// signal-panels-refresh.mjs — keep every rostered property's panel dir current.
//
// This is the lane that turns `.local/signal-dumps/reports/<asset>/` from
// "whatever the operator last pulled by hand" into a STANDING source a property
// repo can read without touching a provider API (docs/20-signal-panels.md).
//
// One pass per property downloads only new archives through the ingest door,
// publishes their Parquet history, then analyzes one pinned generation in a
// bounded child. Reports, daily trend and source freshness become visible in
// one atomic publication, followed by the compact advisory snapshot in Tower.
// No provider APIs or database credentials are used here.
//
// Run by hand:  pnpm signals:refresh
//               pnpm signals:refresh -- --asset example.com
// Run by the runner: scripts/runner/config.mjs CONFIG.panelRefreshCron.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { holdLock, publishSignalHistory } from './signal-history.mjs';
import { DEFAULT_LIMITS, analyzeSignalHistory, storedSearchMarket } from './signal-history-analyze.mjs';
import { PANEL_FRESHNESS_FILE, PANEL_HISTORY_ROOT, PANEL_REPORTS_DIRECTORY, PANEL_REPORTS_ROOT, panelReportPath } from './signal-panel-paths.mjs';
import { publishExecutiveSnapshot } from './signal-insights-publish.mjs';
import { DEFAULT_DOOR, doorUrl, operatorToken } from './ingest-door.mjs';
import { readConfigSnapshot } from './config-store-client.mjs';
import { BING_AI_INTEGRATION, BING_AI_REPORTS } from '../packages/contract/src/signal-families.mjs';
import { readJsonFile } from './json-file.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROSTER_DOCUMENT = 'config/signal-panels.json';
const DOWNLOADS_ROOT = path.join(REPO_ROOT, '.local', 'signal-dumps', 'downloads');

// The door address and the operator bearer are shared with the other signal
// lanes (scripts/ingest-door.mjs) so all three reach the store the same way.
export { DEFAULT_DOOR };

/** Application defaults for omitted refresh fields. The scheduled entry point
 * requires an acknowledged stored roster before selecting any assets. */
export const REFRESH_DEFAULTS = {
  windowDays: 35,
  freshnessMaxAgeDays: 7,
};

/** The trend CSV's header — the one file in the panel dir that can be summed. */
export const TREND_COLUMNS = ['date', 'integration', 'metric', 'value', 'provisional'];
export const TREND_FILE = 'signal-trend-daily.csv';
export const FRESHNESS_FILE = PANEL_FRESHNESS_FILE;

/**
 * The report families no cron produces: the Bing AI Performance exports, which
 * an operator drops by hand. They share an integration id with the
 * API-collected families, so a per-integration freshness reading would let the
 * nightly `bing-webmaster` collection vouch for an export months old; they are
 * measured on their own.
 */
export const UNCOLLECTED_FAMILIES = BING_AI_REPORTS.map((report) => ({ integration: BING_AI_INTEGRATION, report }));

function isUncollected(integration, report) {
  return UNCOLLECTED_FAMILIES.some(
    (family) => family.integration === integration && family.report === report,
  );
}

function usage() {
  console.log(`Usage:
  pnpm signals:refresh [options]

Options:
  --asset <id>       refresh one property instead of every enabled one
  --all              include roster entries marked enabled:false
  --no-publish       refresh local files only; leave Tower advice unchanged
  --window-days <n>  override the roster's archive window
  --door <url>       ingest base url (default ${DEFAULT_DOOR})
  --out <directory>  completed panel root (default ${PANEL_REPORTS_DIRECTORY})
  --in <directory>   archive root (default .local/signal-dumps/downloads)
  --history <dir>    Parquet root (default .local/signal-dumps/history)
  --memory-mb <n>    analysis child heap limit (default ${DEFAULT_LIMITS.memoryMb})
  --duckdb-memory-mb <n>  DuckDB memory limit (default ${DEFAULT_LIMITS.duckdbMemoryMb})
  --temp-disk-mb <n>  spill and staged report limit (default ${DEFAULT_LIMITS.tempDiskMb})
  --time-limit-seconds <n>  analysis wall-time limit (default ${DEFAULT_LIMITS.timeLimitSeconds})
`);
}

export function parseArgs(argv) {
  const options = {
    asset: null,
    all: false,
    publish: true,
    windowDays: null,
    door: DEFAULT_DOOR,
    analysisRoot: PANEL_REPORTS_ROOT,
    historyRoot: PANEL_HISTORY_ROOT,
    limits: {},
    downloadsRoot: DOWNLOADS_ROOT,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--all') {
      options.all = true;
      continue;
    }
    if (arg === '--no-publish') {
      options.publish = false;
      continue;
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${arg} needs a value.`);
    if (arg === '--asset') options.asset = value;
    else if (arg === '--door') options.door = value;
    else if (arg === '--window-days') options.windowDays = Number(value);
    else if (arg === '--out') options.analysisRoot = path.resolve(REPO_ROOT, value);
    else if (arg === '--in') options.downloadsRoot = path.resolve(REPO_ROOT, value);
    else if (arg === '--history') options.historyRoot = path.resolve(REPO_ROOT, value);
    else if (arg === '--memory-mb') options.limits.memoryMb = Number(value);
    else if (arg === '--duckdb-memory-mb') options.limits.duckdbMemoryMb = Number(value);
    else if (arg === '--temp-disk-mb') options.limits.tempDiskMb = Number(value);
    else if (arg === '--time-limit-seconds') options.limits.timeLimitSeconds = Number(value);
    else throw new Error(`Unknown option: ${arg}`);
    index++;
  }
  if (options.asset !== null && !/^[a-z0-9.-]+$/.test(options.asset)) {
    throw new Error('--asset must be a property id such as example.com.');
  }
  if (
    options.windowDays !== null &&
    (!Number.isFinite(options.windowDays) || options.windowDays < 1)
  ) {
    throw new Error('--window-days must be a positive number of days.');
  }
  if (Object.values(options.limits).some((value) => !Number.isInteger(value) || value < 1)) {
    throw new Error('Analysis limits must be whole numbers above zero.');
  }
  return options;
}

/**
 * The roster, as the refresh reads it.
 *
 * Normalizes optional fields. The entry point checks that its stored document
 * has a usable roster; a failed read must never authorize a stale file export.
 */
export function parseRoster(raw) {
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const refresh = parsed && typeof parsed.refresh === 'object' ? parsed.refresh : {};
  const windowDays =
    Number.isFinite(refresh.windowDays) && refresh.windowDays >= 1
      ? Math.floor(refresh.windowDays)
      : REFRESH_DEFAULTS.windowDays;
  const freshnessMaxAgeDays =
    Number.isFinite(refresh.freshnessMaxAgeDays) && refresh.freshnessMaxAgeDays >= 1
      ? Math.floor(refresh.freshnessMaxAgeDays)
      : REFRESH_DEFAULTS.freshnessMaxAgeDays;

  const assets = [];
  const entries = parsed && typeof parsed.assets === 'object' && parsed.assets !== null
    ? Object.entries(parsed.assets)
    : [];
  for (const [asset, entry] of entries) {
    if (typeof asset !== 'string' || !/^[a-z0-9.-]+$/.test(asset)) continue;
    const enabled = entry !== null && typeof entry === 'object' && entry.enabled === true;
    const reason =
      entry !== null && typeof entry === 'object' && typeof entry.reason === 'string'
        ? entry.reason
        : null;
    assets.push({ asset, enabled, reason });
  }
  return { windowDays, freshnessMaxAgeDays, assets };
}

/** Which properties this invocation touches. `--asset` wins over the roster's
 * enabled flag: an operator naming a property means that property. */
export function selectAssets(roster, options) {
  if (options.asset !== null) {
    const known = roster.assets.find((entry) => entry.asset === options.asset);
    return [known ?? { asset: options.asset, enabled: true, reason: 'named-on-the-command-line' }];
  }
  if (options.all) return roster.assets;
  return roster.assets.filter((entry) => entry.enabled);
}

/** Where one archive lands on disk. Identical to the layout
 * scripts/signal-dumps-download.mjs writes, so the two are interchangeable. */
export function archivePath(downloadsRoot, asset, row) {
  return path.join(
    downloadsRoot,
    asset,
    row.integration,
    row.report,
    `${row.reportDate}.json`,
  );
}

/**
 * Merge this pass's manifest rows over whatever an earlier pass recorded, by
 * (integration, report, reportDate) with the newer row winning: the panel dir
 * keeps history the window no longer reaches, and dropping the old rows would
 * make the manifest claim the property has no history. `signals:download`
 * writes the same file with this rule.
 */
export function mergeManifest(previous, current) {
  const byKey = new Map();
  for (const row of [...previous, ...current]) {
    if (!row || typeof row !== 'object') continue;
    const { integration, report, reportDate } = row;
    if (typeof integration !== 'string' || typeof report !== 'string') continue;
    if (typeof reportDate !== 'string') continue;
    byKey.set(`${integration}\0${report}\0${reportDate}`, row);
  }
  return [...byKey.values()].sort((a, b) =>
    `${a.reportDate}${a.integration}${a.report}`.localeCompare(
      `${b.reportDate}${b.integration}${b.report}`,
    ),
  );
}

/** RFC 4180 enough for the values this CSV carries (dates, ids, numbers). */
function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * The daily site-level series, long-form.
 *
 * One row per (date, integration, metric) so Bing's clicks never land in the
 * same column as GSC's — the two count different things and a wide table invites
 * summing them. `provisional` is carried rather than filtered: a provider that
 * has not finished reporting a day is a real observation that may be revised,
 * and hiding those rows would render the last day or two as a cliff.
 */
export function trendCsv(rows) {
  const lines = [TREND_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(
      [row.date, row.integration, row.metric, row.value, row.provisional]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Whole days between two YYYY-MM-DD dates. */
export function dayAge(reportDate, nowIso) {
  const then = Date.parse(`${reportDate}T00:00:00.000Z`);
  const now = Date.parse(`${nowIso.slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return null;
  return Math.round((now - then) / 86_400_000);
}

/**
 * The panel's own answer to "can I trust this today?", written into the panel
 * dir on every pass: data no older than N days is a property of the data, not
 * of the cron, so a refresh that ran perfectly against a collector that
 * stopped a fortnight ago must still produce a panel that says so.
 *
 * Freshness is measured per integration, with one exception: a family with no
 * collector (`UNCOLLECTED_FAMILIES`) cannot be vouched for by the integration
 * it shares, so those families get their own source row, keyed
 * `<integration>/<report>`, aged from their own newest `report_date`, and are
 * excluded from the integration row. They do not drag the top-level `fresh`
 * down: there is no promised cadence to miss, and folding them in would leave
 * every panel permanently red. `sources[]` is a contract with whoever opens
 * the panel dir: collected entries carry `key` and `collected: true`, `fresh`
 * and `stale` mean the collected sources, and the hand-dropped families are a
 * separate `uncollected[]` list. Each collected source also lists its
 * families' own newest report days (`reports[]`), which the panel-review filer
 * (runner/panel-review.mjs) waits on.
 */
export function freshnessReport(input) {
  const { asset, manifest, maxAgeDays, refreshedAt } = input;
  const newest = new Map();
  const newestUncollected = new Map();
  const newestReports = new Map();
  const keepNewer = (bucket, key, reportDate) => {
    const current = bucket.get(key);
    if (current === undefined || reportDate > current) bucket.set(key, reportDate);
  };
  for (const row of manifest) {
    if (isUncollected(row.integration, row.report)) {
      keepNewer(newestUncollected, `${row.integration}/${row.report}`, row.reportDate);
      continue;
    }
    keepNewer(newest, row.integration, row.reportDate);
    if (!newestReports.has(row.integration)) newestReports.set(row.integration, new Map());
    keepNewer(newestReports.get(row.integration), row.report, row.reportDate);
  }

  const measure = (key, newestReportDate, extra) => {
    const ageDays = dayAge(newestReportDate, refreshedAt);
    return {
      key,
      ...extra,
      newestReportDate,
      ageDays,
      fresh: ageDays !== null && ageDays <= maxAgeDays,
    };
  };

  const sources = [...newest.entries()]
    .map(([integration, date]) => ({
      ...measure(integration, date, { integration, collected: true }),
      reports: [...newestReports.get(integration).entries()]
        .map(([report, newestReportDate]) => ({ report, newestReportDate }))
        .sort((a, b) => a.report.localeCompare(b.report)),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const uncollected = [...newestUncollected.entries()]
    .map(([key, date]) => {
      const [integration, report] = key.split('/');
      return measure(key, date, { integration, report, collected: false });
    })
    .sort((a, b) => a.key.localeCompare(b.key));

  return {
    asset,
    refreshedAt,
    maxAgeDays,
    // No source at all is NOT fresh. An empty panel dir and a collapsed one look
    // identical on disk, so the honest answer to "is this current?" with nothing
    // to measure is "no", never "yes, vacuously". A hand-dropped family alone
    // does not count as a source here: it says nothing about whether the
    // collectors are running, which is what this boolean answers.
    fresh: sources.length > 0 && sources.every((source) => source.fresh),
    sources,
    stale: sources.filter((source) => !source.fresh).map((source) => source.key),
    // The families nobody collects, each aged from its own newest export.
    uncollected,
    staleUncollected: uncollected.filter((source) => !source.fresh).map((source) => source.key),
  };
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * One property's pass. Every side effect is injectable. Returns what it did,
 * so a caller can tell a pass that refreshed nothing from a pass that never
 * ran.
 */
export async function refreshAsset(asset, options, deps = {}) {
  panelReportPath(asset, options.analysisRoot);
  const historyDir = path.join(options.historyRoot ?? path.join(path.dirname(options.analysisRoot), 'history'), asset);
  // Covers downloads as well as history/report publication, so a concurrent
  // CLI or scheduled pass cannot mix one pass's source and another's trend.
  await fs.mkdir(path.dirname(historyDir), { recursive: true });
  const release = await holdLock(`${historyDir}.refresh.lock`, (holder) => new Error(
    `Another panel refresh${holder === null ? '' : ` (process ${holder})`} is running for ${asset}; nothing was changed.`,
  ));
  try {
    return await refreshAssetLocked(asset, options, deps, historyDir);
  } finally {
    await release();
  }
}

async function refreshAssetLocked(asset, options, deps, historyDir) {
  const {
    get = fetch,
    token,
    windowDays,
    freshnessMaxAgeDays,
    /** The site's saved search market, from the settings refreshPanels read. */
    market = null,
    writeHistory = publishSignalHistory,
    analyze = analyzeSignalHistory,
    publish = publishExecutiveSnapshot,
    now = () => new Date().toISOString(),
  } = deps;

  const downloadsDir = path.join(options.downloadsRoot, asset);
  const analysisDir = panelReportPath(asset, options.analysisRoot);

  const sourceResponse = await get(
    doorUrl(options.door, 'api/panel-source', { asset, windowDays }),
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!sourceResponse.ok) {
    throw new Error(
      `panel source for ${asset} answered HTTP ${sourceResponse.status}`,
    );
  }
  const source = await sourceResponse.json();
  if (source?.asset !== asset || !Array.isArray(source.manifest) || !Array.isArray(source.trend)) {
    throw new Error(`panel source for ${asset} is malformed or belongs to another asset`);
  }
  const manifestRows = source.manifest;
  const trendRows = source.trend;

  // Already-on-disk archives are skipped by (objectKey, file exists). The
  // object key carries the content hash, so an archive the collector revised
  // gets a new key and is re-fetched; one it re-confirmed unchanged keeps its
  // key and is not.
  const previousManifest = await readJsonFile(
    path.join(downloadsDir, 'manifest.json'),
    { objects: [] },
  );
  const heldKeys = new Map();
  for (const row of Array.isArray(previousManifest?.objects) ? previousManifest.objects : []) {
    if (row && typeof row.objectKey === 'string') {
      heldKeys.set(`${row.integration}\0${row.report}\0${row.reportDate}`, row.objectKey);
    }
  }

  const fetched = [];
  for (const row of manifestRows) {
    const destination = archivePath(options.downloadsRoot, asset, row);
    const key = `${row.integration}\0${row.report}\0${row.reportDate}`;
    if (heldKeys.get(key) === row.objectKey && (await fileExists(destination))) continue;
    const objectResponse = await get(
      doorUrl(options.door, 'api/panel-object', { key: row.objectKey }),
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!objectResponse.ok) {
      throw new Error(
        `archive ${row.integration}/${row.report}/${row.reportDate} for ${asset} ` +
          `answered HTTP ${objectResponse.status}`,
      );
    }
    const body = await objectResponse.text();
    // Parse before writing: a truncated body would flatten into a CSV that reads
    // as real missing rows, which is exactly the lie the contract forbids.
    JSON.parse(body);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, body.endsWith('\n') ? body : `${body}\n`);
    fetched.push(destination);
  }

  const refreshedAt = now();
  const merged = mergeManifest(
    Array.isArray(previousManifest?.objects) ? previousManifest.objects : [],
    manifestRows.map((row) => ({ ...row, asset })),
  );
  await fs.mkdir(downloadsDir, { recursive: true });
  await fs.writeFile(
    path.join(downloadsDir, 'manifest.json'),
    `${JSON.stringify(
      {
        downloadedAt: refreshedAt,
        source: 'panel-refresh',
        asset,
        filters: { from: source?.from ?? null, to: null, integration: null, report: null },
        objects: merged,
      },
      null,
      2,
    )}\n`,
  );

  const freshness = freshnessReport({
    asset,
    manifest: merged,
    maxAgeDays: freshnessMaxAgeDays,
    refreshedAt,
  });
  const history = await writeHistory({ asset, input: downloadsDir, output: historyDir });
  const analysisStartedAt = now();
  const analysis = await analyze({
    asset, history: historyDir, generation: history.generation,
    output: analysisDir, reclamationTargets: null,
    configReadOptions: { door: options.door, token, fetchImpl: get },
    market, limits: options.limits ?? {},
    reportFiles: {
      [TREND_FILE]: trendCsv(trendRows),
      [FRESHNESS_FILE]: `${JSON.stringify(freshness, null, 2)}\n`,
    },
  });
  const analysisCompletedAt = now();

  let publication = { status: 'skipped', reason: 'local preview (--no-publish)' };
  if (options.publish !== false) {
    const snapshot = analysis?.executiveSnapshot;
    const generatedMs = Date.parse(snapshot?.generatedAt);
    if (analysis?.asset !== asset || snapshot?.asset !== asset
      || !Number.isInteger(analysis?.archiveCount) || analysis.archiveCount < 0
      || snapshot?.sourceArchiveCount !== analysis.archiveCount
      || snapshot?.generatedAt !== analysis.analyzedAt
      || !Number.isFinite(generatedMs)
      || snapshot.generatedAt !== new Date(generatedMs).toISOString()
      || generatedMs < Date.parse(analysisStartedAt) || generatedMs > Date.parse(analysisCompletedAt)) {
      throw new Error('Recommendations not published: no matching completed analysis from this refresh.');
    }
    if (analysis.archiveCount === 0) {
      publication = { status: 'skipped', reason: 'no archived source reports; prior advice retained' };
    } else {
      try {
        const published = await publish({ asset, snapshot, door: options.door, token });
        publication = { status: 'published', ...published, generatedAt: snapshot.generatedAt };
      } catch (error) {
        throw new Error(`Recommendation publication not confirmed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return {
    asset,
    archivesFetched: fetched.length,
    trendRows: trendRows.length,
    freshness,
    publication,
  };
}

export async function refreshPanels(options, deps = {}) {
  const token = deps.token ?? (await operatorToken());
  const documents = await readConfigSnapshot({
    door: options.door, token, fetchImpl: deps.fetchImpl,
  });
  const saved = documents.get(ROSTER_DOCUMENT);
  if (!saved) throw new Error('Panel refresh settings are not stored yet. Run pnpm config:seed before refreshing panels.');
  const { assets, refresh } = saved.body;
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)
    || Object.values(assets).some((entry) => !entry || typeof entry !== 'object'
      || Array.isArray(entry) || typeof entry.enabled !== 'boolean')
    || (refresh !== undefined && (!refresh || typeof refresh !== 'object' || Array.isArray(refresh)
      || [refresh.windowDays, refresh.freshnessMaxAgeDays].some((value) => value !== undefined
        && (!Number.isFinite(value) || value < 1))))) {
    throw new Error('Stored panel refresh settings are invalid. No assets were refreshed.');
  }
  const roster = parseRoster(JSON.stringify(saved.body));
  const windowDays = options.windowDays ?? roster.windowDays;
  console.log(`Panel refresh settings: database version ${saved.version}`);
  const targets = selectAssets(roster, options);
  const results = [];
  const failures = [];
  for (const target of targets) {
    try {
      const result = await refreshAsset(target.asset, options, {
        ...deps,
        token,
        windowDays,
        freshnessMaxAgeDays: roster.freshnessMaxAgeDays,
        market: storedSearchMarket(documents, target.asset),
      });
      results.push(result);
      const stale = result.freshness.stale;
      console.log(
        `${target.asset}: ${result.archivesFetched} new archive(s), ` +
          `${result.trendRows} trend row(s), ` +
          (result.freshness.fresh
            ? `fresh within ${roster.freshnessMaxAgeDays}d`
            : `STALE (${stale.length > 0 ? stale.join(', ') : 'no source'})`),
      );
      console.log(`${target.asset}: recommendations ${result.publication.status === 'published'
        ? `${result.publication.created ? 'published' : 'already published'} (${result.publication.id}); analysis ${result.publication.generatedAt}`
        : `not published — ${result.publication.reason}`}`);
    } catch (error) {
      // One property's broken lane must not cost every other property its
      // refresh — the pass reports what failed and keeps going.
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ asset: target.asset, message });
      console.error(`${target.asset}: refresh failed — ${message}`);
    }
  }
  return { results, failures };
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  try {
    const { failures } = await refreshPanels(parseArgs(process.argv.slice(2)));
    if (failures.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
    process.exitCode = 1;
  }
}
