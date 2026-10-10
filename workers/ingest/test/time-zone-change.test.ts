import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  distortedDays,
  previousTimeZone,
  recordTimeZoneChange,
  reportingTimeZoneOn,
  spansTimeZoneChange,
  timeZoneChangesFor,
} from '../src/time-zone-change.js';
import { pgCount, pgRows, reset, storeSignalRun } from './helpers.js';

beforeEach(reset);

const PT = 'America/Los_Angeles';
const ET = 'America/New_York';

async function run(
  asset: string,
  integration: string,
  finishedAt: string,
  timeZone: string | null,
  status: 'success' | 'error' = 'success',
  propertyRef = 'prop',
): Promise<void> {
  await storeSignalRun({
    id: crypto.randomUUID(),
    asset,
    integration,
    credential_ref: 'cred',
    property_ref: propertyRef,
    finished_at: finishedAt,
    status,
    window_start: '2026-08-01',
    window_end: '2026-08-31',
    provider_rows: 1,
    observation_count: 1,
    error_code: status === 'error' ? 'boom' : null,
    error_message: status === 'error' ? 'boom' : null,
    time_zone: timeZone,
  });
}

describe('previousTimeZone', () => {
  it('is null before any run, so a first collection can never be a change', async () => {
    expect(await previousTimeZone(env.STORE, 'meadow.example', 'ga4', 'prop')).toBeNull();
  });

  // Repointing the asset at another GA4 property starts a different series.
  // The old property's zone is not the new one's history.
  it('answers only for the same provider resource', async () => {
    await run('meadow.example', 'ga4', '2026-08-29T03:00:00.000Z', PT, 'success', 'old-prop');
    expect(await previousTimeZone(env.STORE, 'meadow.example', 'ga4', 'new-prop')).toBeNull();
    expect(await previousTimeZone(env.STORE, 'meadow.example', 'ga4', 'old-prop')).toBe(PT);
  });

  it('reads the newest successful run for that property and provider', async () => {
    await run('meadow.example', 'ga4', '2026-08-29T03:00:00.000Z', PT);
    await run('meadow.example', 'ga4', '2026-08-30T03:00:00.000Z', ET);
    // A different provider on the same property is a different day-definition
    // and must not answer for GA4 — Search Console's boundary is fixed by
    // Google and moves independently of the property's own setting.
    await run('meadow.example', 'gsc', '2026-08-31T03:00:00.000Z', PT);
    expect(await previousTimeZone(env.STORE, 'meadow.example', 'ga4', 'prop')).toBe(ET);
  });

  it('ignores failed runs, which observed nothing to define a day with', async () => {
    await run('meadow.example', 'ga4', '2026-08-29T03:00:00.000Z', PT);
    await run('meadow.example', 'ga4', '2026-08-30T03:00:00.000Z', ET, 'error');
    expect(await previousTimeZone(env.STORE, 'meadow.example', 'ga4', 'prop')).toBe(PT);
  });

  // Runs that finished in the same instant answer in the order they were
  // written.
  it('of two runs that finished in the same instant, answers with the one written first', async () => {
    await run('meadow.example', 'ga4', '2026-08-30T03:00:00.000Z', PT);
    await run('meadow.example', 'ga4', '2026-08-30T03:00:00.000Z', ET);
    expect(await previousTimeZone(env.STORE, 'meadow.example', 'ga4', 'prop')).toBe(PT);
  });
});

describe('recordTimeZoneChange', () => {
  const CHANGE = {
    asset: 'meadow.example',
    integration: 'ga4',
    from: PT,
    to: ET,
    effectiveOn: '2026-09-01',
  };

  it('files the change on the timeline, dated to the day the units diverged', async () => {
    expect(await recordTimeZoneChange(env, CHANGE)).toEqual({ filed: true });
    const [row] = await pgRows<{ at: string; kind: string; ref: string; note: string }>(
      `SELECT at, kind, ref, note FROM noticeos.annotations WHERE asset_id = 'meadow.example'`,
    );
    // Dated to the provider day, not to the moment the OS noticed — a window
    // asking "do I span this" needs the day the data changed shape.
    expect(row?.at.slice(0, 10)).toBe('2026-09-01');
    expect(row?.kind).toBe('config');
    // A headline with its values; what it means for a comparison is drawn where
    // the comparison is made.
    expect(row?.note).toBe('GA4 day moved from America/Los_Angeles to America/New_York on 2026-09-01');
  });

  /**
   * The lanes run several times a night and each sees the same difference, so
   * without identity this would file the same event repeatedly. The annotation
   * key is `(asset, at, kind, ref)` and `ref` carries the change itself.
   */
  it('files once however many times the lane notices', async () => {
    await recordTimeZoneChange(env, CHANGE);
    expect(await recordTimeZoneChange(env, CHANGE)).toEqual({ filed: false });
    expect(await pgCount(`SELECT COUNT(*) AS n FROM noticeos.annotations`)).toBe(1);
  });

  it('reports a refused write rather than swallowing it', async () => {
    const result = await recordTimeZoneChange(env, { ...CHANGE, asset: 'not.a.property' });
    // This is the only record that the unit changed; losing it silently would
    // leave every later comparison unable to know.
    expect(result.filed).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('timeZoneChangesFor', () => {
  it('reads back a filed change, keyed by property', async () => {
    await recordTimeZoneChange(env, {
      asset: 'meadow.example',
      integration: 'ga4',
      from: PT,
      to: ET,
      effectiveOn: '2026-08-31',
    });

    const changes = await timeZoneChangesFor(env.STORE, 'ga4');
    expect(changes.get('meadow.example')).toEqual([
      {
        asset: 'meadow.example',
        integration: 'ga4',
        from: PT,
        to: ET,
        effectiveOn: '2026-08-31',
      },
    ]);
  });

  it('is empty for a provider that has never moved a boundary', async () => {
    await recordTimeZoneChange(env, {
      asset: 'meadow.example',
      integration: 'ga4',
      from: PT,
      to: ET,
      effectiveOn: '2026-08-31',
    });

    // GA4's setting is the property's own; Search Console's boundary is fixed
    // by Google and never appears under this provider.
    expect((await timeZoneChangesFor(env.STORE, 'gsc')).size).toBe(0);
  });
});

describe('reportingTimeZoneOn', () => {
  const ONE = [{ effectiveOn: '2026-08-31', from: PT, to: ET }];
  const TODAY = '2026-09-05';

  it('is the current zone when the property has never changed', () => {
    expect(reportingTimeZoneOn([], '2026-08-01', PT, TODAY)).toBe(PT);
  });

  it('is the old zone for days the provider bucketed before the change', () => {
    expect(reportingTimeZoneOn(ONE, '2026-08-30', ET, TODAY)).toBe(PT);
  });

  it('is the new zone from the change day onward', () => {
    expect(reportingTimeZoneOn(ONE, '2026-08-31', ET, TODAY)).toBe(ET);
    expect(reportingTimeZoneOn(ONE, '2026-09-02', ET, TODAY)).toBe(ET);
  });

  it('walks a property that moved twice', () => {
    const two = [
      { effectiveOn: '2026-08-31', from: PT, to: ET },
      { effectiveOn: '2026-09-03', from: ET, to: PT },
    ];
    expect(reportingTimeZoneOn(two, '2026-08-30', PT, TODAY)).toBe(PT);
    expect(reportingTimeZoneOn(two, '2026-09-01', PT, TODAY)).toBe(ET);
    expect(reportingTimeZoneOn(two, '2026-09-04', PT, TODAY)).toBe(PT);
  });

  /**
   * The provider is answering with its current zone right now, so today's rows
   * are bucketed by it whatever the last filed change says. A change the
   * nightly lanes have not filed yet must not send today's hours three hours
   * away.
   */
  it('trusts the provider over a stale filing from the provider day on', () => {
    const stale = [{ effectiveOn: '2026-08-31', from: ET, to: PT }];
    expect(reportingTimeZoneOn(stale, TODAY, ET, TODAY)).toBe(ET);
    expect(reportingTimeZoneOn(stale, '2026-09-06', ET, TODAY)).toBe(ET);
    // The day before is still governed by the filing.
    expect(reportingTimeZoneOn(stale, '2026-09-04', ET, TODAY)).toBe(PT);
  });
});

describe('spansTimeZoneChange', () => {
  const CHANGES = [{ effectiveOn: '2026-09-01', from: PT, to: ET }];

  it('flags a window that starts before the change and ends on or after it', () => {
    expect(spansTimeZoneChange(CHANGES, { start: '2026-08-26', end: '2026-09-01' })).toMatchObject({
      effectiveOn: '2026-09-01',
    });
    expect(spansTimeZoneChange(CHANGES, { start: '2026-08-20', end: '2026-09-05' })).not.toBeNull();
  });

  it('leaves a window entirely on one side of it alone', () => {
    // Wholly before: both ends are old-definition days.
    expect(spansTimeZoneChange(CHANGES, { start: '2026-08-20', end: '2026-08-31' })).toBeNull();
    // Starting ON the change day: every day in it is a new-definition day, so
    // the comparison is clean and must not be marked.
    expect(spansTimeZoneChange(CHANGES, { start: '2026-09-01', end: '2026-09-08' })).toBeNull();
  });

  it('is silent when the property has never changed timezone', () => {
    expect(spansTimeZoneChange([], { start: '2026-08-01', end: '2026-09-30' })).toBeNull();
  });
});

describe('distortedDays', () => {
  /**
   * Moving a boundary does not relabel days, it moves hours between them. Both
   * sides of the move are wrong by the offset alone and neither is evidence
   * about the property.
   */
  it('names the change day and the one before it', () => {
    expect(distortedDays({ effectiveOn: '2026-09-01' })).toEqual(['2026-08-31', '2026-09-01']);
  });

  it('crosses a month boundary correctly', () => {
    expect(distortedDays({ effectiveOn: '2026-03-01' })).toEqual(['2026-02-28', '2026-03-01']);
  });
});
