// Synthetic codebase reports for one invented site: weekly reports over the
// last ninety days of a clock the caller names, the code growing a little
// each week. The shape follows deploy/codebase-report/sample/example.com.json
// (no unused packages measured, more test lines than code); every path and
// number here is made up.

import type { WorkspaceStore } from "@noticeos/postgres";
import type { CodebaseHistoryPoint, CodebaseMeasures, CodebaseReport, CodebaseSlice } from "../shared/codebase";

export const CODEBASE_TOOLS = { scc: "3.5.0", jscpd: "5.3.2", lizard: "1.17.31" };

const DAY_MS = 86_400_000;

export function dayBefore(today: string, days: number): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
}

/** A commit for report `n`: 40 hex characters. */
export function commitOf(n: number): string {
  return `${n.toString(16).padStart(4, "0")}c0de`.repeat(5);
}

/** The measures of the `week`-th report back (0 is the newest). */
export function weeklyMeasures(week: number): CodebaseMeasures {
  const code = 48_210 - week * 600;
  return {
    code_lines: code,
    comment_lines: 6_120,
    files: 412 - week * 3,
    languages: 3,
    duplicated_lines: 1_930,
    duplication_percent: 4,
    duplicate_blocks: 37,
    unused_files: 9,
    unused_exports: 44,
    functions: 1_880,
    complex_functions: 23 - Math.min(week, 5),
    max_function_complexity: 41,
    mean_function_complexity: 3.2,
    test_lines: 49_660,
    test_ratio: 1.03,
    commits_30d: 84,
  };
}

/** The newest report in full, `today`'s. */
export function codebaseReport(asset: string, today: string, measures: CodebaseMeasures = weeklyMeasures(0)): CodebaseReport {
  return {
    asset,
    generatedAt: `${today}T03:12:44.000Z`,
    repository: { remote: "github.com/example/site", ref: "main", commit: commitOf(1), committedAt: `${dayBefore(today, 1)}T22:01:00.000Z` },
    tools: CODEBASE_TOOLS,
    measures,
    unmeasured: { unused_dependencies: "Unused packages are not measured yet." },
    byLanguage: [
      { language: "TypeScript", files: 300, code_lines: 40_000 },
      { language: "CSS", files: 80, code_lines: 6_000 },
      { language: "JavaScript", files: 32, code_lines: 2_210 },
    ],
    findings: {
      duplicates: [
        { lines: 48, files: [{ path: "src/a.ts", startLine: 10 }, { path: "src/b.ts", startLine: 88 }] },
        { lines: 22, files: [{ path: "src/c.ts", startLine: 4 }, { path: "src/d.ts", startLine: 61 }, { path: "src/e.ts", startLine: 9 }] },
      ],
      complexFunctions: [{ path: "src/x.ts", name: "render", line: 120, complexity: 41, length: 210 }],
      unused: [
        { kind: "file", path: "src/old.ts" },
        { kind: "export", path: "src/u.ts", name: "helper" },
        { kind: "dependency", name: "left-pad" },
      ],
      largestFiles: [{ path: "src/big.ts", code_lines: 2_400 }],
    },
  };
}

/** Thirteen weekly reports ending `today`, oldest first. */
export function weeklyHistory(today: string, weeks = 13): CodebaseHistoryPoint[] {
  return Array.from({ length: weeks }, (_, index) => {
    const week = weeks - 1 - index;
    return {
      date: dayBefore(today, week * 7),
      commit: commitOf(week + 1),
      ref: "main",
      generatedAt: `${dayBefore(today, week * 7)}T03:12:44.000Z`,
      measures: weeklyMeasures(week),
      tools: CODEBASE_TOOLS,
    };
  });
}

export function codebaseSlice(asset: string, today: string): CodebaseSlice {
  return {
    history: weeklyHistory(today),
    latest: { date: today, revision: 1, receivedAt: `${today}T03:13:00.000Z`, report: codebaseReport(asset, today) },
  };
}

export const NO_CODEBASE: CodebaseSlice = { history: [], latest: null };

/** One stored report: a day's envelope, and when it arrived. */
export interface StoredCodebaseReport {
  asset: string;
  date: string;
  report: CodebaseReport | Record<string, unknown>;
  receivedAt?: string;
  commit?: string;
}

/**
 * Into `noticeos.codebase_reports` as the ingest writes them: a same-day
 * resend takes the next revision, and the store hands out the number.
 */
export async function storeCodebaseReports(store: WorkspaceStore, reports: readonly StoredCodebaseReport[]): Promise<void> {
  await store.write(async (tx) => {
    for (const row of reports) {
      const envelope = row.report as { generatedAt?: string; repository?: { commit?: string; ref?: string } };
      await tx.execute(
        `INSERT INTO noticeos.codebase_reports
           (workspace_id, asset_id, report_date, revision, commit, ref, generated_at, received_at, envelope)
         SELECT $1::uuid, $2, $3::date, coalesce(max(revision), 0) + 1, $4, $5, $6::timestamptz, $7::timestamptz, $8::json
           FROM noticeos.codebase_reports WHERE asset_id = $2 AND report_date = $3::date`,
        [
          tx.workspaceId, row.asset, row.date,
          row.commit ?? envelope.repository?.commit ?? commitOf(1), envelope.repository?.ref ?? "main",
          envelope.generatedAt ?? `${row.date}T03:12:44.000Z`, row.receivedAt ?? `${row.date}T03:13:00.000Z`,
          JSON.stringify(row.report),
        ],
      );
    }
  });
}

/** Weekly stored reports ending `today`, each its own week's measures and commit. */
export function weeklyStoredReports(asset: string, today: string, weeks = 13): StoredCodebaseReport[] {
  return weeklyHistory(today, weeks).map((point) => {
    const report = codebaseReport(asset, point.date, point.measures);
    report.repository.commit = point.commit;
    return { asset, date: point.date, report, commit: point.commit };
  });
}
