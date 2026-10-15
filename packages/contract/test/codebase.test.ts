import { describe, expect, it } from 'vitest';
import measurerSample from '../../../deploy/codebase-report/sample/example.com.json';
import {
  CODEBASE_MEASURE_KEYS,
  CODEBASE_MEASURES,
  CODEBASE_REPORT_MAX_BYTES,
  CodebaseReport,
  DEFAULT_CODEBASE_RULE_THRESHOLDS,
  codebaseRuleThresholds,
  evaluateCodebaseRules,
  pickComparisonReport,
  utf8Bytes,
  type CodebaseRuleReport,
} from '../src/codebase.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

function validReport(): Record<string, unknown> & { measures: Record<string, number>; findings: Record<string, unknown[]> } {
  return {
    asset: 'example.com',
    generatedAt: '2026-10-15T03:12:44Z',
    repository: {
      remote: 'github.com/example/site',
      ref: 'main',
      commit: COMMIT,
      committedAt: '2026-10-14T22:01:00Z',
    },
    paths: ['apps/site'],
    tools: { image: 'ghcr.io/example/measure@sha256:abc', scc: '3.5.0', jscpd: '5.3.2', lizard: '1.17.31' },
    measures: {
      code_lines: 48210,
      comment_lines: 6120,
      files: 412,
      languages: 6,
      duplicated_lines: 1930,
      duplication_percent: 4.0,
      duplicate_blocks: 37,
      unused_files: 9,
      unused_exports: 44,
      unused_dependencies: 3,
      dependencies_direct: 61,
      functions: 1880,
      complex_functions: 23,
      max_function_complexity: 41,
      mean_function_complexity: 3.2,
      test_lines: 9100,
      test_ratio: 0.19,
      commits_30d: 84,
      files_touched_30d: 260,
      large_commits_30d: 7,
    },
    byLanguage: [{ language: 'TypeScript', files: 300, code_lines: 40000 }],
    findings: {
      duplicates: [{ lines: 48, files: [{ path: 'src/a.ts', startLine: 10 }, { path: 'src/b.ts', startLine: 88 }] }],
      complexFunctions: [{ path: 'src/x.ts', name: 'render', line: 120, complexity: 41, length: 210 }],
      unused: [
        { kind: 'file', path: 'src/old.ts' },
        { kind: 'export', path: 'src/u.ts', name: 'helper' },
        { kind: 'dependency', name: 'lodash' },
      ],
      largestFiles: [{ path: 'src/big.ts', code_lines: 2400 }],
    },
  };
}

const refused = (body: unknown): boolean => !CodebaseReport.safeParse(body).success;

describe('CodebaseReport', () => {
  it('parses a full envelope', () => {
    const parsed = CodebaseReport.safeParse(validReport());
    expect(parsed.success).toBe(true);
  });

  it('allows every measure to be absent: absent is unmeasured, never 0', () => {
    const { findings: _f, byLanguage: _b, paths: _p, ...body } = validReport();
    body.measures = {};
    const parsed = CodebaseReport.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.measures.code_lines).toBeUndefined();
  });

  it('refuses an unknown key at the top, in a measure and in a finding', () => {
    expect(refused({ ...validReport(), extra: 1 })).toBe(true);
    const measure = validReport();
    measure.measures.lines_total = 3;
    expect(refused(measure)).toBe(true);
    const finding = validReport();
    finding.findings.largestFiles = [{ path: 'src/a.ts', code_lines: 1, source: 'x' }];
    expect(refused(finding)).toBe(true);
  });

  it('accepts the measurer\'s own sample report', () => {
    const parsed = CodebaseReport.safeParse(measurerSample);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('accepts a reason for each unmeasured key, and refuses an unknown key or an empty reason', () => {
    const body = validReport();
    delete body.measures.unused_dependencies;
    expect(refused({ ...body, unmeasured: { unused_dependencies: 'Unused packages are not measured yet.' } })).toBe(false);
    expect(refused({ ...body, unmeasured: { lines_total: 'x' } })).toBe(true);
    expect(refused({ ...body, unmeasured: { unused_files: '' } })).toBe(true);
    expect(refused({ ...body, unmeasured: { unused_files: 'x'.repeat(201) } })).toBe(true);
  });

  it('accepts more test lines than code lines', () => {
    const body = validReport();
    body.measures.test_ratio = 1.03;
    expect(refused(body)).toBe(false);
  });

  it('refuses a percent over 100, a negative ratio, a negative or fractional count', () => {
    for (const [key, value] of [
      ['duplication_percent', 100.1],
      ['test_ratio', -0.01],
      ['code_lines', -1],
      ['files', 1.5],
      ['mean_function_complexity', -0.1],
    ] as const) {
      const body = validReport();
      body.measures[key] = value;
      expect(refused(body), key).toBe(true);
    }
  });

  it('refuses a path with .., an absolute path, a backslash and an overlong path', () => {
    for (const path of ['../etc/passwd', 'src/../../x.ts', '/etc/passwd', 'C:/x.ts', 'src\\a.ts', `a/${'x'.repeat(512)}`]) {
      const body = validReport();
      body.findings.largestFiles = [{ path, code_lines: 1 }];
      expect(refused(body), path).toBe(true);
    }
    const dots = validReport();
    dots.findings.largestFiles = [{ path: 'src/a..b.ts', code_lines: 1 }];
    expect(refused(dots)).toBe(false);
  });

  it('refuses a malformed commit and a remote with a scheme, credentials or .git', () => {
    const commit = validReport();
    (commit.repository as Record<string, unknown>).commit = 'ABCDEF';
    expect(refused(commit)).toBe(true);
    for (const remote of ['https://github.com/example/site', 'user:token@github.com/example/site', 'github.com/example/site.git']) {
      const body = validReport();
      (body.repository as Record<string, unknown>).remote = remote;
      expect(refused(body), remote).toBe(true);
    }
  });

  it('refuses each list past its limit', () => {
    const many = <T>(n: number, item: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => item(i));
    const cases: [string, (body: ReturnType<typeof validReport>) => void][] = [
      ['paths', (b) => { b.paths = many(21, (i) => `p${i}`); }],
      ['byLanguage', (b) => { b.byLanguage = many(13, (i) => ({ language: `L${i}`, files: 1, code_lines: 1 })); }],
      ['duplicates', (b) => { b.findings.duplicates = many(21, () => ({ lines: 1, files: [{ path: 'a', startLine: 1 }, { path: 'b', startLine: 1 }] })); }],
      ['duplicate files', (b) => { b.findings.duplicates = [{ lines: 1, files: many(11, (i) => ({ path: `f${i}`, startLine: 1 })) }]; }],
      ['complexFunctions', (b) => { b.findings.complexFunctions = many(21, () => ({ path: 'a', name: 'f', line: 1, complexity: 20, length: 5 })); }],
      ['unused', (b) => { b.findings.unused = many(51, (i) => ({ kind: 'file', path: `f${i}` })); }],
      ['largestFiles', (b) => { b.findings.largestFiles = many(11, (i) => ({ path: `f${i}`, code_lines: 1 })); }],
    ];
    for (const [limit, change] of cases) {
      const body = validReport();
      change(body);
      expect(refused(body), limit).toBe(true);
    }
  });

  it('refuses a body larger than the byte limit', () => {
    const body = validReport();
    body.tools = { ...(body.tools as object), image: 'x'.repeat(512) };
    (body.repository as Record<string, unknown>).ref = 'r'.repeat(255);
    // Every list at its limit with in-bounds paths of three-byte characters.
    const filler = '\u6587/'.repeat(255);
    body.paths = Array.from({ length: 20 }, () => filler);
    body.findings.unused = Array.from({ length: 50 }, () => ({ kind: 'export', path: filler, name: 'n'.repeat(256) }));
    body.findings.complexFunctions = Array.from({ length: 20 }, () => ({ path: filler, name: 'n'.repeat(256), line: 1, complexity: 1, length: 1 }));
    body.findings.duplicates = Array.from({ length: 20 }, () => ({ lines: 1, files: Array.from({ length: 10 }, () => ({ path: filler, startLine: 1 })) }));
    body.findings.largestFiles = Array.from({ length: 10 }, () => ({ path: filler, code_lines: 1 }));
    expect(utf8Bytes(JSON.stringify(body))).toBeGreaterThan(CODEBASE_REPORT_MAX_BYTES);
    expect(refused(body)).toBe(true);
  });
});

describe('CODEBASE_MEASURES', () => {
  it('names every measure once, with the words the Tower shows', () => {
    expect(CODEBASE_MEASURES.map((m) => m.key)).toEqual([...CODEBASE_MEASURE_KEYS]);
    const label = (key: string) => CODEBASE_MEASURES.find((m) => m.key === key)?.label;
    expect(label('code_lines')).toBe('Lines of code');
    expect(label('duplication_percent')).toBe('Repeated code');
    expect(label('unused_files')).toMatch(/^Unused /u);
    expect(label('unused_exports')).toMatch(/^Unused /u);
    expect(label('unused_dependencies')).toMatch(/^Unused /u);
    expect(label('complex_functions')).toBe('Hard-to-change functions');
    expect(label('test_ratio')).toBe('Test coverage by size');
    expect(label('commits_30d')).toBe('Changes in 30 days');
    for (const m of CODEBASE_MEASURES) expect(m.meaning.length).toBeGreaterThan(0);
  });
});

describe('codebaseRuleThresholds', () => {
  it('reads each stored key and falls back per key', () => {
    expect(codebaseRuleThresholds(undefined)).toEqual(DEFAULT_CODEBASE_RULE_THRESHOLDS);
    expect(codebaseRuleThresholds({ flag_defaults: {} })).toEqual(DEFAULT_CODEBASE_RULE_THRESHOLDS);
    expect(codebaseRuleThresholds({ codebase_rules: { duplication_percent: 12, unused_items: 'x', growth_min_lines: -1 } })).toEqual({
      ...DEFAULT_CODEBASE_RULE_THRESHOLDS,
      duplication_percent: 12,
    });
  });
});

describe('pickComparisonReport', () => {
  const at = (reportDate: string) => ({ reportDate });
  it('takes the report nearest 30 days back, at least 28 and at most 45 days back', () => {
    expect(pickComparisonReport('2026-10-31', [at('2026-10-10'), at('2026-10-04'), at('2026-10-01'), at('2026-09-01')])).toEqual(at('2026-10-01'));
    expect(pickComparisonReport('2026-10-31', [at('2026-10-03'), at('2026-09-20')])).toEqual(at('2026-10-03'));
    expect(pickComparisonReport('2026-10-31', [at('2026-10-03'), at('2026-09-29')])).toEqual(at('2026-09-29'));
    expect(pickComparisonReport('2026-10-31', [at('2026-10-10'), at('2026-09-01')])).toBeNull();
  });
});

describe('evaluateCodebaseRules', () => {
  const report = (measures: CodebaseRuleReport['measures'], reportDate = '2026-10-31'): CodebaseRuleReport => ({
    reportNumber: 2,
    reportDate,
    revision: 1,
    commit: COMMIT,
    measures,
  });
  const verdict = (verdicts: ReturnType<typeof evaluateCodebaseRules>, id: string) => verdicts.find((v) => v.ruleId === id)!;
  const T = DEFAULT_CODEBASE_RULE_THRESHOLDS;

  it('fires growth with the sentence and the numbers it used', () => {
    const v = verdict(evaluateCodebaseRules(report({ code_lines: 49900 }), report({ code_lines: 38100 }, '2026-10-01'), T), 'codebase-growth');
    expect(v).toMatchObject({ fired: true, severity: 'warn', kind: 'anomaly', metric: 'code_lines' });
    expect(v.message).toBe('The code grew 31% in 30 days (38,100 → 49,900 lines).');
    expect(v.inputs).toMatchObject({ code_lines: 49900, comparison_code_lines: 38100, added_lines: 11800, growth_percent_30d: 25, growth_min_lines: 500 });
  });

  it('does not fire growth under either threshold, or with no comparison', () => {
    expect(verdict(evaluateCodebaseRules(report({ code_lines: 1200 }), report({ code_lines: 900 }, '2026-10-01'), T), 'codebase-growth').fired).toBe(false);
    expect(verdict(evaluateCodebaseRules(report({ code_lines: 40000 }), report({ code_lines: 38100 }, '2026-10-01'), T), 'codebase-growth').fired).toBe(false);
    const none = verdict(evaluateCodebaseRules(report({ code_lines: 49900 }), null, T), 'codebase-growth');
    expect(none).toMatchObject({ evaluable: false, fired: false });
  });

  it('fires duplication, unused and complexity with their sentences', () => {
    const verdicts = evaluateCodebaseRules(
      report({ duplication_percent: 8.4, unused_files: 14, unused_dependencies: 3, complex_functions: 30 }),
      report({ complex_functions: 23 }, '2026-10-01'),
      T,
    );
    expect(verdict(verdicts, 'codebase-duplication')).toMatchObject({ fired: true, severity: 'warn', kind: 'opportunity', message: '8.4% of the code is repeated.' });
    expect(verdict(verdicts, 'codebase-unused')).toMatchObject({ fired: true, severity: 'info', kind: 'opportunity', message: '14 files and 3 packages are not used.' });
    expect(verdict(verdicts, 'codebase-complexity')).toMatchObject({ fired: true, severity: 'info', kind: 'opportunity', message: '7 more functions became hard to change in 30 days.' });
  });

  it('unused sums only the keys present: an absent package count is missing, never 0', () => {
    const files = verdict(evaluateCodebaseRules(report({ unused_files: 12 }), null, T), 'codebase-unused');
    expect(files).toMatchObject({ evaluable: true, fired: true, message: '12 files are not used.' });
    expect(files.inputs).toMatchObject({ unused_files: 12, unused_dependencies: null, unused_items: 12 });
    expect(verdict(evaluateCodebaseRules(report({ unused_files: 9 }), null, T), 'codebase-unused').fired).toBe(false);
  });

  it('never fires or evaluates a rule whose measures are absent', () => {
    const verdicts = evaluateCodebaseRules(report({}), report({ code_lines: 10, complex_functions: 1 }, '2026-10-01'), T);
    for (const v of verdicts) expect(v, v.ruleId).toMatchObject({ evaluable: false, fired: false, message: null });
  });
});
