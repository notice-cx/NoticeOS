// One site's codebase reports for its Codebase tab: each day's newest revision
// (`noticeos.current_codebase_reports`) over the history window, reduced to
// its measures in SQL so ninety reports never cross as ninety findings lists,
// and the newest report in full.

import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import {
  CODEBASE_HISTORY_DAYS,
  CODEBASE_MEASURE_KEYS,
  type CodebaseComplexFunction,
  type CodebaseDuplicate,
  type CodebaseHistoryPoint,
  type CodebaseLanguage,
  type CodebaseMeasureKey,
  type CodebaseMeasures,
  type CodebaseReport,
  type CodebaseSlice,
  type CodebaseUnusedItem,
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

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === "string";

/** Only known keys with a non-negative number cross; anything else reads as
 * unmeasured, never as zero. */
export function parseMeasures(value: unknown): CodebaseMeasures {
  const source = record(value);
  const out: CodebaseMeasures = {};
  if (!source) return out;
  for (const key of CODEBASE_MEASURE_KEYS) {
    const measure = source[key];
    if (finite(measure)) out[key] = measure;
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

function list<T>(value: unknown, parse: (item: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = record(item);
    const parsed = row ? parse(row) : null;
    return parsed === null ? [] : [parsed];
  });
}

/**
 * The stored envelope as the page reads it. The ingest validated it on the
 * way in; this only keeps a malformed row from breaking the page, dropping a
 * finding it cannot read rather than the report.
 */
export function parseCodebaseReport(json: string): CodebaseReport | null {
  const root = record(parseJson(json));
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
    byLanguage: list<CodebaseLanguage>(root.byLanguage, (row) =>
      text(row.language) && finite(row.files) && finite(row.code_lines)
        ? { language: row.language, files: row.files, code_lines: row.code_lines }
        : null),
    findings: {
      duplicates: list<CodebaseDuplicate>(findings.duplicates, (row) => {
        const files = list(row.files, (file) =>
          text(file.path) && finite(file.startLine) ? { path: file.path, startLine: file.startLine } : null);
        return finite(row.lines) && files.length > 0 ? { lines: row.lines, files } : null;
      }),
      complexFunctions: list<CodebaseComplexFunction>(findings.complexFunctions, (row) =>
        text(row.path) && text(row.name) && finite(row.line) && finite(row.complexity) && finite(row.length)
          ? { path: row.path, name: row.name, line: row.line, complexity: row.complexity, length: row.length }
          : null),
      unused: list<CodebaseUnusedItem>(findings.unused, (row) => {
        if (row.kind === "file" && text(row.path)) return { kind: "file", path: row.path };
        if (row.kind === "export" && text(row.path) && text(row.name)) return { kind: "export", path: row.path, name: row.name };
        if (row.kind === "dependency" && text(row.name)) return { kind: "dependency", name: row.name };
        return null;
      }),
      largestFiles: list(findings.largestFiles, (row) =>
        text(row.path) && finite(row.code_lines) ? { path: row.path, code_lines: row.code_lines } : null),
    },
  };
}
