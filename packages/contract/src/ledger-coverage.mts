// What a Mediavine estimate covers, read once from its note. The ledger keeps
// the answer as data (`ledger_entries.coverage_end`), and both writers of that
// column (`pnpm postgres:import` and the ledger route) apply this one rule.
//
// Authored TypeScript: `pnpm config:generate` writes the `.mjs` and `.d.mts`
// beside it.

/** The sources whose monthly estimates a month of Mediavine daily estimates
 * may replace. */
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
 * coverage note and does not parse: it has no end, and the importer reports
 * it for review. */
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
 * The coverage end of a Mediavine estimate for `period` ('YYYY-MM'), read
 * from its note: a revenue `ads` entry from a Mediavine source whose note is
 * 'Mediavine Journey, … days — PARTIAL, covers …..YYYY-MM-DD', that last day
 * falling in the entry's own month. The note is read in code points.
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
