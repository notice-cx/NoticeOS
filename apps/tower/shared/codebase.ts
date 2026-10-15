// The codebase report as the Tower reads it. The measure table, the keys and
// the comparison bounds mirror `packages/contract/src/codebase-measures.ts`
// exactly and go once the Tower imports it. `CodebaseReport` here is the
// contract's envelope with its optional lists and reasons read as empty, the shape
// `worker/codebase-history.ts` hands the page.

/** Every measure a report may carry. ABSENT means the tool did not measure it,
 * never zero. */
export type CodebaseMeasureKey =
  | "code_lines"
  | "comment_lines"
  | "files"
  | "languages"
  | "duplicated_lines"
  | "duplication_percent"
  | "duplicate_blocks"
  | "unused_files"
  | "unused_exports"
  | "unused_dependencies"
  | "dependencies_direct"
  | "functions"
  | "complex_functions"
  | "max_function_complexity"
  | "mean_function_complexity"
  | "test_lines"
  | "test_ratio"
  | "commits_30d"
  | "files_touched_30d"
  | "large_commits_30d";

export type CodebaseMeasures = Partial<Record<CodebaseMeasureKey, number>>;

/** How a measure's number reads: a whole count, a percent 0..100, a ratio 0..1, or an average. */
export type CodebaseMeasureUnit = "count" | "percent" | "ratio" | "mean";

export interface CodebaseMeasureSpec {
  key: CodebaseMeasureKey;
  unit: CodebaseMeasureUnit;
  /** The name the Tower shows. */
  label: string;
  /** One plain sentence on what the number counts. */
  meaning: string;
}

export const CODEBASE_MEASURES: readonly CodebaseMeasureSpec[] = [
  { key: "code_lines", unit: "count", label: "Lines of code", meaning: "Lines that hold code, in every language, not counting blank lines, comments or tests." },
  { key: "comment_lines", unit: "count", label: "Comment lines", meaning: "Lines that hold only comments." },
  { key: "files", unit: "count", label: "Files", meaning: "Files of code that were measured." },
  { key: "languages", unit: "count", label: "Languages", meaning: "Programming languages found in the code." },
  { key: "duplicated_lines", unit: "count", label: "Repeated lines", meaning: "Lines that appear, copied, in more than one place." },
  { key: "duplication_percent", unit: "percent", label: "Repeated code", meaning: "The share of the code that is copied from somewhere else in it." },
  { key: "duplicate_blocks", unit: "count", label: "Repeated blocks", meaning: "Blocks of code that appear in more than one place." },
  { key: "unused_files", unit: "count", label: "Unused files", meaning: "Files of code that nothing else uses." },
  { key: "unused_exports", unit: "count", label: "Unused shared pieces", meaning: "Pieces of code offered to the rest of the code that nothing uses." },
  { key: "unused_dependencies", unit: "count", label: "Unused packages", meaning: "Outside packages the project installs but never uses." },
  { key: "dependencies_direct", unit: "count", label: "Packages", meaning: "Outside packages the project installs by name." },
  { key: "functions", unit: "count", label: "Functions", meaning: "Functions found in the code." },
  { key: "complex_functions", unit: "count", label: "Hard-to-change functions", meaning: "Functions with so many branches that a change to them is likely to break something." },
  { key: "max_function_complexity", unit: "count", label: "Most branches in one function", meaning: "The number of paths through the most tangled function." },
  { key: "mean_function_complexity", unit: "mean", label: "Average branches per function", meaning: "The average number of paths through a function." },
  { key: "test_lines", unit: "count", label: "Lines of tests", meaning: "Lines of code that check the rest of the code." },
  { key: "test_ratio", unit: "ratio", label: "Test coverage by size", meaning: "Lines of tests for each line of code." },
  { key: "commits_30d", unit: "count", label: "Changes in 30 days", meaning: "Changes saved to the code in the last 30 days." },
  { key: "files_touched_30d", unit: "count", label: "Files changed in 30 days", meaning: "Different files those changes touched." },
  { key: "large_commits_30d", unit: "count", label: "Large changes in 30 days", meaning: "Changes in the last 30 days that each touched 20 files or more." },
];

/** A 30-day change compares with the report nearest 30 days back, between
 * these bounds; a tie goes to the older report. */
export const CODEBASE_COMPARISON_MIN_DAYS = 28;
export const CODEBASE_COMPARISON_TARGET_DAYS = 30;
export const CODEBASE_COMPARISON_MAX_DAYS = 45;

export const CODEBASE_MEASURE_KEYS: readonly CodebaseMeasureKey[] = CODEBASE_MEASURES.map((spec) => spec.key);

export interface CodebaseLanguage {
  language: string;
  files: number;
  code_lines: number;
}

export interface CodebaseDuplicate {
  lines: number;
  files: { path: string; startLine: number }[];
}

export interface CodebaseComplexFunction {
  path: string;
  name: string;
  line: number;
  complexity: number;
  length: number;
}

export type CodebaseUnusedItem =
  | { kind: "file"; path: string }
  | { kind: "export"; path: string; name: string }
  | { kind: "dependency"; name: string };

export interface CodebaseReport {
  asset: string;
  generatedAt: string;
  repository: {
    remote?: string;
    ref: string;
    commit: string;
    committedAt: string;
  };
  paths?: string[];
  tools: {
    image?: string;
    scc: string;
    jscpd: string;
    lizard: string;
  };
  measures: CodebaseMeasures;
  /** Why a measure is absent, in the sentence the Tower shows beside "Not
   * measured"; {} when the report gives no reasons. */
  unmeasured: Partial<Record<CodebaseMeasureKey, string>>;
  byLanguage: CodebaseLanguage[];
  findings: {
    duplicates: CodebaseDuplicate[];
    complexFunctions: CodebaseComplexFunction[];
    unused: CodebaseUnusedItem[];
    largestFiles: { path: string; code_lines: number }[];
  };
}

// --- the asset page's codebase section ---------------------------------------

/** How far back the section's history reaches, in days before the read. */
export const CODEBASE_HISTORY_DAYS = 90;

/** One day's current report, reduced to what the charts and deltas need. */
export interface CodebaseHistoryPoint {
  /** The report's UTC date (`report_date`). */
  date: string;
  commit: string;
  ref: string;
  generatedAt: string;
  measures: CodebaseMeasures;
  /** The tool versions behind the numbers: a change explains a step. */
  tools: CodebaseReport["tools"];
}

export interface CodebaseSlice {
  /** Each day's newest revision in the last `CODEBASE_HISTORY_DAYS`, oldest
   * first. A day with no report is absent. */
  history: CodebaseHistoryPoint[];
  /** The newest report in full, or null when the site has never sent one.
   * It may be older than the history window. */
  latest: {
    date: string;
    revision: number;
    receivedAt: string;
    report: CodebaseReport;
  } | null;
}
