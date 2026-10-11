import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  POSTHOG_FAMILIES,
  POSTHOG_FAMILY_ROWS,
  POSTHOG_ROW_LIMITS,
  POSTHOG_ROW_SCHEMAS,
  POSTHOG_WINDOW_DAYS,
  posthogArchiveBodySchema,
  posthogFamilyFromTag,
  posthogFamilyTag,
  posthogFunnelsRefusal,
  readPosthogAssetSettings,
  type PosthogRowShape,
} from '../src/posthog.js';

function body(family: string, rows: unknown[], extra: Record<string, unknown> = {}) {
  return {
    provider: 'posthog',
    family,
    asset: 'meadow.example',
    host: 'us',
    projectId: '424242',
    projectTimeZone: 'America/New_York',
    window: { start: '2026-09-09', end: '2026-09-22' },
    collectedAt: '2026-09-23T12:30:04.120Z',
    rowLimit: 100,
    truncated: false,
    rows,
    ...extra,
  };
}

describe('PostHog archive contract', () => {
  it('names six families with the contract windows and bounds', () => {
    expect(POSTHOG_FAMILIES).toEqual(['web-daily', 'events', 'exceptions', 'rageclicks', 'web-vitals', 'funnels']);
    expect(POSTHOG_WINDOW_DAYS).toEqual({ 'web-daily': 28, events: 14, exceptions: 14, rageclicks: 14, 'web-vitals': 14, funnels: 7 });
    expect(POSTHOG_ROW_LIMITS['web-daily']).toBe(28);
    expect(POSTHOG_ROW_LIMITS.events).toBe(500);
    expect(POSTHOG_ROW_LIMITS.exceptions).toBe(100);
    expect(POSTHOG_ROW_LIMITS.rageclicks).toBe(100);
    expect(POSTHOG_ROW_LIMITS['web-vitals']).toBe(300);
  });

  it('accepts a body per family and rejects rows of another family', () => {
    expect(
      posthogArchiveBodySchema.safeParse(
        body('events', [{ event: 'first_meal_logged', count: 1597, people: 527, firstSeen: '2026-09-08', lastSeen: '2026-09-22' }]),
      ).success,
    ).toBe(true);
    expect(
      posthogArchiveBodySchema.safeParse(
        body('web-vitals', [{ path: '/calculator', device: 'Desktop', os: 'Chrome OS', lcpP75: 3844, inpP75: 744, clsP75: null, fcpP75: 1200, measurements: 22298 }]),
      ).success,
    ).toBe(true);
    // An events row in a web-daily body is refused, as is an unknown field.
    expect(
      posthogArchiveBodySchema.safeParse(
        body('web-daily', [{ event: 'x', count: 1, people: 1, firstSeen: '2026-09-08', lastSeen: '2026-09-08' }]),
      ).success,
    ).toBe(false);
    expect(
      posthogArchiveBodySchema.safeParse(
        body('web-daily', [{ date: '2026-09-22', pageviews: 1, people: 1, sessions: 1, bounce: 0 }]),
      ).success,
    ).toBe(false);
  });

  it('refuses a body whose rows exceed its row limit or whose window is backwards', () => {
    const row = { date: '2026-09-22', pageviews: 1, people: 1, sessions: 1 };
    expect(posthogArchiveBodySchema.safeParse(body('web-daily', [row, row], { rowLimit: 1 })).success).toBe(false);
    expect(
      posthogArchiveBodySchema.safeParse(body('web-daily', [], { window: { start: '2026-09-22', end: '2026-09-01' } })).success,
    ).toBe(false);
  });

  it('maps a family to the tag an operator types, and back', () => {
    expect(posthogFamilyTag('web-vitals')).toBe('posthog-web-vitals');
    expect(posthogFamilyFromTag('posthog-funnels')).toBe('funnels');
    expect(posthogFamilyFromTag('posthog-nope')).toBeNull();
    expect(posthogFamilyFromTag('ranked-keywords')).toBeNull();
  });
});

// The family list and each row's fields are declared once, in
// src/posthog-families.mts. This suite reads the generated
// posthog-families.mjs (the file the plain-Node flattener imports), so a stale
// generation fails here as well as in `pnpm generate -- --check`.
describe('PostHog family fields — one definition', () => {
  it('builds every row schema from exactly the listed fields, in the listed order', () => {
    expect(Object.keys(POSTHOG_FAMILY_ROWS)).toEqual([...POSTHOG_FAMILIES]);
    expect(Object.keys(POSTHOG_ROW_SCHEMAS)).toEqual([...POSTHOG_FAMILIES]);
    for (const family of POSTHOG_FAMILIES) {
      expect(Object.keys(POSTHOG_ROW_SCHEMAS[family].shape), family).toEqual([...POSTHOG_FAMILY_ROWS[family].fields]);
    }
  });

  it('names a grain for every family', () => {
    expect(Object.fromEntries(POSTHOG_FAMILIES.map((family) => [family, POSTHOG_FAMILY_ROWS[family].grain]))).toEqual({
      'web-daily': 'day',
      events: 'event',
      exceptions: 'exception-message',
      rageclicks: 'page-element',
      'web-vitals': 'page-device-os',
      funnels: 'funnel-step',
    });
  });

  // The deliberate mismatch. Each shape below drifts from the web-daily list the
  // way a hand edit would; `tsc` (the contract's typecheck gate) must refuse
  // it. If the check ever stopped refusing, the unused @ts-expect-error would
  // fail the typecheck instead.
  it('refuses at compile time a row shape that drifts from the list', () => {
    // @ts-expect-error `bounces` is not a web-daily field, so the shape may not carry it.
    const extra = { date: z.string(), pageviews: z.number(), people: z.number(), sessions: z.number(), bounces: z.number() } satisfies PosthogRowShape<'web-daily'>;
    // @ts-expect-error `sessions` is a web-daily field, so the shape may not omit it.
    const missing = { date: z.string(), pageviews: z.number(), people: z.number() } satisfies PosthogRowShape<'web-daily'>;
    const exact = { date: z.string(), pageviews: z.number(), people: z.number(), sessions: z.number() } satisfies PosthogRowShape<'web-daily'>;
    expect([Object.keys(extra).length, Object.keys(missing).length, Object.keys(exact).length]).toEqual([5, 3, 4]);
  });
});

describe('PostHog per-asset settings', () => {
  const calculator = {
    id: 'calculator',
    name: 'Calculator',
    steps: [{ event: '$pageview', path: '/calculator' }, { event: 'form_start' }, { event: 'calculation_complete' }],
  };

  it('reads host, project and funnels', () => {
    expect(readPosthogAssetSettings({ host: 'us', projectId: '424242', funnels: [calculator] })).toEqual({
      ok: true,
      settings: { host: 'us', projectId: '424242', funnels: [calculator] },
    });
    // No funnels saved is a valid state: the funnels family is skipped.
    expect(readPosthogAssetSettings({ host: 'eu', projectId: '1' })).toMatchObject({ ok: true, settings: { funnels: [] } });
  });

  it('names what is missing rather than guessing a region or project', () => {
    expect(readPosthogAssetSettings(undefined)).toMatchObject({ ok: false, reason: 'mapping_missing' });
    expect(readPosthogAssetSettings({ host: 'us' })).toMatchObject({ ok: false, reason: 'mapping_missing', detail: expect.stringContaining('projectId') });
    expect(readPosthogAssetSettings({ host: 'apac', projectId: '1' })).toMatchObject({ ok: false, reason: 'mapping_invalid' });
    expect(readPosthogAssetSettings({ host: 'us', projectId: 'project-1' })).toMatchObject({ ok: false, reason: 'mapping_invalid' });
  });

  it('validates funnels the way the store save does', () => {
    expect(posthogFunnelsRefusal([])).toBeNull();
    expect(posthogFunnelsRefusal([calculator])).toBeNull();
    expect(posthogFunnelsRefusal({})).toMatch(/must be a list/);
    expect(posthogFunnelsRefusal([{ ...calculator, steps: [calculator.steps[0]] }])).toMatch(/needs 2 to 10 steps/);
    expect(posthogFunnelsRefusal([{ ...calculator, steps: Array.from({ length: 11 }, () => ({ event: 'x' })) }])).toMatch(/needs 2 to 10 steps/);
    expect(posthogFunnelsRefusal([calculator, calculator])).toMatch(/repeats the funnel id calculator/);
    expect(posthogFunnelsRefusal([{ ...calculator, id: 'Calculator Funnel' }])).toMatch(/id must be lowercase/);
    expect(posthogFunnelsRefusal([{ ...calculator, name: ' ' }])).toMatch(/needs a name/);
    expect(posthogFunnelsRefusal([{ ...calculator, steps: [{ event: "x' OR 1=1" }, { event: 'y' }] }])).toMatch(/step 1 event/);
    expect(posthogFunnelsRefusal([{ ...calculator, steps: [{ event: 'x', path: 'calculator' }, { event: 'y' }] }])).toMatch(/path must start with \//);
    expect(posthogFunnelsRefusal([{ ...calculator, steps: [{ event: 'x', path: '/a?b=1' }, { event: 'y' }] }])).toMatch(/path/);
    expect(posthogFunnelsRefusal([{ ...calculator, colour: 'red' }])).toMatch(/unknown field colour/);
    expect(posthogFunnelsRefusal(Array.from({ length: 11 }, (_, i) => ({ ...calculator, id: `f${i}` })))).toMatch(/at most 10/);
  });
});
