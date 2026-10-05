// WHAT A MEDIAVINE ESTIMATE COVERS, READ ONCE FROM ITS NOTE (beads ro-ujb9.72
// and ro-ujb9.76.6.1).
//
// D1's financial view decides whether a month of Mediavine daily estimates may
// stand in for an imported monthly estimate by parsing that estimate's note
// (db/migrations/0034_mediavine.sql, `usable_months`). The Postgres ledger
// keeps the answer as data instead, `ledger_entries.coverage_end`, and its view
// reads the column (db/postgres/migrations/0001_baseline.sql). Two writers set
// the column from the same wording: the D1 importer, for the entries D1 holds
// (`pnpm postgres:import`, its ledger rules), and the ledger route, for an entry
// booked after the switch (workers/ingest/src/routes/revenue.ts). This is the
// one rule both apply, so an estimate counts the same whichever wrote it, and
// the same as D1 counted it.
//
// Authored TypeScript: `pnpm config:generate` writes the `.mjs` the importer
// and the ingest import, and the `.d.mts` beside it.

/** The sources whose monthly estimates a month of Mediavine daily estimates
 * may replace (0034's view, 0001_baseline.sql's). */
export const MEDIAVINE_SOURCES: readonly string[] = ['mediavine-journey', 'mediavine'];

/** What of an entry the rule reads. */
export interface CoverageNoteEntry {
  kind: string;
  family: string;
  source: string | null;
  note: string | null;
}

/** A Mediavine estimate's coverage end: a 'YYYY-MM-DD' day, or null when its
 * note states none. `unreadable` marks a note that starts like a PARTIAL
 * coverage note and does not parse: it has no end, as D1 read it, and the
 * importer reports it for review. */
export interface MediavineCoverage {
  end: string | null;
  unreadable: boolean;
}

const PREFIX = 'Mediavine Journey, ';
const MARKER = ' days — PARTIAL, covers ';
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** A calendar day that exists, from year 1900 on. */
function realDay(year: number, month: number, day: number): boolean {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return year >= 1900 && month >= 1 && month <= 12 && day >= 1 && day <= days;
}

/**
 * The coverage end of a Mediavine estimate for `period` ('YYYY-MM'), read from
 * its note exactly as D1's view read it: a revenue `ads` entry from a
 * Mediavine source whose note is 'Mediavine Journey, … days — PARTIAL, covers
 * …..YYYY-MM-DD', that last day falling in the entry's own month. The note is
 * read in characters (code points), as SQLite's `substr` reads text.
 */
export function mediavineCoverage(entry: CoverageNoteEntry, period: string): MediavineCoverage {
  const none: MediavineCoverage = { end: null, unreadable: false };
  const note = entry.note;
  if (entry.kind !== 'revenue' || entry.family !== 'ads' || entry.source === null) return none;
  if (!MEDIAVINE_SOURCES.includes(entry.source) || note === null) return none;
  if (!note.startsWith(PREFIX) || !note.includes(MARKER)) return none;
  const points = [...note];
  const last10 = points.slice(-10).join('');
  const dots = points.slice(-12, -10).join('');
  const valid = DAY.exec(last10);
  if (dots === '..' && valid && realDay(Number(valid[1]), Number(valid[2]), Number(valid[3])) && last10.slice(0, 7) === period) {
    return { end: last10, unreadable: false };
  }
  return { end: null, unreadable: true };
}
