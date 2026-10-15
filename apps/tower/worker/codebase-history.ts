// One site's codebase reports for its Codebase tab: each day's newest revision
// (`noticeos.current_codebase_reports`) over the history window, reduced to
// its measures in SQL so ninety reports never cross as ninety findings lists,
// and the newest report in full.

import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import {
  CodebaseComplexFunction as ComplexFunctionRow,
  CodebaseDuplicate as DuplicateRow,
  CodebaseLanguage as LanguageRow,
  CodebaseLargestFile as LargestFileRow,
  CodebaseMeasuresSchema,
  CodebaseReport as CodebaseEnvelope,
  CodebaseUnusedItem as UnusedRow,
} from "@noticeos/contract/codebase";
import {
  CODEBASE_HISTORY_DAYS,
  CODEBASE_MEASURE_KEYS,
  type CodebaseHistoryPoint,
  type CodebaseMeasureKey,
  type CodebaseMeasures,
  type CodebaseReport,
  type CodebaseSlice,
} from "../shared/codebase";

/** `$1` the asset, `$2` the clock, `$3` the days. Oldest first. */
export const CODEBASE_HISTORY_SQL = `SELECT report_date::text AS date, commit, ref,
       generated_at AS "generatedAt",
       (envelope->'measures')::text AS measures,
       (envelope->'tools')::text AS tools
  FROM noticeos.current_codebase_reports
 WHERE asset_id = $1
   AND report_date > ($2::timestamptz AT TIME ZONE 'UTC')::date - $3::int
 ORDER BY report_date ASC`;

/** `$1` the asset. The newest day's newest revision, whatever its age. */
export const CODEBASE_LATEST_SQL = `SELECT report_date::text AS date, revision, received_at AS "receivedAt",
       envelope::text AS envelope
  FROM noticeos.current_codebase_reports
 WHERE asset_id = $1
 ORDER BY report_date DESC
 LIMIT 1`;

type HistoryRow = {
  date: string;
  commit: string;
  ref: string;
  generatedAt: string;
  measures: string | null;
  tools: string | null;
};

type LatestRow = {
  date: string;
  revision: number;
  receivedAt: string;
  envelope: string;
};

export async function readCodebaseSlice(store: WorkspaceStore, asset: string, now: Date): Promise<CodebaseSlice> {
  const [historyRows, latestRows] = await store.read(async (tx) => [
    await tx.query<HistoryRow>(CODEBASE_HISTORY_SQL, [asset, now.toISOString(), CODEBASE_HISTORY_DAYS]),
    await tx.query<LatestRow>(CODEBASE_LATEST_SQL, [asset]),
  ] as const);
  const history: CodebaseHistoryPoint[] = historyRows.map((row) => ({
    date: row.date,
    commit: row.commit.trim(),
    ref: row.ref,
    generatedAt: javascriptInstant(row.generatedAt),
    measures: parseMeasures(parseJson(row.measures)),
    tools: parseTools(parseJson(row.tools)),
  }));
  const newest = latestRows[0];
  const report = newest ? parseCodebaseReport(newest.envelope) : null;
  return {
    history,
    latest: newest && report
      ? { date: newest.date, revision: newest.revision, receivedAt: javascriptInstant(newest.receivedAt), report }
      : null,
  };
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const text = (value: unknown): value is string => typeof value === "string";

/** Only known keys with a number the contract accepts for them cross;
 * anything else reads as unmeasured, never as zero. */
export function parseMeasures(value: unknown): CodebaseMeasures {
  const source = record(value);
  const out: CodebaseMeasures = {};
  if (!source) return out;
  for (const key of CODEBASE_MEASURE_KEYS) {
    const measure = CodebaseMeasuresSchema.shape[key].safeParse(source[key]);
    if (measure.success && measure.data !== undefined) out[key] = measure.data;
  }
  return out;
}

/** Known keys with a sentence; anything else is no reason, and the page
 * falls back to its own. */
export function parseUnmeasured(value: unknown): Partial<Record<CodebaseMeasureKey, string>> {
  const source = record(value);
  const out: Partial<Record<CodebaseMeasureKey, string>> = {};
  if (!source) return out;
  for (const key of CODEBASE_MEASURE_KEYS) {
    const said = source[key];
    if (text(said) && said.trim() !== "") out[key] = said.trim();
  }
  return out;
}

function parseTools(value: unknown): CodebaseReport["tools"] {
  const source = record(value) ?? {};
  return {
    ...(text(source.image) ? { image: source.image } : {}),
    scc: text(source.scc) ? source.scc : "",
    jscpd: text(source.jscpd) ? source.jscpd : "",
    lizard: text(source.lizard) ? source.lizard : "",
  };
}

/** One of the contract's row schemas, as far as `list` uses it. */
type RowSchema<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };

/** The rows of a list the contract accepts; a row it rejects is dropped. */
function list<T>(value: unknown, row: RowSchema<T>): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = row.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

/** A valid envelope with its optional lists and reasons read as empty. */
function readShape(envelope: CodebaseEnvelope): CodebaseReport {
  const { unmeasured, byLanguage, findings, ...rest } = envelope;
  return {
    ...rest,
    unmeasured: unmeasured ?? {},
    byLanguage: byLanguage ?? [],
    findings: {
      duplicates: findings?.duplicates ?? [],
      complexFunctions: findings?.complexFunctions ?? [],
      unused: findings?.unused ?? [],
      largestFiles: findings?.largestFiles ?? [],
    },
  };
}

/**
 * The stored envelope as the page reads it. The ingest validated it with the
 * contract on the way in, so a row normally passes whole; one that does not
 * (stored under an older contract, or edited) is read part by part, dropping
 * a finding the contract rejects rather than the report.
 */
export function parseCodebaseReport(json: string): CodebaseReport | null {
  const value = parseJson(json);
  const valid = CodebaseEnvelope.safeParse(value);
  if (valid.success) return readShape(valid.data);
  const root = record(value);
  const repository = record(root?.repository);
  if (!root || !repository || !text(root.asset) || !text(root.generatedAt) || !text(repository.commit) || !text(repository.ref)) {
    return null;
  }
  const findings = record(root.findings) ?? {};
  const paths = Array.isArray(root.paths) ? root.paths.filter(text) : undefined;
  return {
    asset: root.asset,
    generatedAt: root.generatedAt,
    repository: {
      ...(text(repository.remote) ? { remote: repository.remote } : {}),
      ref: repository.ref,
      commit: repository.commit,
      committedAt: text(repository.committedAt) ? repository.committedAt : root.generatedAt,
    },
    ...(paths && paths.length > 0 ? { paths } : {}),
    tools: parseTools(root.tools),
    measures: parseMeasures(root.measures),
    unmeasured: parseUnmeasured(root.unmeasured),
    byLanguage: list(root.byLanguage, LanguageRow),
    findings: {
      duplicates: list(findings.duplicates, DuplicateRow),
      complexFunctions: list(findings.complexFunctions, ComplexFunctionRow),
      unused: list(findings.unused, UnusedRow),
      largestFiles: list(findings.largestFiles, LargestFileRow),
    },
  };
}
