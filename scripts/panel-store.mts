/** A site's published panels on disk, as the panel tools read them
 * (panel-mcp.mts): which sites have one, which versions are kept, and what one
 * version holds — its tables, documents and each report family's record.
 *
 * The layout is the analyzer's (signal-history-analyze.mjs): `<root>/<asset>`
 * links to the newest version, `<root>/<asset>.reports/<version>/`. Nothing
 * here writes. Ages are measured when a version is read, against `asOf`; a
 * version records facts, never a verdict that goes stale with it.
 */
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { GZIP_SUFFIX, PANEL_VERSION_KEEP_DAYS, isPanelVersion, panelVersionTime, storedPanelFile } from './panel-versions.mjs';

const ASSET = /^[a-z0-9.-]+$/u;
const HOUR_MS = 3_600_000;
/** A latest version older than this means the daily refresh has stopped publishing. */
const PANEL_BEHIND_HOURS = 36;
const HEADER_BYTES = 64 * 1024;

/** The JSON documents a version carries, by the name the tools use. */
export const PANEL_DOCUMENTS = Object.freeze({
  executive: 'executive.json',
  summary: 'summary.json',
  freshness: 'freshness.json',
  report: 'report.json',
} as const);
export type PanelDocument = keyof typeof PANEL_DOCUMENTS;

/** How to read a panel without drawing a wrong conclusion; docs/20-signal-panels.md has the reasons. */
export const PANEL_RULES: readonly string[] = Object.freeze([
  'A missing table, row or value is unknown, never zero.',
  'Rows with provisional=1 are days the provider is still filling in; leave them out of a change you compute.',
  'Read one report_date at a time: daily reads overlap, so never add rows or people across report dates.',
  'Bing weekly snapshots are revisions of each other; never sum them across collections.',
  'GSC page and query tables are top rows only; their totals never match signal_trend_daily.',
  'dataforseo_serp_panel and posthog_web_vitals rows are per device; filter to one device before counting.',
  'Empty aio_present or aio_cites_us means unknown, not false; empty best_rank means outside the tracked depth.',
  'people counts do not add across rows, days or report dates.',
  'Cite the panel version you read in any finding.',
]);

/** A refusal the caller can act on, worded for an agent. */
export class PanelReadError extends Error {}

export interface PanelRef {
  readonly asset: string;
  readonly version: string;
  readonly latestVersion: string;
  readonly folder: string;
}
export interface PanelTableInfo {
  readonly table: string;
  readonly file: string;
  /** Where the file is stored now: as written, or gzipped. */
  readonly stored: string;
  readonly rows: number | null;
  readonly bytes: number | null;
  readonly sha256: string | null;
  readonly columns: readonly string[];
}
export type FamilyStatus = 'ok' | 'failing' | 'overdue' | 'missing' | 'imported' | 'paused' | 'unchecked';
export interface FamilyCollection {
  readonly state: string;
  readonly reportDate: string | null;
  readonly failure: string | null;
  readonly code: string | null;
  readonly lastSuccessAt: string | null;
  readonly failing: readonly { readonly reportDate: string | null; readonly failure: string | null; readonly code: string | null }[];
}
export interface FamilyReadiness {
  readonly family: string;
  readonly table: string | null;
  readonly role: 'collected' | 'imported';
  readonly status: FamilyStatus;
  readonly newestReportDate: string | null;
  readonly ageDays: number | null;
  readonly collection: FamilyCollection | null;
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
const text = (value: unknown): string | null => typeof value === 'string' ? value : null;

/** The SQL table name of a CSV file: `posthog-web-vitals.csv` is `posthog_web_vitals`. */
export function panelTableName(file: string): string {
  return file.replace(/\.csv$/u, '').replace(/[^a-z0-9_]/gu, '_');
}

/** Whole UTC days from a report day to the day of `asOf`. */
function daysSince(reportDate: string, asOf: string): number | null {
  const then = Date.parse(`${reportDate}T00:00:00.000Z`), now = Date.parse(`${asOf.slice(0, 10)}T00:00:00.000Z`);
  return Number.isFinite(then) && Number.isFinite(now) ? Math.round((now - then) / 86_400_000) : null;
}

/** The first line of a CSV, whether stored as written or gzipped. */
async function csvHeader(file: string): Promise<string[]> {
  const raw = createReadStream(file, file.endsWith(GZIP_SUFFIX) ? {} : { end: HEADER_BYTES });
  const stream = file.endsWith(GZIP_SUFFIX) ? raw.pipe(createGunzip()) : raw;
  let head = '';
  try {
    for await (const chunk of stream) {
      head += (chunk as Buffer).toString('utf8');
      if (head.includes('\n') || head.length >= HEADER_BYTES) break;
    }
  } finally { raw.destroy(); }
  const line = head.split(/\r?\n/u)[0] ?? '';
  const cells: string[] = [];
  let cell = '', quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') { cell += '"'; index++; } else if (char === '"') quoted = false; else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { cells.push(cell); cell = ''; } else cell += char;
  }
  return line.length ? [...cells, cell] : [];
}

async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** A family's status from what the panel holds and how its collection stood. */
function familyStatus(newestReportDate: string | null, role: 'collected' | 'imported', collection: FamilyCollection | null): FamilyStatus {
  if (newestReportDate === null) return 'missing';
  if (role === 'imported') return 'imported';
  switch (collection?.state) {
    case 'healthy': case 'idle': return 'ok';
    case 'failing': return 'failing';
    case 'stale': return 'overdue';
    case 'paused': return 'paused';
    default: return 'unchecked';
  }
}

const days = (failing: FamilyCollection['failing']) =>
  failing.map(day => `${day.reportDate ?? 'latest read'} (${day.code ?? day.failure ?? 'reason not recorded'})`).join(', ');

/** Why a family needs a reader's attention, or null when it does not. */
function familyAttention(family: FamilyReadiness): { status: string; detail: string } | null {
  const state = family.collection?.state ?? 'not recorded';
  const failing = family.collection?.failing ?? [];
  switch (family.status) {
    case 'ok': return failing.length ? { status: 'earlier-failures', detail: `Newest day collected; failing days: ${days(failing)}.` } : null;
    case 'missing': return { status: 'missing', detail: `No report in this panel; collection is ${state}.` };
    case 'imported': return { status: 'imported', detail: `Imported by hand; newest report ${family.newestReportDate}, ${family.ageDays} days old.` };
    case 'failing': return { status: 'failing', detail: `Collection failing: ${days(failing)}. Newest report held: ${family.newestReportDate}.` };
    case 'overdue': return { status: 'overdue', detail: `Collection overdue; newest report ${family.newestReportDate}.` };
    case 'paused': return { status: 'paused', detail: `Collection is paused for this site; newest report ${family.newestReportDate}.` };
    default: return { status: 'unchecked', detail: `Collection is ${state}; newest report ${family.newestReportDate}.` };
  }
}

/** Each family a version's freshness.json records. A version published
 * before families were recorded lists the ones its sources name, unchecked. */
function familiesOf(freshness: Json | null): { family: string; role: 'collected' | 'imported'; newestReportDate: string | null; collection: FamilyCollection | null }[] {
  if (Array.isArray(freshness?.families)) {
    return (freshness.families as unknown[]).flatMap(entry => {
      const row = record(entry), family = text(row?.family);
      if (!row || !family) return [];
      return [{ family, role: row.role === 'imported' ? 'imported' as const : 'collected' as const,
        newestReportDate: text(row.newestReportDate), collection: record(row.collection) as FamilyCollection | null }];
    });
  }
  const families: ReturnType<typeof familiesOf> = [];
  for (const source of Array.isArray(freshness?.sources) ? freshness.sources as unknown[] : []) {
    const integration = text(record(source)?.integration);
    for (const report of Array.isArray(record(source)?.reports) ? record(source)!.reports as unknown[] : []) {
      const name = text(record(report)?.report);
      if (integration && name) families.push({ family: `${integration}-${name}`, role: 'collected', newestReportDate: text(record(report)?.newestReportDate), collection: null });
    }
  }
  for (const source of Array.isArray(freshness?.uncollected) ? freshness.uncollected as unknown[] : []) {
    const row = record(source), integration = text(row?.integration), name = text(row?.report);
    if (integration && name) families.push({ family: `${integration}-${name}`, role: 'imported', newestReportDate: text(row?.newestReportDate), collection: null });
  }
  return families.sort((left, right) => left.family.localeCompare(right.family));
}

export function createPanelStore(root: string) {
  const reportsOf = (asset: string) => path.join(root, `${asset}.reports`);

  /** The version `<root>/<asset>` links to, or null where none is published. */
  async function latestOf(asset: string): Promise<string | null> {
    try {
      const target = path.resolve(root, await fs.readlink(path.join(root, asset)));
      return path.dirname(target) === reportsOf(asset) && isPanelVersion(path.basename(target)) ? path.basename(target) : null;
    } catch { return null; }
  }

  /** Every version kept for `asset`, newest first. */
  async function kept(asset: string): Promise<string[]> {
    const names = await fs.readdir(reportsOf(asset)).catch(() => [] as string[]);
    return names.filter(isPanelVersion).sort((left, right) => panelVersionTime(right)!.localeCompare(panelVersionTime(left)!) || right.localeCompare(left));
  }

  return {
    /** Every site with a published panel. */
    async sites(): Promise<string[]> {
      const names = await fs.readdir(root).catch(() => [] as string[]);
      const sites: string[] = [];
      for (const name of names.sort()) if (ASSET.test(name) && await latestOf(name) !== null) sites.push(name);
      return sites;
    },

    kept,

    /** One version of a site's panel: `version`, or the latest. A version that
     * is no longer kept is refused by name; it never stands in for another. */
    async resolve(asset: string, version?: string | null): Promise<PanelRef> {
      if (!ASSET.test(asset)) throw new PanelReadError('asset must be a site id such as example.com; list_panels lists the sites with a panel.');
      const latestVersion = await latestOf(asset);
      if (latestVersion === null) throw new PanelReadError(`${asset} has no published panel. list_panels lists the sites that have one.`);
      if (version === undefined || version === null) return { asset, version: latestVersion, latestVersion, folder: path.join(reportsOf(asset), latestVersion) };
      if (!isPanelVersion(version)) throw new PanelReadError(`${version} is not a panel version; get_panel names the versions kept for ${asset}.`);
      if (!(await kept(asset)).includes(version)) {
        throw new PanelReadError(`Version ${version} of ${asset}'s panel is no longer kept: versions are kept ${PANEL_VERSION_KEEP_DAYS} days. The latest is ${latestVersion}.`);
      }
      return { asset, version, latestVersion, folder: path.join(reportsOf(asset), version) };
    },

    /** The version's CSV tables: name, columns, rows and recorded size. */
    async tables(ref: PanelRef): Promise<PanelTableInfo[]> {
      const report = record(await readJson(path.join(ref.folder, PANEL_DOCUMENTS.report)));
      const summary = record(await readJson(path.join(ref.folder, PANEL_DOCUMENTS.summary)));
      const recorded = new Map<string, Json>();
      for (const entry of Array.isArray(report?.files) ? report.files as unknown[] : []) {
        const row = record(entry), name = text(row?.name);
        if (row && name) recorded.set(name, row);
      }
      const rows = new Map<string, number>();
      for (const entry of Array.isArray(summary?.datasets) ? summary.datasets as unknown[] : []) {
        const row = record(entry), name = text(row?.name);
        if (name && typeof row?.rows === 'number') rows.set(`${name}.csv`, row.rows);
      }
      const names = new Set<string>();
      for (const name of await fs.readdir(ref.folder)) {
        const file = name.endsWith(`.csv${GZIP_SUFFIX}`) ? name.slice(0, -GZIP_SUFFIX.length) : name;
        if (file.endsWith('.csv')) names.add(file);
      }
      const tables: PanelTableInfo[] = [];
      for (const file of [...names].sort()) {
        const stored = await storedPanelFile(ref.folder, file);
        if (stored === null) continue;
        const entry = recorded.get(file);
        tables.push({ table: panelTableName(file), file, stored: path.basename(stored), rows: rows.get(file) ?? null,
          bytes: typeof entry?.bytes === 'number' ? entry.bytes : null, sha256: text(entry?.sha256), columns: await csvHeader(stored) });
      }
      return tables;
    },

    /** What the version is and how current each of its families is at `asOf`. */
    async describe(ref: PanelRef, asOf: string) {
      const report = record(await readJson(path.join(ref.folder, PANEL_DOCUMENTS.report)));
      const freshness = record(await readJson(path.join(ref.folder, PANEL_DOCUMENTS.freshness)));
      const builtAt = text(report?.analyzedAt) ?? panelVersionTime(ref.version);
      const ageHours = builtAt === null ? null : Math.round((Date.parse(asOf) - Date.parse(builtAt)) / HOUR_MS * 10) / 10;
      const tables = await this.tables(ref);
      const tableOf = new Set(tables.map(table => table.file));
      const families: FamilyReadiness[] = familiesOf(freshness).map(family => ({
        family: family.family,
        table: tableOf.has(`${family.family}.csv`) ? panelTableName(`${family.family}.csv`) : null,
        role: family.role,
        status: familyStatus(family.newestReportDate, family.role, family.collection),
        newestReportDate: family.newestReportDate,
        ageDays: family.newestReportDate === null ? null : daysSince(family.newestReportDate, asOf),
        collection: family.collection,
      }));
      const collection = record(freshness?.collection);
      const attention: { family: string | null; status: string; detail: string }[] = [];
      const latest = ref.version === ref.latestVersion;
      if (!latest) attention.push({ family: null, status: 'not-latest', detail: `A newer version is published: ${ref.latestVersion}.` });
      else if (ageHours !== null && ageHours > PANEL_BEHIND_HOURS) {
        attention.push({ family: null, status: 'panel-behind', detail: `Built ${Math.floor(ageHours)} hours ago; the daily refresh has not published since.` });
      }
      // Without a health read, every family is unchecked: one line says so.
      const healthRead = collection?.available === true;
      if (!healthRead) attention.push({ family: null, status: 'unchecked', detail: 'Collection health was not read when this version was built.' });
      for (const family of families) {
        const note = familyAttention(family);
        if (note !== null && (healthRead || family.status !== 'unchecked')) attention.push({ family: family.family, ...note });
      }
      return {
        asset: ref.asset, version: ref.version, latest, latestVersion: ref.latestVersion,
        builtAt, asOf, ageHours, generation: typeof report?.generation === 'number' ? report.generation : null,
        collectionReadAt: text(collection?.readAt), attention, families, tables,
      };
    },

    /** One of the version's JSON documents, parsed. */
    async document(ref: PanelRef, name: PanelDocument): Promise<unknown> {
      const value = await readJson(path.join(ref.folder, PANEL_DOCUMENTS[name]));
      if (value === null) throw new PanelReadError(`Version ${ref.version} of ${ref.asset}'s panel has no ${PANEL_DOCUMENTS[name]}.`);
      return value;
    },
  };
}
export type PanelStore = ReturnType<typeof createPanelStore>;
