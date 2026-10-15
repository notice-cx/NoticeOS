// The codebase report's measures, its four rules and their thresholds, with
// the words the Tower shows for each. Zod-free, so browser code can import it
// by subpath (`@noticeos/contract/codebase-measures`); the envelope's schema is
// `codebase.ts`, which re-exports this module.
//
// A measure absent from a report was not measured. It is never read as 0:
// a rule whose inputs are absent neither fires nor resolves anything.

/** How a measure's number reads: a whole count, a percent 0..100, a ratio (0 or more; tests can outnumber code), or an average. */
export type CodebaseMeasureUnit = 'count' | 'percent' | 'ratio' | 'mean';

export interface CodebaseMeasure {
  key: CodebaseMeasureKey;
  unit: CodebaseMeasureUnit;
  /** The name the Tower shows. */
  label: string;
  /** One plain sentence on what the number counts. */
  meaning: string;
}

export const CODEBASE_MEASURE_KEYS = [
  'code_lines',
  'comment_lines',
  'files',
  'languages',
  'duplicated_lines',
  'duplication_percent',
  'duplicate_blocks',
  'unused_files',
  'unused_exports',
  'unused_dependencies',
  'dependencies_direct',
  'functions',
  'complex_functions',
  'max_function_complexity',
  'mean_function_complexity',
  'test_lines',
  'test_ratio',
  'commits_30d',
  'files_touched_30d',
  'large_commits_30d',
] as const;
export type CodebaseMeasureKey = (typeof CODEBASE_MEASURE_KEYS)[number];

/** Every measure a report may carry, in the order the Tower lists them. */
export const CODEBASE_MEASURES: readonly CodebaseMeasure[] = [
  { key: 'code_lines', unit: 'count', label: 'Lines of code', meaning: 'Lines that hold code, in every language, not counting blank lines, comments or tests.' },
  { key: 'comment_lines', unit: 'count', label: 'Comment lines', meaning: 'Lines that hold only comments.' },
  { key: 'files', unit: 'count', label: 'Files', meaning: 'Files of code that were measured.' },
  { key: 'languages', unit: 'count', label: 'Languages', meaning: 'Programming languages found in the code.' },
  { key: 'duplicated_lines', unit: 'count', label: 'Repeated lines', meaning: 'Lines that appear, copied, in more than one place.' },
  { key: 'duplication_percent', unit: 'percent', label: 'Repeated code', meaning: 'The share of the code that is copied from somewhere else in it.' },
  { key: 'duplicate_blocks', unit: 'count', label: 'Repeated blocks', meaning: 'Blocks of code that appear in more than one place.' },
  { key: 'unused_files', unit: 'count', label: 'Unused files', meaning: 'Files of code that nothing else uses.' },
  { key: 'unused_exports', unit: 'count', label: 'Unused shared pieces', meaning: 'Pieces of code offered to the rest of the code that nothing uses.' },
  { key: 'unused_dependencies', unit: 'count', label: 'Unused packages', meaning: 'Outside packages the project installs but never uses.' },
  { key: 'dependencies_direct', unit: 'count', label: 'Packages', meaning: 'Outside packages the project installs by name.' },
  { key: 'functions', unit: 'count', label: 'Functions', meaning: 'Functions found in the code.' },
  { key: 'complex_functions', unit: 'count', label: 'Hard-to-change functions', meaning: 'Functions with so many branches that a change to them is likely to break something.' },
  { key: 'max_function_complexity', unit: 'count', label: 'Most branches in one function', meaning: 'The number of paths through the most tangled function.' },
  { key: 'mean_function_complexity', unit: 'mean', label: 'Average branches per function', meaning: 'The average number of paths through a function.' },
  { key: 'test_lines', unit: 'count', label: 'Lines of tests', meaning: 'Lines of code that check the rest of the code.' },
  { key: 'test_ratio', unit: 'ratio', label: 'Test coverage by size', meaning: 'Lines of tests for each line of code.' },
  { key: 'commits_30d', unit: 'count', label: 'Changes in 30 days', meaning: 'Changes saved to the code in the last 30 days.' },
  { key: 'files_touched_30d', unit: 'count', label: 'Files changed in 30 days', meaning: 'Different files those changes touched.' },
  { key: 'large_commits_30d', unit: 'count', label: 'Large changes in 30 days', meaning: 'Changes in the last 30 days that each touched 20 files or more.' },
];

/** Each report's measures: every key optional, and an absent key is unmeasured. */
export type CodebaseMeasures = Partial<Record<CodebaseMeasureKey, number>>;

export const CODEBASE_GROWTH_RULE_ID = 'codebase-growth';
export const CODEBASE_DUPLICATION_RULE_ID = 'codebase-duplication';
export const CODEBASE_UNUSED_RULE_ID = 'codebase-unused';
export const CODEBASE_COMPLEXITY_RULE_ID = 'codebase-complexity';
export const CODEBASE_RULE_IDS = [
  CODEBASE_GROWTH_RULE_ID,
  CODEBASE_DUPLICATION_RULE_ID,
  CODEBASE_UNUSED_RULE_ID,
  CODEBASE_COMPLEXITY_RULE_ID,
] as const;
export type CodebaseRuleId = (typeof CODEBASE_RULE_IDS)[number];

/** `config/constants.json` `codebase_rules`, with its file's own snake_case keys. */
export interface CodebaseRuleThresholds {
  /** Fire growth when lines of code rose at least this percent over the comparison report. */
  growth_percent_30d: number;
  /** ...and by at least this many lines. */
  growth_min_lines: number;
  /** Fire duplication at or above this percent of repeated code. */
  duplication_percent: number;
  /** Fire unused when unused files plus unused packages reach this many. */
  unused_items: number;
  /** Fire complexity when this many more functions became hard to change over the comparison report. */
  complex_functions_added_30d: number;
}

export const DEFAULT_CODEBASE_RULE_THRESHOLDS: Readonly<CodebaseRuleThresholds> = Object.freeze({
  growth_percent_30d: 25,
  growth_min_lines: 500,
  duplication_percent: 8,
  unused_items: 10,
  complex_functions_added_30d: 5,
});

/**
 * Thresholds from a constants document, per key: a key that is missing, not a
 * finite number or negative reads as `fallback`'s, so a stored document that
 * lacks `codebase_rules` behaves as a file that never had it.
 */
export function codebaseRuleThresholds(
  document: unknown,
  fallback: Readonly<CodebaseRuleThresholds> = DEFAULT_CODEBASE_RULE_THRESHOLDS,
): CodebaseRuleThresholds {
  const container =
    typeof document === 'object' && document !== null
      ? (document as { codebase_rules?: unknown }).codebase_rules
      : undefined;
  const stored = typeof container === 'object' && container !== null ? (container as Record<string, unknown>) : {};
  const out = { ...fallback };
  for (const key of Object.keys(out) as (keyof CodebaseRuleThresholds)[]) {
    const value = stored[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value;
  }
  return out;
}

/**
 * The 30-day rules compare with an earlier report of the same site: the one
 * whose date is nearest 30 days back, at least 28 and at most 45 days back.
 * Outside that span a change cannot be stated as a 30-day change, so there is
 * no comparison and those rules stay quiet.
 */
export const CODEBASE_COMPARISON_MIN_DAYS = 28;
export const CODEBASE_COMPARISON_TARGET_DAYS = 30;
export const CODEBASE_COMPARISON_MAX_DAYS = 45;

const DAY_MS = 86_400_000;

/** Whole days from `earlier` to `later`, both `YYYY-MM-DD`. */
export function daysBetween(earlier: string, later: string): number {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / DAY_MS);
}

/** The comparison report for `reportDate` among `candidates`, or null. A tie goes to the older one. */
export function pickComparisonReport<T extends { reportDate: string }>(
  reportDate: string,
  candidates: readonly T[],
): T | null {
  let best: T | null = null;
  let bestDistance = Infinity;
  let bestAge = -Infinity;
  for (const candidate of candidates) {
    const age = daysBetween(candidate.reportDate, reportDate);
    if (age < CODEBASE_COMPARISON_MIN_DAYS || age > CODEBASE_COMPARISON_MAX_DAYS) continue;
    const distance = Math.abs(age - CODEBASE_COMPARISON_TARGET_DAYS);
    if (distance < bestDistance || (distance === bestDistance && age > bestAge)) {
      best = candidate;
      bestDistance = distance;
      bestAge = age;
    }
  }
  return best;
}

/** One report as the rules read it. */
export interface CodebaseRuleReport {
  reportNumber: number;
  reportDate: string;
  revision: number;
  commit: string;
  measures: CodebaseMeasures;
}

/** What one rule found. `evaluable` is false when an input is unmeasured or the comparison is missing. */
export interface CodebaseRuleVerdict {
  ruleId: CodebaseRuleId;
  evaluable: boolean;
  fired: boolean;
  severity: 'info' | 'warn';
  kind: 'anomaly' | 'opportunity';
  /** The measure the flag is about, or null for a rule over two measures. */
  metric: CodebaseMeasureKey | null;
  /** The sentence the flag carries; null unless fired. */
  message: string | null;
  /** The numbers the verdict used, stored as the flag's inputs. */
  inputs: Record<string, unknown>;
}

const whole = (value: number): string => Math.round(value).toLocaleString('en-US');
const plural = (count: number, one: string, many: string): string => `${whole(count)} ${count === 1 ? one : many}`;

function reportRef(report: CodebaseRuleReport) {
  return {
    reportNumber: report.reportNumber,
    reportDate: report.reportDate,
    revision: report.revision,
    commit: report.commit,
  };
}

/**
 * Run the four rules over a report and, for the 30-day rules, its comparison
 * report (`pickComparisonReport`), or null when there is none.
 */
export function evaluateCodebaseRules(
  current: CodebaseRuleReport,
  comparison: CodebaseRuleReport | null,
  thresholds: CodebaseRuleThresholds,
): CodebaseRuleVerdict[] {
  const now = current.measures;
  const then = comparison?.measures;
  const days = comparison === null ? null : daysBetween(comparison.reportDate, current.reportDate);
  const report = reportRef(current);
  const against = comparison === null ? null : { ...reportRef(comparison), days };
  const verdicts: CodebaseRuleVerdict[] = [];

  {
    const lines = now.code_lines;
    const before = then?.code_lines;
    const evaluable = lines !== undefined && before !== undefined && before > 0 && days !== null;
    const added = evaluable ? lines - before : null;
    const percent = evaluable ? ((lines - before) / before) * 100 : null;
    const fired =
      evaluable &&
      percent! >= thresholds.growth_percent_30d &&
      added! >= thresholds.growth_min_lines;
    verdicts.push({
      ruleId: CODEBASE_GROWTH_RULE_ID,
      evaluable,
      fired,
      severity: 'warn',
      kind: 'anomaly',
      metric: 'code_lines',
      message: fired
        ? `The code grew ${whole(percent!)}% in ${days} days (${whole(before!)} → ${whole(lines!)} lines).`
        : null,
      inputs: {
        report,
        comparison: against,
        code_lines: lines ?? null,
        comparison_code_lines: before ?? null,
        added_lines: added,
        growth_percent: percent === null ? null : Math.round(percent * 10) / 10,
        growth_percent_30d: thresholds.growth_percent_30d,
        growth_min_lines: thresholds.growth_min_lines,
      },
    });
  }

  {
    const percent = now.duplication_percent;
    const evaluable = percent !== undefined;
    const fired = evaluable && percent >= thresholds.duplication_percent;
    verdicts.push({
      ruleId: CODEBASE_DUPLICATION_RULE_ID,
      evaluable,
      fired,
      severity: 'warn',
      kind: 'opportunity',
      metric: 'duplication_percent',
      message: fired ? `${percent.toFixed(1)}% of the code is repeated.` : null,
      inputs: {
        report,
        duplication_percent: percent ?? null,
        threshold_percent: thresholds.duplication_percent,
      },
    });
  }

  {
    const files = now.unused_files;
    const packages = now.unused_dependencies;
    const evaluable = files !== undefined || packages !== undefined;
    const items = (files ?? 0) + (packages ?? 0);
    const fired = evaluable && items >= thresholds.unused_items;
    let message: string | null = null;
    if (fired) {
      const parts = [
        ...(files === undefined ? [] : [plural(files, 'file', 'files')]),
        ...(packages === undefined ? [] : [plural(packages, 'package', 'packages')]),
      ];
      const one = parts.length === 1 && items === 1;
      message = `${parts.join(' and ')} ${one ? 'is' : 'are'} not used.`;
    }
    verdicts.push({
      ruleId: CODEBASE_UNUSED_RULE_ID,
      evaluable,
      fired,
      severity: 'info',
      kind: 'opportunity',
      metric: null,
      message,
      inputs: {
        report,
        unused_files: files ?? null,
        unused_dependencies: packages ?? null,
        unused_items: items,
        threshold_items: thresholds.unused_items,
      },
    });
  }

  {
    const complex = now.complex_functions;
    const before = then?.complex_functions;
    const evaluable = complex !== undefined && before !== undefined && days !== null;
    const added = evaluable ? complex - before : null;
    const fired = evaluable && added! >= thresholds.complex_functions_added_30d;
    verdicts.push({
      ruleId: CODEBASE_COMPLEXITY_RULE_ID,
      evaluable,
      fired,
      severity: 'info',
      kind: 'opportunity',
      metric: 'complex_functions',
      message: fired
        ? `${plural(added!, 'more function', 'more functions')} became hard to change in ${days} days.`
        : null,
      inputs: {
        report,
        comparison: against,
        complex_functions: complex ?? null,
        comparison_complex_functions: before ?? null,
        added_complex_functions: added,
        complex_functions_added_30d: thresholds.complex_functions_added_30d,
      },
    });
  }

  return verdicts;
}
