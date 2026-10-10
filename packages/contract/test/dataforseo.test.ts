import { describe, expect, it } from 'vitest';
import {
  DATAFORSEO_BASE_REPORTS,
  DATAFORSEO_PANEL_REPORT,
  DATAFORSEO_PERIODIC_REPORTS,
  DATAFORSEO_REPORT_AVAILABLE_FROM,
  dataForSeoReportsFor,
} from '../src/dataforseo.js';

const PANEL_ASSETS = new Set(['meadow.example', 'northwind.example']);
const NO_PANEL = new Set<string>();

describe('the DataForSEO family vocabulary', () => {
  it('owes a panel property one more family than a domain-only one', () => {
    expect(dataForSeoReportsFor('northwind.example', PANEL_ASSETS)).toContain(
      DATAFORSEO_PANEL_REPORT,
    );
    expect(dataForSeoReportsFor('acorn.example', NO_PANEL)).not.toContain(
      DATAFORSEO_PANEL_REPORT,
    );
  });

  it('dates only the families added after the collector shipped', () => {
    for (const [report, from] of Object.entries(
      DATAFORSEO_REPORT_AVAILABLE_FROM,
    )) {
      expect([...DATAFORSEO_BASE_REPORTS, DATAFORSEO_PANEL_REPORT]).toContain(
        report,
      );
      expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // A founding family carries no date, and that absence is what makes it
    // always due. If this ever becomes a total map, the "unlisted is always
    // due" fallback stops being exercised and an early-dated collection starts
    // reading as complete because it owes nothing.
    expect(DATAFORSEO_REPORT_AVAILABLE_FROM['ranked-keywords']).toBeUndefined();
  });

  /**
   * Graded against today's list, every collection stored before a new family
   * shipped would become retroactively short.
   */
  describe('what was due is a question about a date', () => {
    it('excludes a family from collections that predate it', () => {
      const before = dataForSeoReportsFor('northwind.example', PANEL_ASSETS, '2026-08-04');
      expect(before).not.toContain('backlinks-referring-domains');
      expect(before).not.toContain('backlinks-anchors');
      // …and still owes everything that DID exist that day, so the exclusion is
      // narrow rather than a blanket amnesty.
      expect(before).toContain('backlinks-summary');
      expect(before).toContain(DATAFORSEO_PANEL_REPORT);
    });

    it('includes it from its first collectable date onward', () => {
      const on = dataForSeoReportsFor(
        'northwind.example',
        PANEL_ASSETS,
        DATAFORSEO_REPORT_AVAILABLE_FROM['backlinks-anchors'],
      );
      expect(on).toContain('backlinks-anchors');
      expect(on).toContain('backlinks-referring-domains');
    });

    /**
     * The failure mode the exceptions-map shape exists to prevent: a date
     * earlier than every family must not resolve to "owes nothing", because a
     * collection that owes nothing is complete and the lane goes green by
     * having stopped asking.
     */
    it('still owes the founding families at any date', () => {
      for (const early of ['2026-01-01', '2026-07-05', '1999-12-31']) {
        const due = dataForSeoReportsFor('northwind.example', PANEL_ASSETS, early);
        expect(due).toContain('ranked-keywords');
        expect(due).toContain('backlinks-summary');
        expect(due).toContain(DATAFORSEO_PANEL_REPORT);
        expect(due.length).toBeGreaterThan(0);
      }
    });

    it('asks what is due NOW when no date is given', () => {
      // The collector's sweep plan and the on-demand route both want this: they
      // are deciding what to collect, not grading something already stored.
      expect(dataForSeoReportsFor('northwind.example', PANEL_ASSETS)).toEqual([
        ...DATAFORSEO_BASE_REPORTS,
        DATAFORSEO_PANEL_REPORT,
      ]);
    });

    /**
     * A date the caller could not parse must not shrink the expected set to
     * nothing and declare every collection complete. Failing OPEN here would be
     * silent: the lane would go green because it stopped asking.
     */
    it('falls back to the full set on an unusable date', () => {
      for (const bad of ['', 'yesterday', '2026-8-4', '2026-08-04T00:00:00Z']) {
        expect(dataForSeoReportsFor('northwind.example', PANEL_ASSETS, bad)).toEqual([
          ...DATAFORSEO_BASE_REPORTS,
          DATAFORSEO_PANEL_REPORT,
        ]);
      }
    });
  });

  /**
   * The availability map handles "registered later"; this handles "not
   * weekly": a 28-day family is absent from three `report_date`s out of four
   * by design.
   */
  describe('a periodic family is not part of the weekly identity', () => {
    it('keeps the two sets disjoint', () => {
      for (const report of DATAFORSEO_PERIODIC_REPORTS) {
        expect(DATAFORSEO_BASE_REPORTS).not.toContain(report);
        expect(report).not.toBe(DATAFORSEO_PANEL_REPORT);
      }
    });

    it('never owes a periodic family on any date', () => {
      for (const date of ['2026-07-05', '2026-09-01', '2027-01-01', null]) {
        const due = dataForSeoReportsFor('northwind.example', PANEL_ASSETS, date);
        for (const report of DATAFORSEO_PERIODIC_REPORTS) {
          expect(due).not.toContain(report);
        }
      }
    });
  });
});
