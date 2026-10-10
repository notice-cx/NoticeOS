import { describe, expect, it } from 'vitest';
import type { Ga4RealtimeAsset } from '@noticeos/contract';
import { liveTrafficCardIssue, liveTrafficFailure } from '@shared/live-traffic-health';

// The one live-traffic issue a Wall site row names (`LiveUsers`).
const AT = '2026-09-11T00:00:00Z';
const NOW = Date.parse(AT);
const good = (asset = 'plume.example'): Extract<Ga4RealtimeAsset, { status: 'success' }> => ({ asset, status: 'success', activeUsers5m: 0, activeUsers30m: 0, hourlyActiveUsers: [], observedAt: AT, timeZone: 'America/Los_Angeles', errorCode: null });
const failed = (asset = 'plume.example', errorCode = 'ga4_realtime_http_429'): Extract<Ga4RealtimeAsset, { status: 'error' }> => ({ asset, status: 'error', activeUsers5m: null, activeUsers30m: null, hourlyActiveUsers: null, observedAt: AT, errorCode });

describe("a site row's live-traffic issue", () => {
  it('names a fresh reading as no issue at all, a fresh observed zero included', () => {
    expect(liveTrafficCardIssue(good(), false, NOW)).toBeNull();
  });

  it('keeps a known refusal visible during an intentional cooldown', () => {
    const snapshot = { ...failed(), observedAt: '2026-09-10T23:56:00Z', nextAttemptAt: '2026-09-11T00:01:00Z' };
    expect(liveTrafficCardIssue(snapshot, false, NOW)).toBe('Google rate limit');
  });

  it('names no issue for an hourly outage while the realtime counts work', () => {
    expect(liveTrafficCardIssue({ ...good(), hourlyActiveUsers: null, hourlyErrorCode: 'ga4_intraday_http_429' }, false, NOW)).toBeNull();
  });

  it('shows a shared cold read as checking, not a Google outage', () => {
    expect(liveTrafficCardIssue(failed('plume.example', 'ga4_read_in_progress'), false, NOW)).toBe('Checking traffic');
  });

  it('calls a stale reading out of date, and a slow multi-property poll not', () => {
    expect(liveTrafficCardIssue({ ...good(), observedAt: '2026-09-10T23:56:00Z' }, false, NOW)).toBe('Reading out of date');
    // 60s cache + 30s poll + up to 50s of serial property reads + a 30s clock
    // tick: a healthy feed can legitimately show a two-minute-old reading.
    expect(liveTrafficCardIssue({ ...good(), observedAt: '2026-09-10T23:58:00Z' }, false, NOW)).toBeNull();
    expect(liveTrafficCardIssue({ ...good(), observedAt: '2026-09-11T01:00:00Z' }, false, NOW)).toBe('Reading out of date');
  });

  it('says reconnecting when the poll failed and the last reading was good', () => {
    expect(liveTrafficCardIssue(good(), true, NOW)).toBe('Reconnecting');
    expect(liveTrafficCardIssue(undefined, true, NOW)).toBe('Live traffic unavailable');
  });

  it('turns every failure code into words, never the code', () => {
    expect(liveTrafficFailure('ga4_read_cache_unavailable')).toBe('Traffic refresh unavailable');
    expect(liveTrafficFailure('ga4_realtime_http_403')).toBe('Google access issue');
    expect(liveTrafficFailure('ga4_intraday_timeout')).toBe('Traffic report unavailable');
    expect(liveTrafficFailure('something_new')).toBe('Live traffic unavailable');
    expect(liveTrafficFailure(undefined)).toBe('Live traffic unavailable');
  });
});
