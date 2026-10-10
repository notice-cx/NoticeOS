import { describe, expect, it } from 'vitest';
import {
  REPORT_CADENCE_HOURS,
  REPORT_MAX_AGE_HOURS,
  REPORT_STALE_MULTIPLIER,
  emptyReportingCoverage,
  expectsNightlyReport,
  expectsReports,
  isAllFresh,
  owesNightlyReport,
  releasedFreshnessFlag,
  reportingState,
  showsNightlyReport,
  summarizeReporting,
  worstReportingState,
  type ReportingState,
} from '../src/reporting.js';
import { noNightlyReportAssets } from '../src/configuration.mjs';

const NOW = Date.parse('2026-07-05T12:00:00.000Z');
const HOUR = 3_600_000;
const MAX_AGE_HOURS = REPORT_MAX_AGE_HOURS;

const at = (hoursAgo: number): string => new Date(NOW - hoursAgo * HOUR).toISOString();

describe('expectsReports — the obligation comes from the lifecycle', () => {
  it('holds every launched, non-retired status to a report', () => {
    expect(expectsReports('onboarding')).toBe(true);
    expect(expectsReports('baselining')).toBe(true);
    expect(expectsReports('live')).toBe(true);
  });

  it('excuses only pre-launch and retired', () => {
    expect(expectsReports('pre-launch')).toBe(false);
    expect(expectsReports('retired')).toBe(false);
  });
});

// One constant for the ingest cron and the Tower, and one crossover age.
describe('REPORT_MAX_AGE_HOURS — one staleness age for both surfaces', () => {
  it('is the nightly cadence times the miss the operator tolerates', () => {
    expect(REPORT_CADENCE_HOURS).toBe(24);
    expect(REPORT_STALE_MULTIPLIER).toBe(2);
    expect(REPORT_MAX_AGE_HOURS).toBe(48);
  });

  it('crosses from fresh to stale exactly once, at the threshold', () => {
    const ages = Array.from({ length: 73 }, (_, h) => h);
    const stale = ages.filter((h) => reportingState('live', at(h), NOW, MAX_AGE_HOURS) === 'stale');
    // Every stale age is past the threshold and every fresh age is not — no
    // band where one surface could reasonably say something else.
    expect(Math.min(...stale)).toBe(REPORT_MAX_AGE_HOURS + 1);
    expect(stale).toEqual(ages.filter((h) => h > REPORT_MAX_AGE_HOURS));
  });

  it('leaves 40h — the old disagreement — unambiguously fresh', () => {
    expect(reportingState('live', at(40), NOW, MAX_AGE_HOURS)).toBe('fresh');
  });
});

describe('reportingState — four states, never a boolean', () => {
  it('reads a recent report as fresh and an old one as stale', () => {
    expect(reportingState('live', at(4), NOW, MAX_AGE_HOURS)).toBe('fresh');
    expect(reportingState('live', at(50), NOW, MAX_AGE_HOURS)).toBe('stale');
  });

  it('reads a site that has never sent a report as not-expected, whatever its stage', () => {
    expect(reportingState('onboarding', null, NOW, MAX_AGE_HOURS)).toBe('not-expected');
    expect(reportingState('live', undefined, NOW, MAX_AGE_HOURS)).toBe('not-expected');
  });

  it('reads zero reports on a pre-launch or retired property as not-expected', () => {
    expect(reportingState('pre-launch', null, NOW, MAX_AGE_HOURS)).toBe('not-expected');
    expect(reportingState('retired', at(400), NOW, MAX_AGE_HOURS)).toBe('not-expected');
  });

  it('reads exactly the threshold as fresh — late begins one hour past it', () => {
    expect(reportingState('live', at(REPORT_MAX_AGE_HOURS), NOW, MAX_AGE_HOURS)).toBe('fresh');
    expect(reportingState('live', at(REPORT_MAX_AGE_HOURS + 1), NOW, MAX_AGE_HOURS)).toBe('stale');
  });

  it('treats an unreadable timestamp as stale, not as never having reported', () => {
    // A row exists, so a report did arrive — we simply cannot age it. Calling
    // that "never reported" would overstate the failure.
    expect(reportingState('live', 'not-a-date', NOW, MAX_AGE_HOURS)).toBe('stale');
  });
});

describe('summarizeReporting — the denominator is the expected set', () => {
  it('counts only fresh and stale reports in the expected denominator', () => {
    const states: ReportingState[] = [
      'fresh',
      'fresh',
      'stale',
      'not-expected',
      'not-expected',
      'not-expected',
    ];
    expect(summarizeReporting(states)).toEqual({
      fresh: 2, stale: 1, notExpected: 3, expected: 3,
    });
  });

  it('starts empty', () => {
    expect(summarizeReporting([])).toEqual(emptyReportingCoverage());
  });
});

describe('isAllFresh — a claim about the whole expected set', () => {
  it('is true only when every expected property reported recently', () => {
    expect(isAllFresh(summarizeReporting(['fresh', 'fresh', 'not-expected']))).toBe(true);
  });

  it('keeps a new unconfigured site outside the reporting obligation', () => {
    const newSite = reportingState('live', null, NOW, MAX_AGE_HOURS);
    expect(newSite).toBe('not-expected');
    expect(isAllFresh(summarizeReporting(['fresh', 'fresh', newSite]))).toBe(true);
  });

  it('is false while any property is stale', () => {
    expect(isAllFresh(summarizeReporting(['fresh', 'stale']))).toBe(false);
  });

  it('is false over an empty expected set — no one to be fresh', () => {
    expect(isAllFresh(summarizeReporting([]))).toBe(false);
    expect(isAllFresh(summarizeReporting(['not-expected', 'not-expected']))).toBe(false);
  });
});

describe('worstReportingState — what one glyph should say', () => {
  it('falls to stale, then fresh', () => {
    expect(worstReportingState(summarizeReporting(['fresh', 'stale']))).toBe('stale');
    expect(worstReportingState(summarizeReporting(['fresh', 'fresh']))).toBe('fresh');
  });

  it('has nothing to say when nothing is expected', () => {
    expect(worstReportingState(summarizeReporting(['not-expected']))).toBeNull();
  });
});

describe('a declared "no nightly report"', () => {
  it('owes no report, whatever the lifecycle says', () => {
    expect(owesNightlyReport('live', false, at(3))).toBe(true);
    expect(owesNightlyReport('live', true, at(3))).toBe(false);
    expect(owesNightlyReport('pre-launch', false, at(3))).toBe(false);
  });

  it('is outside the denominator whether it never reported, went quiet, or is fresh', () => {
    const states = [null, at(MAX_AGE_HOURS + 10), at(1)].map((latest) =>
      reportingState('live', latest, NOW, MAX_AGE_HOURS, true),
    );
    expect(states).toEqual(['not-expected', 'not-expected', 'not-expected']);
    const coverage = summarizeReporting([...states, 'fresh']);
    expect(coverage).toMatchObject({ expected: 1, fresh: 1, notExpected: 3 });
    expect(isAllFresh(coverage)).toBe(true);
  });

  it('shows a report it sends anyway while it is current, and "no report" past the stale age', () => {
    expect(showsNightlyReport(true, at(3), NOW)).toBe(true);
    expect(showsNightlyReport(true, at(REPORT_MAX_AGE_HOURS + 1), NOW)).toBe(false);
    expect(showsNightlyReport(true, null, NOW)).toBe(false);
    // An owed report always shows its age: a late one is the stale state.
    expect(showsNightlyReport(false, at(REPORT_MAX_AGE_HOURS + 1), NOW)).toBe(true);
    expect(showsNightlyReport(false, null, NOW)).toBe(false);
  });

  it('releases only the freshness flag of a declared asset', () => {
    const declared = new Set(['acorn.example']);
    expect(releasedFreshnessFlag({ ruleId: 'ingest-freshness', asset: 'acorn.example' }, declared)).toBe(true);
    expect(releasedFreshnessFlag({ ruleId: 'ingest-freshness', asset: 'northwind.example' }, declared)).toBe(false);
    expect(releasedFreshnessFlag({ ruleId: 'asset-pull-failed', asset: 'acorn.example' }, declared)).toBe(false);
  });

  it('reads the list out of a saved constants document, absent as null', () => {
    expect(noNightlyReportAssets({ flag_defaults: {} })).toBeNull();
    expect(noNightlyReportAssets({ no_nightly_report: [] })).toEqual([]);
    expect(noNightlyReportAssets({ no_nightly_report: ['ferns.example', 7, 'Bad Id'] })).toEqual(['ferns.example']);
    expect(noNightlyReportAssets({ no_nightly_report: 'ferns.example' })).toEqual([]);
    expect(noNightlyReportAssets(null)).toBeNull();
  });
});

describe('expectsNightlyReport — a site expects a report once it has sent one', () => {
  it('expects none from a brand-new site, so nothing warns about a sender nobody set up', () => {
    expect(expectsNightlyReport(false, null)).toBe(false);
    expect(expectsNightlyReport(false, undefined)).toBe(false);
    expect(owesNightlyReport('onboarding', false, null)).toBe(false);
    expect(showsNightlyReport(false, null, NOW)).toBe(false);
  });

  it('switches on by itself with the first report, and stays on when the sender stops', () => {
    expect(expectsNightlyReport(false, at(1))).toBe(true);
    expect(reportingState('onboarding', at(1), NOW, MAX_AGE_HOURS)).toBe('fresh');
    // The sender stopped: still expected, so the report goes late, then stale.
    expect(expectsNightlyReport(false, at(24 * 30))).toBe(true);
    expect(reportingState('live', at(24 * 30), NOW, MAX_AGE_HOURS)).toBe('stale');
    expect(showsNightlyReport(false, at(24 * 30), NOW)).toBe(true);
    // An unreadable arrival is still an arrival.
    expect(expectsNightlyReport(false, 'not-a-date')).toBe(true);
  });

  it('never expects one from a declared site, whatever it has sent', () => {
    expect(expectsNightlyReport(true, null)).toBe(false);
    expect(expectsNightlyReport(true, at(1))).toBe(false);
  });
});

// A portfolio of sites that send a report, one whose sender stopped, the OS's
// own report, and sites declared as sending none that never sent one. The
// "has sent one" condition changes nothing for any of them; it differs only
// for a site that has never sent a report and was never declared.
describe('the "has sent one" condition leaves every other site unchanged', () => {
  /** The rule without the "has sent one" condition, frozen here as the
   * reference: owed whenever the stage reports and nothing was declared. */
  function previousRule(status: string, latest: string | null, declared: boolean): ReportingState | 'never-reported' {
    if (!expectsReports(status) || declared) return 'not-expected';
    if (!latest) return 'never-reported';
    const ms = Date.parse(latest);
    if (!Number.isFinite(ms)) return 'stale';
    return NOW - ms > MAX_AGE_HOURS * HOUR ? 'stale' : 'fresh';
  }
  const SITES: { id: string; status: string; latest: string | null; declared: boolean }[] = [
    { id: 'recipes.example.com', status: 'live', latest: at(7), declared: false },
    { id: 'orders.example.com', status: 'live', latest: at(30), declared: false },
    { id: 'stopped.example.com', status: 'live', latest: at(24 * 9), declared: false },
    { id: 'os.example.com', status: 'live', latest: at(1), declared: false },
    { id: 'quiz.example.com', status: 'live', latest: null, declared: true },
    { id: 'summit.example.com', status: 'onboarding', latest: null, declared: true },
    { id: 'codes.example.com', status: 'live', latest: null, declared: true },
    { id: 'lookup.example.com', status: 'live', latest: null, declared: true },
  ];

  it('classifies every site exactly as before', () => {
    for (const site of SITES) {
      expect(reportingState(site.status, site.latest, NOW, MAX_AGE_HOURS, site.declared), site.id).toBe(
        previousRule(site.status, site.latest, site.declared),
      );
    }
  });

  it('counts the same fraction, with the stopped sender still stale and the declared sites outside it', () => {
    const coverage = summarizeReporting(
      SITES.map((site) => reportingState(site.status, site.latest, NOW, MAX_AGE_HOURS, site.declared)),
    );
    expect(coverage).toEqual({ fresh: 3, stale: 1, notExpected: 4, expected: 4 });
    expect(worstReportingState(coverage)).toBe('stale');
  });

  it('shows every nightly slot as before: ages for the senders, "No report" for the declared', () => {
    for (const site of SITES) {
      expect(showsNightlyReport(site.declared, site.latest, NOW), site.id).toBe(site.latest !== null);
    }
  });

  it('changes only a site that has never sent a report and was never declared', () => {
    expect(previousRule('onboarding', null, false)).toBe('never-reported');
    expect(reportingState('onboarding', null, NOW, MAX_AGE_HOURS, false)).toBe('not-expected');
  });
});
