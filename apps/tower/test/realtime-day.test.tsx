import { describe, expect, it } from 'vitest';
import { render } from './render';
import type { Ga4RealtimeAsset, Ga4RealtimeDay, Ga4RealtimePayload } from '@noticeos/contract';
import { SiteRows } from '@/components/wall/SiteRows';
import { currentRealtimeDay, completedRealtimeMinutes, realtimeActivity } from '@/lib/realtime-day';
import { WALL_FIXTURE_NOW, wallFixturePayload, wallFixtureRealtime } from '../e2e/wall-fixture';

const NOW = Date.parse(WALL_FIXTURE_NOW);
const DATE = new Date(NOW).toISOString().slice(0, 10);
const START = Date.parse(`${DATE}T00:00:00Z`);
const MINUTE = Math.floor((NOW - START) / 60_000);
const day = (): Ga4RealtimeDay => ({ date: DATE, timeZone: 'UTC', startAt: new Date(START).toISOString(),
  endAt: new Date(START + 86_400_000).toISOString(), minutes: Array<number | null>(1440).fill(null), sameDayLastWeek: null });
function retained(): Ga4RealtimePayload {
  return { generatedAt: new Date(NOW).toISOString(), assets: wallFixtureRealtime().assets.map(asset => {
    if (asset.status !== 'success') return asset;
    const history = day();
    history.minutes[MINUTE - 3] = 2;
    history.minutes[MINUTE - 1] = 3;
    history.minutes[MINUTE] = 999;
    return { ...asset, observedAt: new Date(NOW).toISOString(), hourlyActiveUsers: null, hourlyErrorCode: 'ga4_realtime_history', realtimeDay: history };
  }) };
}

describe('the retained realtime day on the Wall', () => {
  it('shows minute activity instead of the delayed hourly chart, with gaps and no invented baseline or total', () => {
    const { container } = render(<SiteRows assets={wallFixturePayload().assets} ga4Realtime={retained()} nowMs={NOW} />);
    expect(container.querySelector('[data-site-today]')?.closest('.wall-metric')?.querySelector('h3')?.textContent).toBe('Todayvs last Tue 1,788');
    expect(container.querySelector('[data-site-today-total]')).toHaveTextContent('887');
    expect(container.querySelector('[data-site-today-total]')).toHaveAccessibleName('887 daily active users today so far');
    expect(container.querySelector('[data-site-today-total]')?.closest('.wall-metric-primary')).toHaveTextContent('reported users');
    expect(container.querySelector('[data-site-today-chart] [data-realtime-today]')).not.toBeNull();
    const line = container.querySelector('[data-realtime-today]')!;
    expect(line.querySelectorAll('path').length).toBeLessThanOrEqual(1);
    expect(container.textContent).toContain('Last week pending');
    expect(container.querySelector('[data-realtime-prior]')).toBeNull();
    expect(container.querySelector('[data-today]')).toBeNull();
    expect(container.querySelector('[data-site-trend] [data-tone]')).not.toBeNull(); // Four-week comparison remains.
  });

  it('uses retained realtime data in the same tile for one asset', () => {
    const asset = wallFixturePayload().assets[0]!;
    const { container } = render(<SiteRows assets={[asset]} ga4Realtime={retained()} nowMs={NOW} />);
    expect(container.querySelector('[data-site-today]')?.closest('.wall-metric')?.querySelector('h3')?.textContent).toBe('Todayvs last Tue 1,788');
    expect(container.querySelector('[data-site-today-total]')?.textContent).toBe('887');
    expect(container.querySelector('[data-realtime-today]')).not.toBeNull();
    expect(container.querySelector('[data-site-today]')?.textContent).toBe('Last week pending');
  });

  it('does not draw the current incomplete minute or label yesterday as today', () => {
    const history = day();
    history.minutes[MINUTE - 1] = 3;
    history.minutes[MINUTE] = 999;
    expect(completedRealtimeMinutes(history, NOW).slice(MINUTE - 1, MINUTE + 1)).toEqual([3, null]);
    const snapshot = retained().assets[0]!;
    expect(currentRealtimeDay(snapshot, NOW)).not.toBeNull();
    expect(currentRealtimeDay(snapshot, START + 86_400_000)).toBeNull();
  });

  it.each(['in-progress', 'refused', 'reconnecting'])('keeps recent numbers and the five-minute label stable during %s', mode => {
    const assets = wallFixturePayload().assets;
    const good = retained();
    const { container, rerender } = render(<SiteRows assets={assets} ga4Realtime={good} nowMs={NOW} />);
    const target = assets[0]!.id;
    const cell = () => container.querySelector(`[data-site-row="${target}"] [data-live]`)!;
    const count = cell().querySelector('[data-live-count]');
    const recent = cell().querySelector('[data-live-recent-count]');
    expect(count).not.toBeNull();
    expect(recent).not.toBeNull();
    const text = cell().textContent;
    const failed: Ga4RealtimeAsset = { asset: target, status: 'error', activeUsers5m: null, activeUsers30m: null,
      hourlyActiveUsers: null, observedAt: new Date(NOW).toISOString(), errorCode: mode === 'in-progress' ? 'ga4_read_in_progress' : 'ga4_realtime_http_503' };
    const next = mode === 'reconnecting' ? good : { ...good, assets: good.assets.map(asset => asset.asset === target ? failed : asset) };
    rerender(<SiteRows assets={assets} ga4Realtime={next} ga4RealtimeError={mode === 'reconnecting'} nowMs={NOW + 1_000} />);
    expect(cell().querySelector('[data-live-count]')).toBe(count);
    expect(cell().querySelector('[data-live-recent-count]')).toBe(recent);
    expect(cell().textContent).toBe(text);
    expect(cell().querySelector('[data-live-age]')).toBeNull();
  });
});


describe('hourly activity and day-so-far pace', () => {
  it('shows an estimated cumulative user count that grows with live activity while daily reports stay fixed', () => {
    const assets = structuredClone(wallFixturePayload().assets.slice(0, 1));
    assets[0]!.activeUsers.timeZone = 'UTC';
    assets[0]!.activeUsers.series = [{ t: DATE, v: 10 }, { t: '2026-09-15', v: 1440 }];
    const payload = retained();
    const snapshot = payload.assets.find(asset => asset.asset === assets[0]!.id);
    if (snapshot?.status !== 'success' || !snapshot.realtimeDay) throw new Error('expected retained day');
    const history = snapshot.realtimeDay;
    history.minutes.fill(null);
    history.sameDayLastWeek = Array<number>(1440).fill(2);
    for (let i = 0; i < 60; i++) history.minutes[i] = 4;
    history.minutes[60] = 999;
    const { container, rerender } = render(<SiteRows assets={assets} ga4Realtime={payload} nowMs={START + 60 * 60_000} />);
    const total = () => container.querySelector('[data-site-today-total]');
    expect(total()).toHaveTextContent('120');
    expect(total()).toHaveAccessibleName('120 estimated active users today so far');
    expect(total()?.closest('.wall-metric-primary')).toHaveTextContent('estimated users');
    expect(container.querySelector('[data-site-today-reference]')).toHaveTextContent('1,440');
    history.minutes[60] = 4;
    rerender(<SiteRows assets={assets} ga4Realtime={structuredClone(payload)} nowMs={START + 61 * 60_000} />);
    expect(total()).toHaveTextContent('122');
    rerender(<SiteRows assets={assets} ga4Realtime={payload} nowMs={START + 90 * 60_000} />);
    expect(total()).toHaveTextContent('122');
    expect(total()?.closest('.wall-metric-primary')).toHaveTextContent('29m');
    history.sameDayLastWeek = null;
    rerender(<SiteRows assets={assets} ga4Realtime={structuredClone(payload)} nowMs={START + 90 * 60_000} />);
    expect(total()).toHaveTextContent('10');
    expect(total()?.closest('.wall-metric-primary')).toHaveTextContent('reported users');
  });

  it('keeps the day-so-far deficit when the latest plotted hour has recovered', () => {
    const history = day();
    history.sameDayLastWeek = Array<number | null>(1440).fill(10);
    for (let i = 0; i < 180; i++) history.minutes[i] = i < 60 ? 6 : i < 120 ? 8 : 10;
    const activity = realtimeActivity(history, START + 180 * 60_000);
    expect(activity.hours[2]).toMatchObject({ today: 10, prior: 10 });
    expect(activity.change).toBeCloseTo(-20);
    expect(activity.comparedMinutes).toBe(180);
    expect(activity.through).toBe(new Date(START + 180 * 60_000).toISOString());
  });

  it('compares the same observed minutes and excludes gaps and the partial minute', () => {
    const history = day();
    history.sameDayLastWeek = Array<number | null>(1440).fill(100);
    for (let i = 120; i < 180; i++) { history.minutes[i] = 3; history.sameDayLastWeek[i] = 2; }
    history.minutes[MINUTE] = 99999;
    const activity = realtimeActivity(history, NOW);
    expect(activity.hours[2]).toMatchObject({ today: 3, prior: 2, observedMinutes: 60 });
    expect(activity.hours[1]?.today).toBeNull();
    expect(activity.comparedMinutes).toBe(60);
    expect(activity.change).toBe(50);
    expect(activity.through).toBe(new Date(START + 180 * 60_000).toISOString());
  });

  it('does not manufacture a pace from a missing, zero or tiny baseline', () => {
    const history = day(); history.minutes.fill(4);
    expect(realtimeActivity(history, NOW).change).toBeNull();
    history.sameDayLastWeek = Array<number | null>(1440).fill(0);
    expect(realtimeActivity(history, NOW).change).toBeNull();
    history.sameDayLastWeek.fill(null); history.sameDayLastWeek[0] = 4;
    expect(realtimeActivity(history, NOW).change).toBeNull();
  });

  it('uses paired minutes for the in-progress hour instead of comparing it to a full hour', () => {
    const history = day(); history.sameDayLastWeek = Array<number | null>(1440).fill(100);
    for (let i = 0; i < 30; i++) { history.minutes[i] = 8; history.sameDayLastWeek[i] = 4; }
    const activity = realtimeActivity(history, START + 30 * 60_000);
    expect(activity.comparedMinutes).toBe(30);
    expect(activity.change).toBe(100);
    expect(activity.hours[0]?.prior).toBe(4);
  });

  it('draws a backfilled comparison and a pace immediately, without a week of retained observations', () => {
    const payload = retained();
    for (const snapshot of payload.assets) {
      if (snapshot.status !== 'success' || !snapshot.realtimeDay) continue;
      snapshot.realtimeDay.sameDayLastWeek = Array<number | null>(1440).fill(2);
      snapshot.realtimeDay.minutes.fill(null);
      for (let i = 0; i < MINUTE; i++) snapshot.realtimeDay.minutes[i] = 3;
    }
    const { container } = render(<SiteRows assets={wallFixturePayload().assets} ga4Realtime={payload} nowMs={NOW} />);
    expect(container.querySelector('[data-realtime-prior]')).not.toBeNull();
    expect(container.querySelector('[data-site-today]')?.textContent).toContain('50%');
    expect(container.querySelector('[data-site-today-total]')).toHaveTextContent('887');
    expect(container.querySelector('[data-site-today-reference]')).toHaveTextContent('1,788');
    expect(container.querySelector('[data-site-today]')?.closest('.wall-metric')?.querySelector('.wall-site-axis')?.textContent).toContain('avg users/min');
  });

  it.each(['multiple assets', 'one asset'])('labels the cumulative comparison as day so far in %s', mode => {
    const payload = retained();
    for (const snapshot of payload.assets) {
      if (snapshot.status !== 'success' || !snapshot.realtimeDay) continue;
      snapshot.realtimeDay.sameDayLastWeek = Array<number | null>(1440).fill(10);
      snapshot.realtimeDay.minutes.fill(null);
      for (let i = MINUTE - 180; i < MINUTE; i++) snapshot.realtimeDay.minutes[i] = i < MINUTE - 120 ? 6 : i < MINUTE - 60 ? 8 : 10;
    }
    const assets = wallFixturePayload().assets;
    const { container } = render(<SiteRows assets={mode === 'one asset' ? assets.slice(0, 1) : assets} ga4Realtime={payload} nowMs={NOW} />);
    const today = container.querySelector('[data-site-today]')!;
    expect(today.textContent).toContain('day so far');
    const chip = today.querySelector('[data-tone]')!;
    expect(chip.textContent).toBe('20%');
    expect(chip.getAttribute('data-tone')).toBe('wall-traffic-decline');
    expect(chip.getAttribute('aria-label')).toContain('today so far');
    expect(chip.getAttribute('aria-label')).toContain('180 matching minutes');
    expect(chip.getAttribute('aria-label')).toContain('Includes earlier hours');
  });
});
