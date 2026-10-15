// The codebase report as the Tower reads it. The measure vocabulary (keys,
// labels, meanings, units, the comparison window) is the contract's
// `codebase-measures` module, re-exported here; it is zod-free, so the page can
// import it. `CodebaseReport` here is the contract's envelope with its optional
// lists and reasons read as empty, the shape `worker/codebase-history.ts`
// hands the page.

import type { CodebaseReport as CodebaseEnvelope } from "@noticeos/contract/codebase";
import type { CodebaseMeasureKey, CodebaseMeasures } from "@noticeos/contract/codebase-measures";

export {
  CODEBASE_COMPARISON_MAX_DAYS,
  CODEBASE_COMPARISON_MIN_DAYS,
  CODEBASE_COMPARISON_TARGET_DAYS,
  CODEBASE_MEASURE_KEYS,
  CODEBASE_MEASURES,
  daysBetween,
  pickComparisonReport,
  type CodebaseMeasure,
  type CodebaseMeasureKey,
  type CodebaseMeasures,
  type CodebaseMeasureUnit,
} from "@noticeos/contract/codebase-measures";

type EnvelopeFindings = NonNullable<CodebaseEnvelope["findings"]>;

export type CodebaseLanguage = NonNullable<CodebaseEnvelope["byLanguage"]>[number];
export type CodebaseDuplicate = NonNullable<EnvelopeFindings["duplicates"]>[number];
export type CodebaseComplexFunction = NonNullable<EnvelopeFindings["complexFunctions"]>[number];
export type CodebaseUnusedItem = NonNullable<EnvelopeFindings["unused"]>[number];
export type CodebaseLargestFile = NonNullable<EnvelopeFindings["largestFiles"]>[number];

export interface CodebaseReport extends Omit<CodebaseEnvelope, "measures" | "unmeasured" | "byLanguage" | "findings"> {
  /** ABSENT means the tool did not measure it, never zero. */
  measures: CodebaseMeasures;
  /** Why a measure is absent, in the sentence the Tower shows beside "Not
   * measured"; {} when the report gives no reasons. */
  unmeasured: Partial<Record<CodebaseMeasureKey, string>>;
  byLanguage: CodebaseLanguage[];
  findings: {
    duplicates: CodebaseDuplicate[];
    complexFunctions: CodebaseComplexFunction[];
    unused: CodebaseUnusedItem[];
    largestFiles: CodebaseLargestFile[];
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
