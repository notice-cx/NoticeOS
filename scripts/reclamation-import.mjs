#!/usr/bin/env node
// Load a campaign's static target CSV into the store's link-outreach targets,
// carrying whatever send state the campaign recorded elsewhere.
//
// The list goes to the ingest's door (POST /api/reclamation-targets, with the
// operator bearer), which stores it in one transaction — a script never holds
// a database credential (bead ro-ujb9.76.5.8). `--dry-run`
// shows what would be sent and sends nothing. Importing the same list twice
// changes nothing: a page is stored once, keyed on its site, domain and page,
// and a status only moves forward from a status strictly earlier in the
// funnel, so a row a person moved forward is never dragged back.
//
// The list is the campaign's touch log, one row per target page.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DOOR, doorRequest, doorUrl, operatorToken } from './ingest-door.mjs';
import { installationPath } from './installation.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The CSV schema this importer reads, in order. A file whose header row does
 * not match exactly is a different list and is rejected rather than guessed at. */
const CSV_COLUMNS = [
  'tier',
  'segment',
  'domain',
  'referring_page',
  'links_to_dead',
  'replace_with',
  'contact',
  'notes',
];

/** The tier value that marks the do-not-pitch pseudo-row rather than a target. */
const SKIP_TIER = 'SKIP';

/** Source spellings of "this field does not apply", normalized away on import.
 * The skip pseudo-row uses `n/a` for every column a real target would fill. */
const NOT_APPLICABLE = new Set(['', 'n/a', 'N/A', 'n/A', 'N/a']);

// ---------------------------------------------------------------------------
// A campaign's send-state overlay
// ---------------------------------------------------------------------------
// A campaign's send state is rarely in its CSV. An installation that recorded it
// elsewhere keeps it, hand-encoded, in its own folder's
// `reclamation-overlay.json` (scripts/installation.mts): an array of
// { domain, referringPage?, status, statusAt?, lastVerifiedAt?, outcomeNote? },
// one entry per target row it moves forward. It is reviewable data, never parsed
// out of prose, because a wrong row means a double pitch or a lost reply.
// Without the file there is no overlay (bead ro-ujb9.157).
//
// Mapping rules (see db/README §reclamation_targets):
//   * A hard bounce has no status: the row stays `sent` with the bounce in
//     `outcomeNote`, unless a working address was found and replied.
//   * `statusAt` for opened/clicked is the date the state was READ, not when it
//     happened; the send date belongs in `outcomeNote`.
//   * `lastVerifiedAt` is stamped only where THE PAGE THIS ROW NAMES was verified.

/** The overlay file's name inside the installation folder. */
export const OVERLAY_FILE = 'reclamation-overlay.json';

/** This installation's overlay, or [] when it keeps none. */
export async function readOverlay(options = {}) {
  let text;
  try {
    text = await fs.readFile(installationPath(OVERLAY_FILE, options), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const overlay = JSON.parse(text);
  if (!Array.isArray(overlay)) throw new Error(`${OVERLAY_FILE} must be an array of overlay entries`);
  return overlay;
}

function usage() {
  console.log(`Usage:
  pnpm reclamation:import -- --asset example.com --csv <path> [options]

Options:
  --asset <id>    required property id; every row is scoped to it
  --csv <path>    required target list (tier,segment,domain,referring_page,
                  links_to_dead,replace_with,contact,notes)
  --dry-run       show what would be stored, and store nothing
  --no-overlay    import the CSV alone, without the installation's send-state overlay
  --door <url>    where the local ingest answers (default ${DEFAULT_DOOR})
`);
}

export function parseArgs(argv) {
  let asset = null;
  let csv = null;
  let door = DEFAULT_DOOR;
  let overlay = true;
  let dryRun = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--no-overlay') {
      overlay = false;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${arg} needs a value.`);
    if (arg === '--asset') asset = value;
    else if (arg === '--csv') csv = path.resolve(REPO_ROOT, value);
    else if (arg === '--door') door = value;
    else throw new Error(`Unknown option: ${arg}`);
    index++;
  }
  if (!asset || !/^[a-z0-9.-]+$/.test(asset)) {
    throw new Error('--asset is required and must be a property id such as example.com.');
  }
  if (!csv) throw new Error('--csv is required and must point at the target list.');
  return { asset, csv, door, overlay, dryRun };
}

/**
 * RFC 4180 fields: quoted values may contain commas, newlines, and doubled
 * quotes. The origin list has all three, so a split(',') import would shred it.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let started = false;
  const push = () => {
    row.push(field);
    field = '';
    started = false;
  };
  const endRow = () => {
    push();
    // A trailing newline is not an empty final record.
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (text[index + 1] === '"') {
        field += '"';
        index++;
      } else {
        quoted = false;
      }
      continue;
    }
    if (char === '"' && !started) {
      quoted = true;
      started = true;
    } else if (char === ',') {
      push();
    } else if (char === '\n') {
      endRow();
    } else if (char !== '\r') {
      field += char;
      started = true;
    }
  }
  if (field !== '' || row.length > 0) endRow();
  if (rows.length === 0) throw new Error('The target list is empty.');

  const header = rows[0].map((name) => name.trim());
  if (
    header.length !== CSV_COLUMNS.length ||
    header.some((name, index) => name !== CSV_COLUMNS[index])
  ) {
    throw new Error(
      `Unexpected target-list columns: [${header.join(', ')}]. Expected [${CSV_COLUMNS.join(', ')}].`,
    );
  }
  return rows.slice(1).map((values) =>
    Object.fromEntries(CSV_COLUMNS.map((name, index) => [name, values[index] ?? ''])),
  );
}

/** Optional evidence text: absent, blank, and the source's own "n/a" all mean
 * the same unknown, and an unknown is NULL rather than the string "n/a". */
function optional(value) {
  const trimmed = String(value ?? '').trim();
  return NOT_APPLICABLE.has(trimmed) ? null : trimmed;
}

/** The referring page is part of the key a page is stored once by (its site,
 * domain and page), so "no specific page" is the empty string, never null. */
function pageKey(value) {
  return optional(value) ?? '';
}

function tierOf(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

/**
 * Turn one CSV record into the rows it stands for.
 *
 * The list's last line is not a target: it is a do-not-pitch declaration whose
 * `domain` cell holds ten slash-separated federal and Wikipedia hosts, kept in
 * the sheet so a later research pass does not re-add them. It becomes one `skip`
 * row PER DOMAIN, because "is this host on the do-not-pitch list?" is the
 * question the rest of the pipeline asks, and it is a domain-grain question. The
 * shared reason travels on every row.
 */
function toRows(record, asset) {
  const isSkip = String(record.tier ?? '').trim().toUpperCase() === SKIP_TIER;
  const common = {
    asset,
    tier: tierOf(record.tier),
    segment: optional(record.segment),
    linksToDead: optional(record.links_to_dead),
    replaceWith: optional(record.replace_with),
    contact: optional(record.contact),
    notes: optional(record.notes),
  };
  if (!isSkip) {
    return [
      {
        ...common,
        domain: String(record.domain ?? '').trim(),
        referringPage: pageKey(record.referring_page),
        status: 'queued',
        statusAt: null,
        lastVerifiedAt: null,
        outcomeNote: null,
      },
    ];
  }
  return String(record.domain ?? '')
    .split('/')
    .map((domain) => domain.trim())
    .filter(Boolean)
    .map((domain) => ({
      ...common,
      domain,
      referringPage: '',
      status: 'skip',
      statusAt: null,
      lastVerifiedAt: null,
      outcomeNote: null,
    }));
}

/**
 * Fold the overlay's send state onto the imported rows, matching on domain.
 *
 * An overlay entry that matches no row, or more than one, THROWS. Both mean the
 * CSV and this file have drifted apart, and both have the same consequence if
 * swallowed: a recorded touch silently disappears and the next wave cold-pitches
 * somebody who was already emailed. Loud is correct here.
 */
function applyOverlay(rows, overlay) {
  const applied = [];
  for (const entry of overlay) {
    const matches = rows.filter(
      (row) => row.domain === entry.domain && row.status !== 'skip',
    );
    if (matches.length === 0) {
      throw new Error(
        `The overlay names ${entry.domain}, which is not in the target list. ` +
          'Reconcile the overlay against the CSV before importing — a dropped send state is a double pitch.',
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `The overlay names ${entry.domain}, which matches ${matches.length} target rows. ` +
          'Add the referring page to the overlay entry so the state lands on one row.',
      );
    }
    const row = matches[0];
    row.status = entry.status;
    row.statusAt = entry.statusAt ?? null;
    row.lastVerifiedAt = entry.lastVerifiedAt ?? null;
    row.outcomeNote = entry.outcomeNote ?? null;
    applied.push(row);
  }
  return applied;
}

/**
 * Build the import from CSV text: the rows, and the request the ingest stores
 * them from (POST /api/reclamation-targets). Pure: same inputs, same request
 * out. Nothing here reads the clock, so a diff between two runs is a real
 * change in the list.
 */
export function buildReclamationImport({ asset, csvText, overlay = [] }) {
  const records = parseCsv(csvText);
  const rows = records.flatMap((record) => toRows(record, asset));
  const duplicates = new Set();
  const seen = new Set();
  for (const row of rows) {
    const key = `${row.domain}\u0000${row.referringPage}`;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  if (duplicates.size > 0) {
    throw new Error(
      `The target list carries ${duplicates.size} duplicate (domain, referring page) pair(s); ` +
        'the store cannot hold both, so deduplicate the list first.',
    );
  }

  const applied = applyOverlay(rows, overlay);
  const targets = rows.filter((row) => row.status !== 'skip');
  const skipped = rows.filter((row) => row.status === 'skip');
  const byStatus = new Map();
  for (const row of rows) byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);

  return {
    request: { asset, targets: rows.map(({ asset: _site, ...target }) => target) },
    rows,
    targetCount: targets.length,
    skipCount: skipped.length,
    overlayCount: applied.length,
    statusCounts: Object.fromEntries(
      [...byStatus.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

/**
 * Send one built list to the ingest's door with the operator bearer. Its
 * answer: `{ ok, asset, targets, inserted, moved, verified }` — how many pages
 * were new, how many stored ones moved forward, and how many were re-verified.
 */
export async function sendReclamationTargets(request, { door = DEFAULT_DOOR, token, fetchImpl = fetch } = {}) {
  const response = await doorRequest(fetchImpl, doorUrl(door, 'api/reclamation-targets'), {
    token: token ?? (await operatorToken()),
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  return response.json();
}

export async function importReclamationTargets({ asset, csv, door, overlay = true, dryRun = false }) {
  const csvText = await fs.readFile(csv, 'utf8');
  const result = buildReclamationImport({ asset, csvText, overlay: overlay ? await readOverlay() : [] });
  return { ...result, stored: dryRun ? null : await sendReclamationTargets(result.request, { door }) };
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await importReclamationTargets(options);
    const distribution = Object.entries(result.statusCounts)
      .map(([status, count]) => `${status} ${count}`)
      .join(' · ');
    const list =
      `${result.targetCount} targets + ${result.skipCount} do-not-pitch domains ` +
      `(${result.overlayCount} with imported send state)`;
    if (result.stored === null) {
      console.log(`Would store ${list} for ${options.asset}; nothing was sent (--dry-run).`);
    } else {
      const { inserted, moved, verified } = result.stored;
      console.log(
        `Stored ${list} for ${options.asset}: ${inserted} new, ${moved} moved forward, ${verified} re-verified.`,
      );
    }
    console.log(`Status: ${distribution}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
    process.exitCode = 1;
  }
}
